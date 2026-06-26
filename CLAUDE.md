# CLAUDE.md — Critical implementation rules

**Ez a fájl minden Claude Code session-nek kötelező olvasmány a projekt elején.** A spec a következő szabályokra épít, és bármelyik megszegése **csendes hibát** okoz Painless ROAS-on, Meta EMQ score-on, vagy Google Ads Enhanced Conversions match rate-en.

## 1. Hash specifikáció

### Mezők, amiket SHA-256-tal hash-elünk (lowercase hex output)

| Mező | Normalizáció |
|---|---|
| `email` | lowercase, trim. NE strip plus-suffix. NE strip Gmail dot. |
| `phone_number` | E.164 formátum (`+447123456789`). Normalize_phone helper. |
| `first_name` | lowercase, trim |
| `last_name` | lowercase, trim |
| `city` | lowercase, trim. NE strip ékezetet (`Pécs` marad `pécs`). |
| `postal_code` | uppercase, ALL whitespace stripped (`SW1A 1AA` → `SW1A1AA`) |
| `country` | 2-betűs ISO 3166-1 alpha-2 lowercase (`gb`, `hu`, `de`) |

### Mezők, amiket NEM hash-elünk (pass-through plain)

- `fbp` (Meta browser ID, `fb.1.<ts>.<rand>` formátum)
- `fbc` (Meta click ID)
- `client_id` (GA4 _ga cookie-ból `1234567890.0987654321`)
- `event_id` (UUID, max 40 chars)
- `client_ip_address` (request `CF-Connecting-IP` header-ből)
- `client_user_agent` (request `User-Agent` header-ből)

**Ha véletlenül hash-eled ezeket → Meta dedup teljesen elromlik.**

### Email-specifikus szabályok

- Lowercase: `Jane@Email.com` → `jane@email.com`
- Trim leading/trailing whitespace
- **NE** strip plus-suffix (`john+spam@gmail.com` MARAD `john+spam@gmail.com`)
- **NE** strip Gmail dot (`john.smith@gmail.com` MARAD `john.smith@gmail.com`)
- Indok: Meta a literal stringet hash-eli — ha okoskodunk a saját normalizációval, nem fog egyezni a Meta belső rekordjával

### Phone E.164 formátum

- Strip ALL whitespace, dashes, parentheses, dots: `+44 (0)7123-456.789` → `+447123456789`
- Ha már `+`-szal kezdődik: kész
- UK detektálás: `0`-val kezdődik (national format) → `+44` + remaining
- UK detektálás: `44`-gyel kezdődik (no `+`) → `+44` + remaining
- HU detektálás: `06`-tal kezdődik → `+36` + remaining
- HU detektálás: `36`-tal kezdődik (no `+`) → `+36` + remaining
- Default: ha countryCode='GB' és nincs felismerhető prefix → prepend `+44`
- Default: ha countryCode='HU' → prepend `+36`

### Postal code

- Uppercase: `sw1a 1aa` → `SW1A 1AA`
- Strip ALL whitespace: `SW1A 1AA` → `SW1A1AA`
- Ne strip kötőjelet (US ZIP+4 format `12345-6789` marad)

### Country

- 2-letter ISO 3166-1 alpha-2
- Lowercase: `GB` → `gb`, `HU` → `hu`
- Convert common 3-letter to 2-letter: `GBR` → `gb`, `HUN` → `hu`, `USA` → `us`
- Convert names: `United Kingdom` → `gb`, `Hungary` → `hu`

### SHA-256 output

- Hex string, lowercase
- 64 karakter hosszú
- Web Crypto API: `crypto.subtle.digest('SHA-256', ...)`

## 2. Meta CAPI request structure

- `event_name`: matches Meta standard (Lead, Contact, Purchase, ViewContent) vagy custom event name. Internal name → Meta standard mapping.
- `event_id`: plain UUID, max 40 chars, NEM hashed.
- `event_time`: Unix timestamp **SECONDS-ban** (NEM milliseconds).
- `action_source`: `"website"`.
- `event_source_url`: page URL ahol az event történt.
- `user_data`: hashed object `em`, `ph`, `fn`, `ln`, `ct`, `zp`, `country` mezőkkel.
- `user_data.fbp` és `user_data.fbc`: PLAIN, nem hashed.
- `user_data.client_ip_address`: request header-ből, NEM hashed.
- `user_data.client_user_agent`: request header-ből, NEM hashed.

## 3. Meta Custom Data

- `value`: number, vagy hagyd ki teljesen ha nincs érték.
- `currency`: 3-letter ISO (GBP, HUF, EUR), kötelező ha `value` jelen van.

**Ha véletlenül `value: 0`-t küldenél: ne. Hagyd ki a mezőt teljesen.** Meta a 0-t valós értékként logolja, ami torzítja a ROAS-számítást.

## 4. Google Ads Customer ID format

- 10 digit, NEM dashes (UI shows `123-456-7890`, API needs `1234567890`).
- Ha manager account alatt: `login-customer-id` HEADER (nem body).

## 5. Google Ads OAuth2 token caching

- Cache `access_token` KV-ben TTL=55 perc (token valójában 60 perc múlva jár le, biztonsági margin).
- Cache miss/expired esetén: refresh, store new token.
- Atomic-style refresh: check KV, refresh CSAK ha missing/expired, write back. Multiple Worker instances may race; ez elfogadható — duplikált refresh nem destruktív.

## 6. Google Ads `conversionDateTime` formátum

- Pontosan: `"YYYY-MM-DD HH:MM:SS+00:00"`
- **NEM** ISO 8601 `T` separator (`2026-04-29T10:30:00Z` → hibás)
- **NEM** millisec
- Példa: `2026-04-29 10:30:00+00:00`

