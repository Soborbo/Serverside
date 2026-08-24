# P1 — Reconciliation business-leg: TERV

**Dátum:** 2026-08-24 · **vNext P1** · **Státusz: P1.1 + P1.2 gateway-fél IMPLEMENTÁLVA**
(2026-08-24, a merge-gate review két kötelező korrekciójával).
**Nyitott: a P1.2 CRM-oldali hívása (§3.5) + a 0007 migráció éles D1-en (§3.6).**

**Teszt-fájl:** `tests/reconciliation-business-leg.test.ts` — a RED-baseline elvárásai
MEG VANNAK FORDÍTVA (lásd §5). Három célzott visszavonás bizonyítja, hogy a tesztek a
valódi mechanizmust fogják: a detektor kikapcsolásával 12, a skip-osztályozás
eltávolításával 5, a BLOCKED-kapu kivételével 1 teszt bukik.

> **A 2026-08-24-i merge-gate review két kötelező korrekciója beépítve** — a §2.3 és a
> §2.6 írja le őket. Röviden: (1) nem minden skip veszteség, (2) a mérés élesedése
> gépi állapotgép, nem emberi munkasorrend.

---

## 0. Egy mondatban

A mai reconciliation **pipeline-health**-et mér (a kézbesítések elbuktak-e), nem **business
truth**-t (megérkezett-e minden üzleti esemény oda, ahova kellett). Emiatt egy
**szándékosan kikapcsolt Google offline-láb mellett a monitor zölden megy át** — ezt a
RED-tesztek bizonyítják.

Ez **nem új rendszer**: egy ÚJ LÁB a meglévő `computeSiteDrift`-ben. A cron-slot, a
digest, az alerting, a threshold-modell és a `SiteReconInput` mind él.

---

## 1. Kiindulás — mi van és mi hiányzik

| Réteg | Állapot | Evidencia |
|---|---|---|
| Reconciliation-cron (napi 8:15) | **KÉSZ** | `src/scheduled/reconciliation.ts` |
| vendor_failure_rate + coverage_drift | **KÉSZ** (csak böngésző-fan-out) | `src/lib/reconciliation.ts:91-167` |
| GA4 Data API + GAQL cross-check | **KÉSZ** (opt-in `recon` blokk) | `src/lib/cross-check.ts` |
| Digest / alerting / Analytics Engine | **KÉSZ** | `scheduled/reconciliation.ts:52-73` |
| **Üzleti darabszám ↔ leszállított konverzió** | **NINCS** | lásd §1.1 |

### 1.1 A vakság három, egymástól FÜGGETLEN szerkezeti oka

Mindhárom külön RED-teszttel rögzítve:

1. **A `lead_status_total` holt súly.** A mező létezik és feltöltődik
   (`lib/reconciliation.ts:35` a structban, `:249` az összefésülésben), de egyetlen
   számítás sem olvassa. Bizonyíték: 500 vagy 0 üzleti eseménnyel a `computeSiteDrift`
   kimenete **bitre ugyanaz**.
2. **A `gads` platform ki sem kerül a `PlatformCounts`-ba.** A `PLATFORMS` lista
   (`:214`) `['meta','tiktok','linkedin','msads']` — még ha a lekérdezés adna is
   gads-sorokat, az összefésülés eldobja őket. Ráadásul a delivery-lekérdezés
   `origin IN ('fanout','retry')`-ra szűr (`:281`), az offline kézbesítés pedig
   `origin='offline'` — tehát **kétszeresen** láthatatlan.
3. **A coverage-alap csak a Metára van értelmezve** (`COVERAGE_PLATFORMS`, `:76`). Ez a
   böngésző-fan-outra **helyes és szándékos** (a click-ID forwarderek csak click-ID
   jelenlétében tüzelnek, rájuk az `ad_eligible` hamis alap lenne) — a hiba az, hogy az
   OFFLINE lábnak emiatt egyáltalán nincs coverage-fogalma.

### 1.2 Miért NEM újrahasználható a Meta `ad_eligible` formula

