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

## TRK-400-018 — user_data and user_data_hashed are mutually exclusive

**Severity**: Info (client 400)
**Description**: A hívó EGYSZERRE küldött nyers `user_data`-t ÉS `user_data_hashed`-et (F3-A/2 prehashed contract). Kétértelmű, melyik normalizáló futott — ezért 400, nem néma választás. (Csak szerver-ingressen fordulhat elő: a böngésző-ág eldobja a `user_data_hashed`-et.)
**Action**: A hívó (CRM/outbox) KÜLDJÖN pontosan egyet. Ha az outbox már-hash-elt PII-t tárol, CSAK `user_data_hashed` menjen; nyers PII soha nem hagyja el a CRM-et.

## TRK-400-019 — Invalid prehashed user_data field

**Severity**: Info (client 400)
**Description**: A `user_data_hashed` egy mezője nem 64-hosszú lowercase hex SHA-256 (F3-A/2). A gateway NEM engedi át némán — egy rossz hash némán rontaná a Meta match rate-et.
**Action**: A CRM-nek UGYANAZT a normalizálót kell futtatnia hash ELŐTT, mint a gateway (`lib/hash.ts`: email lowercase/trim, telefon E.164, város ékezet-tartó, irsz. uppercase-no-space, ország ISO-2 lowercase), majd lowercase hex SHA-256-ot küldeni. A hibaüzenet megnevezi a hibás mezőt.

## TRK-400-021 — Request body read failed (stream aborted)

**Severity**: Info (client 400)
**Description**: A kérés-törzs olvasása MENET KÖZBEN szakadt meg (kliens bontott, hálózati hiba) — ez NEM a 16 KiB-os méret-korlát. Korábban a `readBoundedBody` mindkét esetre `null`-t adott, így a megszakadt olvasás `TRK-400-015` (BODY_TOO_LARGE, 413) néven logolódott: a hibakód azt állította, hogy a kliens túl nagy payloadot küld, holott a kapcsolat szakadt meg. Egy hálózati romlás így „óriás body"-hullámnak látszott.
**Action**: Szórványos előfordulás normális (mobilhálózat, elnavigálás beacon közben). TARTÓS/tömeges megjelenés: a site oldali dispatch (sendBeacon vs fetch keepalive), proxy/CDN a hívó és a gateway között, vagy a hívó backend timeoutja. Ha ezzel EGYÜTT `TRK-400-015` is emelkedik, akkor van tényleges méret-probléma is — a kettő most már szétválasztható.

## TRK-900-007 — Retry record could not be stored anywhere

**Severity**: Critical
**Description**: Platform-hívás elbukott ÉS a retry-rekord sem a Queue-ba, sem az R2 DLQ-ba nem került be. Az event dispatched=0 marad (a kézi replay-t az idempotencia így nem nyeli el; vendor event_id-dedup véd).
**Action**: 1) Queues + R2 status a Cloudflare dashboardon. 2) A logból azonosítsd az event_id-t. 3) **Kézi újraküldés kell**: a hívó (böngésző-beacon vagy site backend) ekkorra már megkapta a válaszát, automatikus retry NEM jön — küldd újra az eventet a site backendjéből (ugyanazzal az event_id-vel), vagy a CRM-ből a lead-status-t.

## TRK-950-004 — Accepted without vendor HTTP status (invariant violation)

**Severity**: Critical
**Description**: Egy delivery 'accepted'-ként íródott volna vendor HTTP-státusz nélkül — azaz hívás nem történt, csak egy skip-ág elfelejtette a `skipped` flaget. A normalizeDelivery ilyenkor 'skipped'-et ír e kóddal.
**Action**: Ez KÓDHIBA-jelző (a lomtalan 2026-07-14-i hamis-siker osztálya). Keresd meg az új/skip-utat, ami `{success:true}`-t ad `skipped:true` és `status` nélkül, és javítsd.

## TRK-950-005 — Cross-platform drift (ledger vs GA4 / Google Ads)

