# Consent compliance harness

A **jelenlegi** (CookieYes-es) állapot mérése a teljes flottán, gépi és
ismételhető módon. Ez a munka minden kimenetelben kell — akkor is, ha soha nem
épül saját CMP: enélkül nincs dátumozott baseline, amihez bármit hasonlítani
lehetne.

```bash
npm run compliance                          # teljes flotta, chromium
npm run compliance -- --site=lomtalan       # egyetlen site
npm run compliance -- --browser=both        # chromium + webkit
npm run compliance -- --scenarios=A,C       # csak a kritikus forgatókönyvek
npm run compliance:selftest                 # a mérőműszer öntesztje (élő oldal NÉLKÜL)
```

A riport ide kerül: `reports/<ISO-dátum>/{report.json,report.md,screenshots/}`.

## ⚠️ Ez NEM CI-ba való

Élő oldalakat tölt be. Minden PR-en végigfutva forgalomszennyezés lenne (és a
mérési adat is torzulna a saját látogatásainktól). Kézzel vagy ütemezetten
futtatandó — a `npm test` **nem** futtatja. Amit a `npm test` futtat: a tiszta
mag unit tesztjei (`compliance-lib.test.ts`), azok nem érnek hálózatot.

## Nulla űrlapbeküldés, nulla konverzió — négy védvonal

Egyetlen hamis lead is pénzbe kerül és szennyezi a ledgert, ezért a harness
**megfigyel, nem cselekszik**:

1. **Hálózati abort** — minden nem-GET/HEAD kérés a site SAJÁT originjére
   megszakad (`installSafetyNet`). Ez az űrlap-POST, a `sendBeacon` és a
   fetch-alapú lead útja. A megszakított kérések bizonyítékként bekerülnek a
   riportba (`blocked_first_party_writes`).
2. **DOM-blokk** — a `submit` esemény capture fázisban megáll, a
   `HTMLFormElement.prototype.submit()` no-op (`lib/instrument.mjs`).
3. **Kattintás-allowlist** — kizárólag a felderített consent-gombokra kattintunk
   (accept / reject / settings / revisit). Máshova soha.
4. **Nulla beírás** — a kód sehol nem hív `fill()` / `type()` / `press()`-t:
   `grep -rn "\.fill(\|\.type(\|\.press(" tests/compliance` üres.

Az önteszt ezt **bizonyítja is**: a fixture kétszer próbál beküldeni (egy
`form.submit()` és egy `fetch POST`), a fixture-szerver pedig számolja a
beérkezett nem-GET kéréseket. Ha ez a szám nem nulla, az önteszt bukik.

## Mit mér

| Forgatókönyv | Mit csinál |
|---|---|
| **A** döntés előtt | betölt, vár, semmihez nem nyúl |
| **B** elfogad mindent | egy kattintás az accept gombra |
| **C** elutasít mindent | egy kattintás a reject gombra — **ez a legfontosabb** |
| **D** visszavonás | elfogad → újratölt → revisit → elutasít |
| **E** analytics-only | **részleges** consent: analitika IGEN, marketing NEM (F7) |
| **GPC** | mint az A, `Sec-GPC: 1` fejléccel (csak megfigyelés) |

Mindegyik **friss `browser.newContext()`-ben**, nulla átvitt állapottal.

Ellenőrzések: kimenő kérések kategóriánként (GA4 / Ads / Meta / GTM / CMP /
gateway), sütik, localStorage+sessionStorage **írás ÉS olvasás** (a PECR alatt a
hozzáférés is engedélyköteles), `document.cookie` olvasás, `consent default` a
GTM-hez képest, GTM noscript iframe, banner-UI (reject gomb megléte, mért méret /
kontraszt / betűméret arány, kattintásszám), süti-tájékoztató harmadik felekkel,
és elutasítás utáni pingekben az azonosító-szivárgás.

### Az E (analytics-only) forgatókönyv — és miért magvetett sütivel megy

