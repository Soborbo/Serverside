-- Soborbo CMP · Fázis 1 — consent-proof és banner-mérés (4. brief).
--
-- MIÉRT KÉT TÁBLA. A `consent_log` DÖNTÉSEKET tárol (GDPR Art. 7(1)
-- accountability: bizonyítanunk kell, hogy a látogató hozzájárult, és hogy MIT
-- mondtunk neki, amikor hozzájárult). A `consent_metrics` a banner-MEGJELENÉSEKET
-- méri — ott még nincs döntés, tehát nincs is mit bizonyítani. Egy táblában a
-- kettő azt jelentené, hogy a megjelenés-ping azonosítót hordoz, vagyis a
-- mérőműszer megsértené, amit mér.
--
-- INERT: amíg egyetlen site sem küld `POST /api/consent`-et (a `consent.provider`
-- alapértéke MINDENHOL `'cookieyes'`), ezek a táblák üresek maradnak, és a
-- konverziós út viselkedése bitre azonos a maival. A pilot élesítése EGY KV-flag,
-- amit ember állít át.
--
-- DEPLOY-SORREND: előbb ez a migráció, UTÁNA a Worker. (A `consent_receipts`
-- INSERT egy oszloppal bővül; migráció nélkül a receipt-írás elbukna — a
-- recordConsentReceipt try/catch-el, tehát nem event-vesztés, de a receiptek
-- némán elmaradnának, épp a Fázis D mérése alatt.)

-- ── Döntések — APPEND-ONLY ────────────────────────────────────────────────────
--
-- NINCS `withdrawn_at`, és NINCS UPDATE. A visszavonás egy ÚJ sor `decision =
-- 'withdrawn'` értékkel, eggyel magasabb `revision`-nel. Az aktuális állapot
-- mindig az adott `consent_id` LEGMAGASABB revision-je.
--
-- MIÉRT: a felülírható consent-rekord nem bizonyíték. Ha egy sor módosulhat, a
-- „mire hivatkozott a látogató, amikor igent mondott" kérdés nem válaszolható
-- meg visszamenőleg — a versionált szövegre mutatás (consent_text_version) pont
-- ettől ér valamit.
CREATE TABLE IF NOT EXISTS consent_log (
  id TEXT PRIMARY KEY,

  -- A böngésző/preferencia-lánc stabil azonosítója (a sütiben él, több döntésen át).
  consent_id TEXT NOT NULL,
  -- EGY konkrét döntés UUID-ja. Ez az IDEMPOTENCIA-KULCS, NEM a timestamp: a
  -- kliens 503 után újraküldi ugyanezt az ID-t, és a második beérkezés nem
  -- csinál új sort. Timestamp-alapú kulcs mellett a retry duplikálna.
  consent_event_id TEXT NOT NULL UNIQUE,
  -- Döntésenként nő. A beaconök fordított sorrendben is beérkezhetnek (retry,
  -- hálózati átrendeződés) — a revision nélkül egy KÉSŐBB beérkező RÉGEBBI
  -- döntés felülírná az újat. Az olvasó mindig MAX(revision)-t vesz.
  revision INTEGER NOT NULL,

  site_id TEXT NOT NULL,

  -- accept_all | reject_all | custom | withdrawn.
  -- A `reprompt_shown` SZÁNDÉKOSAN NEM tartozik ide — az nem döntés, hanem
  -- megjelenés-esemény, és a consent_metrics-be megy.
  decision TEXT NOT NULL,

  -- A két kategória, ahogy a panel mutatta (0/1).
  cat_analytics INTEGER NOT NULL,
  cat_marketing INTEGER NOT NULL,

  -- A négy Google Consent Mode v2 jel, ahogy a döntésből leképeztük.
  ad_user_data TEXT,
  ad_personalization TEXT,
  ad_storage TEXT,
  analytics_storage TEXT,

  -- basic | advanced. Per-site KV-érték; a default `basic` (a v4 terv 8.
  -- függeléke: az advanced pre-consent pingjei EEA-ban vitatottak).
  consent_mode TEXT NOT NULL,

  -- „MIT MONDTUNK NEKI" — a három verzió együtt teszi a sort bizonyítékká.
  -- A consent_text_version a Git-ben őrzött, szó szerinti banner-szövegre mutat
  -- (consent-texts/<verzió>/{hu,en}.json). E nélkül a rekord csak azt bizonyítja,
  -- hogy VALAMIRE igent mondtak.
  policy_version TEXT NOT NULL,
  banner_version TEXT NOT NULL,
  consent_text_version TEXT NOT NULL,

  -- Melyik szabálykészlet szerint futott (pl. eea_uk). Az ismeretlen ország
  -- fail-closed a szigorúbb szabályra — a ruleset rögzítése teszi utólag
  -- ellenőrizhetővé, hogy melyik szerint döntöttünk.
  ruleset TEXT NOT NULL,

  lang TEXT,
  country TEXT,
  client_lib_version TEXT,

  -- ── Párhuzamos mérési ablak (a pilot 1-2 hete) ─────────────────────────────
  -- Amíg a CookieYes szkript kint marad (kikapcsolt bannerrel), a kliens az ő
  -- sütijét IS beolvassa, és ide küldi, amit ugyanabban a pillanatban látott.
  -- Így ugyanarra a látogatóra közvetlenül összevethető a két rendszer, nem
  -- aggregált arányokon keresztül. NULL = nem volt jelen.
  cky_cookie_analytics INTEGER,
  cky_cookie_marketing INTEGER,
  -- 0/1: egyezik-e a CookieYes olvasata a sajátunkkal. NULL, ha nincs mihez mérni.
  cky_agreement INTEGER,

  -- Külön a kettő: a kliens szerinti döntés-idő és a szerver beérkezés-ideje. Egy
  -- offline-ról visszatérő beacon napokkal később is érkezhet; egyetlen
  -- timestamppel nem lenne eldönthető, mikor DÖNTÖTT a látogató.
  client_decided_at TEXT NOT NULL,
  server_received_at TEXT NOT NULL
);

