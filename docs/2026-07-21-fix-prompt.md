# Javító prompt — 2026-07-21 audit

> Ezt a promptot add oda egy Claude Code runnak a `Soborbo/Serverside` repóban.
> A hivatkozott hibák teljes leírása (file:line, hibaforgatókönyv, kontextus):
> `docs/2026-07-21-full-audit.md`. A találat-azonosítók (C1, H1…) onnan jönnek.

---

## PROMPT (innentől másolható)

Olvasd el ELŐSZÖR: `CLAUDE.md` (kötelező szabályok), `docs/2026-07-21-full-audit.md`
(a javítandó hibák teljes listája file:line hivatkozásokkal), és a
`FAZIS-0-MUNKACSOMAG.md`-t (kontextus). A feladatod az auditban talált hibák javítása
az alábbi sorrendben és keretek között.

### Kötelező keretek (minden javításra)

1. **NE építs vissza** semmit, amit a README/CLAUDE.md töröltnek jelöl (Turnstile-validáció,
   quote-state DO, on-site szerver GA4/Google Ads leg, offline GA4).
2. Minden javításhoz **teszt is kell**: vagy meglévő teszt javítása (ha az volt hibás — pl.
   C1-nél a teszt-helper), vagy új regressziós teszt, ami a javítás előtt bukna.
3. Minden fázis végén fusson zölden: `npm run typecheck && npm test && npm run check:events
   && npm run check:contract` (repo-root), ÉS `cd soborbo-tracking && npm run typecheck && npm test`.
4. **NE nyúlj éles erőforráshoz** (KV, D1, R2, deploy) — csak kód, teszt, doksi.
5. Kis, fókuszált commitok: fázisonként/találatonként külön commit, a commit-üzenetben az
   audit-azonosítóval (pl. `fix(dlq): expired blocked-config archive loop (audit H5)`).
6. Ha egy javítás wire-kontraktust érint (H3), a döntést NE egyszerűsítsd le némán — tartsd
   magad az auditban javasolt irányhoz, és dokumentáld a kontraktus-változást az érintett
   doc-kommentekben + `docs/`-ban.
7. Amit az audit „Tisztának igazolt" szekciója felsorol, ahhoz NE nyúlj.

### 0. fázis — HATÁRIDŐS (a 07-22-i replay előtt kell)

- **H6**: `scripts/recover-blocked-events.ts:249` — a `wrangler r2 object put` hívásba kerüljön
  be a `--jurisdiction eu` flag (a bucket `jurisdiction="eu"`, lásd wrangler.toml:186-187).
  Teszt: a script parancs-összeállítását unit-teszttel fedd le (a wrangler-hívás argv-jét
  assertáld, wrangler tényleges futtatása nélkül).
- **H5**: `src/lib/deadletter.ts` `archiveExpiredRecord` — `retry_count:
  Math.max(record.retry_count, maxRetriesFor(record))` (MAX_RETRIES helyett), hogy a lejárt
  blocked-config rekord tényleg a `dead/` prefixre kerüljön és ne essen örök pending↔archive
  hurokba. Regressziós teszt: blocked_configuration=true, retry_count=0, lejárt ablak →
  az archív kulcs `isDeadKey`, és második archiválási kör NEM történik.

### 1. fázis — CRITICAL

- **C1**: `soborbo-tracking/lib/consent.ts` — a CookieYes JS-API valódi kategória-kulcsa
  `advertisement`, nem `marketing`. A `getCookieYesConsent()` mappelje az `advertisement`-et
  a lib `marketing` fogalmára; javítsd a `Window.getCkyConsent` típusdeklarációt (a valódi
  alak: `necessary/functional/analytics/performance/advertisement`), és — KRITIKUS — a
  `tests/helpers.ts` stubja a VALÓDI CookieYes-alakot emittálja (`advertisement` kulccsal),
  hogy a suite a CMP-t tesztelje, ne a feltételezést. Nézd át az összes `c.marketing`
  fogyasztót (`index.ts:79` onConsentChange, `waitForConsent('marketing')` hívások) — a
  publikus `ConsentCategory` API maradhat `marketing`, de a CMP-határon egyetlen helyen
  történjen a fordítás.

### 2. fázis — HIGH

- **H1**: `src/lib/meta.ts:134` — töröld a `|| meta.test_event_code` fallbacket (csak
  `payload.test_event_code`); ha a KV-configban `meta.test_event_code` van, CRITICAL
  strukturált log (ne tiszteld az értéket). Vezesd ki a mezőt a `SiteConfig` típusból
  (`src/lib/config.ts:23`). `scripts/setup-painless.sh`: a test_event_code KV-ba írása
  szűnjön meg (per-request marad az egyetlen út), és töröld a `TURNSTILE_SECRET_KEY`
  provisioning lépést (M10 része). Teszt: KV-configban test_event_code → a Meta-request
  body-jában NINCS test_event_code + CRITICAL log születik.