A B és a C két SZÉLSŐ eset. A legtöbb CMP-integráció ezekre van bekötve, és
pont ezért csúszik át rajtuk némán egy „minden vagy semmi" implementáció. A
valódi próba a RÉSZLEGES döntés.

A döntést a CMP saját süti-formátumában **ültetjük be** betöltés előtt
(`cookieyes-consent` vagy `sbo_consent` v2), nem a beállítás-panelt kattintjuk
végig: a kategória-kapcsolók CMP-nként és nyelvenként mások, és egy elrontott
kattintás-sorozat CSENDBEN „elfogad mindent"-et adna — amit a szcenárió
„nincs marketing"-ként könyvelne. A magvetés után **ellenőrizzük**, hogy a CMP
elfogadta-e a döntést (nem jön-e vissza a banner); ha nem, a szcenárió **N-A**
indoklással, nem hamis PASS.

### Vendor-leltár (F7)

Minden lefutott fázisból leltár készül arról, KIK futnak az oldalon. A
`lib/vendor-registry.mjs` kimondja, mit ismerünk; **amit nem, az
`unknown_vendor`**, és nevesített megállapítás lesz belőle — nem néma `other`.

Ez a korábbi állapot javítása: az `'other'` gyűjtőkategóriában egy sose látott
mérőszkript és egy webfont megkülönböztethetetlen volt, vagyis a mérés hiánya
jóváhagyásnak látszott.

**Report-only.** Az ismeretlen vendor önmagában nem jogsértés (lehet legitim, de
a regiszterből hiányzó CDN). A teendő a regiszter bővítése VAGY a szkript
eltávolítása — ember dönt. A terv sorrendje: report-only → alert → gate.

### Statikus forrás-scan (F7)

A futásidejű mérés azt látja, ami EGY betöltésen elindult. A statikus scan az
oldal HTML-jét és az **első fél-beli** szkripteket olvassa, és:

- **FAIL**: PII a `dataLayer.push`-ban (CLAUDE.md 15.) — a szerzőtől függetlenül
  jogsértés, az F12-es bámészkodó is látja;
- **INFO**: nyers consent-parse (INV-005) és közvetlen `fbq`/`gtag` hívás
  (INV-006) — bundle-ölt forrásból NEM eldönthető, hogy a site szerzője írta-e,
  vagy a tracking-csomagunk hozta be, ezért ember dönt;
- **INFO**: a forrásban DEKLARÁLT, de futásidőben soha nem induló tracker — ez
  feltételes betöltő, tehát a futásidejű PASS nem fedi le azt a lábat.

## Amit a mérés NEM tud

- **`NO_BANNER_OBSERVED` ≠ „nincs CMP"** — lehet geo-alapú megjelenítés. A riport
  fejléce ezért kiírja a teszt-IP országát.
- **`consent default`** jöhet a GTM konténeren BELÜLI CMP-sablonból is; ilyenkor a
  dataLayerben nem látjuk. A checker ezt kimondja, nem cáfolatnak állítja be.
- A süti-tájékoztató vizsgálata **kulcsszó-keresés**, nem jogi értékelés.
- `--relay` mellett a válaszokat a futtató Node HTTP-stackje adja (lásd lentebb):
  a HTTP/2–3 és TLS-szintű viselkedés így nem mérhető pontosan.

## `--relay` (csak korlátozott hálózaton)

Alapból KI. Olyan környezethez való, ahol a böngésző nem jut ki a hálózatra
(pl. egy egress-proxy bontja a böngésző alagutazott TLS-ét), a futtató Node
viszont igen. Ilyenkor minden kérést a Node stackje szolgál ki, de a **mérés
sértetlen**: a kérések ugyanúgy megjelennek a felvételben, csak a válasz jön
máshonnan. A riport fejlécében jelezve van, ha ez a mód volt bekapcsolva.

## Fájlok

