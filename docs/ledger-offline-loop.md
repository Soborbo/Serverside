# D1 ledger + CRM offline-loop

Enterprise-réteg, ami a tracking-gateway-t **bizonyítható adat-infrastruktúrává** teszi:
nem csak elküldjük az eventet, hanem rögzítjük, *mi történt, milyen consenttel, hova
ment, mit fogadtak el a vendorok, és melyik leadből lett valódi pénz*.

Két dolgot ad:

1. **D1 ledger** — append-only rekord minden beérkező konverzióról, a normalizált
   vendor-kézbesítésekről és a consent-döntésekről + gateway-szintű **idempotencia**.
2. **CRM offline-loop** (`/api/event/lead-status`) — a CRM visszaküldi a lead lifecycle
   státuszait (qualified → booked → revenue), amiket **Enhanced Conversions for Leads**-ként
   feltöltünk a Google Ads felé, hogy a bidding a tényleges üzleti értéket lássa.

## Adatvédelem (kötelező)

A ledger **SOHA nem tárol nyers vagy hash-elt PII-t** (CLAUDE.md 13. + 15.). Csak
meta-adatot: `event_id`, `lead_id` (UUID, NEM PII), `event_name`, `value`, consent-jelek,
vendor-válaszok. Az `em_present`/`ph_present` flag-ek csak azt jelzik, *volt-e* azonosító
(EMQ/match-quality audithoz) — a hash-t magát nem.

Az offline-loop a PII-t (`user_data`) a CRM hívásából kapja, **menet közben hash-eli és
továbbítja** a Google Ads felé, majd eldobja — sosem írja le.

## Táblák (`migrations/0001_ledger.sql`)

| Tábla | Mire való |
|---|---|
| `events_raw` | minden elfogadott konverzió nyers rekordja |
| `idempotency` | gateway-ingress dedup (ugyanaz a submit 5× → 1 fan-out) |
| `deliveries` | normalizált vendor-kézbesítés (accepted/rejected/skipped) platformonként |
| `consent_receipts` | a consent-döntés bizonyítéka eseményenként |
| `lead_status` | CRM offline-loop lead lifecycle státuszok |

## Élesítés (D1)

A kód **guardolt**: `LEDGER` binding nélkül a ledger-írás + idempotencia no-op, a Worker
teljesen működik. Bekapcsolás:

```bash
wrangler d1 create event-gateway-ledger
# másold a kiírt database_id-t a wrangler.toml [[d1_databases]] blokkjába
wrangler d1 migrations apply event-gateway-ledger --remote
# vedd ki a kommentből a [[d1_databases]] blokkot a wrangler.toml-ben + redeploy
```

## Idempotencia

Kulcs: `site_id:event_name:event_id`. Ez a **beérkezés-dedup**, NEM a vendor-dedup — a
vendorok az `event_id`-vel dedup-olnak (CLAUDE.md 16.). Első látáskor a fan-out lefut;
ismételt látáskor a `seen_count` nő, de a fan-out kimarad. **Fail-open**: D1-hiba esetén
inkább kézbesítünk, mint hogy egy valódi konverziót eldobjunk.

## CRM offline-loop endpoint

`POST /api/event/lead-status` — admin-auth (`X-Admin-Token`), hostname-alapú site routing.

```bash
curl -X POST https://<site-host>/api/event/lead-status \
  -H "X-Admin-Token: $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "revenue_confirmed",
    "value": 1200,
    "currency": "GBP",
    "occurred_at": "2026-06-26T10:30:00Z",
    "user_data": { "email": "jane@email.com", "phone_number": "+447123456789" }
  }'
```

Érvényes státuszok: `lead_validated`, `lead_qualified`, `quote_sent`, `booking_confirmed`,
`job_completed`, `revenue_confirmed`, `lead_disqualified`. Minden státusznak megfelelő
Google Ads **conversion action**-t kell felvenni a SiteConfig `gads.conversion_actions`
mapbe (különben a feltöltés no-op warninggal kimarad).

**GDPR-kapu**: ha a lead capture-kor visszavonta az ad-consentet (`consent_receipts`
szerint `ad_allowed=0`), az offline upload **kimarad**. Ha nincs consent-rekord (D1 nélkül
vagy ismeretlen lead), engedjük (a CRM megbízható, a consent a business felelőssége).

A `lead_id`-t a **kliens** generálja (UUID) capture-kor, és ugyanazt küldi a konverziós
event `lead_id` mezőjébe ÉS a CRM-be — így köthető össze a kettő.

## Reconciliation (automata drift-detektálás)

Napi cron (`15 8 * * *`, a digest után) a ledger fölött drift-et detektál és riaszt —
`src/scheduled/reconciliation.ts`, pure maggal `src/lib/reconciliation.ts`. Két független
hibamódot fog meg site × platform bontásban:

| Jel | Mit fog meg | Küszöb |
|---|---|---|
| **vendor failure rate** (`TRK-950-001`) | a kézbesítések elbukási aránya | warn ≥5%, crit ≥15% |
| **coverage drift** (`TRK-950-002`) | a jogosult eventek be sem jutottak a platformra | warn <90%, crit <70% lefedettség |

- `MIN_SAMPLE=10` guard — nincs riasztás apró zajra.
- A `skipped` (consent-blokkolt) kézbesítések NEM számítanak hibának.
- GA4 lefedettsége az összes eventhez mérve, Meta/Google Ads csak az ad-jogosultakhoz.
- Minden finding → strukturált log (error_code-dal) **+** Analytics Engine metrika
  (`reconciliation` index, site × platform × kind × severity trendhez). Email CSAK ha van
  finding (no-noise). Küszöbök: `DEFAULT_THRESHOLDS` a `lib/reconciliation.ts`-ben.

Ad-hoc lekérdezések (külön warehouse nélkül) a ledger fölött:

```sql
-- Napi accepted lead-count platformonként (drift-figyeléshez)
SELECT date(created_at) AS day, platform, status, count(*) AS n
FROM deliveries
WHERE site_id = 'painless'
GROUP BY day, platform, status
ORDER BY day DESC;

-- Konverzió → revenue funnel (CRM ground truth)
SELECT status, count(*) AS leads, sum(value) AS revenue
FROM lead_status
WHERE site_id = 'painless'
GROUP BY status;
```
