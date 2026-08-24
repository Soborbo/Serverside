-- PECR read-gating telemetria (2. brief, S2).
--
-- MIÉRT: a kliens mostantól a storage OLVASÁSÁT is consent mögé zárja (a UK PECR
-- alatt a terminál-eszközön tárolt adathoz való HOZZÁFÉRÉS is engedélyköteles,
-- nem csak az írás). Ennek van egy valós kockázata: ha a `getCkyConsent()` még
-- nem töltött be, a kliens consent-kapuja prod-ban deny-all-t ad — vagyis egy
-- BELEEGYEZŐ látogatónál is blokkolhatja a gclid/fbclid olvasását. Az eredmény
-- attribúcióvesztés lenne, ráadásul CSENDES.
--
-- Ezért minden blokkolt olvasás jelez a payloadban, és ide kerül. Ha ez a mező
-- gyakran `1` GRANTED consent mellett, akkor a Fázis D betöltési-verseny
-- hipotézise egy MÁSODIK, független méréssel is bizonyított — és a read-gate
-- sürgősebb figyelmet igényel, mint hittük.
--
-- Additív és visszafelé kompatibilis: mindkét oszlop NULLABLE, default nélkül.
-- NULL = a kliens nem jelentett (régi lib vagy szerver-ingress, ahol nincs
-- böngésző-storage) — ez NEM azonos a `0`-val ("jelentett, és nem volt blokk").
-- DEPLOY-SORREND: előbb ez a migráció, UTÁNA a Worker.

-- 0/1: volt-e legalább egy blokkolt storage-olvasás ezen az oldalletöltésen.
ALTER TABLE consent_receipts ADD COLUMN storage_read_blocked INTEGER;

-- Vesszős kulcs-lista (pl. "sb_tracking,_fbp"). A kulcsnevek a MEGLÉVŐ storage-
-- kulcsok — nincs új kulcsnév. PII-t nem tartalmazhat: kulcsNEVEK, nem értékek.
ALTER TABLE consent_receipts ADD COLUMN storage_read_blocked_keys TEXT;
