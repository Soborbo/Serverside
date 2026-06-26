-- D1 ledger — append-only bizonyíték a beérkező konverziókról, a vendor-kézbesítésekről,
-- a consent-döntésekről és a CRM offline-loop lead-státuszokról.
--
-- FONTOS adatvédelmi szabály (CLAUDE.md 13. + 15.): a ledger SOHA nem tárol nyers
-- vagy hash-elt PII-t (email/telefon/név/cím). Csak META-adatot tárol: event_id,
-- lead_id (UUID, NEM PII), event_name, value, consent-jelek, vendor-válaszok.
-- Az `*_present` flag-ek azt rögzítik, MELYIK azonosító volt jelen (match-quality
-- audithoz) — a hash-t magát nem. Az offline-loop (lead_status) a PII-t a CRM
-- hívásból kapja és menet közben hash-eli + továbbítja, sosem tárolja.

-- ── 1. Minden elfogadott konverziós event nyers rekordja ─────────────────────
CREATE TABLE IF NOT EXISTS events_raw (
  id            TEXT PRIMARY KEY,            -- ULID-szerű, a worker generálja
  event_id      TEXT NOT NULL,              -- a kliens shared event_id-je (Meta dedup)
  lead_id       TEXT,                       -- stabil lead UUID, ha a kliens küldte (NEM PII)
  site_id       TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  event_time    INTEGER NOT NULL,          -- Unix seconds (a kliens event_time-ja)
  value         REAL,
  currency      TEXT,
  ad_allowed    INTEGER NOT NULL DEFAULT 0, -- consent feloldás eredménye (0/1)
  em_present    INTEGER NOT NULL DEFAULT 0, -- volt-e hash-elt email (match-quality audit)
  ph_present    INTEGER NOT NULL DEFAULT 0, -- volt-e hash-elt telefon
  received_at   TEXT NOT NULL              -- ISO 8601, a worker fogadási ideje
);
CREATE INDEX IF NOT EXISTS idx_events_raw_site_time   ON events_raw (site_id, received_at);
CREATE INDEX IF NOT EXISTS idx_events_raw_event_id    ON events_raw (event_id);
CREATE INDEX IF NOT EXISTS idx_events_raw_lead_id     ON events_raw (lead_id);

-- ── 2. Idempotencia — a gateway-ingress dedup (NEM a vendor-dedup) ────────────
-- Kulcs: site_id:event_name:event_id. Ugyanaz a submit 5×? → seen_count nő, de
-- a fan-out csak egyszer fut. do_not_replay: consent-visszavonás / policy tiltás.
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  seen_count      INTEGER NOT NULL DEFAULT 1,
  dispatched      INTEGER NOT NULL DEFAULT 0, -- elindult-e már a fan-out (0/1)
  do_not_replay   INTEGER NOT NULL DEFAULT 0  -- tiltott újraküldés (0/1)
);

-- ── 3. Normalizált vendor-kézbesítés (DeliveryResult egységes alak) ───────────
-- delivery_attempts + vendor_responses összevonva — KKV-skálán egy tábla elég.
CREATE TABLE IF NOT EXISTS deliveries (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  lead_id        TEXT,
  site_id        TEXT NOT NULL,
  event_name     TEXT NOT NULL,
  platform       TEXT NOT NULL,             -- meta | ga4 | gads
  status         TEXT NOT NULL,             -- accepted | rejected | skipped
  http_status    INTEGER,
  error_code     TEXT,                      -- TRK-... kód, ha rejected
  vendor_message TEXT,                      -- sanitizált hibaüzenet (nincs PII)
  attempt        INTEGER NOT NULL DEFAULT 0,
  origin         TEXT NOT NULL DEFAULT 'fanout', -- fanout | retry | offline
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_site_time ON deliveries (site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_event_id  ON deliveries (event_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status    ON deliveries (site_id, platform, status);

-- ── 4. Consent receipt — a consent-döntés bizonyítéka eseményenként ───────────
CREATE TABLE IF NOT EXISTS consent_receipts (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  lead_id            TEXT,
  site_id            TEXT NOT NULL,
  ad_user_data       TEXT,                  -- GRANTED | DENIED | UNSPECIFIED | null
  ad_personalization TEXT,
  ad_storage         TEXT,
  analytics_storage  TEXT,
  require_consent    INTEGER NOT NULL DEFAULT 0,
  ad_allowed         INTEGER NOT NULL DEFAULT 0,
  received_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_site_time ON consent_receipts (site_id, received_at);
CREATE INDEX IF NOT EXISTS idx_consent_event_id  ON consent_receipts (event_id);

-- ── 5. CRM offline-loop — lead lifecycle státuszok (a tényleges üzleti érték) ──
-- A CRM ide küldi: lead_qualified / booking_confirmed / job_completed /
-- revenue_confirmed / lead_disqualified. uploaded_to_gads: sikerült-e az
-- Enhanced Conversions for Leads visszaküldés a Google Ads felé.
CREATE TABLE IF NOT EXISTS lead_status (
  id               TEXT PRIMARY KEY,
  lead_id          TEXT NOT NULL,
  site_id          TEXT NOT NULL,
  status           TEXT NOT NULL,           -- internal status / event_name
  value            REAL,
  currency         TEXT,
  occurred_at      TEXT NOT NULL,           -- mikor történt a CRM-ben (ISO 8601)
  source           TEXT NOT NULL DEFAULT 'crm',
  uploaded_to_gads INTEGER NOT NULL DEFAULT 0,
  gads_error_code  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_status_lead ON lead_status (lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_status_site ON lead_status (site_id, created_at);
