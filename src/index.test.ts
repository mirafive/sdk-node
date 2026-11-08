import { describe, expect, spyOn, test } from "bun:test";

import { validateEvent } from "@mirafive/protocol";

import { eventIdFor, Mira, type MiraError } from "./index";

interface Sent {
  url: string;
  headers: Headers;
  body: { sent_at: string; stream?: string; seq?: number; events: Record<string, any>[] };
}

/** A fake ingest: answers with the given statuses in order, then 202. */
function fakeFetch(statuses: (number | "network")[] = []) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
    const status = statuses.shift() ?? 202;
    if (status === "network") throw new TypeError("fetch failed");
    return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent, events: () => sent.flatMap((request) => request.body.events) };
}

const options = { secretKey: "mira_sk_test_1", host: "https://ingest.example" };

describe("Mira (server)", () => {
  test("batches until flushAt, then sends with the secret key", async () => {
    const fake = fakeFetch();
    const mira = new Mira({ ...options, fetch: fake.fetch, flushAt: 3 });
    mira.track({ event: "a", userId: "u1" });
    mira.track({ event: "b", userId: "u1" });
    expect(fake.sent).toHaveLength(0);
    mira.track({ event: "c", userId: "u1" });
    await mira.flush();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.url).toBe("https://ingest.example/v1/batch");
    expect(fake.sent[0]?.headers.get("authorization")).toBe("Bearer mira_sk_test_1");
    expect(fake.events().map((event) => event.event)).toEqual(["a", "b", "c"]);
    await mira.shutdown();
  });

  test("shutdown flushes what is waiting and refuses new events", async () => {
    const fake = fakeFetch();
    const errors: MiraError[] = [];
    const mira = new Mira({
      ...options,
      fetch: fake.fetch,
      onError: (error) => errors.push(error),
    });
    mira.track({ event: "last_one" });
    await mira.shutdown();
    expect(fake.events()).toHaveLength(1);
    mira.track({ event: "too_late" });
    expect(errors[0]?.message).toContain("shut down");
  });

  test("await using flushes at the end of the scope", async () => {
    const fake = fakeFetch();
    {
      await using mira = new Mira({ ...options, fetch: fake.fetch });
      mira.track({ event: "scoped" });
    }
    expect(fake.events().map((event) => event.event)).toEqual(["scoped"]);
  });

  test("retries with the same event ids, then gives up after maxRetries", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const fake = fakeFetch([503, "network", 429]);
    const mira = new Mira({ ...options, fetch: fake.fetch });
    mira.track({ event: "retry_me" });
    await mira.flush();
    expect(fake.sent).toHaveLength(4);
    expect(new Set(fake.sent.map((request) => request.body.events[0]?.event_id)).size).toBe(1);

    const failing = fakeFetch([500, 500, 500]);
    const errors: MiraError[] = [];
    const strict = new Mira({
      ...options,
      fetch: failing.fetch,
      maxRetries: 2,
      onError: (error) => errors.push(error),
    });
    strict.track({ event: "lost" });
    await strict.flush();
    expect(failing.sent).toHaveLength(3);
    expect(errors[0]?.eventIds).toHaveLength(1);
  });

  test("numbers batches per client, and a retry keeps its number and its events", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const fake = fakeFetch([503, 400]);
    const mira = new Mira({ ...options, fetch: fake.fetch, flushAt: 2, onError: () => {} });
    for (const event of ["a", "b", "c", "d", "e"]) mira.track({ event });
    await mira.shutdown();
    expect(
      fake.sent.map((request) => ({
        seq: request.body.seq,
        events: request.body.events.map((event) => event.event),
      })),
    ).toEqual([
      { seq: 1, events: ["a", "b"] },
      { seq: 1, events: ["a", "b"] },
      // Dropped for good (400): the number stays used, so the ingest sees the gap.
      { seq: 2, events: ["c", "d"] },
      { seq: 3, events: ["e"] },
    ]);
    const streams = new Set(fake.sent.map((request) => request.body.stream));
    expect(streams.size).toBe(1);
    const [stream] = streams;
    expect(stream).toMatch(/^[0-9a-f-]{36}$/);

    const other = fakeFetch();
    const second = new Mira({ ...options, fetch: other.fetch });
    second.track({ event: "x" });
    await second.shutdown();
    expect(other.sent[0]?.body).toMatchObject({ seq: 1 });
    expect(other.sent[0]?.body.stream).not.toBe(stream);
  });

  test("a final 4xx is not retried", async () => {
    const fake = fakeFetch([401]);
    const errors: MiraError[] = [];
    const mira = new Mira({
      ...options,
      fetch: fake.fetch,
      onError: (error) => errors.push(error),
    });
    mira.track({ event: "bad_key" });
    await mira.flush();
    expect(fake.sent).toHaveLength(1);
    expect(errors[0]?.status).toBe(401);
  });

  test("revenue sends $revenue with minor units, upper-case currency and entry id", async () => {
    const fake = fakeFetch();
    const mira = new Mira({ ...options, fetch: fake.fetch });
    const eventId = await eventIdFor("order:42:paid");
    mira.revenue({
      userId: "u1",
      amount: 1999,
      currency: "eur",
      entryId: "stripe:in_123",
      eventId,
      timestamp: "2026-01-15T10:00:00Z",
      properties: { plan: "pro" },
    });
    await mira.shutdown();
    const [event] = fake.events();
    expect(event).toMatchObject({
      event_id: eventId,
      type: "track",
      event: "$revenue",
      user_id: "u1",
      timestamp: "2026-01-15T10:00:00.000Z",
      revenue: { amount: 1999, currency: "EUR", entry_id: "stripe:in_123" },
      properties: { plan: "pro" },
      consent: "not_applicable",
    });
    // The payload passes the ingest's own schema.
    expect(validateEvent(event)).toEqual([]);
  });

  test("touchpoint sends $touchpoint with its fields as properties, in the wire schema", async () => {
    const fake = fakeFetch();
    const errors: MiraError[] = [];
    const mira = new Mira({
      ...options,
      fetch: fake.fetch,
      onError: (error) => errors.push(error),
    });
    const eventId = await eventIdFor("survey:r_77");
    mira.touchpoint({
      kind: "survey",
      userId: "u1",
      source: "podcast",
      answer: "The Elternzeit podcast",
      eventId,
      properties: { question: "how_did_you_hear" },
    });
    mira.touchpoint({ kind: "code", userId: "u1", channel: "affiliate", code: "ANNA10", adId: "" });
    // Refused before sending: no channel or source, no person, an unknown kind.
    mira.touchpoint({ kind: "offline", userId: "u1" });
    mira.touchpoint({ kind: "offline", source: "trade_fair" });
    // @ts-expect-error: an unknown kind, as plain JavaScript may send it
    mira.touchpoint({ kind: "billboard", userId: "u1", source: "x" });
    await mira.shutdown();
    expect(errors.map((error) => error.message)).toEqual([
      "MIRA FIVE: touchpoint: a channel or a source is required",
      "MIRA FIVE: touchpoint: a userId or an anonymousId is required",
      "MIRA FIVE: touchpoint: kind must be one of survey, offline, code, custom",
    ]);
    const [survey, code] = fake.events();
    expect(survey).toMatchObject({
      event_id: eventId,
      type: "track",
      event: "$touchpoint",
      user_id: "u1",
      properties: {
        kind: "survey",
        source: "podcast",
        answer: "The Elternzeit podcast",
        question: "how_did_you_hear",
      },
    });
    expect(code?.properties).toEqual({ kind: "code", channel: "affiliate", code: "ANNA10" });
    expect(validateEvent(survey)).toEqual([]);
    expect(validateEvent(code)).toEqual([]);
  });

  test("revenue sends subscription payments and refunds in the wire format", async () => {
    const fake = fakeFetch();
    const mira = new Mira({ ...options, fetch: fake.fetch });
    mira.revenue({
      userId: "u1",
      amount: 999,
      currency: "EUR",
      entryId: "revenuecat:txn_1",
      fee: 150,
      tax: 160,
      product: "premium_monthly",
      subscription: { id: "sub_1", intervalCount: 1, periodStart: "2026-11-01T10:00:00Z" },
    });
    mira.revenue({
      userId: "u1",
      amount: -999,
      currency: "EUR",
      entryKind: "refund",
      entryId: "revenuecat:txn_1:refund",
      refundOf: "revenuecat:txn_1",
    });
    await mira.shutdown();
    const [payment, refund] = fake.events();
    expect(payment?.revenue).toEqual({
      amount: 999,
      currency: "EUR",
      entry_id: "revenuecat:txn_1",
      fee: 150,
      tax: 160,
      product: "premium_monthly",
      subscription: { id: "sub_1", interval_count: 1, period_start: "2026-11-01T10:00:00.000Z" },
    });
    expect(refund?.revenue).toMatchObject({ kind: "refund", refund_of: "revenuecat:txn_1" });
    for (const event of [payment, refund]) expect(validateEvent(event)).toEqual([]);
  });

  test("invalid input goes to onError, never throws", () => {
    const errors: MiraError[] = [];
    const mira = new Mira({
      ...options,
      fetch: fakeFetch().fetch,
      onError: (error) => errors.push(error),
    });
    expect(() => mira.revenue({ amount: 19.99, currency: "EUR" })).not.toThrow();
    expect(() => mira.track({ event: "$pageview" })).not.toThrow();
    expect(() => mira.track({ event: "x", timestamp: "not a date" })).not.toThrow();
    expect(() => mira.track({ event: "x", eventId: "nope" })).not.toThrow();
    expect(() => mira.identify({ userId: "" })).not.toThrow();
    expect(() => mira.revenue({ amount: 100, currency: "EUR", fee: 1.5 })).not.toThrow();
    expect(() =>
      mira.revenue({ amount: 100, currency: "EUR", subscription: { id: "" } }),
    ).not.toThrow();
    expect(errors).toHaveLength(7);
  });

  test("identify and track pass the wire schema, with context and consent", async () => {
    const fake = fakeFetch();
    const mira = new Mira({ ...options, fetch: fake.fetch });
    mira.identify({
      userId: "u1",
      anonymousId: "a1",
      traits: { email: "a@example.com", plan: { name: "pro" } },
    });
    mira.track({
      event: "signed_up",
      userId: "u1",
      consent: { analytics: true, marketing: false },
      context: {
        ip: "203.0.113.9",
        userAgent: "Mozilla/5.0",
        page: { url: "https://app.example/signup" },
      },
    });
    await mira.shutdown();
    const [identify, track] = fake.events();
    expect(identify?.traits).toEqual({ email: "a@example.com", "plan.name": "pro" });
    expect(track?.context).toMatchObject({ ip: "203.0.113.9", user_agent: "Mozilla/5.0" });
    expect(track?.consent).toEqual({ analytics: "granted", marketing: "denied" });
    for (const event of fake.events()) expect(validateEvent(event)).toEqual([]);
  });

  test("group sends $group with the group id and traits", async () => {
    const fake = fakeFetch();
    const mira = new Mira({ ...options, fetch: fake.fetch });
    mira.group({ groupId: "acme", userId: "u1", traits: { name: "Acme GmbH", seats: 12 } });
    await mira.shutdown();
    const [event] = fake.events();
    expect(event).toMatchObject({
      type: "group",
      event: "$group",
      group_id: "acme",
      user_id: "u1",
      traits: { name: "Acme GmbH", seats: 12 },
    });
    expect(validateEvent(event)).toEqual([]);
  });

  test("group without a groupId goes to onError", () => {
    const errors: MiraError[] = [];
    const mira = new Mira({
      ...options,
      fetch: fakeFetch().fetch,
      onError: (error) => errors.push(error),
    });
    mira.group({ groupId: "" });
    expect(errors[0]?.message).toContain("groupId");
  });

  test("identify sends external ids and drops empty, unknown and overlong ones", async () => {
    const fake = fakeFetch();
    const mira = new Mira({ ...options, fetch: fake.fetch });
    mira.identify({
      userId: "u1",
      externalIds: {
        stripe_customer: "cus_123",
        revenuecat_app_user: "",
        shopify_customer: "x".repeat(201),
        // Not a known type: a caller without TypeScript could pass anything.
        ...({ hubspot_contact: "1" } as Record<string, string>),
      },
    });
    mira.identify({ userId: "u2", externalIds: { shopware_customer: "  " } });
    await mira.shutdown();
    const [first, second] = fake.events();
    expect(first?.external_ids).toEqual({ stripe_customer: "cus_123" });
    expect(second?.external_ids).toBeUndefined();
    for (const event of fake.events()) expect(validateEvent(event)).toEqual([]);
  });

  test("context passes app, locale, time zone and location through", async () => {
    const fake = fakeFetch();
    const errors: MiraError[] = [];
    const mira = new Mira({
      ...options,
      fetch: fake.fetch,
      onError: (error) => errors.push(error),
    });
    const context = {
      app: { name: "Diese Automaten", version: "2.4.0", build: "412" },
      locale: "de-DE",
      timezone: "Europe/Berlin",
      location: { latitude: 52.520_008, longitude: 13.404_954 },
    };
    mira.track({ event: "nearby_searched", consent: { analytics: true }, context });
    mira.track({ event: "bad_location", context: { location: { latitude: 91, longitude: 0 } } });
    await mira.shutdown();
    const [good, bad] = fake.events();
    expect(good?.context).toMatchObject(context);
    // A bad location is dropped and reported; the event itself still goes out.
    expect(bad?.event).toBe("bad_location");
    expect(bad?.context.location).toBeUndefined();
    expect(errors[0]?.message).toContain("location");
    for (const event of fake.events()) expect(validateEvent(event)).toEqual([]);
  });

  test("eventIdFor is stable and a valid UUID", async () => {
    const first = await eventIdFor("order:1");
    expect(first).toBe(await eventIdFor("order:1"));
    expect(first).not.toBe(await eventIdFor("order:2"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
