-- 0008 — P1.2 business-count snapshot ordering.
--
-- A business_counts payload a CRM adott napi TELJES snapshotja. A received_at nem
-- alkalmas sorrendezésre: egy régi snapshot retryja később érkezhet, mint egy frissebb.
-- Ez a tábla a FORRÁS által adott generated_at időpontot őrzi site × UTC-nap szerint.
-- A write-path csak akkor cseréli a business_counts sorokat, ha az incoming generated_at
-- nem régebbi az itt tároltnál; így stale retry nem tud frissebb állapotot visszaírni.
CREATE TABLE IF NOT EXISTS business_count_snapshots (
  site_id      TEXT NOT NULL,
  date         TEXT NOT NULL,  -- YYYY-MM-DD UTC business day
  generated_at TEXT NOT NULL,  -- canonical ISO 8601 UTC timestamp from the CRM
  received_at  TEXT NOT NULL,  -- when the gateway accepted this snapshot version
  PRIMARY KEY (site_id, date)
);

CREATE INDEX IF NOT EXISTS idx_business_count_snapshots_date
  ON business_count_snapshots (date, site_id);
