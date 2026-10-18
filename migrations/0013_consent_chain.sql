-- 0013 — a consent-lánc kulcsának EGYETLEN, atomi kötése (2026-10-18 review R7,
-- második utóellenőrzés).
--
-- ── MIÉRT KÜLÖN TÁBLA ───────────────────────────────────────────────────────
-- A 0011/0012 a kulcs-hash-t a consent_log soraira írta, és a „melyik az első
-- kulcs" kérdést egy ORDER BY server_received_at döntötte el. Két egyszerre
-- induló első döntés (két lap, vagy egy azonosítót ismerő harmadik fél) így két
-- KÜLÖN kulcsot köthetett ugyanahhoz a lánchoz, és a „győztes" egy időbélyeg-
-- verseny eredménye volt. Itt a (site_id, consent_id) PRIMARY KEY: a kötés és a
-- lánc első sora EGY D1-batchben (tranzakcióban) íródik, a második kötési
-- kísérlet UNIQUE-hibával elbukik — pontosan egy kulcs nyer.
--
-- ── A KULCS ─────────────────────────────────────────────────────────────────
-- A kulcsot a SZERVER generálja és HttpOnly sütiben adja ki (`sbo_consent_key`,
-- Path=/api/consent) — nem a böngésző localStorage-a tartja. Így a letiltott
-- tárhely nem hagy védelem nélküli láncot, és a kulcs ugyanaddig él, mint a
-- hozzájárulási süti. Itt CSAK a SHA-256(site_id:consent_id:kulcs) áll.
--
-- ── RÉGI LÁNCOK ─────────────────────────────────────────────────────────────
-- A 0013 előtti, kulcs nélküli láncoknak NINCS sora itt, és nem is kaphatnak: a
-- meglévő adatokból (consent_id + a küldő által gyártható süti) a tulajdonos NEM
-- igazolható. Rájuk igazolatlan írás csak szigoríthat; engedélyt az új, kulcsos
-- lánc ad (routes/consent.ts).
--
-- A 0011/0012 alatt már igazoltan kötött kulcsokat átvesszük (a legkorábbi
-- igazolt sor kulcsát) — így egy esetleg már élő 6.11/6.12 lánc sem veszti el a
-- védelmét. A `consent_log.key_hash` oszlopot innentől nem írjuk (audit-örökség).
CREATE TABLE IF NOT EXISTS consent_chain (
  site_id TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (site_id, consent_id)
);

INSERT OR IGNORE INTO consent_chain (site_id, consent_id, key_hash, bound_at)
SELECT site_id, consent_id, key_hash, MIN(server_received_at)
  FROM consent_log
 WHERE key_hash IS NOT NULL AND verified = 1
 GROUP BY site_id, consent_id;