## 7. Google Ads `addressInfo` mezők

- `hashedFirstName`, `hashedLastName`: **hashed**
- `city`, `state`, `postalCode`, `countryCode`: **PLAIN** (nem hashed)

Ez ellentétes Meta-val, ahol a city és postcode is hashelt. Mindegy ugyanaz a normalize, **csak a hash lépés különbözik** platform-onként.

## 8. GA4 Measurement Protocol

- Endpoint: `https://www.google-analytics.com/mp/collect`
- Query params: `?measurement_id=G-XXX&api_secret=YYY`
- Debug: `https://www.google-analytics.com/debug/mp/collect`
- `client_id` REQUIRED. Olvas `_ga` cookie-ból (`GA1.1.1234567890.0987654321` → `1234567890.0987654321`).
- `events[].name`: snake_case, matches our event names.
- `engagement_time_msec`: 100 (minimum, hogy session engagement-be számoljon).

## 9. PII tilos GA4-ben

Email, telefon, név **soha nem mehet** GA4 Measurement Protocol-ra. Ez a Meta CAPI-tól eltérő rule. GA4 csak event metadata-t kap (event_name, value, currency, source, service).

## 10. Turnstile validation

- Validate **MINDEN** API call **ELŐTT**.
- Invalid token: return 403, no fan-out.
- Validation API maga error-ol (non-OK válasz vagy network throw): **fail-CLOSED** az alapértelmezett — log + `valid:false`, az event nem megy ki. Ez szándékos biztonsági döntés (egy spoofolható siteverify-kimaradás ne nyisson kaput a botoknak). A `conversion` route alacsony kockázatú tel/mailto eventeknél degraded-accept-tel kompenzál (lásd `degraded.ts`).
  - **Escape hatch:** `TURNSTILE_FAILOPEN=1` env-flag-gel kapcsolható fail-OPEN (allow-through API-hibánál), ha egy Turnstile-incidens alatt a legitim forgalom átengedése fontosabb. Production default: **kikapcsolva** (fail-closed).
  - **Megjegyzés:** ez a bekezdés korábban fail-open-t írt; a kód (`turnstile.ts` + `tests/turnstile.test.ts`) szándékosan fail-closed-ra váltott egy security-fix során — a doc most ehhez igazodik.

## 11. Failed API calls → R2 dead-letter

- Use `Promise.allSettled`, **NEVER** `Promise.all`.
- Each rejected promise → write event payload R2-be timestamp prefix-szel.
- Cron Trigger óránként retry DLQ events-eket.

## 12. Response: always 204 No Content

- sendBeacon ignores response body anyway.
- Don't expose internal errors to client.
- Internal errors → Cloudflare Workers logs.

## 13. Logging

- Use `console.log` structured JSON-nel (Cloudflare picks up automatically).
- **NEVER** log user_data, even after hashing.
- Log: `site_id`, `event_name`, success/failure per platform, latency.

## 14. Multi-tenant routing

- Hostname-based site detection: `new URL(request.url).hostname`.
- Look up site config via KV (`SITE_CONFIG.get(hostname)`).
- Ha nincs config: 404. NEVER use a fallback config.

## 15. PII NEM mehet a kliensoldali dataLayer-be

A `user_data` (email, telefon, név, cím) kizárólag a `sendToWorker()` POST body-jában megy. A kliensoldali GTM `dataLayer.push` **soha** nem tartalmaz PII-t.

Ha bárhol látsz `dataLayer.push({user_data: {...}})` mintát, az **biztonsági hiba** — az F12-es bámészkodó látja, és GDPR Article 32 violation kockázatot jelent.

## 16. Az `event_id` shared mind a 3 platformon

Egy konverziós event-nek **egy** `event_id`-je van. Meta CAPI dedup-ol vele a kliens Pixel-lel. GA4 a `event_id` paramétert metadata-ként kapja (NEM dedup-ol). Google Ads a `orderId` mezőbe kapja meg.

**Ha 3 különböző event_id-t generálsz**: Meta dedup elromlik, és a duplikált Lead-ek ROAS torzulást okoznak.

## 17. Sprint-független szabály: `Test event code` kötelező KIVÉTEL Sprint 4-9 között

A Sprint 4 (Meta CAPI) kezdetben `test_event_code: "TEST_<SITE>"`-tel indul, hogy a Test Events-ben látható legyen.

**Sprint 9 előtt KÖTELEZŐ kivenni** a `test_event_code`-ot a KV configból. Ha bent marad, **minden valós konverzió Test stream-be megy**, NEM a fő stream-be — nem fognak megjelenni a Meta Ads Manager riportokban. Csendes hiba.

## 18. Ne ugorj sprint-eket

Minden sprint épít a megelőzőre. A Sprint 8 nem fog működni Sprint 1-7 nélkül. Ha el akarsz ugrani sprint-et, **kérdezd meg** előbb, hogy az milyen következménnyel jár.

## 19. Painless production-deploy KIZÁRÓLAG Sprint 9-ben

A Sprint 1-8 alatt a Worker production-on **deploy-olható**, de **csak a saját curl-tesztjeid hívják**. Painless front-end **nem** küld Worker-nek semmit Sprint 9 előtt. Ha véletlenül elindítanál egy production roll-out-ot Sprint 9 előtt, **azonnal állítsd le** és vond vissza.

## 20. Stage-by-stage validation

Minden sprint végén:
1. Code lefut, deploy-olódik
2. Manuális tesztelés (curl, GTM Preview, Meta Test Events, GA4 DebugView)
3. Cloudflare Workers logs **24 órán át** tisztaak
4. Csak akkor lépsz a következő sprint-re

Ne építs új réteget hibás alapra.
