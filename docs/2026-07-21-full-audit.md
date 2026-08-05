# Teljes kód-audit — 2026-07-21

**Scope:** a teljes Serverside repó (gateway `src/`, `soborbo-tracking/` kliens-package,
`scripts/`, `migrations/`, CI, wrangler-config, docs) + a Fázis-0 munkacsomag
(`FAZIS-0-MUNKACSOMAG.md`) terv-konformancia. HEAD: `5b91b0e`.

**Módszer:** KÉT audit-kör. 1. kör: 4 párhuzamos, független kód-olvasó audit (core libek;
route/ingress; scheduled/DLQ/scriptek; kliens-package + contract-sync). 2. kör (az 1. körben
csak érintőlegesen fedett területekre): kliens-komponensek + `server/backend/` + GTM-container
tag-szinten; maradék src-modulok + keresztirányú sweep; és a TESZTSUITE-ok hamis-zöld auditja.
A CRITICAL/HIGH találatok kézzel újra-ellenőrizve. Gépi ellenőrzések: root 491/491 teszt zöld, soborbo-tracking 112/112
zöld, mindkét typecheck tiszta, `check:events` + `check:contract` OK. **Minden lenti hiba
logikai/spec-szintű — a tesztek nem fogják meg őket** (több esetben épp a teszt-stub a hibás).

**Javítás:** a `docs/2026-07-21-fix-prompt.md` az ehhez tartozó, futtatható javító prompt.

---

## ⛔ HATÁRIDŐS FIGYELMEZTETÉS

A Fázis-0 C-blokk replay határideje **~07-22** (a legrégebbi jogosult esemény Meta-ablaka).
A **H6** hiba miatt a `recover-blocked-events.ts --execute` élesben nagy valószínűséggel
elhasal (EU-jurisdictiós R2 bucket, hiányzó `--jurisdiction eu` flag) — a dry-run ezt NEM
mutatja meg, mert csak D1-t olvas. **Ezt a határidő előtt kell javítani.**

---

## CRITICAL

### C1 · A CookieYes JS-API olvasó nem létező `marketing` kategóriát néz — élesben MINDEN marketing-consentes böngésző-láb halott

- **Hely:** `soborbo-tracking/lib/consent.ts:44-48` (+ a hibás global interface :17-28)
- **Hiba:** `getCkyConsent().categories.marketing === true` — a CookieYes valódi API-ja
  `necessary / functional / analytics / performance / advertisement` kategóriákat ad vissza,
  **`marketing` kulcs nincs** (CookieYes hivatalos doksi ellen ellenőrizve). A package saját
  két *cookie*-parsere helyesen az `advertisement` kulcsot használja
  (`lib/gateway.ts:125`, `server/backend/gateway-dispatch.ts:174`) — kizárólag a JS-API
  olvasó rossz. Betöltött CookieYes mellett `categories.marketing === undefined` →
  `hasMarketingConsent()` **mindig false** productionben.
- **Következmény (mind néma):**
  - `index.ts:237` — telefon/email/whatsapp klikk-konverziók gateway-lába soha nem küld;
  - `index.ts:142,165` — `trackLeadSubmit`/`trackContactSubmit` `consentBlocked:true`-val
    kihagyja a `pushLeadConversion`-t → nincs Pixel Lead, nincs böngésző GA4-konverzió,
    nincs Google Ads EC-adat — „accept all" user esetén sem;
  - `persistence.ts:174` — gclid/fbclid/UTM soha nem perzisztálódik → többoldalas flow-n
    üres a rejtett gclid-mező, offline EC loop degradálódik;
  - `events.ts:122` — `setUserDataForEC()` no-op → GTM User-Provided-Data mindig üres;
  - `index.ts:79` — az `onConsentChange` listener is `c.marketing`-et néz → grant után sem éled fel.
- **Miért zöld mégis 112 teszt:** `tests/helpers.ts:3-10` egy kitalált `marketing` kulcsú
  CookieYes-alakot stubol — a suite a feltételezést teszteli, nem a CMP-t.
- **Álcázás:** a szerver-leg (gateway-dispatch, cookie-parser) működik, ezért a dashboardok
  élnek — pont ettől maradhat észrevétlen.
- **Fix:** `getCookieYesConsent()`-ben `advertisement` → lib-szintű `marketing` mapping;
  a `Window.getCkyConsent` típus javítása; a teszt-helper a VALÓDI CookieYes-alakot emittálja.

---

## HIGH

### H1 · CLAUDE.md §17 sértés: a Meta `test_event_code` még mindig KV-configból is jöhet

- **Hely:** `src/lib/meta.ts:134` (`payload.test_event_code || meta.test_event_code`),
  `src/lib/config.ts:23` (a mező még a típusban van), `scripts/setup-painless.sh:126,155`
  (default/dev fázisban KV-ba írja).
- **Hiba:** a §17 szerint a test-kód KIZÁRÓLAG per-request mehet, KV-ból SOHA (két éles
  Meta-leak történt pont így, a 300s edge-cache miatt). A fallback újra felfegyverzi a csapdát:
  egyetlen ottfelejtett KV-mező a teljes cache-ablakra a Test streambe tereli a valódi konverziókat.
- **Fix:** a `|| meta.test_event_code` fallback törlése; ha KV-configban mégis van ilyen mező,
  CRITICAL log (nem tisztelet); a mező kivezetése a `SiteConfig` típusból; setup-painless.sh
  igazítása (test-kód csak explicit flaggel, KV-ba soha).

### H2 · Az offline (lead-status → Data Manager) lábon NINCS `not_configured`-védelem — a lomtalan-tanulság csak a böngésző-fan-outra lett alkalmazva

- **Hely:** `src/routes/lead-status.ts:263-299`, `src/lib/datamanager.ts:76-90`,
  `src/lib/config.ts:82-85`.
- **Hiba:** ha a `gads.customer_id` vagy a `conversion_actions[eventName]` eltűnik a KV-ból
  (pontosan a 07-14-i lomtalan-incidens hibaosztálya), a `sendToDataManager`
  `{success:true, skipped:true}`-t ad **skip_reason nélkül**; a lead-status: nincs DLQ-rekord,
  nincs riasztás, a CRM `200 {ok:true, uploaded_to_gads:false}`-t kap. Az
  `expected_platforms.offline` a configban definiálva van, de **sehol nem fogyasztja semmi**
  (grep-pel igazolva); a `daily-digest.ts:109` explicit kizárja az offline lábat. A payload+hash
  a skip pillanatában megvan, aztán örökre elvész. Ez a P0 pénz-láb.
- **Fix:** `skip_reason: 'not_configured'` a `GAdsResult`-ba; `isExpectedPlatform(…, 'offline')`
  ellenőrzés a lead-statusban; elvárt+hiányzó config esetén `blocked_configuration` DLQ-rekord
  (R2, 7 napos ablak) + TRK-900-008 CRITICAL — a `conversion.ts:785-829` mintájára.