- **H2**: az offline láb `not_configured` védelme. `src/lib/datamanager.ts`: a config-hiányos
  skip kapjon `skip_reason: 'not_configured'`-ot (GAdsResult bővítés);
  `src/routes/lead-status.ts`: `isExpectedPlatform(siteConfig, 'offline', 'gads')` (vagy a
  meglévő helper offline-ágának bekötése) — elvárt platformon hiányzó config esetén
  `blocked_configuration` DLQ-rekord (R2, 7 napos ablak — a `conversion.ts:785-829` mintája)
  + TRK-900-008 CRITICAL alert; a CRM-válasz jelezze a blokkolt állapotot. Az
  `expected_platforms.offline` mező így végre fogyasztásra kerül. Tesztek: elvárt+hiányzó
  config → DLQ-rekord + alert; nem-elvárt → csendes skip marad.
- **H3**: prehashed email-kontrakt egyértelműsítése. `src/lib/hash.ts`: két külön wire-kulcs —
  `sha256_email` (Meta-normalizált; /conversion-server) és `sha256_email_google`
  (Google-normalizált; /lead-status). Endpointonként a NEM odavaló email-kulcs → 400
  (TRK-400-019 vagy új kód), és minden `sha256_`-prefixű, de nem ismert kulcs → 400 (typo-védelem,
  ne néma ignore). Igazítsd a `lead-status.ts:48-50` doc-kommentet a tényleges kulcsnévhez.
  Ügyelj: a `mapped.data = {}` üres-objektum truthy-bug (a `??` fallback kiütése) is szűnjön
  meg — üres prehash-eredmény esetén a raw-út fusson. Tesztek: rossz kulcs 400; üres prehash →
  fallback hash-elés; a helyes kulcs endpoint-helyesen mappel.
- **H4**: `src/lib/ledger.ts` `getLatestConsentForLead` adja vissza az `ad_personalization`-t
  is; `src/routes/lead-status.ts` a két consent-jelet FÜGGETLENÜL mappelje (GRANTED/DENIED/
  ismeretlen→mező kihagyva) — soha ne származtasson ad_personalization=GRANTED-et pusztán
  ad_user_data-jelből. Teszt: receipt ad_user_data=GRANTED + ad_personalization=DENIED →
  a Data Manager payloadban ad_personalization=DENIED (nem GRANTED).
- **H7**: `scripts/bootstrap-cloudflare.sh` — a bucket-létrehozás `soborbo-tracking-dlq-eu`
  néven `--jurisdiction eu`-val; a toml-patch sed-jét szkópold a megfelelő
  `[[kv_namespaces]]` blokkra (awk/marker-alapú), és az OAUTH_TOKENS id-t külön, helyesen
  patcheld. Teszt: shell-script viselkedés fixture-tomlon (vagy legalább a patch-logika
  kiemelése node-ba és unit-teszt).

### 3. fázis — MEDIUM

Sorrendben: M1 (meta.ts hibaüzenet-sanitizálás + központi sanitizálás a
`normalizeDelivery`-ben, a `String(settled.reason)` ágat is), M2 (CORS: site-config-alapú
origin-feloldás az OPTIONS/response úton, `allowedOriginHosts` újrahasznosítással),
M3 (KV-config shape-guard + TRK-CFG-001 + optional-chain a `gads` olvasásoknál),
M4 (`generate-site.mjs` emitáljon `expected_platforms: {smoke:['meta']}`-t meta-blokk esetén),
M5 (wrangler.toml Queues-komment vs valóság rendezése — kérdezd meg a usert, melyik állapot
igaz: ha a queue-k léteznek, a kommentet+docs-ot igazítsd; ha nem, kommenteld vissza a
blokkokat), M6 ('EU' country-code ne kényszerítsen +44-et), M7 (`isValidConversionPayload`:
`user_data` nem-tömb objektum), M8 (rate-limit a 404-úton + token-jelenlétnél a limiter a
KV-olvasás elé), M9 (error-codes.md regenerálás + CI-check az enum↔doksi teljességre),
M10 maradéka (ga4 api_secret kivezetése a generate-site inputból + guard-teszt + secret-scanner
lépés a CI-be), M11 (slo-check try/catch izoláció), M12 (`collectAttribution`: tartós írás
csak consenttel), M13 (SKILL.md példa kanonikus kulcsokkal).

### 4. fázis — LOW (idő függvényében; egyenként kicsi)

L1-L20 a `docs/2026-07-21-full-audit.md` szerint. Kiemelten megéri: L3 (ga4 random client_id
helyett skip), L6 (admin discard őszinte válasza + do_not_replay tisztelete a cronban),
L8 (Turnstile-maradvány mező+kommentek törlése), L10 (digest smoke-verdikt determinisztikus),
L15 (egyetlen event_id-generátor), L17 (elavult doksik: client-lib/README, contract-hash
üzenete, CHECKLIST/CANONICAL-EVENTS/EVENTS re-vendor lépések, README mappa-struktúra).
L9-nél (begin_checkout + browser-úti user_data) NE dönts egyedül — tedd fel a kérdést a
usernek (curl-hamisítható match-data vs legitim use-case), és a döntése szerint járj el.

### Átadás

A végén frissítsd a `docs/2026-07-21-full-audit.md`-t: minden találat mellé ✅ (javítva,
commit-SHA) / ⏭ (kihagyva, indokkal) / ❓ (user-döntésre vár). Foglald össze a válaszodban,
mi változott, mi maradt nyitva, és mely javítás igényel operátori lépést (pl. M5 queue-k,
H6 utáni éles replay-futtatás).
