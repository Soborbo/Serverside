-- EMQ-proxy metrika (daily digest): a Meta match-kulcsok JELENLÉTÉT rögzítjük
-- eseményenként, a meglévő em_present/ph_present mintájára. A leggyakoribb csendes
-- CAPI-regresszió egy eltört fbc/fbp-forwarding — a kézbesítés (smoke) zöld marad,
-- csak a match-minőség esik. A flag NEM PII: a cookie/click-ID értékét magát SOHA
-- nem tároljuk, csak hogy volt-e (CLAUDE.md 13.).
ALTER TABLE events_raw ADD COLUMN fbc_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events_raw ADD COLUMN fbp_present INTEGER NOT NULL DEFAULT 0;