### H3 · Prehashed email-kontrakt: kétértelmű kulcsnév + néma unknown-key-eldobás → némán degradáló Gmail EC match rate

- **Hely:** `src/routes/lead-status.ts:48-50` (a komment `email_sha256_google` kulcsnevet
  dokumentál), `src/lib/hash.ts:321-354` (`PREHASHED_FIELD_MAP` csak `sha256_email`-t fogad,
  az ismeretlen kulcsokat **némán ignorálja**).
- **Hiba (két réteg):**
  1. Ha a CRM a lead-status kommentet szó szerint implementálja (`email_sha256_google` kulcs),
     a mapper némán eldobja → `mapped.data = {}` (truthy!) → a
     `prehashedUserData ?? hashUserDataForGoogle(...)` fallback SOSEM fut le → a Data Manager
     nulla identifierrel skippel, csak egy warn loggal. A teljes offline EC-láb némán meghal.
  2. Mélyebb kontrakt-hiba: **ugyanaz** a wire-kulcs (`sha256_email`) a `/conversion-server`-en
     Meta-normalizált, a `/lead-status`-on Google-normalizált hash-t KELL hordozzon — semmi
     nem különbözteti meg és semmi nem validálja. Egy leadenként egy hash-t tároló CRM
     (a hash.ts:315 kommentjének természetes olvasata) mindkét endpointra ugyanazt küldi →
     a Gmail-userek EC match rate-je némán romlik (pont a CLAUDE.md-ben megjósolt hiba).
- **Fix:** külön wire-kulcs a két normalizációnak (pl. `sha256_email` = Meta-szabály,
  `sha256_email_google` = Google-szabály); a lead-status a Google-kulcsot fogadja; endpointonként
  a ROSSZ kulcs fail-loud 400 legyen (nem néma ignore); a `sha256_`-prefixű, de a mapben nem
  szereplő kulcsokra szintén 400 (typo-védelem — az F3-A doc-comment pont ezt ígéri).

### H4 · Kitalált `ad_personalization` consent megy a Google-nek

- **Hely:** `src/routes/lead-status.ts:279-292`; `src/lib/ledger.ts:517-537`
  (`getLatestConsentForLead` csak `ad_allowed, ad_user_data`-t olvas, pedig a receipt
  az `ad_personalization`-t is tárolja — ledger.ts:368-393).
- **Hiba:** a `consentEvidence` kizárólag ad_user_data-jelből származik, mégis
  `{ad_user_data:'GRANTED', ad_personalization:'GRANTED'}` megy ki. Aki capture-kor
  az ad_personalization-t explicit MEGTAGADTA, arról GRANTED-et állítunk a Google-nek —
  consent-hamisítás (GDPR/DMA-kitettség), és a két sorral feljebbi „consentet nem találunk ki"
  kommentnek is ellentmond.
- **Fix:** `getLatestConsentForLead` bővítése `ad_personalization`-nel; a két jel független
  mappelése (ismeretlen → mező kihagyása), ahogy a `datamanager.ts:mapConsentSignal` már tudja.

### H5 · Lejárt blocked-config DLQ-rekordok örök pending↔archive hurokban — sosem érik el a dead-archívumot

- **Hely:** `src/lib/deadletter.ts:277-290` (`archiveExpiredRecord`:
  `retry_count: Math.max(record.retry_count, MAX_RETRIES)` = 3) vs `deadletter.ts:135-137`
  (a dead-prefix döntés `maxRetriesFor(record)`-ot használ, ami blocked_configuration-re **28**).
- **Hiba:** a blocked-config skip nem növel retry_count-ot (`scheduled/retry.ts:67-70`), így a
  7 nap után lejárt rekord retry_count≈0-val érkezik → 3 < 28 → az „archív" másolat a
  **pending** prefixre kerül, az eredeti törlődik → a következő órás cron megint expirednek
  minősíti → örök óránkénti R2 put/delete churn. A retention (`isDeadKey`) sosem takarítja,
  az SLO-check és a digest örökre pendingként számolja (hamis DLQ-inflácio, idővel hamis
  >500 CRITICAL), és a 200-as expired-slot zombikkal telik meg. **A Fázis-0 recovery 3 rekordja
  ~07-28-tól pont ebbe a hurokba esne.** (Két független audit-ág is megtalálta.)
- **Fix:** `retry_count: Math.max(record.retry_count, maxRetriesFor(record))` az
  `archiveExpiredRecord`-ban (vagy explicit `forceDead` flag a `writeDeadLetter`-ben).

### H6 · `recover-blocked-events.ts --execute`: az EU-jurisdictiós bucketbe jurisdiction-flag nélkül ír — élesben elhasal, pont a határidős lépésnél

- **Hely:** `scripts/recover-blocked-events.ts:249`
  (`wrangler r2 object put soborbo-tracking-dlq-eu/<key> --file … --remote`, nincs
  `--jurisdiction eu`), miközben `wrangler.toml:186-187` szerint a bucket `jurisdiction = "eu"`.
- **Hiba:** az EU-jurisdictiós bucketek külön névtérben élnek; a wrangler r2 object parancsnak
  `-J eu` kell, különben „bucket not found". A dry-run (csak D1-olvasás) átmegy — a hiba csak
  az éles futásnál jön elő, a 07-22-i Meta-ablak határidőn.
- **Fix:** `'--jurisdiction', 'eu'` a put-hívásba + előtte smoke-teszt egy eldobható kulccsal.
  (Kapcsolódó LOW: a rekord friss `first_failed_at = now`-t kap → a DLQ-ablak túlnyúlik a
  Meta event_time+7d ablakán — zaj, lásd L12.)

### H7 · `bootstrap-cloudflare.sh`: rossz DLQ-bucket + a sed elrontja az OAUTH_TOKENS KV-id-t

- **Hely:** `scripts/bootstrap-cloudflare.sh:36` (`soborbo-tracking-dlq`-t hoz létre,
  jurisdiction nélkül — a binding `soborbo-tracking-dlq-eu`, `jurisdiction="eu"`);
  `:47-52,66` (a `patch_toml "id"` sed-regexe MINDKÉT `[[kv_namespaces]]` `id`-sorára
  illeszkedik → az OAUTH_TOKENS némán a SITE_CONFIG namespace-id-t kapja).
- **Hiba:** friss accounton a deploy elbukik (nincs meg a bucket), vagy „javítva" a PII nem-EU
  bucketbe kerül (a wrangler.toml saját GDPR P0 kommentje ellen); a KV-id-korrupció a két
  namespace összemosásával jár.
- **Fix:** bucket létrehozás `--jurisdiction eu`-val és a helyes névvel; a toml-patch
  blokk-szkópolása (pl. awk a binding-markerek között), OAUTH_TOKENS külön patchelése.

