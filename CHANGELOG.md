# Changelog

## 2.1.1 — 2026-11-08

### Removed

- `dealStage` and `dealLost` from 2.1.0. A project's pipeline maps its own events to stages on
  the MIRA FIVE server (Settings → Pipeline): send the events your system already has. 2.1.0 is
  deprecated; nothing else changed.

## 2.1.0 — 2026-11-08 (deprecated)

- Added `dealStage` and `dealLost`; removed again in 2.1.1.

## 2.0.0 — 2026-11-08

A rewrite for the current MIRA FIVE platform: consent tiers, the revenue ledger, touchpoints and
the `/v1/batch` wire format.

### Added

- `revenue()` with subscriptions, refunds, fees and tax; `touchpoint()`; `identify`
  external ids (Stripe, RevenueCat, Shopify, Shopware); `eventIdFor`; batch sequence numbers;
  reads `MIRAFIVE_SECRET_KEY`; refuses public keys; `MiraError.code`; `enabled: false`; typed
  event maps; `await using`.

### Migrating from 1.x

- **Keys:** projects have a public key (`mira_pk_…`, browser and apps) and a secret key
  (`mira_sk_…`, servers). `mf_…` website and secret keys are gone. Every SDK refuses the wrong
  kind of key with a clear message.
- **Host:** `https://events.mirafive.io` (was `collect.mirafive.io`).
- **Environment:** `MIRAFIVE_SECRET_KEY` and `MIRAFIVE_HOST` on servers; the public key as
  `NEXT_PUBLIC_MIRAFIVE_KEY`, `VITE_MIRAFIVE_KEY`, `PUBLIC_MIRAFIVE_KEY` (Astro),
  `NUXT_PUBLIC_MIRAFIVE_KEY` or `MIRAFIVE_PUBLIC_KEY` (PHP templates).
- **Consent:** there are no modes any more. The browser SDK follows the site's consent banner
  (`consent: "auto"`) and collects what each tier allows: cookieless without consent, an
  anonymous id with analytics consent, a user with `identify`. Server events carry the consent
  they were collected under (default `not_applicable`).
- **Revenue:** `revenue()` on the server SDKs, in integer minor units with an ISO currency,
  `entryId` (replaces `payment_id`), `entryKind`, fees, tax, refunds and subscriptions. Revenue
  properties on plain events are no longer read.
