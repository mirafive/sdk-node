/**
 * `@mirafive/node`: the MIRA FIVE server SDK for Node, Bun, Deno, Convex and edge runtimes.
 *
 * Only web platform APIs are used (`fetch`, Web Crypto, `AbortSignal.timeout`), so it runs
 * anywhere. Sessions, identity and attribution happen on the MIRA FIVE server; this SDK delivers
 * events reliably, and at most once per `event_id`.
 */
import {
  backoffMs,
  cleanExternalIds,
  cleanProperties,
  DEFAULT_HOST,
  isUuid,
  keyKind,
  LIMITS,
  retryable,
  retryAfterMs,
  toConsent,
  touchpointKinds,
  trimHost,
  uuidv7,
  type BatchResult,
  type BillingInterval,
  type ConsentInput as PurposeInput,
  type EventContext,
  type ExternalIdType,
  type RevenueKind,
  type TouchpointChannel,
  type TouchpointKind,
  type WireEvent,
} from "@mirafive/protocol";

import { VERSION } from "./version";

export { eventIdFor, uuidv7 } from "@mirafive/protocol";
export type {
  BillingInterval,
  ExternalIdType,
  RevenueKind,
  TouchpointChannel,
  TouchpointKind,
} from "@mirafive/protocol";
export { VERSION } from "./version";

export const LIBRARY = { name: "@mirafive/node", version: VERSION } as const;

/** Events kept in memory while the ingest is unreachable; the oldest are dropped beyond this. */
const MAX_QUEUE = 10_000;

/**
 * Your events and their properties, for autocomplete and type checks:
 * `new Mira<{ report_exported: { format: "csv" | "pdf" } }>()`.
 */
export type EventMap = Record<string, Record<string, unknown> | undefined>;

export interface MiraOptions {
  /**
   * The project's secret key (`mira_sk_…`). Default: the `MIRAFIVE_SECRET_KEY` environment
   * variable. Never ship it to a browser or an app.
   */
  secretKey?: string;
  /** Ingest origin. Default: `MIRAFIVE_HOST`, else `https://events.mirafive.io`. */
  host?: string;
  /** `false` sends nothing and needs no key; input is still checked. For tests and local runs. */
  enabled?: boolean;
  /** Send as soon as this many events are waiting (at most 100 per request). Default 50. */
  flushAt?: number;
  /** Send waiting events at least this often. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Retries per batch on network errors, 408, 429 and 5xx. Default 5. */
  maxRetries?: number;
  /** Timeout per request. Default 10 000 ms. */
  timeoutMs?: number;
  /** Receives every problem. Default: `console.error`. The event methods never throw. */
  onError?: (error: MiraError) => void;
  /** A custom `fetch` (tests, proxies). Default: the global one. */
  fetch?: typeof fetch;
}

/**
 * What went wrong, for `onError`:
 * - `config`: a missing or wrong key, the client cannot send
 * - `invalid_input`: an event was not queued; `message` says which field
 * - `rejected`: the ingest refused single events of a batch (see `eventIds`)
 * - `dropped`: a batch was given up after retries or refused as a whole (`status`)
 * - `queue_full`: the ingest was unreachable for long; the oldest events were dropped
 * - `shut_down`: an event arrived after `shutdown()`
 */
export type MiraErrorCode =
  | "config"
  | "invalid_input"
  | "rejected"
  | "dropped"
  | "queue_full"
  | "shut_down";

export class MiraError extends Error {
  override readonly name = "MiraError";
  readonly code: MiraErrorCode;
  /** The HTTP status of the answer, when there was one. */
  readonly status: number | undefined;
  /** The `event_id`s that were not delivered. */
  readonly eventIds: string[];

