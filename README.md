# @mirafive/node

The MIRA FIVE server SDK for Node 20+, Bun, Deno, Cloudflare Workers, Vercel and other edge
runtimes. It uses only `fetch`, Web Crypto and `AbortSignal.timeout`, and has no dependencies
besides `@mirafive/protocol`.

Use it for what only your server knows: revenue (the server is the only place money may come
from), a paid invoice, a plan change, a survey answer from your CRM, and backfills. Batching,
retries and exactly-once event ids are built in. **The secret key stays on the server.**

Using a framework? [`@mirafive/next`](https://github.com/mirafive/sdk-next) (`after()`),
[`@mirafive/tanstack`](https://github.com/mirafive/sdk-tanstack) (middleware),
[`@mirafive/nuxt`](https://github.com/mirafive/sdk-nuxt) (`useServerMira`) and
[`@mirafive/convex`](https://github.com/mirafive/sdk-convex) (mutations) wrap this package.

## Install

```sh
npm install @mirafive/node   # or: bun add, pnpm add, yarn add
```

```sh
# .env — the project's secret key, from the MIRA FIVE dashboard
MIRAFIVE_SECRET_KEY=mira_sk_…
```

## Usage

```ts
import { Mira, eventIdFor } from "@mirafive/node";

// Reads MIRAFIVE_SECRET_KEY (and MIRAFIVE_HOST, if set). One client per process is enough.
await using mira = new Mira({
  onError: (error) => console.warn(error.code, error.message, error.eventIds),
});

mira.identify({
  userId: "user_42",
  traits: { email: "ada@example.com", plan: "pro" },
  // The same person in other systems, so connectors link their money to this user:
  externalIds: { stripe_customer: "cus_123" }, // also revenuecat_app_user, shopify_customer, shopware_customer
});

mira.group({ groupId: "acme", userId: "user_42", traits: { name: "Acme GmbH", seats: 12 } });

mira.track({
  event: "report_exported",
  userId: "user_42",
  properties: { format: "csv" },
  context: { ip: request.ip, userAgent: request.headers["user-agent"] },
});

mira.revenue({
  userId: "user_42",
  amount: 1999, // minor units: 19.99 EUR
  currency: "EUR",
  entryId: "stripe:in_123", // the same money from the Stripe connector is counted once
  eventId: await eventIdFor("order:123:paid"),
});

// A touchpoint that is not a visit: the models credit it like one (docs/attribution.md).
mira.touchpoint({
  kind: "survey", // also offline, code, custom
  userId: "user_42",
  source: "podcast", // or channel: "affiliate", "video", … (MIRA's channels)
  answer: "The Elternzeit podcast",
  eventId: await eventIdFor("survey:response_77"),
});
// `await using` flushes when the scope ends. Without it, call `await mira.shutdown()`.
```

- **Touchpoints:** `touchpoint` sends `$touchpoint` for what leaves no visit: a survey answer
  ("How did you hear about us?"), an offline contact (a trade fair, a phone call), a redeemed
  discount or partner code (`code`), or anything you model yourself (`custom`). It needs a `userId`
  or `anonymousId` and a `channel` or a `source`; without a `channel`, `source`, `medium` and
  `campaign` decide it like the UTMs of a link, the project's channel rules included. More fields:
  `content` (the ad), `campaignId`, `adGroupId`, `adId`, `code`, `answer` (passes the PII guard)
  and `externalRef` (your record, `hubspot:123`). A browser or app may send `survey` only.

Every `revenue` call becomes one entry in the project's revenue ledger, keyed by `entryId` (sent
twice, it counts once). `amount` is what the customer paid, VAT included. Subscriptions and
refunds are optional fields:

```ts
// A subscription payment (the first one and every renewal).
mira.revenue({
  userId: "user_42",
  amount: 999,
  currency: "EUR",
  entryId: "revenuecat:txn_1000000123",
  product: "premium_monthly",
  subscription: { id: "sub_42", interval: "month" }, // pays from now for one month
});

// A refund takes the money back, and the credit of the channels that earned it.
mira.revenue({
  userId: "user_42",
  amount: -999,
  currency: "EUR",
  entryKind: "refund",
  entryId: "revenuecat:txn_1000000123:refund",
  refundOf: "revenuecat:txn_1000000123",
});
```

- **`entryKind`:** `charge` (one-time, the default), `subscription_payment` (the default with
  `subscription`), `refund` (the default for a negative amount), `dispute` and `dispute_won`.
- **MRR** comes from subscription payments and the period each pays for (`interval`, `intervalCount`, or `periodStart` and `periodEnd`).
- **Attribution:** a subscription payment inherits the credits of the person's acquisition (their
  first conversion, sign-up, trial or first purchase, set per project), a refund those of the
  money it takes back.

- **`track`, `identify`, `group`, `revenue` and `touchpoint` never throw.** Problems go to `onError` as a `MiraError` with
  `status` and the affected `eventIds`.
- **Batching:** a request goes out when `flushAt` events are waiting or every `flushIntervalMs`.
  The timer does not keep the process alive; call `shutdown()` (or use `await using`) before exit.
- **Retries:** network errors, 5xx, 408 and 429 are retried up to `maxRetries` times with
  exponential backoff and jitter, honouring `retry-after`, always with the same event ids. Other
  4xx answers are final.
- **Sequence numbers:** every batch carries a random `stream` id per `Mira` instance and a `seq`
  from 1 (a retry keeps its number), so the server can count lost batches.
- **Context:** besides `ip`, `userAgent` and `page`, `context` takes `app` (`name`, `version`,
  `build`), `locale`, `timezone` and `location` (`{ latitude, longitude }`, only one your app
  already has and only with analytics consent; MIRA rounds it to 2 decimals). An invalid location
  is dropped and reported; the event still goes out.
- **Once only:** pass `eventId` to report one fact from several places (browser and server, or a
  job that may run twice). `eventIdFor("order:123:paid")` makes a stable UUID from your own key.
- **Backfills:** `timestamp` accepts past dates (`Date`, ISO string or epoch ms).
- **Consent:** defaults to `not_applicable` (server-only facts). For events that describe what a
  visitor did, pass what your banner recorded: `consent: { analytics: true, marketing: false }`.

## What is collected at each consent tier

| `consent` on the event                           | Tier    | What MIRA keeps                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `not_applicable` (default), no `userId`          | T1      | The event, `anonymous_id` if given, geo from `context.ip` (the IP is discarded)               |
| `not_applicable` with `userId`                   | T2      | Plus `user_id`, traits (PII traits encrypted at rest), revenue per person                     |
| `{ analytics: 'granted' }`                       | T1 / T2 | As above                                                                                      |
| `{ analytics: 'granted', marketing: 'granted' }` | T3      | Plus click ids, and later forwarding to ad platforms                                          |
| `{ analytics: 'denied' \| 'unknown' }`           | T0      | No `user_id`, `anonymous_id` or `session_id`: the event counts, but is not linked to a person |

## Options

| Option            | Default                                            | Meaning                                                                                   |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `secretKey`       | `MIRAFIVE_SECRET_KEY`                              | The project's secret key (`mira_sk_…`). A public key is refused.                          |
| `host`            | `MIRAFIVE_HOST`, else `https://events.mirafive.io` | The ingest origin.                                                                        |
| `enabled`         | `true`                                             | `false` sends nothing and needs no key; input is still checked. For tests and local runs. |
| `flushAt`         | `50`                                               | Send when this many events wait (at most 100).                                            |
| `flushIntervalMs` | `2000`                                             | Send waiting events at least this often.                                                  |
| `maxRetries`      | `5`                                                | Retries per batch for network errors, 408, 429 and 5xx.                                   |
| `timeoutMs`       | `10000`                                            | Per request.                                                                              |
| `onError`         | `console.error`                                    | Receives every `MiraError`.                                                               |
| `fetch`           | global `fetch`                                     | For tests and proxies.                                                                    |

`MiraError.code` says what happened: `config` (missing or wrong key), `invalid_input` (an event
was not queued; the message names the field), `rejected` (the ingest refused single events),
`dropped` (a batch was given up), `queue_full`, `shut_down`. `deletePerson` also throws
`rate_limited` and `unavailable` (see below).

## Checking the setup

```ts
await new Mira().checkConnection(); // { key: "secret" }, or a MiraError that says what to fix
```

It asks the ingest whether the key works (`GET /v1/check`) and sends no event, so it is safe in
a deploy check or a health endpoint. It is the only method that throws.

## Erasing a person (GDPR Art. 17)

```ts
const proof = await mira.deletePerson("user_42");
// { request_id: "…", deleted: { events: 12, person_traits: 3, … }, revenue_kept: 1, completed_at: "…" }
```

Erases the person with the same effect as the dashboard's People page: events, devices, traits,
ids in other systems and touchpoints. Revenue stays in the totals, without the person. `userId` is
the id you send in events.

- **Synchronous:** unlike the event methods it does not batch. It resolves with the proof or
  rejects with a `MiraError`: `config` (missing, wrong or public key) and `invalid_input` (empty
  id, or more than 200 characters) will not succeed on a retry; `rate_limited` and `unavailable`
  (`error.retryable`) will, later. It retries those twice itself (`{ maxRetries }`).
- **Idempotent:** a person nothing is stored about, or one already erased, resolves with zero
  rows. Call it again after any failure, for example from a job with retries.
- **Late events:** events that name the person afterwards are refused for 30 days (`onError`
  reports them as `rejected`, reason `erased`). Stop sending them from your side.
- Needs the secret key; `mira_pk_…` is refused. Server only.

## Typed events

```ts
const mira = new Mira<{ report_exported: { format: "csv" | "pdf" } }>();
mira.track({ event: "report_exported", userId: "user_42", properties: { format: "csv" } });
```

## Serverless and edge

The client batches in the background. In a serverless function, send before the function
returns: `await mira.flush()` at the end of the handler, or hand the promise to the platform's
`waitUntil` (`ctx.waitUntil(mira.flush())`). Long-running servers need nothing but a
`shutdown()` on exit.

## For AI coding assistants

Rules for integrating MIRA FIVE correctly. They hold for every MIRA FIVE SDK.

- **Keys:** the public key (`mira_pk_…`) goes in browser and app code. The secret key (`mira_sk_…`)
  goes only into the server's environment (`MIRAFIVE_SECRET_KEY`), never into client code, a
  `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_` variable or a repository. The SDKs refuse the wrong key.
- **Money** is sent only from the server: integer minor units plus an ISO 4217 currency
  (`amount: 1999, currency: "EUR"` is 19.99 EUR), never floats.
- **Count once:** give money an `entryId` from the payment provider (`stripe:in_123`), so the
  Stripe connector and retries do not double it. Give business events a stable id:
  `eventId: await eventIdFor("order:123:paid")`. The same key gives the same id in every SDK.
- **Personal data** never goes into event names or properties. Use your own user id (not an email)
  for `identify`; put email, name and phone in its traits, which MIRA FIVE encrypts at rest.
- **Consent:** keep `consent: "auto"`; it follows the site's consent banner (Usercentrics,
  Cookiebot, consentmanager, CCM19, Borlabs, any TCF 2.2 CMP, Google Consent Mode). Call
  `consent()` only for a custom banner. Do not gate the SDK behind consent yourself: without
  consent it is cookieless and still counts.
- **Never block on analytics:** event methods return nothing, never throw, and batch on their
  own. Do not `await` or `try` them. Call `flush()`/`shutdown()` only at the end of a script or a
  serverless function.
- **Server events and visitors:** pass the browser's `mira.anonymousId` to your server and set it
  as `anonymousId` on server events, so a purchase joins the visit and its source.
