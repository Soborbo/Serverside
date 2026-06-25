# 2026-06 Upgrade — API frissítés, Consent Mode v2, EMQ, Cloudflare modernizáció

Ez a kör a 4 platform legfrissebb doksijának áttekintése (Meta, Google Ads, GA4,
Cloudflare) alapján készült. Összefoglaló: **egyetlen API-verzió sem járt le** —
a stack a jelenlegi verziókon van. A valódi nyereség compliance + adatminőség +
Cloudflare-modernizáció.

## 1. API verziók — már a legfrissebbek (nincs törő változás)

| Platform | Verzió | Státusz |
|---|---|---|
| Meta Graph API | `v25.0` | 2026-02-18 óta a legújabb. v26 ~ősszel. **Nincs teendő.** |
| Google Ads API | `v24` (REST path) | v24 a legfrissebb major (v24.2 a legújabb minor; a `/v24/` út közös). Sunset ~2027 közepe. **Nincs teendő.** |
| GA4 Measurement Protocol | verziózatlan | Nem deprecated. **Nincs teendő.** |

A verziókonstansok kommentálva (`lib/meta.ts`, `lib/gads.ts`), hogy a következő
bump egyértelmű legyen.

## 2. Tartalmi javítások (adatminőség + compliance)

- **Consent Mode v2 end-to-end** (`lib/consent.ts`): a kliens `consent`
  objektumot küld (`ad_user_data`, `ad_personalization`, `ad_storage`,
  `analytics_storage`).
  - **EU/GDPR gating**: ha `ad_user_data === 'DENIED'` (vagy a `SiteConfig`
    `require_consent: true` és nincs consent) → **Meta CAPI + Google Ads
    konverzió NEM megy** (no-op, nincs DLQ). GA4 mindig megy, consent-jelekkel.
  - **Meta**: US-traffic `data_processing_options: ['LDU']` (CCPA).
  - **Google Ads**: `consent { adUserData, adPersonalization }` a ClickConversion-ön
    (EEA-attribúcióhoz).
  - **GA4**: top-level `consent` objektum (cookieless modellezés DENIED esetén).
  - A 60 perces késleltetett quote-konverzió a consent-döntést a Durable
    Object állapotában tárolja, és tüzeléskor érvényesíti.
- **Meta EMQ**: hashelt `external_id` (user/CRM/cookie id) → magasabb match quality.
  (A `client_ip_address` + `client_user_agent` már korábban megvolt.)
- **GA4 `session_id`**: a `_ga_<stream>` cookie-ból; nélküle az MP-event nem
  jelenik meg rendesen a riportokban. (`engagement_time_msec` már megvolt.)

`require_consent` opcionális `SiteConfig` mező — EEA-site-okon ajánlott `true`.
Default (hiányzó/false) = backward-compatible.

## 3. Cloudflare platform-modernizáció

| # | Mit | Megjegyzés |
|---|---|---|
| H1 | **Queues alapú DLQ** + consumer (`worker.ts queue()`), natív retry + backoff | **Guarded**: ha nincs `DLQ` binding, R2-fallbackre + óránkénti cronra esik vissza. A kimerült retry R2 'dead' archívumba megy (SLO-check/digest látja). |
| H2 | **Natív Rate Limiting** binding (`INGEST_LIMITER`), 100/60s, IP+hostname kulcs | **Guarded**: binding nélkül kimarad. 429-et ad túllépéskor. |
| H3 | Fan-out `ctx.waitUntil`-ban, 204 azonnal | **Már megvolt** — változatlan. |
| M1 | DO `alarm()` vs. késleltetett queue-üzenet | **DO megtartva** — valódi, fejlődő állapotot tárol (quote→upgrade→view_content), nem csak időzítő. |
| M2 | KV config-olvasás `cacheTtl: 300` | Csökkenti a KV-olvasást a forró úton. |
| L1 | Workers Logs observability | **Már be volt kapcsolva** (`head_sampling_rate = 1.0`). |
| L2 | `compatibility_date` → `2026-06-25` | — |
| M3 | Secret-ek dokumentálva a wrangler.toml-ban | A GAds OAuth tokenek szándékosan KV-ben maradnak (dinamikusan frissülnek), NEM Secrets Store-ban. |

## 4. Élesítési lépések (a guardolt featúrák bekapcsolása)

```bash
# H1 — Queues
wrangler queues create event-gateway-dlq
wrangler queues create event-gateway-dlq-dead
# majd wrangler.toml: vedd ki a kommentből a [[queues.producers]] +
# [[queues.consumers]] blokkot → wrangler deploy

# H2 — Rate limiting
# wrangler.toml: vedd ki a kommentből a [[ratelimits]] blokkot → wrangler deploy
```

A featúrák **fokozatosan, biztonságosan** kapcsolhatók: amíg a bindingek nincsenek
bekötve, a kód a régi (R2 + cron / csak-Turnstile) úton megy. Semmi sem törik el
a deploy pillanatában.

## 5. Kliens-oldal (client-lib)

- `consent` küldése: a site beállítja a `window.__trackingConsent`-et a CMP-jéből,
  vagy átadja a `trackConversion(..., { consent })`-ben.
- `external_id`: `user_data.external_id` — add ugyanezt a böngésző Pixelnek is.
- `session_id`: automatikusan a `_ga_<stream>` cookie-ból.

## Tesztek

140 teszt zöld (124 eredeti + 16 új: consent parse/resolve, external_id hash,
Meta LDU/external_id, GA4 session_id/consent, Google Ads consent). Typecheck tiszta.