---

## MEDIUM

### M1 · A Meta-forwarder nyers vendor-hibaüzenete sanitizálatlanul kerül a ledgerbe és a DLQ-ba

`src/lib/meta.ts:220` a NYERS `responseBody.error?.message`-et adja vissza (csak a :212 log
sanitizált). Ez a `normalizeDelivery` → `deliveries.vendor_message` (`ledger.ts:136`, csak
truncate) és a DLQ `failure_reason` (`conversion.ts:833-847`) útvonalon perzisztálódik. A
`log-sanitize.ts` maga írja: a Meta néha visszaechózza a beküldött értékeket → hash/email
kerülhet a ledgerbe, a ledger saját „SOHA nem tárol PII-t" invariánsa (ledger.ts:12) ellen.
Minden más forwarder (datamanager:243, gads:216/235, tiktok:122) sanitizál — a meta.ts a kivétel.
**Fix:** `sanitizeErrorMessage(...)` a meta.ts return-jében ÉS központilag a
`normalizeDelivery`-ben (a `String(settled.reason)` ágat is beleértve, ledger.ts:106).

### M2 · CORS: a `resolveAllowedOrigin` nem ismeri a site `allowed_origins`-át — cross-host küldőknek néma esemény-vesztés

`src/worker.ts:245-271` csak az `env.ALLOWED_ORIGINS` globált nézi; az ingress-oldali
`checkOrigin`/`allowedOriginHosts` (`lib/origin.ts:54`) viszont a SiteConfig
`allowed_origins`-át is. Aki tényleg használja ezt a knobot (külön landing-domain), annak a
JSON-os fetch preflightja rossz ACAO-t kap → a böngésző el sem küldi a POST-ot, miközben az
ingress elfogadta volna. **Fix:** az OPTIONS/response útvonalon is site-config-alapú
origin-feloldás (`allowedOriginHosts`).

### M3 · Nincs runtime KV-config-validáció; hiányzó `gads` blokk → TypeError 500 a lead-statuson és a health-checken

`src/lib/config.ts:255` (`return raw as SiteConfig`, semmi shape-guard), `gads` non-optional
a típusban; `lead-status.ts:263` (`siteConfig.gads.customer_id`) és `admin.ts:357` védtelenül
olvassa. Kézzel szerkesztett, `gads` nélküli config (bizonyított hibaosztály!) → 500 minden
lead-status híváson, MIELŐTT a `recordLeadStatus` lefutna (a státusz-sor is elvész); DLQ-retryben
óránkénti CRON_RETRY_FAILED. A TRK-CFG-001 kód létezik, de sosem emittálódik betöltéskor.
**Fix:** minimális shape-guard a `getSiteConfig`-ban + optional-chain a hívóknál + TRK-CFG-001 log.

### M4 · `generate-site.mjs` sosem emittál `expected_platforms`-ot — minden generátorral onboardolt site a Fázis-0 védelmen KÍVÜL van

`scripts/generate-site.mjs:183-208` (`toSiteConfig`) csak site_id/country/currency/meta/gads[/ga4]-t
ír. `isExpectedPlatform` (`config.ts:284-286`) `expected_platforms.smoke` nélkül false → egy
későbbi config-vesztés újra TERMINÁLIS néma skip (se DLQ, se TRK-900-008) — pont a lomtalan-
hibamód. **Fix:** `expected_platforms: { smoke: ['meta'] }` emit, ha van meta blokk (+ input-validáció).

### M5 · wrangler.toml: a Queues-blokkok ÉLNEK, miközben a saját kommentjük (és a docs) szerint kommentben vannak

