-- 0010 — a lifecycle-status DETERMINISZTIKUS azonosítója + a lead-scope index.
--
-- ── MIÉRT (a `lead_status` sorai per-KÍSÉRLET keletkeznek) ───────────────────
-- A `recordLeadStatus` feltétel nélküli INSERT friss UUID-vel, és a hívás a
-- routes/lead-status.ts-ben a 503/202 elágazások ELŐTT ütemeződik. Vagyis MINDEN
-- CRM-újrapróbálkozás (és minden elveszett 200 utáni ismétlés) ÚJ sort ír
-- ugyanarról az egyetlen üzleti eseményről.
--
-- A két olvasó `COUNT(*)`-gal számol:
--   * lib/business-counts.ts — a CRM napi darabszámát veti össze a ledgerével.
--     Három újrapróbált lead PONTOSAN elfedhet három olyat, ami sosem érkezett meg
--     (a drift-ellenőrzés `got >= count` ágon továbblép).
--   * lib/reconciliation.ts — az offline `received` szám. Egy tranziens Data
--     Manager-kiesés (3 lead, mind 503-azva, majd elfogadva) received=6 / accepted=3
--     képet ad → HAMIS `offline_coverage_drift` + 50%-os `offline_vendor_failure`,
--     mindkettő CRITICAL. A riasztás pont akkor kiált, amikor minden rendben van.
--
-- ── MIÉRT NEM ELÉG A `DISTINCT lead_id` ─────────────────────────────────────
-- A P10 óta EGY leadhez TÖBB jogos `payment_received` tartozhat (előleg +
-- részletek). A lead_id-re dedupálva két valódi részfizetés EGYNEK látszana —
-- vagyis a túlszámolást alulszámolásra cserélnénk.
--
-- A helyes kulcs a már létező, determinisztikus `orderId`:
--   sha256(lead_id + '_' + status)                       — egyszeri státuszok
--   sha256(lead_id + '_' + status + '_' + occurrence_id)  — ismételhetők (P10)
-- Ugyanaz az üzleti esemény MINDIG ugyanazt adja (a retry is), két külön
-- részfizetés viszont KÜLÖNBÖZŐT. Ez megy fel a Google-nek `transactionId`-ként
-- is, tehát a ledger és a platform ugyanazon a kulcson számol.
--
-- ── VISSZAFELÉ KOMPATIBILIS ────────────────────────────────────────────────
-- Az oszlop NULLABLE, a régi sorokban NULL marad. Az olvasók
-- `COUNT(DISTINCT COALESCE(order_id, id))`-t használnak: a történeti soroknál az
-- `id` (sor-egyedi) miatt ez BITRE a mai `COUNT(*)`, az újaknál viszont dedupál.
-- Backfill SZÁNDÉKOSAN nincs: a régi sorokhoz nem tudjuk utólag megmondani,
-- melyik volt újrapróbálkozás — a hamis pontosság rosszabb, mint a bevallott hiány.
ALTER TABLE lead_status ADD COLUMN order_id TEXT;

-- A napi aggregációk (site_id, occurred_at/created_at) melletti dedup-kulcs.
CREATE INDEX IF NOT EXISTS idx_lead_status_order ON lead_status (site_id, order_id);

-- ── A `consent_receipts` lead-scope indexe ─────────────────────────────────
-- A `getLatestConsentForLead` (a lifecycle GDPR-kapuja, MINDEN /lead-status
-- híváson lefut) és a `getLeadTrail` `(site_id, lead_id)`-re szűr, a 0001 viszont
-- csak `(site_id, received_at)` és `(event_id)` indexet adott. A tábla ráadásul
-- alapból NEM purge-ölt (retention.ts: opt-in), tehát korlátlanul nő — a pénz-út
-- lekérdezése az, ami elsőként lassul be.
CREATE INDEX IF NOT EXISTS idx_consent_lead ON consent_receipts (site_id, lead_id);
