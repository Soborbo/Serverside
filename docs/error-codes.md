# Tracking Worker error codes — runbook

Format: `TRK-{category}-{number}`. Severity: `critical` (admin alert), `warning` (log only), `info` (debug).

A teljes enum forrás: `src/lib/error-codes.ts`.

---

## TRK-000-001 — Unhandled exception

**Severity**: Critical
**Description**: Top-level fetch handler throw-olt egy nem várt error-t.
**Action**:
1. Cloudflare Workers Logs → keresd a stack trace-t
2. Reproduce manuálisan a request payload-dal
3. Add error handling a megfelelő helyen (try/catch + DLQ)

## TRK-000-002 — KV read failed

**Severity**: Warning
**Description**: A `env.SITE_CONFIG.get()` vagy `env.OAUTH_TOKENS.get()` exception-t dobott.
**Action**:
1. Cloudflare status: https://www.cloudflarestatus.com
2. KV namespace ID stimmel a `wrangler.toml`-ban?
3. Csak átmeneti CF-issue → automatikusan helyreáll

## TRK-000-003 — KV write failed

**Severity**: Warning
**Action**: Ugyanaz mint TRK-000-002.

## TRK-000-004 / 005 — R2 read/write failed

**Severity**: Warning
**Action**:
1. R2 bucket létezik? `wrangler r2 bucket list`
2. Binding `DEAD_LETTER` stimmel?

## TRK-000-006 — Durable Object failed

**Severity**: Warning
**Action**: Sprint 6.5 specifikus, akkor kerül kifejtésre.

## TRK-400-001 — Invalid JSON

**Severity**: Info
**Description**: A request body nem érvényes JSON.
**Action**: Általában bot-ot vagy elromlott klienst jelez. Loggolni elég.

## TRK-400-002 — Invalid payload structure

**Severity**: Info
**Action**: Astro front-end build-je hibásan POST-ol? `event_name`, `event_id`, `event_time`, `turnstile_token` mind required.

## TRK-400-003 — Missing Turnstile token

**Severity**: Info
**Action**: Front-end nem várta meg a Turnstile widget completion-t. GTM event sequence ellenőrzendő.

## TRK-400-004 — Invalid Turnstile token

**Severity**: Info
**Description**: A Turnstile API rejected a token-t (timeout, replay, hostname mismatch).
**Action**: Általában legitim — token expired vagy bot-ot fogott el.

## TRK-400-005 — Turnstile API unavailable

**Severity**: Info
**Description**: A `challenges.cloudflare.com/turnstile/v0/siteverify` endpoint-tól nem-2xx vagy network error jött.
**Action**: Graceful degradation aktiválódik (request átmegy). Cloudflare status-t check.

## TRK-500-001 — No site config

**Severity**: Warning
**Description**: A request hostname-jéhez nincs KV-bejegyzés.
**Action**:
1. `wrangler kv:key list --binding=SITE_CONFIG`
2. Új site rollout? Add hozzá a `wrangler kv:key put` paranccsal a config-ot.
3. Tipikusan multi-tenant rollout előtt jelentkezik.

## TRK-500-002 / 003 — Missing Pixel ID / Meta token

**Severity**: Warning
**Action**: Site config KV-ben placeholder maradt. Töltsd ki valós Meta Events Manager értékkel.

## TRK-500-004 / 005 / 006 — Missing GA4 / GAds config / conversion action

**Severity**: Warning
**Action**: Ugyanaz a logika — placeholder marad a KV config-ban.

## TRK-500-007 — Invalid site config JSON

**Severity**: Warning
**Action**:
1. `wrangler kv:key get --binding=SITE_CONFIG <hostname>`
2. Validate the JSON (`echo '{...}' | jq .`)
3. Re-upload a fixed JSON-t

## TRK-600-001 — Meta API rejected

**Severity**: Warning
**Description**: Graph API non-200-zal válaszolt.
**Action**:
1. Meta Events Manager → Diagnostics
2. Check error message-et a log-okban
3. Specifikusabb error code-ra váltás (token revoke → 600-004; rate limit → 600-006)

## TRK-600-002 / 003 — Meta API timeout / network error

**Severity**: Warning
**Action**: Esemény → DLQ, óránkénti cron retry-olja.

## TRK-600-004 — Meta invalid access token

**Severity**: Critical
**Description**: Token revoked vagy expired.
**Action**:
1. Meta Business Manager → Painless Pixel → Settings → Conversions API
2. Ha "Access token revoked": regenerate System User token
3. Update KV: `wrangler kv:key put --binding=SITE_CONFIG ...`
4. DLQ records sikerülnek a következő cron run-on
**Common causes**: System User permissions changed, MFA reset, password changed