`wrangler.toml:55-76`: „amíg ezek kommentben vannak … vedd ki a kommentből" — de a
`[[queues.producers]]`/`[[queues.consumers]]` aktív. Ha a queue-k nincsenek létrehozva, a
deploy elbukik; ha létre lettek hozva, a doksi (`soborbo-tracking/docs/SERVERSIDE-FOLLOWUP.md`
„Until then the DLQ runs on R2", DEPLOY.md) hazudik az üzemmódról. **Fix:** vagy vissza kommentbe,
vagy a komment+docs átírása Queues-live állapotra (és a queue-k létének megerősítése).

### M6 · `countryCode: 'EU'` telefonok némán +44-be kényszerítve

`src/lib/hash.ts:125` — `if (countryCode === 'GB' || countryCode === 'EU')`: EU-configú site-on
egy német `030 1234567` → `+44301234567` → szintaktikailag valid, rossz országú E.164 → a ph
identifier SOHA nem matchel, site-szinten, némán. **Fix:** 'EU' esetén csak a már nemzetközi
(`+`/felismerhető CC) input megy át; egyébként `undefined`.

### M7 · A conversion-route `user_data`-ja strukturálisan validálatlan — szerver-hívónak néma identity-vesztés

`src/types.ts:200-273` (`isValidConversionPayload` nem nézi a `user_data`-t): string/tömb
`user_data` (pl. dupla-JSON-encode outbox-bug) átmegy, `hashUserData` nulla mezőt talál → az
event nulla identifierrel megy ki, a hívó sikert kap, a Meta EMQ némán összeomlik. Bónusz:
`user_data_hashed` + string `user_data` esetén (`Object.keys("a@b.c").length > 0`) félrevezető
TRK-400-018-at kap. A `validateLeadStatusBody` (lead-status.ts:84-91) ezt HELYESEN csinálja.
**Fix:** `user_data` (ha jelen van) nem-tömb objektum legyen az `isValidConversionPayload`-ban.

### M8 · Bármilyen `X-Admin-Token` jelenléte kikerüli az elülső rate limitet; a 404-es út egyáltalán nincs limitálva

`src/routes/conversion.ts:145-159, 272-291, 311-319`: a `presentsServerToken` (validálatlan
header-jelenlét) átugorja az elülső limitert; invalid token csak a reject-ágon limitált — addig
per-request ingyen: 16KiB body-read, JSON-parse, payload-validáció, KV `getSiteConfig`. Ismeretlen
hostname + token → 404 a limiter érintése NÉLKÜL. Nem auth-bypass, de gyengíti a „limit+Origin
a két pillér" posztúrát és a WAF-mentesítés érvét. **Fix:** IP-limiter a `!siteConfig` 404-return
előtt is; token-jelenlétnél a halasztott limiter-check a `getSiteConfig` ELÉ.

### M9 · `docs/error-codes.md` súlyos driftben az `error-codes.ts`-től

Hiányzó runbook-bejegyzések: **TRK-900-008** (amire az egész Fázis-0 épül; a riasztó email
a runbookra mutat — `notify.ts:168`), TRK-960-001/002, minden TRK-840-*, TRK-810/820/830-*,
TRK-400-008..016 (köztük a critical TRK-400-016), TRK-000-008, TRK-EVT/GA4-002/META-002/PROV/CFG.
Tartalmi drift: „5+ retry" vs `MAX_RETRIES=3`; a TRK-400-005 a törölt Turnstile-utat írja élőként.
**Fix:** doksi-regenerálás az enumból + CI-check, hogy minden enum-tagnak van doc-heading-je.

### M10 · Secret-higiénia (Fázis-0 E-blokk) hiányos + Turnstile-maradványok a scriptekben

- `scripts/generate-site.mjs:142` még KÖVETELI a `ga4.api_secret`-et ga4-blokk esetén, és a
  `toSiteConfig` visszaemittálja — az E-2(3) („kivezetés a site-input elvárásokból") nincs kész;
  az E-2(4) guard-teszt (ga4-blokk ne térhessen vissza indoklás nélkül) nem létezik.
- Nincs secret-scanner a CI-ben (E-3); a `.gitignore` fedi a `secrets/`+`prod-audit/`-ot (ennyi kész).
- `scripts/setup-painless.sh:217` még provisionál `TURNSTILE_SECRET_KEY`-t (törölt kapu,
  CLAUDE.md §10; a wrangler.toml szerint a secret TÖRLENDŐ).
**Fix:** E-2(3-4)/E-3 leszállítása; Turnstile-secret lépés törlése a scriptből.

### M11 · `handleSloCheck`: nincs hibaizoláció az R2-listázás körül

`src/scheduled/slo-check.ts:133-137`: a `countDlqRecords` nincs try/catch-ben; egy tranziens
R2-list hiba az egész waitUntil-promise-t buktatja, és a MÖGÖTTE futó `checkConversionSpike`
(conversion-spam őr) is kimarad az adott 30 perces slotból. Minden más scheduled handler izolál.
**Fix:** try/catch + a spike-check feltétel nélküli lefuttatása.

### M12 · `collectAttribution` consent nélkül ír localStorage-ot — a package saját szabálya ellen

`soborbo-tracking/lib/gateway.ts:256-264` (`__sb_attribution`): az explicit-DENIED és az
unknown-consent ágban is `writeStoredAttribution(merged)` fut — UTM-ek, landing_page, referrer
tartós tárolásba, consent-check NÉLKÜL (a `persistence.ts:4-7` szabálya: „localStorage → only
after marketing consent"). A click-ID-k helyesen kapuzottak, a többi nem. EEA-ban ePrivacy-kitettség.
**Fix:** a nem-granted ágakban csak in-memory merge, tartós írás consenthez kötve.

### M13 · Az onboard-site skill példa-inputja elbukik a saját generátora validációján

`.claude/skills/onboard-site/SKILL.md:74-75` — a példa `conversion_actions` kulcsai
(`callback_conversion`, `phone_conversion`) legacy aliasok, amiket a `generate-site.mjs:52,156-163`
explicit elutasít (exit 1) — ahogy azt a skill 39-46. sora maga is elmagyarázza. A kockázat:
az operátor a generátort „javítja" vagy kézzel írja a KV-t (mindkettő tiltott).
**Fix:** a példa kulcsait kanonikus offline nevekre cserélni (`lead_qualified`, `booking_confirmed`, …).

---

## LOW

- **L1** · `src/lib/tiktok.ts:87-89`: `value` currency nélkül / `currency` value nélkül is
  kimegy — a Rule 3 párosítás (`value>0 && currency`) a többi forwarderben megvan.
- **L2** · `src/lib/meta.ts:96`: value>0 + hiányzó currency → a bevétel-jel némán elvész;
  legalább warn log kellene.
- **L3** · `src/lib/ga4.ts:54,203-207`: hiányzó client_id-re RANDOM client_id-t gyárt —
  a Rule 8 szerint pont emiatt lett kikapcsolva a láb; a DLQ-retry útvonalon minden retry ÚJ
  szintetikus GA4-clientet szül. Skip legyen fabrikálás helyett.
- **L4** · `src/lib/ledger.ts:181-246`: a `suppressGa4` gépezet (INFLIGHT_WINDOW_MS) minden
  requesten kiszámolódik, de SENKI nem fogyasztja (a GA4-leg kikerült a fan-outból) — halott
  kód félrevezető doc-kommentekkel. Két audit-ág is jelezte.
- **L5** · `src/lib/gads-oauth.ts:40-46`: az OAuth code-exchange fetch-nek nincs timeoutja
  (a refresh-nek 5s van) — lógó Google-endpoint beragasztja a callback route-ot.
- **L6** · `src/routes/admin.ts:213-220`: a DLQ-discard `ok:true`-t jelez akkor is, ha az R2
  delete elbukott; a cron/`retrySingle` nem nézi a `do_not_replay`-t → a „eldobott" event a
  következő cron-körben mégis kézbesítődhet.
- **L7** · `src/routes/conversion.ts:545,586`: a `/conversion-server` siker és a duplikátum-
  elnyomás is csupasz 204 — a CLAUDE.md §12 a 204-et a böngésző-beaconnek tartja fenn; a CRM nem
  tudja megkülönböztetni az accepted/duplicate/consent-skip kimeneteket. `200 {accepted, duplicate}` javasolt.
- **L8** · Turnstile-maradványok: `src/types.ts:57-61,220-224` (a payload még elfogad
  `turnstile_token`-t, a komment élő „Turnstile-kapuról" beszél), `src/env.ts:33` („csak
  Turnstile véd"). Validáló kód nincs (helyes), de a mező+kommentek félrevezetők.
- **L9** · Rule 10 drift: a `begin_checkout` a tokenless böngésző-úton megy (`src/events.json:110-121`),
  pedig a CLAUDE.md §10 felsorolásában nincs benne; továbbá a böngésző-út a low-risk eventeken
  is továbbítja a hash-elt `user_data`-t → hamisított Originnel tetszőleges hash-elt identity
  fűzhető Contact/InitiateCheckout eventekhez (match-data poisoning maradék-vektor). Döntés kell:
  user_data eldobása a böngésző-úton VAGY a kivétel dokumentálása.
- **L10** · `src/scheduled/daily-digest.ts:126-155`: a smoke-ellenőrzés last-row-wins és nincs
  ORDER BY → többsoros delivery (skipped fan-out + accepted retry) esetén a verdikt a D1
  sorrendjétől függ → lehetséges hamis CRITICAL vagy elfedett hiba.
- **L11** · `src/lib/deadletter.ts:20-24`: a „6 órás backoff" fiktív — csak a 28-as plafont
  deriválja; a valós ütem az órás cron. Ha a config HIBÁS credentiallal áll vissza, 28 valódi
  hiba ~28 óra alatt elég, és a rekord ~4,5 nappal a hirdetett 7 napos ablak előtt dead-archiválódik.
- **L12** · `scripts/recover-blocked-events.ts:213,226`: a recovery-rekord friss
  `first_failed_at=now`-t kap → a DLQ-ablak recovery+7d-ig fut, túl a Meta event_time+7d ablakán
  (a poszt-ablak retry-k vendor-rejectet kapnak — zaj; lejáratkor lásd H5).
- **L13** · `scripts/patch-site-config.mjs:23-24`: `execFileSync('npx', …, {shell:true})` —
  az argok shell-interpolálódnak, a dupla-`JSON.stringify` idézés platform-törékeny.
- **L14** · `scripts/recover-blocked-events.ts:1`: a shebang (`env node --experimental-strip-types`)
  Linuxon `-S` nélkül nem fut; a dokumentált `node scripts/…` hívás Node ≥23-at feltételez.
- **L15** · `soborbo-tracking/lib/events.ts:38-43` vs `lib/uuid.ts:8-23`: a ténylegesen használt
  `generateEventId()` Math.random-fallbackes, miközben a `uuid.ts` pont ezt tiltotta ki („az
  event_id dedup-kulcs") — két generátor, ellentmondó garanciák.
- **L16** · `soborbo-tracking/lib/persistence.ts:276-285`: a precíz `_fbc`-rekonstrukció
  (`fbclidAt`-ból) halott kód a dispatch-úton — a `sendToWorker` csak a nyers cookie-t küldi,
  a gateway-fallback (`src/lib/attribution.ts:137-144`) pedig a KONVERZIÓ idejével bélyegzi a
  fbc-t, nem a klikkével (match-quality romlás). C1 javítása után válik élővé.
- **L17** · Elavult doksik a konszolidáció (6a63800) után: `client-lib/README.md:5-8` még a
  `Soborbo/claudeskills`-t nevezi kanonikusnak; `scripts/contract-hash.mjs:90,100` nem létező
  `soborbo-tracking/events.json` re-vendorálására utasít; `soborbo-tracking/docs/CHECKLIST.md:21-22`
  önellentmondó; ugyanez `CANONICAL-EVENTS.md:85`, `EVENTS.md:63-65`. A root `README.md`
  mappa-struktúrája a `0*-sprint-*.md`-ket a gyökérben mutatja (docs/archive-ba kerültek, 4e07ace).
- **L18** · `src/routes/admin.ts:81`: `decodeURIComponent` egy `%zz` lead-path-ra URIError →
  500 + TRK-000-001 CRITICAL log-zaj (auth mögött). try/catch → 400.
- **L19** · `src/lib/oauth-state.ts:25-32`: get-then-delete eventually-consistent KV-n — a
  nonce ~60s-ig replayelhető PoP-ok között (kihasználáshoz valid egyszer-használatos Google
  `code` is kell — minimális impakt, teljesség kedvéért).
- **L20** · `src/scheduled/daily-digest.ts`: literál NUL-byte-ok composite-map-kulcs
  szeparátorként — valid JS, de grep/diff-ellenséges. (Megjegyzés, nem hiba.)

---

## Terv-konformancia (FAZIS-0-MUNKACSOMAG v1.1)

Kódban igazoltan KÉSZ: skip-taxonómia (consent_denied/not_expected/not_configured,
TRK-900-008, Queue-bypass egyenesen R2-be, 7 napos ablak, retry_count-nem-növelés),
`recover-blocked-events.ts` minden ígért guardja (dry-run default, 3-elemű kemény allowlist,
PII-mentes output, prod hash, 6 per-event check, idempotencia érintetlen), órás cron + queue
consumer, smoke-őr a digestben, migrations↔kód oszlop-konzisztencia, retention nem bántja a
7 napos pending DLQ-t, CI (typecheck+contract-lock+mindkét tesztsuite).

NINCS kész / sérült:
- **E-2(3-4)**: ga4 api_secret még input-elvárás; guard-teszt nincs (M10).
- **E-3**: secret-scanner nincs a CI-ben (M10).
- **expected_platforms.offline**: definiálva, de sehol nem fogyasztott (H2).
- A C-blokk replay-eszköze élesben elhasalna (H6), és a recovery-rekordok később
  zombi-hurokba esnének (H5).

## Kereszt-megerősítések

- H5-öt két független audit-ág találta meg egymástól függetlenül.
- C1-et a CookieYes hivatalos dokumentációja ellen is ellenőriztük; a package saját
  cookie-parsere (helyes kulcs) belső bizonyíték.
- C1, H1, H3, H4, H5, H6, M2, M3, M5 kézzel, a forrásban újra-ellenőrizve a szintézis előtt.

---

# MÁSODIK KÖR (2. kör) — komponensek, backend-dispatch, maradék src, tesztsuite

A 2. kör azonosítói `K2-` prefixszel. A kézi spot-check-kel megerősítettek: K2-H1, K2-H3,
K2-H4, K2-H5, K2-H6 (meta.test.ts), K2-M1 (nincs AbortSignal a gateway-dispatchben).

## 2. kör — HIGH

### K2-H1 · A RevealContact a CÉG SAJÁT email/telefon értékét küldi be a látogató `user_data`-jaként

- **Hely:** `soborbo-tracking/components/RevealContact.astro:44-45` —
  `trackEmailConversion({ email: value })` / `trackPhoneConversion({ phone: value })`, ahol a
  `value` a site felfedett kontakt-címe (a komponens `value` propja, pl. `hello@example.com`).
- **Hiba:** igazolt lánc: `trackClickConversion(..., params:{email})` → `sendToWorker`
  `user_data.email` → a gateway `em`-mé hash-eli. MINDEN felfedő látogató a cég saját
  email/telefon hash-ével, azonos identitással megy a Metának — az EMQ-t aktívan rontja, és a
  Meta különböző látogatókat egy szintetikus profilba olvaszthat. Kontraszt: a Tracking.astro
  tel:/mailto: auto-bind helyesen PII NÉLKÜL hívja ugyanezeket.
- **Fix:** a `{ email: value }` / `{ phone: value }` argumentumok törlése a RevealContactban.

### K2-H2 · GTM-container: nincs consent-update (újra-tüzelő) trigger — a "2 másodpercnél később elfogadó" látogató teljes böngésző ad-lába elveszik

- **Hely:** `soborbo-tracking/gtm/gen-container.mjs:141-149, 201-213` (+ a generált
  container.json); `components/Tracking.astro:33` (`wait_for_update: 2000`).
- **Hiba:** a base tagek (Google Tag, Meta Pixel Base) csak All Pages triggeren futnak
  consent-gate mögött; a GTM NEM tüzeli újra a consent-blokkolt taget későbbi grant után —
  a 2s-os wait_for_update ablakon túl elfogadó first-visit usernél a Pixel Base sosem fut,
  az `fbq` definiálatlan marad → a konverziós Custom HTML tag `fbq('track',…)` hívása
  ReferenceError → a böngésző-Pixel event elveszik, és a CAPI-legnek nincs dedup-párja.
  Nincs `cookieyes_consent_update` custom-event trigger és History Change trigger sem a
  containerben. Pont a legjobban attribuálható szegmens esik ki (ad → banner-elfogadás →
  konverzió ugyanazon a pageview-n).
- **Fix:** consent-update trigger (CookieYes dataLayer consent-update eventje) a Base/Google
  Tag tüzelési triggerei közé.

### K2-H3 · A callback-flow leadenként KÉT Meta Leadet könyvel — a "shared event_id" a szállított komponensekkel megvalósíthatatlan

- **Hely:** `soborbo-tracking/components/CallbackButton.astro:25` (a `trackCallbackConversion()`
  visszaadott eventId-t eldobja) + `gtm/gen-container.mjs:215-223` (a `Meta Pixel - Lead` tag a
  T_CALLBACK triggeren, azaz a CTA-KLIKKEN tüzel, event_id A).
- **Hiba:** a callback később valódi form-POST lesz, a backend `callback_request_submitted`-et
  dispatchel a CAPI-ra a form hidden-field event_id-jával (B). A≠B → Meta leadenként 2 Leadet
  könyvel (3-at, ha a form TrackedForm és a saját push-a is Leadet tüzel). Ugyanaz a hibaosztály,
  mint a HANDOVER-run6 Beautyflow Lead↔Contact dedup-rése.
- **Fix:** VAGY a Pixel Lead ne a CTA-klikken tüzeljön (csak a form push-án), VAGY a
  CallbackButton írja be az eventId-jét a cél-form `event_id` hidden mezőjébe.

### K2-H4 · A digest "nulla konverzió" riasztását a napi smoke-lead örökre elnémítja — hamis zöld pont a megcélzott incidens-osztály fölött

- **Hely:** `src/scheduled/daily-digest.ts:34-38` — a `collectAcceptedCounts` query-jében
  NINCS smoke-kizárás (szemben a `cross-check.ts:396`-tal, ami `lead_id NOT LIKE 'smoke-%'`-t
  szűr).
- **Hiba:** minden SMOKE_SITES-beli site (az összes éles site) naponta kap egy szintetikus
  eventet a teljes szerver-láncon → `counts.has(siteId)` mindig true → a "ZERO accepted
  conversions" figyelmeztetés (a 06-28→07-13-as néma kiesés őre) SOHA nem tüzelhet, akkor sem,
  ha a valódi kliens-dispatch teljesen meghal.
- **Fix:** `AND (lead_id IS NULL OR (lead_id NOT LIKE 'smoke-%' AND lead_id NOT LIKE
  'dm-validate%'))` a count-querybe (vagy event_id-alapú szűrés).

### K2-H5 · Nincs riasztás-throttling/dedup sehol — kritikus riasztás leadenként/30 percenként a végtelenségig

- **Hely:** `src/lib/notify.ts:153-177` (nincs cooldown/dedup-kulcs/KV-state);
  `src/routes/conversion.ts:757-765, 802-809` (per-konverzió per-platform sendAlert);
  `src/scheduled/slo-check.ts:141-175` (deadCount>0 → 30 percenként újra-email; a dead
  rekordot a retention csak ~90 nap után törli → egyetlen dead rekord ≈ 4300 ismételt email).
- **Hiba:** egy lejárt Meta-token vagy hiányzó config forgalmas site-on MINDEN beérkező
  leadnél email+Twilio SMS-t küld a javításig; a riasztás-fáradtság garantálja, hogy a
  KÖVETKEZŐ valódi kritikus jelzés elveszik + Twilio-költség.
- **Fix:** KV-alapú cooldown `(error_code, site_id)` kulcson (1-6h TTL) a `sendAlert`-ben;
  a slo-checkben "korábban jelentett darabszám" marker.

### K2-H6 · A tesztsuite több helyen a HIBÁS viselkedést betonozza be — a javítások teszt-bukást fognak okozni, ez várt

- `tests/meta.test.ts:141-157` — "includes test_event_code when present in config": a
  CLAUDE.md §17-tiltott KV-fallbacket (1. kör H1) ASSERTÁLJA. A H1-javítással együtt ezt a
  tesztet az ellenkezőjére kell fordítani.
- `tests/prehashed-user-data.test.ts:142-145` — "ignores unknown keys (forward-compat)": a
  néma unknown-key-eldobást (1. kör H3) áldja meg, a függvény saját doc-commentje ("never a
  silent pass-through") ellenében.
- `tests/lead-status-consent.test.ts:81-104, 159-184` — az `ad_personalization` consent-
  fabrikálást (1. kör H4) pinneli; a receipt-stub alakja ki sem tudja fejezni a capture-kori
  ad_personalization=DENIED-et.
- `tests/false-success-and-dispatch.test.ts:202`, `tests/server-ingress.test.ts:147,262,322` —
  a szerver-úti csupasz 204-et (1. kör L7 / §12-eltérés) kontraktusként kódolják.
- **Fix-elv:** ezek NEM megőrzendő tesztek — a kapcsolódó prod-javítással együtt kell őket
  az elvárt (spec-helyes) viselkedésre átírni.

### K2-H7 · A CookieYes-stub robbanási sugara: ~5 kliens-tesztfájl hamis-zöld, és a suite belső inkonzisztenciája árulkodó

- **Hely:** `soborbo-tracking/tests/helpers.ts:3-11` (a C1-es rossz `marketing` alak);
  hamis-zölddé tett fájlok: `index.test.ts` (~25 consent-gatelt flow), `events.test.ts`,
  `flow.test.ts`, `persistence.test.ts:74-79`, és áttételesen `gateway.test.ts:45-55` (a
  cookie-hiányos→JS-API fallback "gclid-megőrzést" bizonyít, ami élesben mindig strip).
  Közben a `gateway-contract.test.ts` a VALÓDI cookie-alakot (`advertisement`) használja —
  egy suite-on belül két ellentmondó CMP-modell.
- **Fix:** a C1-javítás részeként a helper a valódi CookieYes-alakot emittálja, és a
  `consent.test.ts` kapjon no-CMP+prod → deny-all ágat (ma az `isDevMode()` vitest alatt
  mindig true, így a fail-closed ág tesztelhetetlen).

### K2-H8 · Nulla tesztlefedettség a pénz-kritikus rétegeken

- `soborbo-tracking/server/backend/gateway-dispatch.ts` (310 sor, az ÖSSZES
  `server_ingress_only` money-konverzió egyetlen dispatch-útja): EGYETLEN teszt sem importálja.
  A fejlécében felsorolt 5 "silent money bug" kontraktust semmi nem kényszeríti ki.
- `src/worker.ts:170-230` queue() consumer: nulla teszt (attempts-indexelés, archive-then-ack
  sorrend, poison-message út, ack-elnyomás R2-hiba esetén).
- Az 1. kör hibáinak egyike sem volt teszt által megfogható: blocked-config expiry-archive
  (H5), lead-status hiányzó gads-blokk (M3), prehashed rossz-kulcs route-szinten (H3),
  CORS preflight site-configgal (M2), digest többsoros delivery (L10), retention↔7napos
  DLQ-ablak együttműködés. **Szisztematikus minta:** a lomtalan-incidens tanulságai KIZÁRÓLAG
  a böngésző-fan-out lábon lettek letesztelve; az offline CRM-leg, a queue-consumer, a
  scheduled/R2-réteg, a CORS-réteg és a site-backend dispatcher vagy teszteletlen, vagy a
  hibás viselkedést pinneli.

## 2. kör — MEDIUM

### Gateway / src

- **K2-M1** · `soborbo-tracking/server/backend/gateway-dispatch.ts:127-131,279-307`: nincs
  request-timeout (se AbortSignal) — a retry-ciklus a user lead-POST-jában awaitelődik; egy
  beteg gateway 3 lógó fetch + 1,6s sleep erejéig a formot beadó usert várakoztatja. Fix:
  `signal: AbortSignal.timeout(~3000)` per kísérlet.
- **K2-M2** · `gateway-dispatch.ts:160`: `decodeURIComponent` malformed cookie-értéken
  (pl. `%`-ra végződő) URIError-t dob — a hívók a lead-route argumentum-listájában hívják
  inline → a TRACKING miatt 500-azik maga a lead-POST (a modul saját szabálya ellen). Fix:
  try/catch, fallback a nyers értékre.
- **K2-M3** · `soborbo-tracking/components/TrackedForm.astro:122-129,152-168`: nincs valódi
  double-submit védelem — a 600ms-os `waitForTracking` ablakban a második klikk natívan
  submittol, majd a pending handler MÉG EGYSZER `requestSubmit()`-el → két CRM-lead két külön
  lead_id-vel (az offline Google-loop később duplán számolhat); a submit gomb sosem disabled;
  az `isSubmitting` flag sosem resetel. Fix: submitter disable + flag-reset.
- **K2-M4** · `gtm/gen-container.mjs:22,242-243` → container.json: a BOOLEAN paraméterek JSON
  boolean-ként (nem `"true"` stringként) mennek — a valódi GTM-exportok mindig stringet
  használnak; import-elutasítás vagy néma paraméter-eldobás kockázata (Conversion Linker, EC
  enablement). Az awct EC-kulcsok (`enableUserProvidedData`/`userProvidedData`) nem egyeznek
  a valódi awct-exportok Enhanced Conversions szótárával — ha a GTM az ismeretlen kulcsot
  eldobja, az EC némán KI. A `gtm-container.test.ts` ebből semmit nem ellenőriz. Fix: egy
  valódi GTM-exporttal byte-szinten összefésülni.
- **K2-M5** · `soborbo-tracking/lib/events.ts:64-71` + `gen-container.mjs:215-223,234-246`:
  a `trackCalculatorComplete` milestone-push event_id/value nélkül megy, de a GTM-trigger csak
  event-névre illeszt → a `Meta Pixel - Lead` `{eventID:'undefined'}` literált, az awct
  `orderId:"undefined"`-et kap. Ha egy site a lib-komment áldott opcióját követve EZT drótozza
  konverziónak, minden böngésző-Lead `undefined` eventID-n osztozik → a Meta KÜLÖNBÖZŐ userek
  Leadjeit dedupolja össze, a Google orderId-dedupja konverziókat olvaszt össze. Fix:
  event_id+value út a trackCalculatorComplete-nek VAGY a milestone átnevezése.
- **K2-M6** · `gen-container.mjs:84-85,234-246`: EGYETLEN közös Google Ads conversion label a
  quote + callback + phone-click hármasra — telefonklikk ugyanazt az Ads-actiont könyveli, mint
  a beadott árajánlat; a site-inputs (`trapezlemezes.json`) 4 külön action-ID-t sorol fel. Fix:
  eventtípusonként külön label-konstans + awct tag.
- **K2-M7** · `src/worker.ts:170-230` + `src/scheduled/retry.ts:152-165`: a queue-consumer
  BUKOTT retry-ja nem ír `rejected` delivery-sort (`recordRetryDelivery` csak sikerkor hívódik)
  → a reconciliation vendor_failure_rate-je pont kiesés alatt mér alul (5 bukásból 1 látszik).
  Fix: bukott/kimerült retry is kerüljön a ledgerbe `origin='retry'`-val.
- **K2-M8** · `src/lib/emq.ts:165-181`: a coverage-drop proxy az ÖSSZES events_raw sor fölött
  számol, a strukturálisan em/ph-mentes klikk-eventeket is beleértve → egy klikk-kampány hamis
  EMQ_COVERAGE_DROP riasztást szül, egy alacsony volumenű form-em-törés pedig elbújhat. Fix: a
  query szűkítése konverzió-típusú (vagy ad_allowed=1) eventekre.

### Tesztsuite (a K2-H6/H7/H8-on túl)

- **K2-M9** · `tests/daily-digest.test.ts:139-150`: a D1-stub site/platformonként mindig
  PONTOSAN egy delivery-sort ad → az 1. kör L10 (no-ORDER-BY last-write-wins) rendezési hibája
  strukturálisan tesztelhetetlen; a stub SQL-substring-dispatchel és a `LIKE 'smoke-%'`
  predikátumot sosem futtatja.
- **K2-M10** · CORS/preflight: nulla teszt (`corsHeaders`/`resolveAllowedOrigin`/OPTIONS), és
  az `origin.test.ts:59-69` (per-site allowed_origins az ingressen) hamis magabiztosságot ad
  egy olyan knobról, aminek a preflight-lába törött (1. kör M2).
- **K2-M11** · `src/scheduled/retention.ts` (cursor-loop, uploaded-Date szemantika,
  dead-only kapu) és a `listPendingRetries` R2-lapozása teszteletlen — minden R2-list stub
  egyoldalas, nem-truncated választ ad.
- **K2-M12** · A conversion-tesztek env-jéből az `INGEST_LIMITER` hiányzik (csak admin.test
  stubolja) → a limiter-hívások teljes törlése is zöld maradna; az 1. kör M8 útjai
  teszteletlenek.
- **K2-M13** · `tests/meta-parity.test.ts` tautologikus: az elvárást ugyanabból az
  events.json-ból generálja, amiből a kód — a valódi kockázatot (elgépelt Meta standard
  event-név az events.json-ban) semmi nem validálja a Meta tényleges szótára ellen.

## 2. kör — LOW

- **K2-L1** · `notify.ts:30-33`: RFC 2047 sértés — egyetlen, korlátlan hosszú encoded-word a
  subjectben (75 char a plafon); hosszú magyar/emoji-s subjectet downstream MTA-k
  torzíthatnak. Fix: chunkolás.
- **K2-L2** · `worker.ts:133-153`: nem illeszkedő cron-string néma no-op — wrangler.toml
  trigger-átírás worker.ts nélkül = az adott alrendszer (pl. DLQ-retry) hang nélkül kikapcsol.
  Fix: záró else + error log.
- **K2-L3** · Index-hiányok: `consent_receipts.lead_id` (a forró `/lead-status` út
  full-scanel receipt-miss esetén), `deliveries.lead_id` (getLeadTrail), és a napi cronok
  csupasz timestamp-range szűrései a (site_id,ts) kompozitokkal nem kiszolgálhatók. Jelen
  volumenen elfogadható; skálázás előtt pótolni.
- **K2-L4** · `scheduled/retention.ts:84`: a dead-rekord kora az `obj.uploaded`-ból számolódik,
  amit az archiválás resetel → a day-0 hiba payloadja (nyers event_payload + hashed_user_data,
  PII at rest) ~97 napig él 90 helyett. GDPR data-minimization drift; javítani vagy
  dokumentálni.
- **K2-L5** · `slo-check.ts:10-13` duplikálja az `isDeadKey`-t import helyett —
  kulcsformátum-változásnál a pending/dead számok szétcsúsznak.
- **K2-L6** · `error-codes.ts:1-17` fejléc-taxonómia: a 960-as sáv és az alfa-sávok
  (TRK-EVT/GA4/META/PROV/CFG) hiányoznak a fájl SAJÁT fejlécéből (a docs/error-codes.md
  driftjén felül).
- **K2-L7** · `metrics.ts`: három különböző blob-séma egy AE-datasetben, csak index-értékkel
  megkülönböztetve — blob-pozíciós lekérdezés csendben kever. (Az írások helyesen
  nem-blokkolók.)
- **K2-L8** · `gateway-dispatch.ts:292-301`: a nem-listázott 4xx-ek (405/408/413/415/422/429)
  a retry-ciklusba esnek — 413/415/422 retry-ból sosem javul (~1,6s felesleges latencia).
- **K2-L9** · `gateway-dispatch.ts:212-224`: pozitív `value` currency nélkül némán elvész
  (nincs log) — a szerver-leg ROAS-érték csendes vesztése.
- **K2-L10** · `TrackedForm.astro:151` + `lib/index.ts:141-142,285-299`: a gclid/fbclid hidden
  mezők consent-blokkolt esetben IS kitöltődnek (a `trackLeadSubmit` a consent-check ELŐTT
  olvassa őket) → a klikk-ID-k nem-consentelt usernél is a form-POST-tal a CRM/Sheets felé
  utaznak. A vendor-küldést a gateway fail-close-olja, de az ID-k site-oldalt tárolódnak.
- **K2-L11** · Site-oldali durabilitás: a dispatch-kimerülés csak logol (backend/README
  szerint) — a gateway DLQ-ja csak az odáig eljutott eventeket fedi; gateway-kiesésnél a
  form-konverziók szerver-lába végleg elvész. Dokumentáltan vállalt (smoke/digest észleli),
  de ez detektálás, nem recovery.
- **K2-L12** · `monitoring/watchdog.ts:64-99`: a watchdog SAJÁT hibája néma (waitUntil-ben
  rejectel, se alert, se heartbeat) — a védőháló észrevétlenül rohadhat; a `KEY_EVENTS`-beli
  `primary_conversion` nem létezik az events.json-ban.
- **K2-L13** · `server/backend/smoke.ts:32`: a `REPLACE_ME_SITE_ID` placeholder őrizetlenül
  dispatchelődik, ha nem írják át.
- **K2-L14** · Container-név "canonical (v5)" vs package v6 — kozmetikai, de import közben
  zavaró.
- **K2-L15** · Tautologikus tesztek: `consent.test.ts:29-33` (`typeof === 'boolean'` bármire
  átmegy), `persistence.test.ts:134-137` (`toContain(getDevice())` nem tud bukni).
- **K2-L16** · A D1-fake-ek SQL-substringre dispatchelnek és scriptelt sorokat adnak — a
  `checkIdempotency` RETURNING/upsert-konfliktus szemantikája sosem fut valódi SQLite ellen;
  nincs integrációs szint (miniflare/wrangler D1) a kompenzálásra.

## 2. kör — tisztának igazolt

`admin-ui.ts` (textContent-only render, CSP), OAuth-route-hármas (a már ismert két LOW-n túl),
`debug-ga4.ts` (mindig /debug/mp/collect, prod-eventet nem tud küldeni), `health.ts`,
`provenance.ts`, `attribution.ts`, `skip-reason.ts`; emq százalék-matek és cross-check/recon
query-alakok, dátum-injection guardok; retention SQL parametrizált; queue() per-message
try/catch (poison-message nem mérgezi a batch-et — de teszteletlen, lásd K2-H8);
PhoneLink/TrackingNoscript/examples/site-inputs/smoke-test.sh/SETUP-SERVER.md/
gen-event-aliases.mjs; gateway-dispatch mag-kontraktjai (4xx nem-retriable magja, azonos body
retry-n át, header/útvonal-egyezés a worker-rel, cookie-parser helyes `advertisement` kulcsa,
per-request test_event_code, value:0 nem küldhető); a kliens-suite kontraktus-erős darabjai
(`gateway-contract.test.ts`, forwarder-tesztek, hash-tesztek, `skip-classification.test.ts` a
böngésző-lábra, `worker-error-status.test.ts`); a teszt-idő-kezelés tiszta (nincs rothadó dátum).

## Tisztának igazolt területek (nem kell hozzányúlni)

Rule-1 normalizálók (Meta email-szabály, ékezet-megőrzés, postal-kötőjel, ISO-allowlist);
fbp/fbc/ip/UA/event_id plain; event_time seconds (LinkedIn ms-szorzója helyes); legacy gads
datetime vs Data Manager RFC3339 szétválasztás; DM address (nincs city, regionCode plain
uppercase); allSettled + enqueueFailure-boolean + TRK-900-007 + háromrétegű
accepted-requires-http_status; prehashed data soha nem re-hash-elődik és a böngésző-út eldobja;
determinisztikus orderId=transactionId; browser-út user_data_hashed/test_event_code/client_ip
drop; high-value gate kanonikus néven (alias-bypass nincs); admin-token timing-safe compare;
contract-sync (events.json ↔ event-contract.ts ↔ GTM container byte-azonos regenerálás);
R2-kulcs ütközésmentesség; cron-stringek ↔ worker.scheduled 1:1; retention-guardok.