**Severity**: Warning (finding-szinten lehet critical a napi emailben)
**Description**: A ledger event-countja és a GA4 Data API / Google Ads API aznapi konverzió-száma küszöb fölött tér el (site × event bontás, előző UTC-nap). Modell 2-ben a GA4-et és a Google Ads on-site konverziót a böngésző/GTM birtokolja — ha az az ág némán elromlik (GTM-publikálás, tag-törés, Consent Mode-regresszió), a ledger-belső recon NEM látja; pont ezt fogja meg ez a check (2026-07-15-i eset: ledger 4 callback, GA4 2, Google Ads 2, és semmi nem riasztott).
**Action**: 1) Nézd meg, MELYIK irányban tér el: platform < ledger → a böngésző-ág (GTM Preview, tag-státusz, Consent Mode); platform > ledger → a gateway-ág (Workers logs, ledger). 2) Számolj a dokumentált zajjal: időzóna-nap-határ és consent-tiltás ±1-2 darabot csúsztathat — az ismétlődő vagy nagy eltérés a jel. 3) A config a SITE_CONFIG `recon` blokkja (lib/cross-check.ts).

## TRK-950-006 — Cross-platform reconciliation query failed

**Severity**: Warning
**Description**: A cross-check egyik lekérdezése (D1 / Google Ads GAQL / GA4 Data API) elbukott — az adott láb aznap kimaradt, a többi lefutott. GA4 403 + "analytics.readonly scope" hint = a refresh token még a scope-bővítés ELŐTTI consenttel készült.
**Action**: GA4 403-nál: re-consent (`/api/event/oauth-init?customer_id=...` a site gads customer-jével — az új consent a datamanager + adwords + analytics.readonly hármat adja). Google Ads hibánál: developer token / login-customer-id / OAuth token státusz. D1-hibánál: mint TRK-950-003.

## TRK-950-011 — Cross-platform reconciliation NOT RUNNING

**Severity**: Warning
**Description**: Maga a monitor áll. Nem drift, hanem annak a hiánya, hogy bármit is megnéztünk volna: vagy EGYETLEN site-on sincs `recon` blokk, vagy minden leg kimaradt (hiányzó `ga4_property_id` / `gads_onsite_actions`, 403-as scope), vagy a ledger-lekérdezés bukott. Modell 2-ben ez a check az EGYETLEN monitora a böngésző/GTM-ágnak, ezért az álló monitor nem lehet néma. A 2026-08-16-i audit szerint a check a bevezetése óta EGYETLEN napon sem futott le — üres finding-listát adott, amit a napi riport megkülönböztethetetlenül „nincs drift"-ként jelentett.
**Action**: 1) A napi recon-email megmondja, hány site-on van `recon` blokk (`X / Y`). 2) Vedd fel a SITE_CONFIG KV-be: `recon.ga4_property_id` = a GA4 **numerikus** property ID (NEM a `G-XXX` measurement id; GA4 → Admin → Property Settings), és/vagy `recon.gads_onsite_actions` = `{ "<kanonikus event_name>": "<on-site Google Ads conversion action NEVE>" }` (a fiókban látható név, pl. „Callback requested" — NEM a `gads.conversion_actions` offline ID-térképe). 3) Ha ezután a GA4-leg `query_failed`-del skippel 403-mal: re-consent (`/api/event/oauth-init?customer_id=...`) az `analytics.readonly` scope-hoz, és ellenőrizd, hogy az adott Google-fiók LÁTJA-e a property-t. 4) A leg-szintű kimaradás a logban `skipped_legs`-ként, site/platform/ok bontásban látszik.

## TRK-950-007 — Meta EMQ below threshold

**Severity**: Warning
**Description**: A Dataset Quality API szerint egy event composite EMQ score-ja a küszöb (7) alá esett a site-on. A smoke-őr kézbesítést bizonyít, match-minőséget nem — a leggyakoribb csendes CAPI-regresszió (eltört fbc/fbp- vagy em/ph-forwarding) csak itt látszik.
**Action**: 1) Events Manager → dataset → Event Match Quality: melyik kulcs lefedettsége esett? 2) fbc/fbp-esésnél a kliens cookie-olvasás/`buildFbcFromFbclid` út és a site dispatch-kódja. 3) em/ph-esésnél a form→backend→gateway user_data lánc. 4) A digest EMQ-szekciója site-onként mutatja a score-okat.