## TRK-600-005 — Meta pixel not found

**Severity**: Warning
**Action**: `pixel_id` rossz a config-ban, vagy a System User-nek nincs hozzáférése. Meta Events Manager-ban check.

## TRK-600-006 — Meta rate limited

**Severity**: Warning
**Action**: DLQ → cron retry-olja exponential backoff-fal.

## TRK-600-007 — Meta invalid user_data

**Severity**: Warning
**Description**: Meta visszadobta a hash-elt user_data-t (rossz normalizáció).
**Action**:
1. **NE** próbálkozz a payload nélkül logolni — PII!
2. Ellenőrizd: `src/lib/hash.ts` deviáció a CLAUDE.md-től?
3. Re-deploy fix után — DLQ records sikerülni fognak.

## TRK-600-008 — Meta events_received: 0

**Severity**: Warning
**Description**: 200 OK jött vissza, de Meta szerint 0 esemény fogadva.
**Action**: Általában test_event_code hibás — Sprint 9 előtt KÖTELEZŐ kivenni a `test_event_code`-ot a KV configból.

## TRK-700-001 / 002 — GA4 API timeout / network error

**Severity**: Warning
**Action**: DLQ → cron retry.

## TRK-700-003 — GA4 validation failure

**Severity**: Warning
**Description**: Debug endpoint validation messages-t küldött.
**Action**: Replay a payload-ot a `/debug/mp/collect`-en. Fix the event schema.

## TRK-700-004 / 005 — GA4 invalid measurement_id / api_secret

**Severity**: Warning
**Action**: GA4 Admin → Data Streams → re-generate API secret. Update KV.

## TRK-800-001 — GAds no access token

**Severity**: Warning
**Action**: Refresh OAuth flow vagy retry.

## TRK-800-002 / 003 — GAds API timeout / network error

**Severity**: Warning
**Action**: DLQ.

## TRK-800-004 — GAds partial failure

**Severity**: Warning
**Description**: A response `partialFailureError`-t tartalmaz — egy konverzió mehet, másik elbukott.
**Action**: A failed conversion-okat retry-old; a successful-eket NE.

## TRK-800-005 — GAds auth rejected (401)

**Severity**: Critical
**Action**:
1. Test: `curl '/api/event/oauth-debug?customer_id=...'`
2. Refresh token revoked? Run OAuth flow again
3. New refresh token KV-be

## TRK-800-006 — GAds OAuth refresh failed

**Severity**: Critical
**Description**: OAuth refresh token exchange failed.
**Action**:
1. Test: `curl '/api/event/oauth-debug?customer_id=...'`
2. Ha `access_token_received: false`: refresh token revoked
3. Run OAuth flow again from browser
4. New refresh token saved to KV
5. DLQ records succeed on next cron run
**Common causes**: Customer revoked access, password changed, account closed

## TRK-800-007 — GAds developer token invalid

**Severity**: Critical
**Action**: Google Ads → Tools → API Center → ellenőrizd a token státuszát. Re-issue szükséges lehet.

## TRK-800-008 — GAds invalid conversion action

**Severity**: Warning
**Action**: Conversion action ID nincs Google Ads-ban. Update KV `gads.conversion_actions` mapping.

## TRK-800-009 — GAds no refresh token

**Severity**: Critical
**Action**: KV-ben nincs refresh_token a customer-hez. OAuth flow futtatása szükséges.

## TRK-800-010 — GAds rate limited

**Severity**: Warning
**Action**: DLQ → cron retry exponential backoff-fal.

## TRK-900-001 — DLQ write failed

**Severity**: Critical
**Description**: R2 bucket write fail — esemény elveszett.
**Action**:
1. R2 status: https://www.cloudflarestatus.com
2. Bucket exists? `wrangler r2 bucket list`
3. Permissions on the binding stimmelnek?

## TRK-900-002 / 003 — DLQ list / delete failed

**Severity**: Warning
**Action**: Cron retry next hour will retry the operation.

## TRK-900-004 — Cron retry failed

**Severity**: Warning
**Action**: Cloudflare Workers Logs → check stack trace.

## TRK-900-005 — Max retries exceeded

**Severity**: Warning
**Description**: A DLQ record 5+ retry-on hibázott.
**Action**: Manuális vizsgálat — a payload corrupt, vagy az API permanenten elérhetetlen. Töröld vagy javítsd kézzel.

## TRK-900-006 — DLQ corrupt record