-- Site-onkénti idősoros lekérdezés (napi arányok, admin-nézet).
CREATE INDEX IF NOT EXISTS idx_cl_site_time ON consent_log(site_id, server_received_at);
-- A legfrissebb revision feloldása egy consent_id-re — ezt hívja a
-- GET /api/consent/:consent_id és az offline/replay ág minden upload ELŐTT.
CREATE INDEX IF NOT EXISTS idx_cl_cid_rev ON consent_log(consent_id, revision);

-- ── Banner-megjelenések — SZIGORÚAN ID-MENTES ────────────────────────────────
--
-- Se `consent_id`, se user-azonosító, se fingerprint-elem, se IP, se UA. A
-- megjelenéskor a látogató még nem döntött semmiről: egy azonosítót hordozó ping
-- pontosan az a nem-esszenciális adatgyűjtés lenne consent előtt, amit a banner
-- meg akar előzni. Ezért ez a tábla nem JOIN-olható a consent_log-hoz — ez nem
-- hiányosság, hanem a lényeg.
CREATE TABLE IF NOT EXISTS consent_metrics (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  banner_version TEXT NOT NULL,
  lang TEXT,
  -- mobile | tablet | desktop — viewport-osztály, nem eszköz-ujjlenyomat.
  device_class TEXT,
  -- Megjelenéstől a döntésig eltelt idő. NULL, ha nem lett döntés — és ez maga is
  -- adat (mennyi látogató hagyja figyelmen kívül a bannert).
  interaction_ms INTEGER,
  shown_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cm_site_time ON consent_metrics(site_id, shown_at);

-- ── A konverziós út kötése a consent-proofhoz ────────────────────────────────
--
-- NULLABLE, és a CookieYes-oldalakon MINDIG NULL marad — nem hiba. Ahol a saját
-- CMP fut, ez köti a konverziót ahhoz a konkrét döntéshez, amire hivatkozunk:
-- a receipt megmondja, mit LÁTTUNK az event pillanatában, a consent_log azt,
-- hogy a látogató MIT DÖNTÖTT és mit olvasott hozzá.
ALTER TABLE consent_receipts ADD COLUMN consent_id TEXT;