## TRK-950-008 — Meta Dataset Quality API query failed

**Severity**: Info
**Description**: Az EMQ-lekérdezés (`GET /{version}/dataset_quality`) elbukott — a digest a ledger-proxy metrikára (em/ph/fbc/fbp jelenlét-lefedettség) esik vissza. Várható ok: a Meta docs szerint az Events Manager-es client system user (CAPI-onboarding) token jelenleg NEM kompatibilis az EMQ API-val — ez permanens állapot lehet, ezért csak info.
**Action**: Ha valódi EMQ-t akarsz: Business Manager rendes system user token `ads_read` + (`ads_management` VAGY `business_management`) engedéllyel a KV `meta.access_token`-be (a CAPI events-küldésnek is jó). Egyébként nincs teendő — a proxy-őrzés él.

## TRK-950-009 — Match-key coverage drop (EMQ proxy)

**Severity**: Warning
**Description**: Egy match-kulcs (em/ph/fbc/fbp) 24 órás jelenlét-lefedettsége ≥25 százalékponttal a 7 napos átlaga alá esett (élő baseline-nál, ≥5 eventes mintán) — az eltört identifier-forwarding klasszikus képe, miközben a kézbesítés zöld marad.
**Action**: 1) MELYIK kulcs esett? fbp → a kliens `_fbp` cookie-olvasása/dispatch; fbc → `_fbc` cookie + fbclid-attribúció; em/ph → a form/backend user_data lánc. 2) Nézd a site legutóbbi front-end deployát — a regresszió jellemzően onnan jön. 3) A flag-ek az events_raw `*_present` oszlopai (PII nincs tárolva).

---

# TRK-910-* — Consent-diagnosztika (Fázis D, 2026-08)

**Miért a 910-es sáv, és nem a 900-as**: a Fázis D briefje ezeket TRK-900-001…006-ként
írja le, de a 900-as sávban a 001–008 FOGLALT (DLQ + Cron kódok, fentebb), élesben
kibocsátva, ezzel a runbookkal és historikus log-találatokkal. Az újraszámozás néma
diagnosztika-vesztés lenne — egy TRK-900-002 találat mást jelentene tegnap és ma.
A consent-kódok ezért a szabad 910-es sávot kapták, 1:1 sorrendben: 910-001 ↔ 900-001,
… 910-006 ↔ 900-006.

**Közös háttér**: három párhuzamos consent-olvasás fut ugyanarra a döntésre — kliens
`getCkyConsent()` JS API, kliens `cookieyes-consent` süti-parse, és a szerver HTTP
Cookie header parse-a. A Fázis D ezek eltérését MÉRI (nem javítja): 30 nap adatból 9
olyan `skipped` delivery van, aminek a receiptje GRANTED. Elsőszámú hipotézis:
betöltési verseny. A per-event kódok INFO szintűek — az aggregált jel a napi
keresztellenőrzésé (`scheduled/consent-check.ts`, cron 08:30 UTC).

## TRK-910-001 — Consent object missing

**Severity**: Info
**Description**: A payloadban egyáltalán nincs `consent` blokk. Viselkedés VÁLTOZATLAN: a site
`require_consent` szabálya dönt (fail-closed site-on skip `consent_missing_failclosed` okkal).
**Action**: Ha egy site-on tömeges: a kliens-lib nem küld consentet (régi verzió), vagy a
site-backend nem hívja a `readConsentFromCookie`-t. Nézd a `consent_receipts.source_used`
és a NULL-forrás oszlopokat ugyanarra a site-ra.

## TRK-910-002 — Consent unparseable

**Severity**: Info (de a `consent_strict: true` site-on fail-closed)
**Description**: Van `consent` objektum, de egyetlen érvényes Consent Mode v2 jel sem
olvasható ki belőle. `consent_debug` sor íródik a nyers stringekkel (14 napos purge).
**Action**: A `consent_debug.raw_cookie` / `raw_api` megmutatja, mit küldött a kliens.
Jellemzően rossz kulcsnév (`marketing` a `advertisement` helyett) vagy elrontott
signal-érték.