  constructor(
    code: MiraErrorCode,
    message: string,
    options: { status?: number; eventIds?: string[]; cause?: unknown } = {},
  ) {
    super(`MIRA FIVE: ${message}`, { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.eventIds = options.eventIds ?? [];
  }
}

/**
 * Consent as stamped on a server event. Facts only your server knows (a paid invoice) are
 * `not_applicable`, the default. For what a visitor did, pass what your banner recorded.
 */
export type ConsentInput = "not_applicable" | { analytics: PurposeInput; marketing?: PurposeInput };

/** When something happened. Past values are fine with a secret key (backfills). */
export type TimeInput = Date | string | number;

/** Fields every event takes. */
export interface Common {
  /** Your user id. Pseudonymous: your own id, never an email address. */
  userId?: string;
  /**
   * The browser's anonymous id (`mira.anonymousId` in `@mirafive/web`), so this server event
   * joins that visitor's journey and its sources.
   */
  anonymousId?: string;
  /**
   * Report one fact from several places only once: the browser and your server both send
   * `purchase` with the same id. `eventIdFor("order:123:paid")` makes a stable one.
   */
  eventId?: string;
  timestamp?: TimeInput;
  consent?: ConsentInput;
  context?: {
    /** The end user's IP, for geo. Used at ingest and never stored. */
    ip?: string;
    /** The end user's user agent, for the device. */
    userAgent?: string;
    page?: { url?: string; referrer?: string; title?: string };
    /** Your app's name and version, for events from an app backend. */
    app?: { name?: string; version?: string; build?: string };
    /** The end user's locale (`de-DE`) and IANA time zone (`Europe/Berlin`). */
    locale?: string;
    timezone?: string;
    /** A location your app already has. Only with analytics consent; rounded to about 1 km. */
    location?: { latitude: number; longitude: number };
  };
}

export type TrackInput<
  Events extends EventMap = EventMap,
  Name extends keyof Events & string = keyof Events & string,
> = Common & { event: Name; properties?: Events[Name] };

export interface IdentifyInput extends Common {
  userId: string;
  /** Traits such as `plan`. PII traits (`email`, `name`, `phone`, …) are encrypted at rest. */
  traits?: Record<string, unknown>;
  /** The person's ids in other systems, so connectors link their money to this user. */
  externalIds?: Partial<Record<ExternalIdType, string>>;
}

export interface GroupInput extends Common {
  /** The company or account, for B2B. */
  groupId: string;
  traits?: Record<string, unknown>;
}

export interface RevenueInput extends Common {
  /** Integer minor units: `1999` is 19.99 EUR, `500` is 500 JPY. */
  amount: number;
  /** ISO 4217, for example `EUR`. */
  currency: string;
  /**
   * The provider object this money belongs to (`stripe:in_123`, `crm:case-81`). The ledger keeps
   * one entry per id, so the same money sent twice, or also by a connector, counts once.
   */
  entryId?: string;
  /**
   * `charge` (one-time, the default), `subscription_payment` (the default with `subscription`),
   * `refund` (the default for a negative amount), `dispute` or `dispute_won`.
   */
  entryKind?: RevenueKind;
  /** @deprecated Not sent since 2.2.0: MIRA FIVE counts what the customer paid. Removed in 3.0.0. */
  fee?: number;
  /** @deprecated Not sent since 2.2.0: MIRA FIVE counts what the customer paid. Removed in 3.0.0. */
  tax?: number;
  /** For a refund or dispute: the `entryId` of the money it takes back. */
  refundOf?: string;
  /** The product or plan, for example `premium_monthly`. */
  product?: string;
  /** The subscription this payment renews, and the period it pays for. */
  subscription?: {
    id: string;
    /** Default `month`. */
    interval?: BillingInterval;
    /** Default 1: `{ interval: "month", intervalCount: 3 }` bills quarterly. */
    intervalCount?: number;
    /** Default: the event's time and one interval later. */
    periodStart?: TimeInput;
    periodEnd?: TimeInput;
  };
  properties?: Record<string, unknown>;
}

/**
 * A touchpoint that is not a visit: the answer to "How did you hear about us?", a trade fair
 * contact, a redeemed code. The attribution models credit it like a visit. It needs a `userId`
 * or an `anonymousId`, and a `channel` or a `source`.
 */
export interface TouchpointInput extends Common {
  kind: TouchpointKind;
  /** One of MIRA FIVE's channels. Without it, `source`, `medium` and `campaign` decide, like UTMs. */
  channel?: TouchpointChannel;
  /** Where it came from: `podcast`, `instagram`, `trade_fair_2026`, a partner. */
  source?: string;
  medium?: string;
  campaign?: string;
  /** The ad or creative, as `utm_content` names it for a visit. */
  content?: string;
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  /** The discount or partner code. */
  code?: string;
  /** The survey answer as the person gave it. It passes MIRA FIVE's PII guard. */
  answer?: string;
  /** The record in your system, such as a CRM contact (`hubspot:123`). */
  externalRef?: string;
  properties?: Record<string, unknown>;
}

type QueuedEvent = WireEvent & { event_id: string };

function toIso(value: TimeInput | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MiraError("invalid_input", `invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

const validLocation = (value: { latitude: number; longitude: number }) =>
  Number.isFinite(value.latitude) &&
  Number.isFinite(value.longitude) &&
  Math.abs(value.latitude) <= 90 &&
  Math.abs(value.longitude) <= 180;

/** Environment variables where the runtime has them (Node, Bun, Deno, Convex), else undefined. */
function env(name: string): string | undefined {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env?.[name] || undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The server client. One per process is enough; it batches and retries on its own.
 *
 * ```ts
 * import { Mira } from "@mirafive/node";
 *
 * const mira = new Mira(); // reads MIRAFIVE_SECRET_KEY
 * mira.track({ event: "report_exported", userId: "user_42" });
 * await mira.shutdown(); // before the process exits, or `await using mira = new Mira()`
 * ```
 */
export class Mira<Events extends EventMap = EventMap> implements AsyncDisposable {
  private readonly key: string;
  private readonly host: string;
  private readonly endpoint: string;
  private readonly enabled: boolean;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly onError: (error: MiraError) => void;
  private readonly fetch: typeof fetch;

  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The running flush; flushes are serialised so batches keep their order. */
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  /** A random stream per client, memory only, and its batch count from 1 (lost-batch detection). */
  private readonly stream = crypto.randomUUID();
  private seq = 0;

  constructor(options: MiraOptions = {}) {
    this.key = options.secretKey ?? env("MIRAFIVE_SECRET_KEY") ?? "";
    this.host = trimHost(options.host ?? env("MIRAFIVE_HOST") ?? DEFAULT_HOST);
    this.endpoint = `${this.host}/v1/batch`;
    this.flushAt = Math.min(Math.max(1, options.flushAt ?? 50), LIMITS.eventsPerBatch);
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? 2_000);
    this.maxRetries = Math.max(0, options.maxRetries ?? 5);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.onError = options.onError ?? ((error) => console.error(error));
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    let enabled = options.enabled ?? true;
    if (enabled && !this.key) {
      this.report(
        new MiraError(
          "config",
          "no secret key: set MIRAFIVE_SECRET_KEY or pass { secretKey }. Events are dropped.",
        ),
      );
      enabled = false;
    } else if (enabled && keyKind(this.key) === "public") {
      this.report(
        new MiraError(
          "config",
          "this is a public key (mira_pk_…). The server SDK needs the project's secret key (mira_sk_…); public keys belong in @mirafive/web. Events are dropped.",
        ),
      );
      enabled = false;
    }
    this.enabled = enabled;
  }

  /** A custom event. Names starting with `$` are reserved for MIRA FIVE. */
  track<Name extends keyof Events & string>(input: TrackInput<Events, Name>): void {
    this.safely(() => {
      const name: unknown = input?.event;
      if (typeof name !== "string" || !name.trim()) {
        throw new MiraError("invalid_input", "track: event is required");
      }
      if (name.startsWith("$")) {
        throw new MiraError(
          "invalid_input",
          `track: "${name}" is reserved (names starting with $)`,
        );
      }
      if (name.length > LIMITS.nameLength) {
        throw new MiraError(
          "invalid_input",
          `track: event names have at most ${LIMITS.nameLength} characters`,
        );
      }
      this.push(
        { type: "track", event: name, properties: cleanProperties(input.properties) },
        input,
      );
    });
  }

  /** Who the user is, with traits and ids in other systems. */
  identify(input: IdentifyInput): void {
    this.safely(() => {
      if (!input?.userId) throw new MiraError("invalid_input", "identify: userId is required");
      const externalIds = cleanExternalIds(input.externalIds);
      this.push(
        {
          type: "identify",
          event: "$identify",
          traits: cleanProperties(input.traits),
          ...(externalIds ? { external_ids: externalIds } : {}),
        },
        input,
      );
    });
  }

  /** The company or account a user belongs to (B2B), with its traits: name, size, plan. */
  group(input: GroupInput): void {
    this.safely(() => {
      if (!input?.groupId) throw new MiraError("invalid_input", "group: groupId is required");
      this.push(
        {
          type: "group",
          event: "$group",
          group_id: input.groupId,
          traits: cleanProperties(input.traits),
        },
        input,
      );
    });
  }

  /**
   * Money, as `$revenue`: one entry in the project's revenue ledger. Pass `entryId` when the same
   * money also arrives through a connector (Stripe, RevenueCat), so it counts once.
   */
  revenue(input: RevenueInput): void {
    this.safely(() => {
      if (!Number.isSafeInteger(input?.amount)) {
        throw new MiraError(
          "invalid_input",
          "revenue: amount must be an integer in minor units (1999 for 19.99)",
        );
      }
      if (!/^[A-Za-z]{3}$/.test(input.currency ?? "")) {
        throw new MiraError("invalid_input", "revenue: currency must be an ISO 4217 code (EUR)");
      }
      const subscription = input.subscription;
      if (subscription !== undefined && !subscription.id) {
        throw new MiraError("invalid_input", "revenue: subscription.id is required");
      }
      this.push(
        {
          type: "track",
          event: "$revenue",
          properties: cleanProperties(input.properties),
          revenue: {
            amount: input.amount,
            currency: input.currency.toUpperCase(),
            ...(input.entryId ? { entry_id: input.entryId } : {}),
            ...(input.entryKind ? { kind: input.entryKind } : {}),
            ...(input.refundOf ? { refund_of: input.refundOf } : {}),
            ...(input.product ? { product: input.product } : {}),
            ...(subscription
              ? {
                  subscription: {
                    id: subscription.id,
                    ...(subscription.interval ? { interval: subscription.interval } : {}),
                    ...(subscription.intervalCount
                      ? { interval_count: subscription.intervalCount }
                      : {}),
                    ...(subscription.periodStart !== undefined
                      ? { period_start: toIso(subscription.periodStart) }
                      : {}),
                    ...(subscription.periodEnd !== undefined
                      ? { period_end: toIso(subscription.periodEnd) }
                      : {}),
                  },
                }
              : {}),
          },
        },
        input,
      );
    });
  }

  /**
   * A touchpoint that is not a visit, as `$touchpoint`. With `eventIdFor("survey:" + responseId)`
   * a re-sent answer counts once.
   */
  touchpoint(input: TouchpointInput): void {
    this.safely(() => {
      if (!touchpointKinds.includes(input?.kind)) {
        throw new MiraError(
          "invalid_input",
          `touchpoint: kind must be one of ${touchpointKinds.join(", ")}`,
        );
      }
      if (!input.channel && !input.source?.trim()) {
        throw new MiraError("invalid_input", "touchpoint: a channel or a source is required");
      }
      if (!input.userId && !input.anonymousId) {
        throw new MiraError("invalid_input", "touchpoint: a userId or an anonymousId is required");
      }
      const given: Record<string, string | undefined> = {
        kind: input.kind,
        channel: input.channel,
        source: input.source,
        medium: input.medium,
        campaign: input.campaign,
        content: input.content,
        campaign_id: input.campaignId,
        ad_group_id: input.adGroupId,
        ad_id: input.adId,
        code: input.code,
        answer: input.answer,
        external_ref: input.externalRef,
      };
      const fields: Record<string, string> = {};
      for (const [name, value] of Object.entries(given)) if (value) fields[name] = value;
      this.push(
        {
          type: "track",
          event: "$touchpoint",
          properties: { ...cleanProperties(input.properties), ...fields },
        },
        input,
      );
    });
  }

  /**
   * Whether the key and host work, without sending an event: for setup scripts, deploy checks and
   * health endpoints. Resolves with the key's kind; rejects with a `MiraError` (`config`) that
   * says what to fix. The only method that throws.
   */
  async checkConnection(): Promise<{ key: "public" | "secret" }> {
    if (!this.key) {
      throw new MiraError("config", "no secret key: set MIRAFIVE_SECRET_KEY or pass { secretKey }");
    }
    const url = `${this.host}/v1/check`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: {
          authorization: `Bearer ${this.key}`,
          "user-agent": `${LIBRARY.name}/${LIBRARY.version}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MiraError("config", `cannot reach ${url}: is MIRAFIVE_HOST right?`, {
        cause: error,
      });
    }
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; key?: "public" | "secret"; error?: string }
      | undefined;
    if (response.ok && body?.ok && body.key) return { key: body.key };
    if (response.status === 401) {
      throw new MiraError(
        "config",
        `the ingest refused the key (${body?.error ?? "HTTP 401"}): check MIRAFIVE_SECRET_KEY`,
        { status: 401 },
      );
    }
    throw new MiraError(
      "config",
      `${url} answered HTTP ${response.status}, not like a MIRA FIVE ingest: is MIRAFIVE_HOST right?`,
      { status: response.status },
    );
  }

