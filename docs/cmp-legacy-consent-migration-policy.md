<!-- TRUTH-ANCHOR: cmp-legacy-migration-policy -->
# P3.1 — `legacyConsentMigrationPolicy`: a döntés és az indoklása

**Döntés: `reconsent_all`.** A saját CMP-re álláskor minden látogató **újra kap bannert**;
a korábbi CookieYes-döntést **semmilyen formában nem vesszük át**.

**Hol él a döntés kódban:** `soborbo-tracking/lib/consent-migration.ts`
(`LEGACY_CONSENT_MIGRATION_POLICY`). **Amit őriz:** `soborbo-tracking/tests/consent-migration.test.ts`.

---

## Miért nem migrálunk

A szabály egyszerű: *ha az ekvivalencia nem bizonyítható, re-consent.* Négy független
ok miatt nem bizonyítható.

### 1. A kategória-taxonómia nem egyezik

| CookieYes | saját CMP |
|---|---|
| necessary | necessary |
| functional | — |
| analytics | analytics |
| performance | — |
| advertisement | marketing |

Egy látogató, aki a CookieYes-ben `analytics: yes` + `performance: no` kombinációt adott,
**nem képezhető le egyértelműen**: a mi `analytics` kategóriánk mindkettőt lefedi. Az
`functional`/`performance` döntéseinek nincs hová menniük. Bármelyik irányba döntenénk,
azt tulajdonítanánk az illetőnek, amit nem mondott.

### 2. Hiányzik a bizonyíték-láb

A `consent_log` a GDPR Art. 7(1) („a hozzájárulás igazolhatósága") miatt **négy**
verziómezőt követel: `policy_version`, `banner_version`, `consent_text_version`,
`client_lib_version`. Egy CookieYes-döntéshez ezekből **egy sincs meg**.

Egy migrált sor tehát nem tudná megmondani, **mit olvasott** az illető, amikor igent
mondott — vagyis pont az a bizonyíték hiányozna, amiért a napló egyáltalán létezik. Egy
üres bizonyíték rosszabb, mint a hiányzó: úgy néz ki, mintha lenne.

### 3. Amit a CookieYes sütijéből látunk, az két boolean

A `readCkyParallelWindow()` az `analytics` és az `advertisement` kulcsot olvassa ki.
**Nincs benne időbélyeg, nincs consent-azonosító, nincs szövegverzió.** A „mikor és mire
mondott igent" kérdésre a süti nem válaszol — így a 180 napos élettartam-szabályt sem
tudnánk alkalmazni rá.

### 4. Az ekvivalencia nem is auditálható

A 2026-08-25-i ellenőrzéskor a csatlakoztatott CookieYes-fiókban a flotta **nyolc
domainjéből egy** szerepelt (`trapezlemezes.hu`). A többi site banner-szövegét és
kategória-leírásait API-ból nem tudjuk kiolvasni, tehát a „ugyanazt a célt írta le"
állítás **nem ellenőrizhető** — legfeljebb feltételezhető.

---

## Mi az ára, és miért vállaljuk

A flip napján a visszatérő látogatók ismét bannert kapnak, és amíg nem döntenek,
`unknown` állapotban vannak → a marketing-jelek `denied`-ek.

**Ez mérhető visszaesést okoz** az attribúcióban és a böngésző-oldali konverziókban.
Ezért a rollout-ablak része:

1. **Baseline-snapshot a flip ELŐTT** — 7 napos konverzió- és consent-arány.
2. A visszaesés **várt**, nem incidens — a hirdető-tájékoztatás a rollout része.
3. A szerver-láb (CAPI, offline Google) **nem** esik ki: az a backend üzleti tényére épül,
   nem a böngésző-consentre — de a `require_consent` miatt a marketing-kézbesítés
   ott is a döntéstől függ.

Az alternatíva az lenne, hogy egy **nem bizonyítható jogalapra** építve küldünk tovább
hirdetési adatot. Ez pontosan az a fajta néma kockázat, amit a rendszer mindenhol máshol
is elutasít — csak itt a következménye nem elvesztett konverzió, hanem hatósági kitettség.

---

## Implicit süti-másolás: TILOS

A `readCkyParallelWindow()` kimenete **kizárólag** a wire-payload
`cky_cookie_analytics` / `cky_cookie_marketing` **telemetria**-mezőibe kerül (a párhuzamos
mérési ablak diagnosztikája). Soha nem lesz belőle `sbo_consent` süti.

Ezt három szinten kényszerítjük ki (`tests/consent-migration.test.ts`):

- **viselkedés** — egy elfogadott CookieYes-süti mellett `readSboConsent()` `null`, és
  mindkét kapu zárva marad;
- **statikus őr** — az `sbo_consent` sütit egyetlen függvény írja, és a CookieYes olvasata
  sehol nem folyik bele az sbo-állapotba;
- **kód-jelenlét** — `cookieyes_migrated` / `migrateLegacyConsent` / `seedFromCookieYes`
  mintájú kód **nem létezhet** a libben.

---

## Ha valaha mégis migrálnánk

A politika `migrate_if_equivalent`-re állítása **nem egysoros szerkesztés**. Ami hozzá kell:

1. **Kategória-leképezés bizonyítása** site-onként (a tényleges CookieYes-konfigból, nem
   feltételezésből), beleértve a `functional`/`performance` kezelését.
2. **Szövegverzió-egyezés**: bizonyítani, hogy a CookieYes-szöveg ugyanazokat a célokat és
   ugyanazokat az adatkezelőket nevezte meg, mint a `consent-texts/<verzió>/`.
3. **Időbélyeg-forrás**: honnan tudjuk, mikor született a döntés (a 180 napos szabályhoz).
4. **Forrás-jelölés**: a migrált sor `source = cookieyes_migrated` értékkel, hogy utólag
   megkülönböztethető legyen egy valódi, saját CMP-s hozzájárulástól.

Ezek nélkül a migráció nem „kényelmesebb", hanem **nem bizonyítható** — és a különbség
csak egy hatósági megkeresésnél derülne ki.

---

## Kapcsolódó

- Flip-előfeltétel-őr: `node scripts/check-cmp-flip-readiness.mjs <hostname> [--config <fájl>]`
- Pilot-runbook: `docs/cmp-fazis2-pilot-runbook.md`
- Süti-formátum és a re-consent trigger: `soborbo-tracking/lib/consent-sbo-state.ts`
  (a `policy_version` a v2-es sütiben — szövegváltozás = új kérdés)
