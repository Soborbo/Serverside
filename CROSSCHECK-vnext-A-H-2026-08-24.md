# vNext terv — 37. fejezet A–H cross-check + állítás-verifikáció (2026-08-24)

**Bemenet:** `D:\soborbo-tracking-vnext-teljes-terv.md` (53 KB terv) + az első cross-check vélemény.
**Módszer:** 3 párhuzamos repo-audit (kliens-package · gateway/generator/events · CRM) + git/PR-leltár. Minden állítás mögött fájl+sor. Implementáció NEM történt.
**Repo-állapot a cross-check pillanatában:** Serverside `feat/soborbo-cmp-fazis2` @ `7959a95` (= origin, PR #67 NYITVA); CRM origin/main @ `ac6cec8`, working tree `feat/beautyflow-services-treatments` + 4 uncommitted tracking-fájl.

---

## 0. Branch/worktree-leltár (a „bizonyítsd" kérés)

| Tény | Evidencia |
|---|---|
| `feat/soborbo-cmp-fazis2` **origin-on létezik** | `git ls-remote origin` → `7959a95 refs/heads/feat/soborbo-cmp-fazis2`; lokális HEAD azonos, nincs unpushed commit |
| **PR #67 NYITVA** rá | „CMP Fázis 2 — saját consent-modul kliensoldala + offline-feloldás (inert, provider-flag mögött)", 2026-08-24 12:37 |
| 5 commit a main előtt | `c7eaa12` (2.5 gateway offline/replay) → `252e3af` (kliens-mag: consent-sbo.ts, consent-sbo-state.ts) → `a8500d1` (2.1+2.2: Tracking.astro sbo-ág, ConsentBanner) → `0fc9917` (2.7: harness provider-param) → `7959a95` (runbook + schema consent-blokk + INSTALL sbo-szekció) |
| PR #63 (Fázis 1, `feat/soborbo-cmp`) | MERGED 2026-08-17 — a GitHubon látott branch ez volt |
| Serverside working tree | a tracking-kód tiszta; untracked csak doksik/handoverek/scriptek |
| **CRM uncommitted munka** | `gateway-sender.ts +13`, `lifecycle.ts +38-3`, `ads.ts +1`, `lifecycle.test.ts +64` — **click-ID-propagáció a lifecycle-outboxba** (lásd D.4) — SEMMILYEN branchen nincs, csak a working tree-ben |
| CRM lokális main | elavult ref (`d8617e4`), de a tracking-modul bájt-azonos `d8617e4`↔`ac6cec8`↔HEAD között — a main-idézetek mind érvényesek |

---

## 1. Korábbi „már kész / folyamatban" állítások verifikációja

| Állítás | Státusz | Evidencia |
|---|---|---|
| `test_event_code` gate „csak CLAUDE.md-szabály" | **OBSOLETE (az állításom volt téves) → DONE** | `generate-site.mjs:120-129` hard error; `--allow-test-event-code` bypass `:63,:70,:324`; schema-tükör `site-config.schema.json:44-46`. ⚠️ Maradék-rés: a bypass-flaggel a kód **KV-configba is beíródik** (`:204`), csak checklist-sor figyelmeztet (`:284`) |
| INV-010 (accepted csak vendor-státusszal) kész | **DONE** | `src/lib/ledger.ts:132` `normalizeDelivery`, `src/lib/error-codes.ts:200` `TRK-950-004`; retry-út is ezen könyvel (`retry.ts:82,217`) |
| CMP Fázis 2 „folyamatban a lokális branchen" | **PARTIAL — de NEM local-unpushed: pusholt branch + nyitott PR #67** | lásd 0. pont. Kliens-mag+banner+boot+harness+szerver-replay-kapu KÉSZ a branchen; main-merge, pilot-site-flip, CookieYes-migráció NINCS |
| GTM-konformancia-alap létezik (`check:events`) | **PARTIAL — pontosítva** | `soborbo-tracking/server/check-event-contract.mjs`: code↔docs↔**committed** `gtm/container.json` (trigger-lét, ≥1 aktív tag, orphan-warn). **ÉLŐ GTM-ellenőrzés NULLA** — GTM API-hívás sehol (grep: csak MCP-permission + narratíva). ⚠️ Két különböző `check:events` él azonos névvel: a root `server/check-event-contract.mjs` CSAK az events.json belső alakját nézi, GTM-et nem |
| Data Manager-migráció kész | **DONE** | `lib/datamanager.ts` él, lead-status→Data Manager út a normalizeDelivery-n könyvel (`datamanager.ts:22`) |
| High-value gate (money = szerver-ingress-only) kész | **DONE** | `events.json`: 5 event `server_ingress_only:true` (quote/callback/contact/order_request/purchase); kliens-oldali dokumentálás `lib/index.ts:16-20` (TRK-400-017) |
| „Reconciliation-réteg nincs" | **PARTIAL — pontosítva** | Reconciliation-cron LÉTEZIK (`src/scheduled/reconciliation.ts`, naponta 8:15): vendor_failure_rate + coverage_drift (csak Meta), cross-check GA4 Data API + GAQL ellen (opt-in `recon` blokk). **DE: üzleti-darabszám ↔ tracking egyeztetés NINCS** — a `lead_status_total` mező létezik a structban (`lib/reconciliation.ts:35,249`), de **senki nem olvassa** (halott súly). Minden mai check pipeline-health, nem business truth |

---

## 2. A–H cross-check

### A. Jelenlegi implementáció, ami ellentmond a tervnek (fájl + sor + indok)

| # | Ellentmondás | Evidencia | Tervpont |
|---|---|---|---|
| A1 | **CookieYes script a consent-default ELŐTT renderelődik, MINDKÉT módban** (sbo-ban is, ha `cookieYesId` átadva — párhuzamos-ablak dizájn) | `Tracking.astro:37-40` (CKY) vs `:42-59` / `:71-125` (default) | §9.4 „consent bootstrap a legelső" |
| A2 | **Tag Gateway bekapcsolását két doksi ma is előírja** | `INSTALL.md:117-118`, `docs/cloudflare-setup.md:3-7` | §4.1 default OFF |
| A3 | **Érvényes `ga4` blokk némán KV-be íródik**; a hiányzó blokk warningja ráadásul azt sugallja, hogy kellene („kimarad ennél a site-nál") | `generate-site.mjs:135-143, 198-203` | §4.2 GA4 MP ki a generátorból |
| A4 | **Browser money-conversion submit ELŐTT tüzel**: `validate → track → 600ms vak wait → submit`; a `quote_calculator_submitted` push a GTM-ben Google Ads awct (+EC user data!), GA4 és Meta Pixel Lead taget indít | `TrackedForm.astro:124-152`; `lib/index.ts:378-380` (vak timer); `gen-container.mjs:234-246` (awct), `:215-223` (Pixel Lead) | §4.3, INV-001/002 |
| A5 | **EC side-channel nyers mutable global** (`window.__sbUserData` + `#__sb_user_data__` hidden div), getter-API nincs; consent-visszavonás NEM üríti (`purgeMarketingStorage` nem nyúl hozzá), csak az 5 mp-es timer | `events.ts:121-140`, `persistence.ts:481-485` | §11.4 |
| A6 | **Copy-based install ma is előírás** (components/+lib/ másolás, backend-fájlok másolása) | `INSTALL.md:107-109, 140-141` | §4.4, §18 |
| A7 | **Három consent-state alak él egyszerre**: kliens sbo (analytics/marketing kategóriák, `consent-sbo-state.ts:40-49`) ↔ szerver Google-szignálok (4 mező, `src/lib/consent.ts:28-35`) ↔ CookieYes-kategóriák (`consent.ts:228-264`). Mapping van, egyetlen kanonikus típus nincs | fenti sorok | INV-004 |
| A8 | **A generátor round-tripje ADATVESZTŐ**: `toSiteConfig` fix mezőlistát épít, a `consent` / `consent_strict` / `recon` / `monitoring` blokkot **némán eldobja** — egy sbo-pilot site configját újragenerálva a pilot-flag eltűnne a KV-ből | `generate-site.mjs:183-219` | §16-17, INV-007 |
| A9 | **Doksi↔runtime drift a consent-defaultról**: `docs/gtm-setup.md` szerint Custom HTML GTM-tag, a valóság inline `Tracking.astro` (ahogy `gen-container.mjs:135-139` is mondja) | gtm-setup.md „Tags — base" | §20.5, Phase 0 truth freeze |
| A10 | **Duplicate-GTM-védelem cookieyes-módban nincs** (vanilla snippet), sbo-módban van (`__sboLoadGtm` loaded-flag, de render-enként újraassignolódik) | `Tracking.astro:62-68` vs `:88-90` | §28.2 „GTM exactly one" |
| A11 | **UK-site a generátorban semmilyen consent-figyelmeztetést nem kap**: `GB` benne van az `ALLOWED_COUNTRIES`-ban, de nincs az `EEA_COUNTRIES`-ban → a `require_consent` warning ki sem váltódik | `generate-site.mjs:54-55, 176-179` | §41.5 (ICO), §17.3 |

### B. Tervpontok, amik meglévőt építenének újra (reuse-javaslattal)

| # | Tervpont | Már létezik | Reuse |
|---|---|---|---|
| B1 | §29 reconciliation-infra | Cron-slotok, digest, alerting, GA4 Data API + GAQL cross-check, threshold-modell mind él (`scheduled/reconciliation.ts`, `lib/cross-check.ts:455+`) | CSAK az üzleti leg hiányzik: a már létező (de holt) `lead_status_total` + egy CRM-count bemenet bekötése a `computeSiteDrift`-be. **Nem új rendszer — egy új láb.** |
| B2 | §10.3 runtime scan + §27.6 consent-mátrix | `tests/compliance/` (687 soros Playwright-harness): A/B/C/D/GPC szcenáriók, pre-consent storage/request/cookie/GTM-sorrend checkek, POST-body-inspekció, gombparitás-mérés, provider-paraméterezés, 13 site | Hiányzik: analytics-only szcenárió, vendor-registry a classify-hoz, CI-kompatibilis mód (ma explicit „NEM CI-BA VALÓ") |
| B3 | §9.9 consent receipt store | `consent_log` D1-tábla (0006): consent_id / consent_event_id (idempotencia) / monoton revision / kötelező 4 verziómező / withdrawal-as-new-row / replay-gate (`consent-log.ts`, `ledger.ts:607-733`) | A terv receipt-store-ja szerveroldalon KÉSZ. Ne épüljön második. |
| B4 | §17 generator hard errors | 22 hard-error-feltétel él, köztük unknown-event (conversion_actions kulcsokra), token-rotációs guard, determinisztikus output (verifikálva: nincs Date.now/random a token kivételével) | A hiányzó kapukat (lásd E) a MEGLÉVŐ `validate()`-be kell tenni, nem új validátorba |
| B5 | §13.3 idempotencia | CRM: `onConflictDoNothing` + determinisztikus kulcsok (`lc:`/`oc:`/`src:`/`ev:`) + payloadHash; gateway: event_id-dedup + `markDoNotReplay` | Kész minta, a PRG-token flow ehhez csatlakozzon |
| B6 | §8.3 ecommerce-taxonómia | `events.json` már tartalmazza: view_item, add_to_cart, begin_checkout, add_payment_info, order_request_submitted (flow A), purchase (flow B, server_ingress_only) | Hiányzik CSAK: `refund`; subscription-eventek egyáltalán nincsenek (de fleet-igény sincs — lásd G) |
| B7 | §26 attribution | Kliens: last-touch click-ID/UTM + first-touch landing/referrer (`gateway.ts:286-430`) + külön first/last párok (`persistence.ts:60-69`, 90 nap); CRM: `lead_attribution` set-once snapshot (§26.2 leadgenre KÉSZ) | ⚠️ a gateway-ledger SZÁNDÉKOSAN csak presence-flageket tárol (0001/0002 migráció) — a terv trace-elvárását ehhez kell igazítani, nem fordítva |
| B8 | §30 observability | Strukturált hibakódok, EMQ-monitoring, version-drift CI, SLO-spike, manifest-drift, smoke-őr | A terv §30.3 browser-diagnostics részben él (storage_read_blocked telemetria, TRK-3001 PII-őr) |

### C. Technikailag hibás vagy túl drága tervpontok (alternatívával)

1. **Fleet-wide generated GTM P1-ként** — a mai `gen-container.mjs` EGY hardcode-olt leadgen-profil placeholder ID-kkal (nincs input-fájl, `:279-280`); a per-site paraméterezés + élő containerek migrációja a tényleges munka. *Alternatíva (a korábbi körben már elfogadva):* élő-container konformancia-check most, generálás új site-oknál + fokozatosan.
2. **§9.3 `receiptId` a cookie-ban** — a jelenlegi dizájn tudatosan NEM teszi a `consent_event_id`-t a sütibe (döntésenként friss UUID, wire-only), a hivatkozás `consent_id`+`revision` párral megoldott. A terv szerinti cookie-beli receiptId visszalépés lenne. *Alternatíva:* a terv §9.3-at igazítani a megvalósult modellhez.
3. **§16 site registry új YAML-rétegként** — ma már 3 formátum él (generator-input JSON + `site-config.schema.json`, KV-config, `src/site-manifest.json` fingerprintek). Egy negyedik formátum = új driftfelület. *Alternatíva:* a meglévő generator-input séma bővüljön registry-vé (consent/recon/profile mezőkkel — az A8-as eldobás-bug fixével együtt).
4. **INV-008 unknown-tracker deploy-blocker azonnal hard gate-ként** — a harness hálózatfüggő és explicit nem CI-be való; 6 site `cmp:"unknown"`. *Alternatíva:* a terv saját CSP-mintája szerint: report-only → alert → gate, a vendor-registry stabilizálódása után.
5. **§27.7 „payment fail → purchase 0" E2E** — a fleetben nincs online payment-flow (a webshop-checkout lead-ként megy a CRM-be, lásd F5); ez az E2E ma teszthetetlen, ne legyen kapu, amíg nincs ilyen site.

### D. Migrációs / adatvesztési kockázatok

1. **CookieYes → sbo consent-átvitel: NULLA sor kód.** Grep (`migrat|legacy|seed|örököl|átvesz`) a consent-sbo modulokban: nincs találat. A `readCkyParallelWindow()` (`consent-sbo.ts:83-105`) CSAK telemetriát másol a POST-payloadba, állapotot nem. Sbo-flip után minden korábbi accept elveszik → banner újra mindenkinek, GTM le, amíg nem dönt. A `legacyConsentMigrationPolicy` (user-döntés) jelenleg nem is scaffoldolt. **A pilot-flip (runbook 2.6) előtt döntés kell: migrál vagy tudatos re-consent.**
2. **Generátor-újrafuttatás = pilot-flag-vesztés** (A8): amíg a `toSiteConfig` eldobja a `consent`/`recon` blokkot, egy sbo-site KV-jének újragenerálása némán visszabillenti CookieYes-módba a szervert. Ez a terv Phase 1 előtti P0-fix.
3. **Commit-after-success cutover**: a konverzió a form-oldalról a thank-you-oldalra kerül → (a) Meta dedup: a szerver-CAPI event_id-nek át kell élnie a PRG-redirectet (signed token); (b) Ads-riporting: a bot/validation-fail konverziók eltűnése **szándékos, de látható volumencsökkenés** — a hirdetőt előre tájékoztatni kell; (c) átmenet alatt double-fire/zero-fire ablak — canary + E2E kötelező.
4. **A CRM click-ID-fix csak working tree-ben él.** A 2026-08-09-es incidens (16 `revenue_confirmed` gclid nélkül, **nulla match**) javítása — gclid/gbraid/wbraid a `lead_attribution`-ből a lifecycle-outboxba és top-level a `/lead-status` bodyba — 4 fájlban uncommitted, semmilyen branchen. Egy checkout/clean elviszi. **Első teendő: branch+commit+PR.** (Mellékhatás: a payloadHash változik az új mezőkkel; a dedup-kulcs nem — a már-enqueue-olt sorok nem duplázódnak.)
5. **GTM**: nincs big-bang rename (a terv §8.1 helyesen), `legacy_ga4` aliasok élnek; a konformancia-fázis alatt az élő v13/v29/v30/v31 containerek exportját menteni (Phase 0 tétel a tervben — helyes).
6. **OAuth**: a GADS_OAUTH_CLIENT_ID + DEVELOPER_TOKEN a mai napig hiányzik a live workerről (🔴 memória, 2026-07-15 óta) — a terv §11.8 EC-account-verifier-e fleet-szinten bukna; **ops-fix a verifier előtt**.
7. **D1**: `consent_log` max-revision 10 000 guard + retention-cron él; a 0006 migráció éles D1-ellenőrzése a pilot-flip előfeltétele (runbook szerint is).

### E. Géppel ma nem enforce-olható invariánsok + kellő kapu

| Invariáns | Ma | Kellő kapu |
|---|---|---|
| INV-001/002 (business truth first) | NEM enforce-olható — a TrackedForm dizájnból tüzel pre-submit | Money-path E2E (§27.7) + TrackedForm-redesign; addig legalább egy teszt, ami a MAI viselkedést rögzíti dokumentáltan |
| INV-004 (egy ConsentState) | 3 alak, mapping-tesztek külön-külön | Cross-layer ekvivalencia-kontraktus-teszt (sbo-cookie → kliens-kategória → wire → szerver-szignál végig egy fixture-ön) |
| INV-005/006 (site-kódban tilos raw CMP-parse / fbq / gtag) | Semmi — a site-ok külön repók | A user által javasolt reusable workflow / `npx @soborbo/tracking-audit` lint-CLI (grep-szabályok egy helyen) |
| INV-007 (reproducible artifacts) | A generátor determinisztikus (verifikálva), de CI nem futtatja újra diffre; `check:contract` (contract-hash) csak az events-szerződésre él | Regenerate-and-diff CI-job + az A8-as round-trip-fix (enélkül a diff hamis pozitív) |
| INV-008 (unknown tracker) | Harness detektál consent-bound requestet, de nincs vendor-registry, ami ellen osztályozna; nem CI-képes | Vendor-registry + report-only CI-mód (C4) |
| INV-009 (PII-leak) | Runtime: `redactPii` + TRK-3001; harness: POST-body-inspekció (`C_pings_carry_no_identifiers`) | Statikus CI PII-teszt hiányzik (dataLayer-push minták, URL-query) — a lint-CLI-be való |
| INV-010 | **ENFORCE-OLT** (`normalizeDelivery`) | — |

### F. Nem egyértelmű business-event szemantikák (repo-evidenciával)

1. **`revenue_confirmed` ≠ kifizetett bevétel.** Ma: `lezart_nyert` státusz + kézzel beírt `leads.final_value` (`lifecycle.ts:63-69`). Közben a CRM-ben LÉTEZIK teljes invoicing (`invoices.status='paid'`, `payments`, `payment_allocations` — `invoicing.ts`), de **semmi nem köti a trackinghez** (consumer-grep: nulla). A terv „üzletileg igazolt revenue" elvárása döntést kér: won-kori becslés marad, vagy paid-invoice-ra köt át.
2. **won visszavonása nem retraktál.** `lead-status.ts:48-50`: won-ból kilépés nullázza `wonAt`+`conversionUploadedAt`-ot, de a már feltöltött konverziót semmi nem vonja vissza (nincs refund/retraction event — `refund` az events.json-ból is hiányzik).
3. **`quote_sent` / `booking_confirmed` / `job_completed`**: a gateway-oldal elfogadná (events.json offline-eventek léteznek), a domain-adat is megvan (`quotes.sentAt`, `QUOTE_STATUSES`, `JOB_STAGES` 13 stage, `APPOINTMENT_STATUSES`), de a CRM-mapping 2 elemű (`tracking-worker.ts:25-28`: kvalifikalt + lezart_nyert), a bővítés helye kommentben jelölve (`:22-23`). Per-tenant szemantika-döntés kell (painless job-stage ≠ beautyflow appointment).
4. **`order` surface → `quote_calculator_submitted`.** A CRM a webshop-kosaras beküldést szándékosan Lead-ként mappeli (`initial-conversion.ts:72-77`), MIKÖZBEN az events.json-ban pont erre van `order_request_submitted`. Vagy a CRM-mapping frissüljön, vagy dokumentált döntés legyen, hogy a Meta-optimalizálás miatt marad Lead.
5. **`purchase`**: a fleetben ma senki nem emittálja (nincs payment-backend); a kanonikus definíció jó („valódi fizetés rögzült árral"), de élő út nincs.
6. **`subscription_started`**: nincs domain, nincs site — a taxonómia-bővítés elhalasztható, amíg nincs előfizetéses ügyfél.
7. **consent a CRM-ben**: `marketingConsent` newsletter-szemantikájú (ezért a fabrikált-DENIED-tilalom, `gateway-sender.ts:105-122`); a `consent_receipt_id` oszlop létezik az outboxban, de **soha senki nem tölti** (3 grep-hit: séma+builder). A terv §15.1 „consent snapshot/reference" elvárásához a sbo `consent_id` CRM-ig vitele kell (a runbook 2.6 backend-`consentId` lépése pont ez).

### G. Site-típusonkénti adapter-igény (csak repo-evidencia)

- **Astro**: bizonyított — a package maga Astro-komponens, a CRM Astro, a fleet magja Astro. Első adapter.
- **Vanilla/script-tag**: bizonyított igény — a trapezlemezes webshop UNAS-platformon fut (nem saját build; MCP-adapter is UNAS-hoz van), oda Astro-komponens nem telepíthető.
- **Next/React**: NINCS repo-evidencia egyetlen fleet-site-ra sem → nem kell v1-ben (a terv §6 „next/ # csak ha kell" megjegyzése helyes).
- **WordPress/PHP**: nincs evidencia.
- A compliance-lista 6 nem-onboardolt site-ja (`bristol*`, `nemesventilatorhaz`, `skinlab_hu`) frameworkje felderítetlen — ez a terv Step 1 fleet-audit tétele, előbb az, aztán adapter-döntés.

### H. Prod-viselkedés, ami a migrációval elveszne (explicit lista)

1. **Korábbi CookieYes-consentek** sbo-flipnél (D1) — döntés nélkül a marketing-consentes visszatérők „unknown"-ba esnek.
2. **Pre-submit browser-konverziók**: a bot/invalid submitek konverziói eltűnnek (kívánatos), de az Ads/Meta riportban volumencsökkenésként jelentkezik + a konverzió-oldal átkerül (GA4 attribúció-oldal változik).
3. **`wait_for_update: 2000` viselkedés**: sbo-módban nincs — GTM el sem indul consent előtt, tehát a Google consent-mode modellezési jel (cookieless ping) is megszűnik pre-consent. Ez a Basic-mód tudatos ára (terv §9.6 vállalja), de mérési following-jel-vesztés.
4. **`TrackingNoscript`** sbo-site-okon KIVEZETENDŐ (`INSTALL.md:274-275`) — noscript-pageview-mérés elveszik.
5. **CookieYes párhuzamos-ablak telemetria** (`cky_cookie_*` mezők) a teljes CookieYes-eltávolítással megszűnik — előtte le kell zárni a párhuzamos-mérési kiértékelést.
6. **GA4 MP DLQ-retry láb** (`debug-ga4` + régi ga4-rekordok): ha a ga4-config kikerül a KV-ből, a maradék DLQ-rekordok drainelése előbb fusson le.

---

## 3. Következmények a roadmaphoz (nem implementáció — bemenet a rövidített tervhez)

**Terv-fejezetenkénti készültség:** §3 megtartandók: DONE · §4.1/4.2 truth freeze: NOT DONE (élő doksi-ellentmondás) · §4.3 commit-after-success: NOT DONE · §4.4/§18 package: NOT DONE · §9 saját CMP: PARTIAL (PR #67 nyitva; migráció+pilot hátra) · §9.9 receipt: DONE · §10: PARTIAL (harness igen, registry/CI nem) · §11 EC: PARTIAL (side-channel él, de A5-ös hibákkal; verifier NOT DONE + 🔴 OAuth-secret-blokkoló) · §12/§13: NOT DONE · §15.3: PARTIAL (2/7 lifecycle; click-ID-fix UNCOMMITTED) · §16: PARTIAL · §17: PARTIAL (22 kapu él; A8+A11+E-táblázat a rés) · §20: PARTIAL (generált container 1 hardcode-profil; élő-GTM-check nincs) · §27: PARTIAL · §28: szerver-smoke DONE, browser-smoke ütemezve NINCS · **§29: PARTIAL — pipeline-health kész, business-leg NOT DONE (P1)** · §31 CSP: NOT DONE.

**Sorrend-kritikus, terven kívüli tételek, amiket a cross-check hozott felszínre:**
1. CRM click-ID-fix commit/PR (working tree-ben veszélyben — D4).
2. Generátor round-trip-fix: `consent`/`recon` blokk átengedése (A8) — a PR #67-es pilot ELŐFELTÉTELE, különben bármely regenerálás visszabillenti.
3. `legacyConsentMigrationPolicy` döntés + implementáció a pilot-flip előtt (D1).
4. Reconciliation business-leg (P1): CRM-lead-count bemenet a meglévő `computeSiteDrift`-be — a `lead_status_total` már ott várja.
5. GADS OAuth-secretek pótlása (🔴 ops, 2026-07-15 óta) — minden Google-oldali verifier/reconciliation előfeltétele.