  /** Sends everything waiting. Resolves once delivered or given up (see `onError`); never rejects. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flushing = this.flushing
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.report(new MiraError("dropped", "flush failed", { cause: error }));
      });
    return this.flushing;
  }

  /** Flushes, stops the timer and refuses new events. Call it before the process exits. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private push(base: Pick<QueuedEvent, "type" | "event"> & Partial<QueuedEvent>, input: Common) {
    if (this.closed) throw new MiraError("shut_down", `${base.event}: the client was shut down`);
    if (input.eventId !== undefined && !isUuid(input.eventId)) {
      throw new MiraError(
        "invalid_input",
        `${base.event}: eventId must be a UUID (see eventIdFor)`,
      );
    }
    const given = input.context;
    const context: EventContext = { library: LIBRARY };
    if (given?.ip) context.ip = given.ip;
    if (given?.userAgent) context.user_agent = given.userAgent;
    if (given?.page) context.page = given.page;
    if (given?.app) context.app = given.app;
    if (given?.locale) context.locale = given.locale;
    if (given?.timezone) context.timezone = given.timezone;
    if (given?.location) {
      // A bad location would make the ingest refuse the whole event: drop only the location.
      if (validLocation(given.location)) {
        context.location = {
          latitude: given.location.latitude,
          longitude: given.location.longitude,
        };
      } else {
        this.report(
          new MiraError(
            "invalid_input",
            `${base.event}: location dropped (latitude -90..90, longitude -180..180)`,
          ),
        );
      }
    }

    const event: QueuedEvent = {
      ...base,
      event_id: input.eventId?.toLowerCase() ?? uuidv7(),
      timestamp: toIso(input.timestamp),
      context,
      consent: toConsent(input.consent),
    };
    if (input.userId) event.user_id = String(input.userId).slice(0, LIMITS.idLength);
    if (input.anonymousId) event.anonymous_id = String(input.anonymousId).slice(0, LIMITS.idLength);

    if (!this.enabled) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) {
      const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.report(
        new MiraError("queue_full", "queue full, oldest events dropped", {
          eventIds: dropped.map((item) => item.event_id),
        }),
      );
    }
    if (this.queue.length >= this.flushAt) void this.flush();
    else this.timer ??= this.startTimer();
  }

  private startTimer() {
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // Do not keep a Node or Bun process alive just for the timer; `shutdown()` does the last flush.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  private async drain() {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.flushAt);
      // Numbered when formed, so a batch dropped for good leaves a gap the server can count.
      this.seq += 1;
      // One batch at a time, on purpose: order is kept and a struggling ingest is not hammered.
      await this.send(batch, this.seq);
    }
  }

  /** One batch with retries: the same events, ids and `seq` every time; the ingest deduplicates. */
  private async send(batch: QueuedEvent[], seq: number) {
    const eventIds = batch.map((event) => event.event_id);
    for (let attempt = 0; ; attempt += 1) {
      let status: number | undefined;
      let wait = 0;
      let cause: unknown;
      try {
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.key}`,
            "user-agent": `${LIBRARY.name}/${LIBRARY.version}`,
          },
          body: JSON.stringify({
            sent_at: new Date().toISOString(),
            stream: this.stream,
            seq,
            events: batch,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = response.status;
        if (response.ok) {
          const result = (await response.json().catch(() => undefined)) as BatchResult | undefined;
          if (result?.rejected?.length) {
            this.report(
              new MiraError(
                "rejected",
                `${result.rejected.length} event(s) rejected: ${result.rejected[0]?.reason}`,
                { status, eventIds: result.rejected.map((item) => eventIds[item.index] ?? "") },
              ),
            );
          }
          return;
        }
        wait = retryAfterMs(response.headers.get("retry-after"));
        if (!retryable(status)) {
          const hint =
            status === 401 || status === 403
              ? " (check the secret key)"
              : status === 402
                ? " (the project's plan is paused)"
                : "";
          this.report(
            new MiraError("dropped", `batch refused: HTTP ${status}${hint}`, { status, eventIds }),
          );
          return;
        }
      } catch (error) {
        cause = error;
      }
      if (attempt >= this.maxRetries) {
        this.report(
          new MiraError("dropped", `batch dropped after ${attempt + 1} attempts`, {
            status,
            eventIds,
            cause,
          }),
        );
        return;
      }
      await sleep(backoffMs(attempt, wait));
    }
  }

  private safely(action: () => void) {
    try {
      action();
    } catch (error) {
      this.report(
        error instanceof MiraError
          ? error
          : new MiraError("invalid_input", "unexpected error", { cause: error }),
      );
    }
  }

  private report(error: MiraError) {
    try {
      this.onError(error);
    } catch {
      // A throwing error handler must not break the caller either.
    }
  }
}
