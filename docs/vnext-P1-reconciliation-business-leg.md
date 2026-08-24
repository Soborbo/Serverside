# P1 — Reconciliation business-leg: TERV

**Dátum:** 2026-08-24 · **vNext P1 (első batch „E" fázis)** · **Státusz: TERV + RED TESZTEK.
Implementáció NEM történt** — az a jóváhagyott sorrend 6. tétele, az A–E lezárása és egy
új review után.

**RED-teszt fájl:** `tests/reconciliation-business-leg.test.ts` — szándékosan „fordított"
tesztek: azt rögzítik, hogy a MAI kód hol vak. Az implementáció során ezeket **meg kell
fordítani**; ha a P1 elkészül és az a fájl változatlanul zöld, az implementáció nem ért a
lényegig.

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

### 2.3 A négy új finding

| kind | severity | feltétel | jelentés |
|---|---|---|---|
| `offline_zero_delivery` | **critical** | `received > 0 && accepted === 0` ÉS (`last_accepted_at` létezik ÉS 24h-n belüli előzmény volt) **VAGY** (7 napos ablakban `received >= offlineMinSample && accepted === 0 && (expected \|\| configured)`) | a láb HALOTT — ez a terv RED-tesztjének célfindingje |
| `offline_coverage_drift` | warning / critical | `accepted / max(0, received - skipped)` a küszöb alatt | részleges kiesés |
| `offline_vendor_failure` | warning / critical | `rejected / (accepted + rejected)` a küszöb fölött | a Google elutasít (auth, allowlist, formátum) |
| `offline_config_missing` | **critical** | `received >= offlineMinSample && !configured` | a CRM olyan státuszokat küld, amiket a config nem tud sehova feltölteni — a lead „meg lett jelölve", de a pénz nem ér célba |

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

### 2.4 D1-lekérdezések (a meglévő `fetchReconInputs` mellé)

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

### 2.5 Bekötés

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

```http
POST /api/event/admin/business-counts
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

### 3.4 Amit a v1 SZÁNDÉKOSAN nem csinál

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
TRK-950-012  RECON_OFFLINE_ZERO_DELIVERY      critical
TRK-950-013  RECON_OFFLINE_COVERAGE_DRIFT     warning|critical
TRK-950-014  RECON_OFFLINE_VENDOR_FAILURE     warning|critical
TRK-950-015  RECON_OFFLINE_CONFIG_MISSING     critical
TRK-950-016  RECON_BUSINESS_SOURCE_DRIFT      critical
TRK-950-017  RECON_BUSINESS_SOURCE_MISSING    warning|critical
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

A `tests/reconciliation-business-leg.test.ts` elvárásai, amiket az implementációnak MEG
KELL FORDÍTANIA:

| Mai (RED-baseline) elvárás | P1 után |
|---|---|
| `computeSiteDrift(50 lead_status, 0 offline delivery) === []` | `kinds` tartalmazza az `offline_zero_delivery`-t, `summarize().worst === 'critical'` |
| `lead_status_total: 500` és `0` ugyanazt adja | a kettő ELTÉRŐ kimenetet ad |
| `assembleReconInputs` eldobja a `gads` sort | a gads offline láb saját `OfflineLegInput`-ként jelenik meg |
| a 100%-ban skipped láb néma | `offline_config_missing` különválasztja a config-hiányt a consent-tiltástól |

Amit az implementáció **nem ronthat el** (szintén tesztelve): a meglévő Meta
`coverage_drift` + `vendor_failure_rate` és a `minSample`-őr változatlanul működik. A
business-leg ÚJ láb, nem a Meta-formula átírása.

---

## 6. Sorrend és függőségek

1. **P1.1 előbb.** Önmagában is értéket ad (a gateway-ben már megvan minden adat), és
   nem igényel CRM-változást.
2. **P1.2 utána**, mert CRM-oldali munkát is kér (aggregátum-endpoint hívása a meglévő
   cronból) — és mert a P1.1 nélkül nincs mihez viszonyítani.
3. **Nyitott előfeltétel mindkettőhöz:** a P2 OAuth-helyreállítás. Amíg a Google offline
   feltöltés nem tud sikerülni, a `offline_zero_delivery` **igazat mondana**, de nem
   drift-ként — hanem a P2 ismert, nyitott hibájaként. Előbb legyen egy valódi
   `accepted` sor a ledgerben (`docs/gads-oauth-repair-runbook.md` §3), utána élesítsük
   a detektort, különben az első naptól riasztás-zajt termel.
