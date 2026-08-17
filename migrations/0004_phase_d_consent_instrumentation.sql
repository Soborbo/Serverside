-- Fázis D — consent-diagnosztika műszerezés (S1).
--
-- MIÉRT: 30 nap ledger-adatból 9 olyan delivery van, ami `skipped` státuszú,
-- miközben a hozzá tartozó consent receipt GRANTED (8× lomtalan, 1× agykontroll).
-- Ezeknek nem szabadna létezniük — és mivel EGYETLEN skipped sornak sincs
-- error_code-ja, a skip oka sehol nincs rögzítve: nem tudjuk, melyik ágon
-- keletkeztek. Elsőszámú hipotézis: betöltési verseny (a CookieYes szkript
-- betöltése ELŐTT sül el az event → az API-alapú kliens-kapu deny-t mond,
-- miközben a süti-alapú receipt GRANTED-et rögzít).
--
-- Ez a migráció NEM javít semmit — MÉR. A három párhuzamos consent-olvasás
-- (kliens API, kliens süti, szerver Cookie header) szándékosan marad, mert az a
-- diagnosztika TÁRGYA; egységesítésük megsemmisítené a mérést.
--
-- Additív és visszafelé kompatibilis: minden új oszlop NULLABLE, default nélkül.
-- DEPLOY-SORREND: előbb ez a migráció, UTÁNA a Worker.

-- ── 1. Skip-ok megnevezése ───────────────────────────────────────────────────
-- A `SkipReason` típus már létezett a kódban (lib/skip-reason.ts), csak nem
-- perzisztálódott. Enum-értékek (lásd a típust): consent_denied |
-- consent_missing_failclosed | consent_missing_legacy | consent_uncertain_failclosed |
-- no_identifiers | dedup | not_expected | not_configured | eea_rule | template_guard.
-- Backfill NINCS: a régi sorok NULL-ok maradnak, a jövőbeliek számítanak.
ALTER TABLE deliveries ADD COLUMN skip_reason TEXT;

-- ── 2. Consent-források a receipten ──────────────────────────────────────────
-- Parse-olt booleanok forrásonként, NEM nyers stringek (a nyers dump csak a
-- consent_debug táblába megy, kizárólag mismatch esetén).
--
-- NULL SZEMANTIKA — FONTOS: NULL = az adott forrás NEM VOLT ELÉRHETŐ abban a
-- pillanatban. Ez nem hiányzó adat, hanem maga a bizonyíték (pl. az API még nem
-- töltött be → betöltési verseny). SOHA ne töltsd fel default értékkel, és ne
-- írj rá NOT NULL DEFAULT 0-t: attól a mérés hazudni kezd.
ALTER TABLE consent_receipts ADD COLUMN src_cookie_analytics INTEGER;   -- süti-parse (kliens vagy site-backend)
ALTER TABLE consent_receipts ADD COLUMN src_cookie_marketing INTEGER;
ALTER TABLE consent_receipts ADD COLUMN src_api_analytics INTEGER;      -- getCkyConsent() (kliens JS API)
ALTER TABLE consent_receipts ADD COLUMN src_api_marketing INTEGER;
ALTER TABLE consent_receipts ADD COLUMN src_server_analytics INTEGER;   -- a worker SAJÁT HTTP Cookie header parse-a
ALTER TABLE consent_receipts ADD COLUMN src_server_marketing INTEGER;
-- Melyik forrás hajtotta a KLIENS döntését: cookieyes_cookie | cookieyes_api |
-- override | server_cookie | none.
ALTER TABLE consent_receipts ADD COLUMN source_used TEXT;
-- 1 = minden NEM-NULL forrás egyezik; 0 = bármelyik kettő eltér; NULL = egyetlen
-- forrás sem volt elérhető (nincs mit összevetni).
ALTER TABLE consent_receipts ADD COLUMN source_consistent INTEGER;
-- browser | server — melyik ingressen érkezett az event.
ALTER TABLE consent_receipts ADD COLUMN ingress_kind TEXT;
ALTER TABLE consent_receipts ADD COLUMN client_lib_version TEXT;
-- CookieYes alatt NULL MARAD: a `cookieyes-consent` süti nem hordoz timestampet,
-- és heurisztikát nem találunk ki rá. Csak az sbo_consent korszakban lesz értéke.
ALTER TABLE consent_receipts ADD COLUMN consent_age_s INTEGER;

-- KIEGÉSZÍTÉS a brief oszloplistájához (jelezve, mert ELTÉRÉS a specifikációtól):
-- a napi keresztellenőrzés (S3/2.) „TRK-9xx darabszám site_id × client_lib_version
-- bontásban"-t kér. A -002/-003 a consent_debug-ból számolható, a -001 a
-- jel-oszlopokból — de a -005 (a jelek belül inkonzisztensek) és a -006 (elavult
-- kliens-lib) SEHOL nem lenne D1-ből lekérdezhető, csak a Workers-logban.
-- Márpedig épp ezek dominanciája dönti el a döntési kaput (A kimenetel: „a saját
-- bekötéseink csúsznak szét"). Ezért a receipt egy vesszős KÓD-listát is hordoz
-- (pl. "TRK-910-003,TRK-910-005"); tiszta eventnél NULL. Ez parse-olt telemetria,
-- NEM nyers süti — az továbbra is kizárólag a consent_debug táblába megy.
ALTER TABLE consent_receipts ADD COLUMN finding_codes TEXT;

-- ── 3. Rövid életű debug-tábla ───────────────────────────────────────────────
-- CSAK mismatch esetén ír (TRK-910-002 parse-olhatatlan / TRK-910-003 források
-- ellentmondanak). A nyers süti-stringek KIZÁRÓLAG ide kerülnek, a
-- consent_receipts-be soha. 14 napos purge (lib/retention.ts) — nem örök napló.
CREATE TABLE IF NOT EXISTS consent_debug (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  error_code    TEXT NOT NULL,
  raw_cookie    TEXT,
  raw_api       TEXT,
  raw_server    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_debug_created ON consent_debug (created_at);