| Fájl | Szerep |
|---|---|
| `sites.json` | a mérendő flotta (`src/site-manifest.json` + `wrangler.toml` route-ok alapján) |
| `run.mjs` | a futtató: forgatókönyvek, safety-net, riport-írás |
| `lib/instrument.mjs` | az oldalba injektált műszer (storage/cookie/dataLayer + submit-blokk) |
| `lib/classify.mjs` | request-osztályozás + ping-azonosító vizsgálat |
| `lib/vendor-registry.mjs` | **a** vendor-igazság: minta → név, kategória, consent-osztály (F7) |
| `lib/inventory.mjs` | vendor-leltár fázisonként + analytics-only értékelés (F7) |
| `lib/static-scan.mjs` | forrás-scan: tiltott minták + deklarált trackerek (F7) |
| `lib/banner.mjs` | banner-felderítés, WCAG-kontraszt, gomb-egyenrangúság |
| `lib/checks.mjs` | megfigyelés → PASS/FAIL/N-A + bizonyíték |
| `lib/report.mjs` | `report.json` + `report.md` |
| `selftest/` | helyi, szándékosan szabálysértő fixture — a műszer kalibrálása |
| `compliance-lib.test.ts` | a tiszta mag unit tesztjei (a `npm test` futtatja) |
| `inventory-lib.test.ts` | a leltár + statikus scan unit tesztjei (a `npm test` futtatja) |

## Böngészők

`npx playwright install chromium webkit` (egyszer). Ha a futtató környezet hoz
böngészőt: `PW_CHROMIUM_EXECUTABLE=/path/to/chrome`, `PW_WEBKIT_EXECUTABLE=…`.

**A WebKit nem elhagyható**: a Safari ITP a first-party storage-ot eltérően
kezeli, tehát egy csak-Chromium mérés nem mond semmit a flotta Safari-forgalmáról.

## Ismert hiba — a mérés nem determinisztikus (JAVÍTANDÓ)

Ugyanaz a flotta, ugyanaz a böngésző, három egymás utáni futás: **55 / 51 / 53
FAIL**. Az ingadozás nem egyenletes — a `nemesventilatorhaz` és a
`szelloztetes` oldalakon koncentrálódik (`nemesventilatorhaz` 8 / 5 / 6).

Az oszlop-összesítés stabil, tehát a riport fő táblázata használható; **egyetlen
site FAIL-számára viszont nem szabad következtetést építeni.**

A gyanú: időzítési verseny a megfigyelési ablakban — a döntés előtti szakasz
fix várakozással zárul, és a lassabban induló tagek hol beleesnek, hol nem.

**Ez a következő kör legfontosabb javítása.** Egy determinisztikusnak szánt
megfigyelő eszköz nem ingadozhat 8%-ot: egy műszer, ami zajt ad, egy ponton
hazudni fog — és a harness ismert torzítása alapján optimista irányba fog.

## A műszer torzítása: OPTIMISTA

Eddig **két** különböző mechanizmus adott hamis PASS-t, és **mindkettőt ember
fogta meg a nyers bizonyíték átolvasásával, nem az ellenőrzés**:

1. **Első félen proxyzott Google-mérés** (Google Tag Gateway): a hit a site saját
   domainjén, egyedi útvonalon ment, tehát sem a domain-, sem az útvonal-minta
   nem fogta meg → `other`. Javítva a `tid=G-|GT-|AW-` szabállyal.
2. **Safari ITP által eldobott süti**: a site megpróbálta letenni, a böngésző
   eldobta, a süti-tárban nem volt semmi → PASS. Nem javítható a harness-ben —
   ezért jelöli meg a `report.md` a WebKit-only futásnál az érintett oszlopokat.

Ebből következik a riport állandó fejléc-sora: **a ✅ gyengébb állítás, mint a
❌.** Új ellenőrzés írásakor mindig azt kérdezd meg először, hogy mitől adhat
hamis PASS-t — a hamis FAIL magától kiderül, a hamis PASS nem.
