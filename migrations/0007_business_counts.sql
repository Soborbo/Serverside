-- 0007 — P1.2: CRM business-source reconciliation.
--
-- MIÉRT: a P1.1 offline láb azt méri, hogy a GATEWAY-BE BEÉRKEZETT lifecycle-státuszok
-- eljutottak-e a Google-ig. Azt NEM látja, ha a CRM→gateway hívás EL SEM INDUL:
-- olyankor `received = 0`, és nulla elvárás mellett a nulla kézbesítés tökéletesen
-- egészségesnek látszik. Ez a gateway-ledger szerkezeti vakfoltja — semmilyen
-- gateway-oldali lekérdezés nem tudja betömni, mert a hiányzó hívásról nincs nyoma.
--
-- A megoldás egy PII-MENTES napi aggregátum, amit a CRM a MEGLÉVŐ cron-driveréről
-- pushol: csak (event_name, count) párok. Se lead_id, se érték, se identitás.
--
-- Az idempotencia a PRIMARY KEY-ből jön (`ON CONFLICT DO UPDATE`), tehát az
-- újraküldés biztonságos — ugyanaz a minta, mint a CRM outbox determinisztikus
-- kulcsainál. Egy késve érkező, javított aggregátum felülírja a korábbit.
CREATE TABLE IF NOT EXISTS business_counts (
  site_id     TEXT NOT NULL,
  date        TEXT NOT NULL,           -- YYYY-MM-DD (UTC), a CRM-napra vonatkozik
  event_name  TEXT NOT NULL,           -- kanonikus lifecycle event (lead_qualified, …)
  count       INTEGER NOT NULL,
  received_at TEXT NOT NULL,           -- mikor vettük át (ISO 8601)
  PRIMARY KEY (site_id, date, event_name)
);

-- A recon a legutóbbi napokat kérdezi site-onként; a PK bal oldala (site_id) már
-- fed, de a dátum-tartományos lekérdezéshez a fordított sorrend a hasznos.
CREATE INDEX IF NOT EXISTS idx_business_counts_date ON business_counts (date, site_id);
