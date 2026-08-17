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
| **GPC** | mint az A, `Sec-GPC: 1` fejléccel (csak megfigyelés) |

Mindegyik **friss `browser.newContext()`-ben**, nulla átvitt állapottal.

Ellenőrzések: kimenő kérések kategóriánként (GA4 / Ads / Meta / GTM / CMP /
gateway), sütik, localStorage+sessionStorage **írás ÉS olvasás** (a PECR alatt a
hozzáférés is engedélyköteles), `document.cookie` olvasás, `consent default` a
GTM-hez képest, GTM noscript iframe, banner-UI (reject gomb megléte, mért méret /
kontraszt / betűméret arány, kattintásszám), süti-tájékoztató harmadik felekkel,
és elutasítás utáni pingekben az azonosító-szivárgás.

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
| `lib/banner.mjs` | banner-felderítés, WCAG-kontraszt, gomb-egyenrangúság |
| `lib/checks.mjs` | megfigyelés → PASS/FAIL/N-A + bizonyíték |
| `lib/report.mjs` | `report.json` + `report.md` |
| `selftest/` | helyi, szándékosan szabálysértő fixture — a műszer kalibrálása |
| `compliance-lib.test.ts` | a tiszta mag unit tesztjei (a `npm test` futtatja) |

## Böngészők

`npx playwright install chromium webkit` (egyszer). Ha a futtató környezet hoz
böngészőt: `PW_CHROMIUM_EXECUTABLE=/path/to/chrome`, `PW_WEBKIT_EXECUTABLE=…`.

**A WebKit nem elhagyható**: a Safari ITP a first-party storage-ot eltérően
kezeli, tehát egy csak-Chromium mérés nem mond semmit a flotta Safari-forgalmáról.