## TRK-910-003 — Consent sources disagree

**Severity**: Info (de a `consent_strict: true` site-on fail-closed)
**Description**: Két consent-forrás ellentmond egymásnak (`source_consistent = 0`).
`consent_debug` sor íródik. **Ez a Fázis D fő mérőszáma.**
**Action**: 1) `consent_receipts`: melyik forráspár tér el (`src_cookie_*` vs `src_api_*` vs
`src_server_*`)? 2) Ha az API mond DENY-t, miközben a süti GRANTED-et: betöltési verseny
(A kimenetel — kliens-egységesítés kell, nem CMP). 3) Ha a süti maga hordoz rossz
állapotot konzisztens lib-verzió mellett: B kimenetel (CookieYes a hibás).

## TRK-910-004 — Consent expired

**Severity**: Info
**Description**: **DEFINIÁLVA, DE NEM ÉLESÍTVE.** CookieYes alatt SOHA nem tüzelhet: a
`cookieyes-consent` süti nem hordoz timestampet, tehát a `consent_age_s` mindig NULL.
Kizárólag az sbo_consent (saját CMP) korszakban aktiválható. Fail-closed viselkedést
akkor sem kap — a `consent_strict` csak a 002/003/005 kódokra hat.
**Action**: Ha valaha megjelenik CookieYes alatt: valaki heurisztikát tett a
`consent_age_s`-be. Ne tegyen.

## TRK-910-005 — Consent signals internally inconsistent

**Severity**: Info (de a `consent_strict: true` site-on fail-closed)
**Description**: Az ad-hármas (`ad_user_data` / `ad_personalization` / `ad_storage`) szétesik:
az egyik GRANTED, a másik DENIED vagy hiányzik. A CookieYes-leképezésben ez a három EGYSÉG,
tehát valami rosszul fordít.
**Action**: A fordítási pont a kliens `getConsentState()` vagy a site-backend
`readConsentFromCookie` — mindkettő az `advertisement` kategóriát képezi le mindhárom jelre.
Részleges objektum jellemzően kézi `__trackingConsent` override-ból vagy saját site-kódból jön.

## TRK-910-006 — Client lib version below minimum

**Severity**: Info
**Description**: A jelentett `client_lib_version` a `MIN_CLIENT_LIB_VERSION` (jelenleg 6.1.0)
alatt van. A HIÁNYZÓ verzió NEM tüzeli a kódot (a régi libek nem is küldenek telemetriát) —
azt a NULL-forrás mintázat mutatja meg.
**Action**: Frissítsd a site `soborbo-tracking` package-ét. Amíg nem frissül, az adott site
consent-diagnosztikája vak marad.

## TRK-910-007 — Consent cross-check query failed

**Severity**: Warning
**Description**: A napi consent-keresztellenőrzés egyik D1-lekérdezése elbukott. A napi levél
ilyenkor VAKFOLTKÉNT jelenti — nem „nincs jel".
**Action**: D1 státusz + a `leg` mező a logban (granted_skips / findings / consistency_* /
null_sources / debug_rows). Ellenőrizd, hogy a 0004 migráció lefutott-e (a hiányzó
`skip_reason` / `finding_codes` oszlop pontosan ezt a hibát adja).

## TRK-910-008 — GRANTED consent but delivery skipped

**Severity**: Warning
**Description**: GRANTED consent receipt MELLETT keletkezett `skipped` delivery — pontosan az
a rejtély, amiért a Fázis D létezik (30 nap alatt 9 darab). Ilyen sornak nem szabadna léteznie.
**Action**: A `skip_reason` bontás mondja meg az ágat: `consent_missing_failclosed` →
a payload consentje nem GRANTED volt, miközben a receipt igen (verseny vagy két forrás);
`not_configured` → config-vesztés (lomtalan-osztály), nem consent-ügy; `(unnamed)` → a
0004 migráció ELŐTTI sor, ott csak az időbélyeg segít.
