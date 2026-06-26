# Click-ID forwarders (TASK 3)

The gateway captures `msclkid` / `ttclid` / `li_fat_id` / `twclid` in the client's
`attribution` map. This adds **per-platform forwarders** wired into the fan-out
alongside Meta / GA4 / Google Ads — consent-gated, with the same Queues + DLQ
durability and per-site config pattern.

| Platform | Click ID | Module | API | Status |
|---|---|---|---|---|
| TikTok | `ttclid` | `lib/tiktok.ts` | Events API 2.0 (`/event/track/`) | **Implemented** (live call marked `TODO(live)` — unverified, no sandbox creds) |
| LinkedIn | `li_fat_id` | `lib/linkedin.ts` | Conversions API (`/rest/conversionEvents`) | **Implemented** (live call `TODO(live)`) |
| Microsoft Ads | `msclkid` | `lib/msads.ts` | Offline conversions (Bing Ads `ApplyOfflineConversions`) | **Scaffold only** — record built, live SOAP+OAuth transport is `TODO` (not faked) |

> `twclid` (X/Twitter) is captured by the client but **no forwarder was requested**
> in TASK 3, so it is not forwarded. Easy to add on the same pattern if needed.

## Behavior

- **Consent-gated:** each forwarder is only called when `adAllowed` (Consent Mode v2
  `ad_user_data` not denied), exactly like Meta and Google Ads. GA4 is unaffected.
- **No-op when unconfigured:** a forwarder whose per-site config block is absent (or
  whose click ID is missing) returns `{ success: true, skipped: true }` and makes **no
  network call**. In the ledger these are recorded as `skipped`, so reconciliation
  coverage is not skewed by platforms a site doesn't use.
- **PII:** TikTok and LinkedIn match on the already-SHA-256-hashed `em`/`ph` from
  `HashedUserData` (no raw PII). Microsoft matches on `msclkid` only.
- **Durability:** failures flow to the existing Queues + R2 DLQ and are retried by
  `retrySingle` (extended to handle the three new platforms).
- **Observability:** new error codes `TRK-810-*` (msads), `TRK-820-*` (tiktok),
  `TRK-830-*` (linkedin); fan-out metric + structured success flags per platform.

## Per-site config

Optional blocks in the `SITE_CONFIG` KV JSON (see `scripts/painless-config.template.json`):

```jsonc
"tiktok":   { "pixel_code": "...", "access_token": "...", "event_names": { /* optional override */ } },
"linkedin": { "access_token": "...", "conversion_rules": { "contact_form_submit": "urn:lla:llaPartnerConversion:123" }, "api_version": "202401" },
"microsoft_ads": { "customer_id": "...", "conversion_names": { "phone_conversion": "Phone Lead" } }
```

## Live-call TODOs (before enabling per platform)

- **TikTok / LinkedIn:** the request construction follows the documented APIs but is
  **untested against the live endpoint** (no credentials in this environment). Verify
  in the TikTok Events Manager *Test Events* / LinkedIn Campaign Manager before relying
  on the data. The `TODO(live)` comment marks the exact fetch.
- **Microsoft Ads:** the live transport is **not implemented** — Bing Ads offline
  conversion upload is SOAP + OAuth (developer token + refresh token), not a simple
  REST/JSON endpoint. `lib/msads.ts` builds the canonical `OfflineConversion` record
  and is fully wired into the fan-out, but `sendToMsAds` returns `scaffolded: true`
  without sending. Implement the transport per the file-header `TODO(live)`.