Az `ad_eligible` a **böngészőből beérkezett, ad-jogosult eventek** száma. Az offline láb
bemenete ettől független: **CRM-lifecycle-státuszok** (`lead_qualified`,
`revenue_confirmed`, …), amikből nagyságrendekkel kevesebb van, más ritmusban érkeznek
(napok–hetek a lead capture után), és amiknek a jogosultsága is máshogy dől el
(a lead consent-receiptje + a site `conversion_actions` térképe, nem az event `ad_allowed`
flagje). Egy 60 böngésző-eventes naphoz tartozhat 2 offline feltöltés — az `ad_eligible`
alapon ez 97%-os „coverage drift" lenne, minden nap, minden site-on.

**Az offline láb elvárt alapja a `lead_status` beérkezés, event-típusonként.**

---

## 2. P1.1 — Google offline expected base

### 2.1 Új bemeneti struktúra

A `SiteReconInput` mellé (nem helyette), site × event_name bontásban:

```ts
export interface OfflineLegInput {
  site_id: string;
  /** A CRM-lifecycle event neve: lead_qualified | revenue_confirmed | booking_confirmed | … */
  event_name: string;
  /** lead_status sorok az ablakban — EZ az elvárt alap. */
  received: number;
  /** deliveries: origin='offline', platform='gads' */
  accepted: number;
  skipped: number;
  rejected: number;
  /** A site configja fel tudná-e tölteni: van gads.customer_id ÉS conversion_actions[event_name]. */
  configured: boolean;
  /** expected_platforms.offline tartalmazza-e a 'gads'-ot. */
  expected: boolean;
  /** A LEGUTÓBBI sikeres offline feltöltés ideje (ISO) — a regresszió-detektorhoz. */
  last_accepted_at: string | null;
}
```

### 2.2 Két ablak, mert az offline volumen kicsi

A böngésző-oldali `minSample: 10` itt használhatatlan: a lifecycle-események ritkák (a
2026-07-20-i ledger-mérésben **összesen 7** `lead_status` sor volt). Egy 24 órás,
10-es mintás küszöb egy halott lábra **soha** nem sülne el. Ezért:

| Detektor | Ablak | Mit fog meg |
|---|---|---|
| **regresszió** (elsődleges) | 24 óra | „tegnap még ment, ma nem" — volumentől függetlenül |
| **abszolút** | 7 nap gördülő | „egy hete kap, egy hete nem tölt fel" |

