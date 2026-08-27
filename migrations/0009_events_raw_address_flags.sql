-- M5 — A CÍM-MEZŐK LEFEDETTSÉGE MÉRHETŐVÉ TÉVE.
--
-- A ledger eddig NÉGY match-kulcs jelenlétét írta (em, ph, fbc, fbp), és az
-- EMQ-proxy metrika is csak ezt a négyet nézte. Ha egy site abbahagyta a
-- city/postal_code/country küldését, az a napi digestben és a
-- coverage-riasztásban LÁTHATATLAN maradt — csak a Meta Events Managerben,
-- késleltetve.
--
-- Ez nem elméleti hiány volt: a painless böngésző-lába hónapokig postal_code
-- NÉLKÜL küldött, miközben a szerver-lába küldte, és SEMMI nem jelezte. Egy
-- mezőkészlet-szerződés, amit nem mérünk, a következő regressziónál is csendes
-- lesz.
--
-- Vendor-oldali indok, hogy pont ez a három: a Worker felől a META az egyetlen
-- platform, amely ct/zp/country-t kap (TikTok csak em/ph, LinkedIn csak em).
--
-- A flag NEM PII: az értéket magát SOHA nem tároljuk, csak hogy volt-e
-- (CLAUDE.md 13.). Ugyanaz a minta, mint a 0002-es migrációban.
ALTER TABLE events_raw ADD COLUMN ct_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events_raw ADD COLUMN zp_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events_raw ADD COLUMN country_present INTEGER NOT NULL DEFAULT 0;
