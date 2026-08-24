# Soborbo Tracking vNext — VÉGLEGES FEJLESZTÉSI TERV

**Dátum:** 2026-08-24 · **Státusz: APPROVED** (cross-check után jóváhagyott végrehajtási sorrend)
**Források:** az eredeti vNext-terv (`D:\soborbo-tracking-vnext-teljes-terv.md`) → két körös cross-check (evidencia: `CROSSCHECK-vnext-A-H-2026-08-24.md`, ebben a repóban) → jóváhagyott roadmap. Ez a dokumentum a kanonikus végrehajtási terv; az 53 KB-os eredeti terv architektúra-referenciaként él tovább, a napi munka EBBŐL megy.

**Alapelv:** NEM rewrite. A működő rétegeket (event-gateway fan-out, D1 ledger + `normalizeDelivery`, CRM durable outbox, `events.json` kanonikus event-forrás, `consent_log`, compliance-harness) megtartjuk, és csak a bizonyított réseket zárjuk.

**Készültségi kiindulópont (2026-08-24, evidenciával a cross-checkben):**
- ✅ DONE: `test_event_code` hard gate · INV-010 (`normalizeDelivery`, TRK-950-004) · Data Manager offline út · high-value server-only gate (5 event `server_ingress_only`) · `consent_log` receipt-store (0006) · determinisztikus generátor 22 hard-error-kapuval · kliens attribution (first/last touch) · CRM outbox (lease/retry/idempotencia) · napi digest + EMQ + manifest-drift + version-drift CI
- ✅ **CMP Fázis 2 MAIN-EN (PR #67 merged, `ad04d46`), INERT** — provider-default `cookieyes` mindenhol; a flip két kézi kapcsoló (site env + KV `consent.provider`)
- ⚠️ PARTIAL: reconciliation (pipeline-health kész, business-leg NINCS) · GTM-kontraktus (committed container ellen igen, élő GTM ellen semmi) · CRM lifecycle (2/7 event) · EC side-channel (él, de nyers global + withdrawal-purge nélkül)
- ❌ NOT DONE: CookieYes→sbo consent-migráció (nulla sor) · commit-after-success · versioned package · truth-freeze docs · CSP
- 🔴 OPS: GADS OAuth-secretek hiányoznak a live workerről (2026-07-15 óta) · CRM click-ID-fix csak working tree-ben

---

## 0. Döntési szabályok

- **R0.1 — Pénzút előbb.** Sorrend-elv: (1) elvesző/nem attribuálható conversion → (2) néma zöld monitor → (3) pilotot visszabillentő config → (4) consent-migráció → (5) drift → (6) skálázás → (7) performance.
- **R0.2 — Egy változás / egy bizonyítható ok.** Money-path változás nem csomagolható össze másik money-path- vagy consent-változással ugyanabban a rollout-ablakban.
- **R0.3 — Előbb piros, aztán zöld.** Minden kritikus javításhoz teszt kell, amely a fix visszaállításával bizonyíthatóan elbukik.
- **R0.4 — Claude Code operátor, nem autoritás.** A sikert schema, CI, Playwright, ledger, vendor response és reconciliation dönti el — nem az implementáló véleménye.

---

# P0 — Azonnali adatvesztési és pilot-blokkoló hibák

## P0.1 — CRM click-ID fix mentése és merge · CRITICAL

**Állapot:** a javítás CSAK a CRM working tree-jében él (4 fájl, semmilyen branchen). A 2026-08-09-es incidens javítása: 16 `revenue_confirmed` ment fel gclid nélkül, **nulla match**.

**Teendő:** branch `origin/main`-ről (a tracking-fájlok bájt-azonosak main és a kicsekkolt beautyflow-branch között — a diff tisztán átemelhető) → csak a 4 érintett fájl (`lifecycle.ts`, `gateway-sender.ts`, `errors/codes/ads.ts`, `lifecycle.test.ts`) → PR → merge → production-verifier.

**A kötelező tesztek NAGYRÉSZT MÁR MEGÍRVA** a working tree-ben (+64 sor: unit + valós-D1 integráció, top-level emisszió, `'attribution' in body === false`, üres-string-kihagyás, null-safe default). A PR-leírásba kötelezően: a `payloadHash` az új mezőkkel változik, a dedup-kulcs (`lc:<leadId>:<eventName>`) NEM — a már sorban álló rows nem duplázódnak.

**DoD:** nincs uncommitted money-path munka; a lifecycle-outbox snapshot tartalmazza az elérhető click ID-ket; negatív eset (nincs click-ID → hashed identity megy, fabrikált gclid nincs) tesztelve. **PROD CHECK:** a következő `revenue_confirmed` után D1: `SELECT gclid FROM crm_tracking_events` nem-NULL.

## P0.2 — Generator round-trip adatvesztés · CRITICAL

**Hiba:** a `toSiteConfig` (`generate-site.mjs:183-219`) fix mezőlistából épít — a `consent`, `recon`, `consent_strict`, `monitoring` blokkot NÉMÁN ELDOBJA. Egy sbo-pilot site KV-jének újragenerálása csendben visszabillentené CookieYes-módba. **A CMP-pilot-flip előfeltétele.**

**Teendő:** a generator legyen lossless minden támogatott SiteConfig-mezőre. Az egyetlen schema-forrás **MÁR LÉTEZIK**: `soborbo-tracking/server/site-config.schema.json` — a fix erre épüljön, NE új típusra. Figyelem: az `expected_platforms` ma hardcode-olt (`:215-216`) — a lossless átengedés ezt is érinti.

**Hard contract (új CI-teszt):**
```text
parse(live_config) → generate → parse(generated) → semantic_equal(live_config)
```
Bukásnál `GENERATOR_ROUNDTRIP_FAIL`. Megjegyzés: ez a kontrakt ma le sem futtatható (a generator-input más alakú, mint a live SiteConfig) — a fix része az input-oldal kiterjesztése is.

**DoD:** sbo-config újragenerálása nem változtat provider-állapoton; `recon` nem vész el; round-trip-teszt CI-ben; a 15 élő KV-config round-trip-futtatása zero-diff.

## P0.3 — Generator consent-guard: UK-rés · HIGH

**Hiba:** `GB` valid country (`ALLOWED_COUNTRIES`), de nincs az `EEA_COUNTRIES`-ban (`:54-55`) → UK-site SEMMILYEN `require_consent`-figyelmeztetést nem kap — pont a PECR-piacon.

**Teendő:** a jogi kapu neve NE `EEA_COUNTRIES` legyen, hanem `CONSENT_REQUIRED_MARKETS` (minimum: GB, HU, DE, FR, IT, ES, EU). **Szigor:** új site-nál ezeken a piacokon a hiányzó `require_consent: true` HARD ERROR (nem warning), ha marketing-tracking engedélyezett.

## P0.4 — `test_event_code` bypass-rés · HIGH

**Állapot:** az alap hard gate DONE (`generate-site.mjs:120-129`). Maradék-rés: a `--allow-test-event-code` bypass-szal a kód a **KV-configba is beíródik** (`:204`), csak checklist-sor figyelmeztet — a két korábbi production Meta-leak pontos receptje.

**Teendő:** a bypass kizárólag ephemeral/teszt-outputot engedjen — a `kv-put.sh` production-outputot NE generáljon test-kóddal (vagy hard-failing markerrel generáljon). **Figyelem:** a bypass-utat a guard-tesztek használják (`tests/generate-site.test.ts` az opt-int invariánsként rögzíti) — a megoldásnak ezt a tesztutat meg kell tartania.

**Invariáns:** `production SiteConfig contains meta.test_event_code → impossible`.

## P0.5 — Truth-freeze dokumentáció · HIGH

A dokumentáció a JELENLEGI kanonikus modellt írja le, ne a célállapotot — különben újratermeljük a docs↔valóság driftet:

- Google Tag Gateway auto-injection: **DEFAULT OFF** — törlendő az enable-utasítás: `INSTALL.md:117-118`, `docs/cloudflare-setup.md:3-7`;
- on-site GA4 MP mirror: OFF; szerver-GA4: OFF (a `ga4` KV-blokk legacy/diagnostics-only — a generátor-warning szövege is javítandó, ma azt sugallja, hogy kellene);
- Data Manager = az offline Google-út (legacy uploadClickConversions dormant);
- **CMP: default `cookieyes`, `sbo` = pilot, per-site human döntés; célállapot: sbo fleet-wide** — NEM „CookieYes legacy" (még nem az);
- `docs/gtm-setup.md` consent-default ellentmondás javítása (Custom HTML taget ír, a valóság inline `Tracking.astro` — ahogy `gen-container.mjs:135-139` is mondja).

---

# P1 — Reconciliation business-leg (ELŐREHOZVA, nem Phase 8)

**Ami kész:** reconciliation-cron (napi 8:15) vendor_failure_rate + Meta coverage_drift; GA4 Data API + GAQL cross-check (opt-in `recon` blokk); digest/alert-infra. **Ami hiányzik:** üzleti darabszám ↔ leszállított konverzió összevetés — a `lead_status_total` mező létezik és feltöltődik (`lib/reconciliation.ts:35,249`), de **senki nem olvassa**. Ez nem új rendszer: egy új láb a meglévő `computeSiteDrift`-be. A Meta `ad_eligible` formula NEM újrahasználható erre.

## P1.1 — Google offline expected base
Site-onként és event-típusonként (`lead_qualified`, `revenue_confirmed`, később bővülve): `lead_status` beérkezések ↔ `deliveries origin='offline' platform='gads'` accepted/skipped/rejected. Új findingek: `offline_coverage_drift`, `offline_vendor_failure`, `offline_config_missing`, `offline_zero_delivery`.

## P1.2 — CRM business-source recon
`CRM lifecycle source count ↔ gateway lead_status count` — mert ha a CRM→gateway hívás el sem indul, a gateway-ledger önmagában nem látja a hiányt. **v1-javaslat:** napi PII-mentes aggregátum a `crm_tracking_events`-ből (event_name × status count), a MEGLÉVŐ cron-driveren pusholva — nincs új infrastruktúra. Nem kell teljes event-sync.

## P1.3 — Alerting
Minimum mezők: site, event type, expected, delivered, failure rate, utolsó sikeres upload; warning + critical szint.

**DoD / RED TEST:** egy szándékosan kikapcsolt Google offline-láb **24 órán belül piros**. A piros bizonyíték ma előállítható: a jelenlegi kód egy halott offline-láb mellett zölden megy át — az új findinggel buknia kell.

---

# P2 — GADS OAuth / offline ops helyreállítás · CRITICAL OPS

🔴 A `GADS_OAUTH_CLIENT_ID` + `GADS_DEVELOPER_TOKEN` 2026-07-15 óta hiányzik a live workerről — minden Google offline verifier és reconciliation értelmetlen enélkül.

**Munkamegosztás:** a state-audit, scope-ellenőrzés (Data Manager!), validate-only smoke és a runbook elkészíthető agent-oldalon; **a secret-beírás user-kezű**. Kimenet: pontos „mit írj be és hova" runbook + első valós `accepted` upload igazolása a ledgerben + token-expiry-monitoring.

**Hard health rule:** ha `gads.customer_id != null` és vannak offline actions, de OAuth nincs → `SITE HEALTH = RED`. Nem warning, nem silent skip.

---

# P3 — CMP pilot-előkészítés (a Fázis 2 main-merge UTÁNI lépések)

**Státusz:** engine/kliens-kód **MAIN-EN (PR #67 merged, inert)**. Pilot-site-integráció + provider-flip NOT DONE. Runbook: `docs/cmp-fazis2-pilot-runbook.md`. Pilot-jelölt: olcsokontenerhaz.hu.

## P3.1 — `legacyConsentMigrationPolicy` (flip ELŐTT kötelező döntés)
Ma NULLA sor migráció létezik (grep-pel bizonyítva) — flip után minden korábbi CookieYes-accept elvész, banner újra mindenkinek. Explicit döntés kell: `migrate_if_equivalent` VAGY `reconsent_all`. Implicit cookie-copy TILOS.
- **Ha migrálunk:** bizonyítandó a cél/kategória/policy-szöveg ekvivalencia; timestamp-hiány kezelése dokumentált; a migrált state forrás-jelölt (`source = cookieyes_migrated`).
- **Ha re-consent:** returning userek default unknown → a várható attribution/conversion-dip előre mérve és kommunikálva; rollout-ablak tudatos.

## P3.2 — policyVersion + receipt-szemantika
A meglévő `consent_log`-modellhez igazítva (consent_id + monoton revision + kötelező 4 verziómező + withdrawal-as-new-row). **NE vezessünk be párhuzamos új ConsentState-modellt** — az eredeti terv §9.3 cookie-beli `receiptId`-je elvetve: a hivatkozás `consent_id`+`revision` párral megoldott, a `consent_event_id` döntésenként friss, wire-only.

## P3.3 — Pilot canary (egyetlen site)
Flip-előfeltételek: P0.2 generator-fix ✓ · P2 OAuth tiszta ✓ · P3.1 migráció-döntés ✓ · 0006-os migráció éles D1-en ellenőrizve · baseline conversion-snapshot + Tag Assistant baseline + GTM-snapshot. **A flip napján CSAK a CMP változik** (R0.2). Ismert gotcha: a párhuzamos ablak alatt a CookieYes-szkript kikapcsolt bannerrel bent marad — GTM Preview-ban ellenőrzendő, hogy NEM push-ol saját consent-parancsot.

## P3.4 — Rollback
Egyetlen flag: `provider: sbo → cookieyes`. Utána a business-tracking folytatódik, a consent_log auditnak megmarad, és (P0.2 után) nincs round-trip-veszteség.

---

# P4 — Versioned tracking package

**Cél:** a copy-based client-install (`INSTALL.md:107-109,140-141`) megszüntetése — a drift bizonyítottan bekövetkezett (skinlab click-ID-fork; 2026-07-31 multi-site lib-driftek).

Első célpont: **Astro**. Bontás csak amennyire kell: `@soborbo/tracking-core` + `@soborbo/tracking-astro` + `@soborbo/consent` — ne legyen idő előtt 8 mikropackage. Kötelező: immutable version + lockfile + changelog + client-version-telemetria (a payloadban már megy `client_lib_version`) + upgrade-guide + rollback. **Tiltás:** site-repo nem tartalmazhat forkolt canonical tracking-forrást.

**DoD:** ugyanaz a package-verzió két site-on bitre ugyanazt a core-kódot jelenti.

---

# P5 — Commit-after-business-success (browser money-láb)

**Pontos cél:** a SZERVER money-láb már backend-owned (outbox → gateway). A javítandó rész a böngésző: a `TrackedForm` ma `validate → track → 600ms vak wait → submit` sorrendű (`TrackedForm.astro:124-152`), azaz a Google Ads awct (+EC user data), GA4 és Meta Pixel Lead a backend-siker ELŐTT tüzel.

**Új invariáns:** `browser money conversion ONLY AFTER business backend success`.

- **P5.2 fetch/XHR form:** `submit → backend → success JSON(event_id/business_id) → conversion.commit()`.
- **P5.3 klasszikus form:** PRG + signed one-time success-token: `POST → backend accepted → 303 → thank-you → commit exactly once`. PII nem mehet URL-be; a Meta-dedup event_id-nek át kell élnie a redirectet (a tokenben utazik).
- **P5.4 negatív tesztek:** validation fail / anti-bot fail / CRM fail / server 500 / duplicate submit / success-reload → `Google Ads = 0, Meta Pixel conversion = 0, CAPI money event = 0`; sikernél `exactly 1 logical conversion`.

**Cutover-figyelmeztetés:** a bot/invalid konverziók eltűnése SZÁNDÉKOS, de az Ads/Meta-riportban volumencsökkenésként jelentkezik, és a konverzió oldala átkerül (GA4-attribúció változik) — a hirdető-tájékoztatás a rollout része. Canary-site + R0.2 kötelező.

---

# P6 — Enhanced Conversions hardening

**Platform rule:** `google_ads.enabled → EC REQUIRED` (nem opcionális checkbox).

- **P6.1 Web EC:** standard identity-adapter (email, phone E.164, név, cím ahol van); PII továbbra sem mehet normál dataLayerbe (a `redactPii` + TRK-3001 runtime-őr marad).
- **P6.2 Ephemeral EC store:** a jelenlegi side-channel nyers mutable global (`window.__sbUserData` + hidden div, `events.ts:121-140`), és consent-visszavonás NEM üríti (csak az 5 mp-es timer). Cél: package-owned getter (`getGoogleUserData()`-minta) + purge a `purgeMarketingStorage`-ba. **Nem kötelező rewrite, ha a jelenlegi mechanizmus regresszió nélkül biztonságossá tehető** — de a withdrawal-purge mindenképp kell.
- **P6.3 ECL (CRM-es site):** identity + attribution + click ID (P0.1!) + lifecycle → Data Manager.
- **P6.4 Hard tests (Ads-enabled site csak akkor healthy):** user-provided data a GTM-tagnek elérhető · `ad_user_data` consent helyes · no PII in dataLayer · conversion csak success után.

---

# P7 — Live GTM conformance (NEM full generation)

**Ami van:** code ↔ docs ↔ **committed** `gtm/container.json` kontrakt (`check:events`). **Ami kell:** `LIVE GTM ↔ canonical expected contract` — élő GTM-ellenőrzés ma NULLA (GTM API-hívás sehol a repóban).

**Read-only first:** GTM API/export → szemantikus normalizálás → triggerek, aktív tagek, conversion ID/label, consent-követelmények, EC-user-data-változó, duplicate-tagek összevetése. Drift → `FAIL / HEALTH RED`. (A stape-gtm MCP `gtm_*` toolok elérhetők hozzá.)

**Script-név-footgun javítása:** két különböző `check:events` él azonos névvel (root: csak events.json-alak; package: GTM-kontrakt) → átnevezés: `check:engine-events` / `check:gtm-contract` / (új) `check:live-gtm`.

**Full GTM generation: HALASZTVA.** A mai `gen-container.mjs` egyetlen hardcode-olt leadgen-profil placeholder ID-kkal — a per-site paraméterezés a tényleges munka. Új site-oknál később default lehet; meglévő containereknél fokozatos, mért migráció.

---

# P8 — Runtime tracker-inventory + compliance-gate

**Ami van:** `tests/compliance/` Playwright-harness (A fresh / B accept / C reject / D withdrawal / GPC szcenáriók; pre-consent storage/request/GTM-sorrend; POST-body-inspekció; gombparitás; provider-paraméterezett; 13 site). **Ami hiányzik:** analytics-only szcenárió · vendor-registry (unknown → classify → `DEPLOY FAIL`, de először report-only → alert → gate, mert a harness hálózatfüggő és ma explicit „NEM CI-BA VALÓ") · static scan (source/GTM/packages/embed).

**Multi-repo CI:** NEM másolunk workflow-t site-onként. Reusable GitHub workflow (`uses: Soborbo/Serverside/.../tracking-compliance.yml@v7`) VAGY verziózott `npx @soborbo/tracking-audit` CLI — a compliance-logika EGY helyen él. Ez fedi az INV-005/006 (site-kódban tilos raw consent-parse / fbq / gtag) lint-jét is.

---

# P9 — Site-profil bővítés + adapterek

Repo-evidencia alapján: **1. Astro** (a fleet magja) · **2. vanilla/script-tag** (UNAS-webshop — trapezlemezes — Astro-komponens nem telepíthető). **Next adapter NEM készül**, amíg nincs konkrét site; WordPress/PHP-ra sincs evidencia. A 6 nem-onboardolt site (bristol×3, nemesventilatorhaz, skinlab_hu) framework-felderítése az onboarding Step 1 része.

Business truth profilonként: leadgen → CRM vagy site-backend durable lead store · ecommerce → order/payment backend · paywall/subscription → auth/billing backend (subscription-eventek az events.json-ba CSAK akkor, ha lesz ilyen site).

---

# P10 — Revenue-szemantika

**Jelenlegi probléma:** a `revenue_confirmed` = `lezart_nyert` státusz + kézzel beírt `leads.final_value` — NEM garantáltan tényleges pénzügyi bevétel. Közben a CRM-ben teljes invoicing él (`invoices.status='paid'`, `payments`), amit SEMMI nem köt a trackinghez; won visszavonása pedig nem retraktálja a feltöltött konverziót (`refund` event nem létezik).

**Site-/profil-szintű döntés kell:** egyszerű leadgen → won-kori érték marad, dokumentáltan; job/invoicing-os tenant (painless) → `paid → revenue_confirmed`. **Retraction/refund üzleti modell** (refund / cancellation / conversion adjustment) — nem feltétlen első implementáció, de a `revenue_confirmed` szemantikáját ADDIG IS dokumentálni kell, hogy ne jelentsen többet a valóságnál. Kapcsolódó mapping-döntés: a webshop-kosaras `order` surface ma `quote_calculator_submitted`-ként megy, miközben az events.json-ban létezik `order_request_submitted` — vagy a CRM-mapping frissül, vagy dokumentált döntés marad Lead-ként.

## 🔴 HARD OPEN ITEM — `revenue_confirmed ≠ won` (rögzítve: 2026-08-24 merge-gate review)

**Nem most javítjuk** (más money-path változás fut, R0.2), de a tétel innentől NYITOTT és nevesített, nem „majd valamikor":

> Ahol az üzleti rendszer KÉPES ténylegesen tudni a `paid` állapotot, ott a `revenue_confirmed` nem jelentheti a `won`-t. A painless CRM-ben teljes invoicing él (`invoices.status='paid'`, `payments`, `payment_allocations`), és **semmi nem köti a trackinghez** (consumer-grep: nulla találat) — miközben a `revenue_confirmed` egy kézzel beírt `leads.final_value`-t visz fel Google Adsbe konverziós értékként.

**A célállapot szemantikája, amikor sorra kerül:**

| CRM-esemény | tracking-event | mit jelent |
|---|---|---|
| `lezart_nyert` (won) | `booking_confirmed` / converted lead | az ügyletet megnyertük — becsült érték |
| `invoices.status='paid'` | `revenue_confirmed` | **ténylegesen befolyt pénz**, a számla összegével |

**Amíg ez nincs meg, két dolog KÖTELEZŐ:**
1. a `revenue_confirmed` mai jelentése (won-kori becslés, kézi érték) minden riportban és doksiban **kimondva** — hogy ne jelentsen többet a valóságnál;
2. a won VISSZAVONÁSA ma sem retraktál (`lead-status.ts:48-50` nullázza a `wonAt`/`conversionUploadedAt`-ot, de a **már feltöltött konverziót semmi nem vonja vissza**; `refund` event az `events.json`-ból is hiányzik) — a conversion adjustment / refund modell ugyanennek a tételnek a része, nem külön ügy.

**Miért nem kozmetika:** a Google Ads a feltöltött értékre optimalizál. Egy won-kori becslés és egy befolyt összeg közti szisztematikus eltérés a bidding-et torzítja — csendben, mert minden mérőszám zöld marad.

---

# P11 — Performance hardening (csak stabil tracking után)

Elsődleges: CookieYes eltűnik · Tag Gateway duplicate-loader nincs · Clarity deferred/off · felesleges third-party JS ki · consent-bootstrap minimális · package bundle-budget. **Nem cél:** Lighthouse-pontért Meta Pixel / Google browser-signal vak eltávolítása. Minden performance-változás A/B-méréssel, nem intuícióval.

---

# P12 — Fleet health view

Egy képernyőn, site-onként: CMP · package-verzió · GTM-drift · browser/server smoke · Meta · Google offline · EC-státusz · business-reconciliation · inventory · last healthy. Health: `GREEN / YELLOW / RED / UNKNOWN` — **UNKNOWN soha nem számít GREEN-nek.**

---

# Jóváhagyott végrehajtási sorrend

**Most (első batch, A–E):**
1. **A.** CRM click-ID working-tree mentés → branch → PR (P0.1)
2. **B.** Generator hardening: round-trip + UK-guard + test-code-bypass (P0.2–P0.4)
3. **C.** Truth-freeze docs (P0.5)
4. **D.** GADS OAuth state-audit + repair-runbook (P2 — a secret-beírás user-kezű)
5. **E.** Reconciliation business-leg terv + red-testek (P1)

**Ezután új review, majd:**
6. Reconciliation business-leg implementáció (P1) → 7. Legacy consent-migration policy döntés (P3.1) → 8. CMP pilot-site-integráció + canary-flip (P3.3, olcsokontenerhaz) → 9. Versioned Astro package (P4) → 10. Commit-after-success browser conversion (P5) → 11. EC hard gate (P6) → 12. Live GTM conformance (P7) → 13. Runtime inventory/compliance (P8) → 14. Vanilla/UNAS adapter (P9) → 15. Revenue-szemantika + adjustment-modell (P10) → 16. Fleet dashboard (P12) → 17. Performance hardening (P11) → 18. Full GTM generation csak később, indokolt skálán.

**A CMP-pilotot CSAK az A–E lezárása után flipeljük.**

---

# Change-isolation szabály

Ugyanabban a rollout-ablakban TILOS: CMP-flip + Ads conversion-action-változtatás · CMP-flip + OAuth-repair · commit-after-success + nagy GTM-refactor · package-migráció + event-taxonómia-rename · GTM-generation + EC-migráció. Egy változás → mérés → stabilitás → következő.

---

# Claude Code implementációs protokoll

Minden fázis ELŐTT kötelező visszaadni:

```text
STATUS      DONE / PARTIAL / NOT DONE / OBSOLETE / LOCAL
EVIDENCE    file:line / PR / commit
RED TEST    mi bukik a változás előtt
CHANGE      minimális módosítás
GREEN PROOF unit / E2E / ledger / vendor
ROLLBACK    egyértelmű visszaállítás
PROD CHECK  mit figyelünk utána
```

Ha nincs RED TEST vagy rollback: **NO GO.** Money-path esetén critical-suite-skip: **CI FAIL.**

Tilos (az eredeti terv §33 alapján, változatlanul): új event-név schema nélkül · `gtag`/`fbq` site-business-kódban · consent-cookie kézi parse · tracking-package forrásának site-oldali átírása · generated GTM kézi módosítása · money conversion submit-attemptből · új third-party tracker registry nélkül · CI/smoke skip.

---

# Az első batch fázis-előtti protokoll-blokkjai

**A. CRM click-ID fix** — STATUS: LOCAL. EVIDENCE: CRM working tree `lifecycle.ts:71-77` (incidens-komment), `gateway-sender.ts:151-156,208-213`, `ads.ts:45` (OUTBOX-BUILD-003). RED TEST: a working-tree-beli 6 új teszteset a fix visszavonásával bukik. CHANGE: branch origin/main-ről + a 4 fájl, semmi más. GREEN PROOF: CRM-suite + 2 valós-D1 integrációs teszt. ROLLBACK: revert-commit (dedup-kulcs változatlan → adatkockázat nélkül). PROD CHECK: következő `revenue_confirmed` → D1 `gclid` nem-NULL.

**B. Generator hardening** — STATUS: NOT DONE (round-trip, UK) / PARTIAL (test-code). EVIDENCE: `generate-site.mjs:183-219`, `:54-55,176-179`, `:204`. RED TEST: (1) round-trip sbo-configgal — ma bukik (consent-blokk eltűnik); (2) GB-site require_consent nélkül — ma warning sincs; (3) bypass+production kombináció — ma átmegy. ROLLBACK: a generátor pure, nincs élő mellékhatás. PROD CHECK: 15 élő KV-config round-trip zero-diff.

**C. Truth-freeze docs** — STATUS: NOT DONE. EVIDENCE: `INSTALL.md:117-118`, `docs/cloudflare-setup.md:3-7`, `docs/gtm-setup.md` (consent-default drift), generátor GA4-warning szövege. Kapu: doksi-grep a tiltott mintákra a check-scriptben. ROLLBACK: git revert.

**D. OAuth state-audit** — STATUS: NOT DONE, 🔴 ops 2026-07-15 óta. Kimenet: secret-lista + Data Manager scope-ellenőrzés + validate-only smoke-terv + user-runbook. PROD CHECK: első valós `accepted` Data Manager-upload a ledgerben.

**E. Reconciliation business-leg terv** — STATUS: PARTIAL. EVIDENCE: `lib/reconciliation.ts:35,249` (holt `lead_status_total`), `:76` (`COVERAGE_PLATFORMS=['meta']`). RED TEST: teszt, ami bizonyítja, hogy a MAI kód egy kikapcsolt offline-láb mellett zölden átmegy — az új `offline_zero_delivery` findinggel buknia kell. CHANGE (terv-szinten): P1.1 lábak + P1.2 CRM-aggregátum-feed dizájn. GREEN PROOF: a szándékosan kikapcsolt láb 24 órán belül piros.

---

# Indító prompt (új Claude Code session-höz)

Az alábbi promptot másold be változtatás nélkül egy friss session-be az első batch elindításához:

```text
Olvasd el a d:\Serverside\VNEXT-TERV.md végleges fejlesztési tervet és az evidencia-mellékletét
(d:\Serverside\CROSSCHECK-vnext-A-H-2026-08-24.md). Ez a kanonikus terv — az 53 KB-os eredeti
vNext-dokumentum csak architektúra-referencia.

FELADAT: kizárólag az ELSŐ BATCH (A–E) végrehajtása, ebben a sorrendben:
  A. CRM click-ID fix mentése (d:\soborbo-crm\soborbo-crm working tree, 4 uncommitted fájl!)
     → branch origin/main-ről → PR. FIGYELEM: checkout/clean/stash NE történjen a diff
     megmentése előtt — ez az egyetlen példánya a 2026-08-09-es incidens javításának.
  B. Generator hardening (P0.2 round-trip + P0.3 UK-guard + P0.4 test-code-bypass) — a
     site-config.schema.json az egyetlen schema-forrás; a meglévő guard-teszteket ne törd.
  C. Truth-freeze docs (P0.5) — a JELENLEGI modellt írja le, ne a célállapotot.
  D. GADS OAuth state-audit + repair-runbook (P2) — a secret-beírás az enyém, te auditálsz
     és runbookot írsz.
  E. Reconciliation business-leg TERV + red-testek (P1) — implementáció még nem.

SZABÁLYOK:
- Minden fázis ELŐTT add vissza a terv szerinti protokoll-blokkot
  (STATUS / EVIDENCE / RED TEST / CHANGE / GREEN PROOF / ROLLBACK / PROD CHECK).
  RED TEST vagy rollback nélkül NO GO.
- Egy fázis = egy branch = egy PR. Money-path változást ne csomagolj össze mással (R0.2).
- Merge-t NE csinálj kérdezés nélkül — a Serverside main-merge AUTODEPLOYOL (Workers Builds).
- CMP pilot-flip TILOS ebben a batchben (csak A–E lezárása + új review után).
- Munka előtt mindkét repóban: git fetch && állapot-leltár (a lokális refek elavultak lehetnek).
- A CLAUDE.md invariánsai és a terv „Tilos" listája kötelező.

Az A–E lezárása után állj meg és kérj review-t.
```