A tervi DoD („a szándékosan kikapcsolt offline-láb 24 órán belül piros") a **regresszió**-
detektoron teljesül: nem darabszám kell hozzá, hanem a `last_accepted_at` megléte. Ez
ugyanaz a minta, amit az `expected_platforms` a napi digestben már használ (a megfigyelt
előzményhez mérünk), és pontosan azért létezik, mert egy hiányzó config és egy szándékos
kihagyás a delivery-sorból nézve azonos.

### 2.3 Skip-osztályozás — NEM minden kihagyás veszteség (review-korrekció #1)

A coverage nevezője **nem** a puszta beérkezés. Három `lead_status`, mindhárom
visszavont marketing-consenttel → 3 skipped, 0 accepted: ez **nem halott
Google-láb, hanem pontosan helyes működés**. Riasztani rá hamis pozitív, és a
riasztás-fáradtság pont azt a néma hibát fedné el, amiért a lánc létezik.

A vízválasztó **policy vs. hiba**:

| skip_reason | számít veszteségnek? | miért |
|---|:--:|---|
| `consent_denied`, `consent_withdrawn`, `consent_missing_failclosed`, `consent_missing_legacy`, `consent_uncertain_failclosed` | ❌ | a rendszer helyesen döntött úgy, hogy nem küld |
| `not_expected`, `eea_rule`, `dedup` | ❌ | policy / nem is elvárt / nem is veszteség |
| `not_configured`, `invalid_identifier`, `no_identifiers`, `template_guard` | ✅ | config- / adatminőség- / transport-hiba: a pénz emiatt nem ér célba |
| ismeretlen vagy hiányzó ok | ✅ | a pénzúton a „nem tudjuk, miért nem ment el" nem minősülhet rendben lévőnek |

```text
expected_delivery = received − Σ(legitim policy-skip)
offline_zero_delivery  ⇔  expected_delivery > 0 ÉS accepted = 0
```

**Ez NEM ugyanaz a tengely, mint az `isTerminalSkip` (retryable-e).** A
`no_identifiers` terminális — a retry sem segítene —, de coverage-szempontból
**veszteség**: jött egy lead, akit nem tudunk feltölteni, mert nincs matchelhető
azonosítója. A két tengely külön él (`countsAgainstOfflineCoverage` vs.
`isTerminalSkip`), és a teljességet teszt kényszeríti ki: minden `SKIP_REASONS`-beli
oknak explicit osztályozottnak kell lennie, különben egy új ok csendben az
„ismeretlen → veszteség" ágra esne.

### 2.4 A három új finding

| kind | severity | feltétel | jelentés |
|---|---|---|---|
| `offline_zero_delivery` | **critical** | ARMED + `expected_delivery(24h) > 0 && accepted = 0` (REGRESSZIÓ) **VAGY** `expected_delivery(7d) >= offlineMinSample && accepted(7d) = 0` (ABSZOLÚT) | a láb HALOTT |
| `offline_coverage_drift` | warning / critical | `accepted / expected_delivery(24h)` a küszöb alatt, **és `accepted > 0`** (nulla kézbesítésnél a zero_delivery már szólt — nem duplázunk) | részleges kiesés |
| `offline_vendor_failure` | warning / critical | `rejected / (accepted + rejected)` a küszöb fölött | a Google elutasít (auth, allowlist, formátum) |

> **A tervezett `offline_config_missing` finding NEM készült el ilyen formában.** A
> review-korrekció #2 szerint a hiányzó előfeltétel nem drift, hanem **állapot**: a
> láb `BLOCKED_DEPENDENCY`-be kerül, findinget nem termel (a health-check már jelzi,
> egy második riasztás ugyanarról csak zaj), de **nem is néma** — lásd §2.6.

Küszöb-javaslat (külön blokk, NEM a böngésző-thresholdok újrahasználata):

```ts
export const DEFAULT_OFFLINE_THRESHOLDS = {
  offlineMinSample: 3,          // a lifecycle-volumen kicsi; a regresszió-detektor nem is használja
  offlineCoverageWarn: 0.15,    // delivered < 85% of expected
  offlineCoverageCrit: 0.4,     // delivered < 60% of expected
  offlineFailureWarn: 0.05,
  offlineFailureCrit: 0.15,
  offlineStaleHours: 24         // a regresszió-detektor ablaka
};
```

### 2.6 Dependency-állapotgép (review-korrekció #2)

A mérés élesedését **gép dönti el, nem emberi munkasorrend** („ne felejtsük el
később bekapcsolni"):

| állapot | mikor | mit tesz |
|---|---|---|
| `BLOCKED_DEPENDENCY` | hiányzik egy előfeltétel: `customer_id` / `conversion_action` / OAuth worker-secret / refresh token | **NINCS drift-finding.** A hiba ismert, a health-check jelzi. De a láb **nem néma**: riportsor + `TRK-950-015` warning-log az okkal |
| `UNARMED` | előfeltételek rendben, de **nincs bizonyított sikeres feltöltés** | a 24h REGRESSZIÓ-detektor nem alkalmazható (nincs mihez mérni); a 7 napos ABSZOLÚT igen |
| `ARMED` | van legalább egy `accepted` + **nem-NULL `http_status`** + nem-szintetikus offline delivery | minden detektor él |

A `BLOCKED_DEPENDENCY` **megelőzi** az `ARMED`-et: hiába volt korábban sikeres
feltöltés, ha most hiányzik egy előfeltétel, a mérés nem értelmes.

Az ARMED-horgony `http_status IS NOT NULL` feltétele nem formalitás: az INV-010
(TRK-950-004) előtti korszakból maradt „accepted vendor-státusz nélkül" sorok nem
bizonyítanak sikeres feltöltést, és élesítenék a regresszió-detektort egy sosem
működött lábon.

**Ez oldja fel a §6-ban leírt P2-függést is:** nem kell megvárni a
secret-helyreállítást az implementációval, mert amíg az OAuth hiányzik, a láb
magától `BLOCKED_DEPENDENCY`-ben áll és nem riaszt.

### 2.7 D1-lekérdezések (a meglévő `fetchReconInputs` mellé)

```sql
-- (a) Üzleti beérkezés: mennyi lifecycle-státusz jött be, event-típusonként
SELECT site_id, status AS event_name, COUNT(*) AS received
FROM lead_status
WHERE created_at >= ?1
  AND lead_id NOT LIKE 'smoke-%' AND lead_id NOT LIKE 'dm-validate%'
GROUP BY site_id, status;

-- (b) Offline kézbesítés: ugyanaz az ablak, de az OFFLINE originre
SELECT site_id, event_name,
       COALESCE(SUM(status = 'accepted'), 0) AS accepted,
       COALESCE(SUM(status = 'rejected'), 0) AS rejected,
       COALESCE(SUM(status = 'skipped'),  0) AS skipped
FROM deliveries
WHERE created_at >= ?1 AND origin = 'offline' AND platform = 'gads'
GROUP BY site_id, event_name;

-- (c) A regresszió-detektor horgonya: mikor volt utoljára SIKERES offline feltöltés
SELECT site_id, event_name, MAX(created_at) AS last_accepted_at
FROM deliveries
WHERE origin = 'offline' AND platform = 'gads' AND status = 'accepted'
GROUP BY site_id, event_name;
```

> **Az event-szintű bontás feltételei igazoltak** (2026-08-24, kódból):
> `deliveries.event_name` `TEXT NOT NULL` (`migrations/0001_ledger.sql:53`), tehát mindig
> ki van töltve; az `origin` engedett értékei `fanout | retry | offline` (`:60`), és a
> lead-status út mindhárom írási pontján `origin: 'offline'` megy
> (`routes/lead-status.ts:391,472,553`). A `(site_id, platform, status)` index
> (`:65`) fedi a szűrést; a `MAX(created_at)`-os (c) lekérdezés teljes táblát olvas —
> ha ez lassúvá válik, `(platform, origin, status, created_at)` fedő index a megoldás,
> nem a lekérdezés elhagyása.
>
> A szintetikus sorok kizárása (`smoke-`, `dm-validate`) **nem opcionális**: a napi
> smoke és a validate-only füst-teszt különben elfedné a halott lábat — pontosan az a
> hibaosztály, ami miatt a lomtalan-kiesés öt napig zöld maradt.

### 2.8 Bekötés

`computeSiteDrift(input, thresholds, offlineLegs?)` — a `DriftKind` unió bővül a négy új
értékkel, a `DriftFinding` egy opcionális `event_name` mezővel. A `summarize` és a
cron-oldali log/metrika-emisszió változatlan formában viszi tovább; a
`KIND_ERROR_CODE` térkép (`scheduled/reconciliation.ts:22`) kap négy új sort.

---

## 3. P1.2 — CRM business-source recon

### 3.1 A megfogandó hibamód

A P1.1 azt méri, hogy a **gateway-be beérkezett** lifecycle-státuszok eljutottak-e a
Google-ig. Azt **nem** látja, ha a CRM→gateway hívás **el sem indul**: olyankor
`received = 0`, és nulla elvárás mellett nulla kézbesítés tökéletesen egészségesnek
látszik. Ez a gateway-ledger szerkezeti vakfoltja — semmilyen gateway-oldali lekérdezés
nem tudja betömni.

### 3.2 v1: napi PII-mentes aggregátum a MEGLÉVŐ cron-driveren

**Nem** teljes event-sync, **nem** új infrastruktúra. A CRM-nek már van cron-drivere (az
outbox sender), a gateway-nek már van admin-route-ja és per-site token-auth-ja.

> **Az implementált útvonal ELTÉR a tervezettől.** Nem `/api/event/admin/business-counts`,
> hanem **`/api/event/business-counts`**. Ok: a teljes `/admin/*` felület a GLOBÁLIS
> `ADMIN_API_TOKEN` mögött van, és a CRM-nek per-site tokenje van (`crm_token_sha256`).
> Az admin-felületre téve a CRM-be be kellene tenni a globális tokent — tenant-izolációs
> visszalépés, ami egy szivárgás blast-radiusát 1 site-ról az egész flottára emelné.
> Az auth így ugyanaz, mint a `/lead-status`-on (`authenticateLeadStatus`).

```http
POST /api/event/business-counts
X-Admin-Token: <per-site CRM token>
Content-Type: application/json

{
  "date": "2026-08-23",
  "site_id": "painless",
  "counts": [
    { "event_name": "lead_qualified",    "count": 12 },
    { "event_name": "revenue_confirmed", "count": 3 }
  ]
}
```

**PII-mentes konstrukció:** csak `(event_name, count)` párok. Se lead_id, se érték, se
identitás. A `crm_tracking_events` táblából egy `GROUP BY event_name` aggregátum.

Tárolás — egy kicsi, új D1 tábla (migráció 0007):

```sql
CREATE TABLE IF NOT EXISTS business_counts (
  site_id     TEXT NOT NULL,
  date        TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  event_name  TEXT NOT NULL,
  count       INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (site_id, date, event_name)
);
```

Az idempotencia a PK-ból jön (`INSERT … ON CONFLICT DO UPDATE`), tehát az újraküldés
biztonságos — ugyanaz a minta, mint a CRM outbox determinisztikus kulcsainál.

### 3.3 A két új finding

| kind | severity | feltétel |
|---|---|---|
| `business_source_drift` | critical | `business_counts.count` és a `lead_status` beérkezés eltérése a küszöb fölött ugyanarra a `(site, date, event_name)`-re → a CRM→gateway dispatch ejt |
| `business_source_missing` | warning → critical | egy site-ra tegnap volt aggregátum, ma nincs → **maga a CRM-cron állt le** |

A `business_source_missing` szándékosan a megfigyelt előzményhez mér, nem egy
konfigurált listához: egy sosem-jelentkező site nem riaszt (nincs bekötve), de egy
elhallgató igen.

### 3.4 Validáció — szerver-szerver, tehát KONKRÉT 400

A hívónak tudnia kell javítani, ezért minden elutasítás megnevezi az okot
(`invalid_payload` + `detail`). Amit a gateway visszautasít:

| eset | miért |
|---|---|
| ismeretlen / nem-offline `event_name` | a kanonikus `events.json` az egyetlen forrás; egy elgépelt név csendben egy soha nem egyeztetett sort hozna létre |
| jövőbeli `date` | majdnem biztosan időzóna-hiba a hívónál; elfogadva egy örökre üres napot hozna létre |
| nem létező naptári nap (`2025-02-30`, `2026-13-01`) | a regex csak az ALAKOT nézi; ezek átmennének, 200-at kapnának, és egy olyan nap alá íródnának, amit a recon soha nem kérdez le — a monitor arra a payloadra csendben megszűnne |
| duplikált `event_name` | különben az utolsó csendben felülírná az elsőt |
| negatív / tört / abszurd `count` | cardinality- és hibavédelem |

`count: 0` **érvényes** — a „ma nulla lead" valós, mérendő információ.

**Jelzősor (heartbeat).** Minden sikeres beküldés kiír egy `event_name =
'__report__'`, `count = 0` sort. Enélkül egy nulla-lifecycle-es nap (amikor a CRM
dokumentált `GROUP BY` lekérdezése ÜRES tömböt ad) nem hagyna nyomot, és a
`findSilentBusinessSources` „a CRM-cron leállt"-ot jelentene — holott a cron lefutott
és sikeresen hívott. A jelzősor a drift-számításból **explicit ki van hagyva**: életjel,
nem üzleti darabszám.

**A nap-hozzárendelés oszlopa `occurred_at`, nem `created_at`.** A CRM aggregátuma az
esemény IDEJÉRE csoportosít; a gateway oldalán ugyanannak a napnak kell kijönnie. A
felvétel idejét (`created_at`) használva egy UTC-éjfélen átnyúló outbox-retry az
eredeti napot hiányosnak, a következőt figyelmen kívül hagyott többletnek mutatná — és
a 3-as minimum mellett már EGY késve érkezett kérés hamis CRITICAL-t adna. Az outbox
lease/retry miatt ez nem elméleti eset.

> A **P1.1** offline láb SZÁNDÉKOSAN marad `created_at`-en: ott a `lead_status`
> beérkezést a SAJÁT kézbesítéseivel vetjük össze, tehát mindkét oldal gateway-oldali
> idő — ott az `occurred_at` vinné el a két oldalt egymástól.

A válasz **soha nem 204**: nincs LEDGER → 503, D1-írás hibája → 500. A
„nyugtázom, de eldobom" pont az a néma adatvesztés, amit a P1.2 mérni hivatott
(CLAUDE.md 12).

### 3.5 ⏳ NYITOTT — a CRM-oldali hívás

A gateway-fél kész és tesztelt; a **CRM-nek még hívnia kell**. A meglévő cron-driverbe
(outbox sender) illeszkedő napi lépés:

```ts
// A tegnapi UTC-napra, a crm_tracking_events-ből aggregálva. PII NINCS a payloadban.
const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const counts = await db
  .select({ event_name: crmTrackingEvents.eventName, count: sql`COUNT(*)` })
  .from(crmTrackingEvents)
  .where(and(eq(crmTrackingEvents.eventKind, 'lifecycle'), sqlDateEquals(crmTrackingEvents.occurredAt, date)))
  .groupBy(crmTrackingEvents.eventName);

await fetch(`${env.TRACKING_WORKER_URL.replace('/lead-status', '/business-counts')}`, {
  method: 'POST',
  headers: { 'X-Admin-Token': env.TRACKING_ADMIN_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ date, counts })
});
```

Fontos: a **már meglévő** `TRACKING_ADMIN_TOKEN` (per-site) megy vele — új secret nem
kell. A hívás idempotens (PK-ütközésen felülír), tehát a retry biztonságos, és egy
késve érkező javított aggregátum javítja a korábbit.

### 3.6 ⏳ NYITOTT — a 0007 migráció éles D1-en

```bash
npx wrangler d1 migrations apply event-gateway-ledger --remote
# ellenőrzés:
npx wrangler d1 execute event-gateway-ledger --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='business_counts'"
```

Amíg a tábla nincs kint, a `/business-counts` 500-at ad (a CRM retry-ol, nem veszít
adatot), a recon business-lába pedig `null`-t kap. Ez **nem** „nincs eltérés": a napi
riport `business_check_failed: true`-t ír, a levél tárgya `+ business-source NOT
RUNNING`, és a levélben ott a teendő. Egy bukott monitor SOHA nem látszhat tisztának —
`?? []`-vel pontosan az történne.

### 3.7 Amit a v1 SZÁNDÉKOSAN nem csinál

- nem szinkronizál event-szintű rekordokat (az teljes második ledger lenne);
- nem próbál lead-szintű join-t (PII-felület, és a `lead_id` a gateway-ben már megvan);
- nem blokkol semmit — tisztán megfigyelés, ahogy a reconciliation többi lába.

---

## 4. P1.3 — Alerting

Minden offline/business finding **kötelező** mezői (a terv minimuma):

| mező | forrás |
|---|---|
| `site_id` | input |
| `event_name` | a lifecycle-státusz (`lead_qualified`, …) |
| `expected` | `received` (P1.1) / `business_counts.count` (P1.2) |
| `delivered` | `accepted` |
| `failure_rate` | `rejected / (accepted + rejected)` |
| `last_successful_upload` | `last_accepted_at` |
| `severity` | warning / critical |

Új hibakódok — a **TRK-950 sáv** szabad számai (a `-011`-ig foglalt, lásd
`src/lib/error-codes.ts:194-220`):

```
TRK-950-012  RECON_OFFLINE_ZERO_DELIVERY      critical      ✅ KIOSZTVA (P1.1)
TRK-950-013  RECON_OFFLINE_COVERAGE_DRIFT     warning       ✅ KIOSZTVA (P1.1)
TRK-950-014  RECON_OFFLINE_VENDOR_FAILURE     warning       ✅ KIOSZTVA (P1.1)
TRK-950-015  RECON_OFFLINE_BLOCKED            warning       ✅ KIOSZTVA (P1.1)
                                                            (a tervezett *_CONFIG_MISSING
                                                             helyett — lásd §2.6)
TRK-950-016  RECON_BUSINESS_SOURCE_DRIFT      critical      ✅ KIOSZTVA (P1.2)
TRK-950-017  RECON_BUSINESS_SOURCE_MISSING    warning       ✅ KIOSZTVA (P1.2)
```

> A sávot **nem** szabad újrahasznosítani: a `TRK-910` blokk kommentje
> (`error-codes.ts:162-168`) pontosan azt rögzíti, hogy egy már kiosztott kód
> újraértelmezése retrospektív log-vesztés — egy régi találat holnap mást jelentene.

**Csatorna:** a meglévő `handleReconciliation` út — structured log (`error_code`-dal) +
Analytics Engine metrika + email CSAK findingnál. **Nincs** új riasztási csatorna: a
riasztás-fáradtság ugyanúgy elfedi a néma hibát, mint a csend.

---

## 5. DoD és a RED→GREEN átmenet

**DoD (a tervből):** *egy szándékosan kikapcsolt Google offline-láb 24 órán belül piros.*

Gyakorlati bizonyítás az implementáció után (nem szimuláció): egy teszt-site
`gads.conversion_actions` térképéből vedd ki az adott eventet, küldj be egy valódi
lifecycle-státuszt, és a következő recon-futásnak `offline_config_missing`-et **kell**
adnia; majd állítsd vissza, és a következő futásnak tisztának kell lennie.

A `tests/reconciliation-business-leg.test.ts` elvárásai MEG VANNAK FORDÍTVA:

| Régi (RED-baseline) elvárás | Most |
|---|---|
| `computeSiteDrift(50 lead_status, 0 offline delivery) === []` | ✅ `offline_zero_delivery`, `summarize().worst === 'critical'` |
| `lead_status_total: 500` és `0` ugyanazt adja | ✅ a kettő ELTÉRŐ kimenetet ad |
| `assembleReconInputs` eldobja a `gads` sort | ✅ a gads offline láb saját `OfflineLegInput`-ként jön be (a `PLATFORMS` lista helyesen továbbra sem tartalmazza — az a böngésző-fan-outé) |
| a 100%-ban skipped láb néma | ✅ a skip OKA dönt: `consent_withdrawn` → csend, `not_configured` → CRITICAL. Azonos darabszám, azonos „0 accepted" — a különbség az ok |

Amit az implementáció **nem ronthat el** (szintén tesztelve): a meglévő Meta
`coverage_drift` + `vendor_failure_rate` és a `minSample`-őr változatlanul működik. A
business-leg ÚJ láb, nem a Meta-formula átírása.

---

## 6. Sorrend és függőségek

1. ✅ **P1.1** — kész. Önmagában is értéket ad (a gateway-ben már megvolt minden adat),
   CRM-változást nem igényelt.
2. ✅ **P1.2 gateway-fél** — kész (endpoint + tábla + recon-láb + riport).
   ⏳ **P1.2 CRM-fél** — §3.5, a meglévő cron-driverbe illeszkedő napi hívás.
3. **A P2 OAuth-függést a kód kezeli, nem a munkasorrend** (review-korrekció #2). Amíg
   a worker-secret vagy a refresh token hiányzik, az érintett láb `BLOCKED_DEPENDENCY`
   állapotban áll: **nem riaszt**, de a napi riportban ott a sora az okkal. Amint a
   `docs/gads-oauth-repair-runbook.md` szerinti helyreállítás megtörtént, a láb magától
   `UNARMED`-be, majd az első bizonyított feltöltés után `ARMED`-be lép — kézi
   „bekapcsolás" nincs, és nem is felejthető el.