**Severity**: Warning
**Action**: A R2-ben lévő JSON malformed. Töröld a record-ot.

## TRK-000-007 — Ledger write failed

**Severity**: Warning
**Description**: D1 ledger-írás (events_raw / deliveries / consent_receipts / lead_status / idempotency) elbukott.
**Action**: A request-path NEM törik (a ledger best-effort). 1) D1 status; 2) `wrangler d1 migrations apply` lefutott-e; 3) ha tartós, az idempotencia fail-open → dupla konverzió kockázat, vizsgáld.

## TRK-400-006 — Invalid lead-status payload

**Severity**: Info
**Action**: A `/api/event/lead-status` body hibás. Ellenőrizd: `lead_id` (UUID, nem PII), `status` az allowlistából, `value`/`currency`/`occurred_at` formátum.

## TRK-400-007 — Lead-status unauthorized

**Severity**: Warning
**Description**: A `/api/event/lead-status` admin-auth (X-Admin-Token) megbukott.
**Action**: A CRM helyes `ADMIN_API_TOKEN`-t küld? Ha ismeretlen forrás → vizsgáld (jogosulatlan hozzáférési kísérlet).

## TRK-950-001 — Reconciliation: vendor failure rate

**Severity**: Warning (a finding lehet critical is — lásd email/log severity)
**Description**: Egy platform kézbesítési hibaaránya átlépte a küszöböt (warn ≥5%, crit ≥15%).
**Action**: 1) Mely platform + site? 2) Nézd a kapcsolódó TRK-6xx/7xx/8xx kódokat a logban (token lejárt? rate limit? rossz conversion action?). 3) DLQ újrapróbálkozik, de a gyökérok javítandó.

## TRK-950-002 — Reconciliation: coverage drift

**Severity**: Warning (a finding lehet critical is)
**Description**: A jogosult eventek nem értek el a platformra (warn <90%, crit <70% lefedettség). MÁS, mint a failure rate — az ilyen event lehet, hogy nem is termel rejected delivery-t (csendes skip, hiányzó conversion action, config-hiba).
**Action**: 1) Van conversion action a `gads.conversion_actions`-ben az adott event_name-re? 2) Maradt-e bent `test_event_code` (CLAUDE.md 17.)? 3) Consent-gating nem tilt-e túl sokat? 4) Total outage (0%) → platform/config azonnal.

## TRK-950-003 — Reconciliation query failed

**Severity**: Warning
**Action**: A napi recon D1-lekérdezése elbukott. D1 status + migrations. A recon best-effort, a fő flow nem érintett.

## TRK-400-017 — High-value event rejected on browser path

**Severity**: Warning
**Description**: Form/lead/purchase konverzió (`quote_calculator_submitted`, `callback_request_submitted`, `contact_form_submitted`, `order_request_submitted`, `purchase`) érkezett a böngésző-útra (`/api/event/conversion`). Ezek KIZÁRÓLAG a hitelesített `/api/event/conversion-server` ingressen jöhetnek (per-site token) — az Origin curl-ből hamisítható.
**Action**: 1) Ha ismeretlen forrás → hamisított-konverzió kísérlet, az elutasítás a helyes viselkedés. 2) Ha egy SAJÁT site kliens-kódja termeli → a site backendjének kell dispatchelnie (lásd painless/lomtalan minta: `sendGatewayConversion`), a böngésző-leg csak a Meta Pixelé.

## TRK-900-007 — Retry record could not be stored anywhere

**Severity**: Critical
**Description**: Platform-hívás elbukott ÉS a retry-rekord sem a Queue-ba, sem az R2 DLQ-ba nem került be. Az event dispatched=0 marad, hogy egy kliens-retry újrakézbesíthesse (vendor event_id-dedup véd).
**Action**: 1) Queues + R2 status a Cloudflare dashboardon. 2) A logból azonosítsd az event_id-t; ha nem jön kliens-retry, a konverzió kézi újraküldést igényel a site backendjéből.

## TRK-950-004 — Accepted without vendor HTTP status (invariant violation)

**Severity**: Critical
**Description**: Egy delivery 'accepted'-ként íródott volna vendor HTTP-státusz nélkül — azaz hívás nem történt, csak egy skip-ág elfelejtette a `skipped` flaget. A normalizeDelivery ilyenkor 'skipped'-et ír e kóddal.
**Action**: Ez KÓDHIBA-jelző (a lomtalan 2026-07-14-i hamis-siker osztálya). Keresd meg az új/skip-utat, ami `{success:true}`-t ad `skipped:true` és `status` nélkül, és javítsd.
