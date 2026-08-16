# PECR storage-access E2E (Playwright)

Amit ez a suite bizonyít, és a vitest nem tud:

1. **Hogy nem TÖRTÉNIK hozzáférés.** A unit teszt a getter visszatérési értékét
   nézi; itt a `Storage.prototype.getItem/setItem/removeItem` és a
   `document.cookie` leírója van patchelve (`fixture/index.html`, minden más
   szkript ELŐTT), tehát magát a MŰVELETET látjuk. A PECR alatt az olvasás a
   szabályozott cselekmény, nem az eredménye — egy „nincs localStorage kulcs"
   assert ezt nem fedi.
2. **A PRODUCTION consent-kaput.** A package `isDevMode()`-ja `getCkyConsent()`
   hiányában dev-ben ENGED, prodban deny-all. A vitest dev-módban fut, ezért a
   „CookieYes sosem tölt be" ág — a betöltési verseny szélső esete — csak itt
   mérhető. A fixture ezért `vite build` production bundle
   (`vite.e2e.config.ts`).
3. **bfcache / vissza-navigáció**: a kapu a visszaállított oldalon is érvényes.

## Futtatás

```bash
npm run test:e2e                 # chromium + webkit
npx playwright test --project=chromium
```

Böngészők: `npx playwright install chromium webkit` (egyszer).

Ha a futtató környezet HOZ böngészőt (sandbox, előre telepített binárisokkal),
add meg letöltés helyett:

```bash
PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npx playwright test --project=chromium
PW_WEBKIT_EXECUTABLE=/path/to/pw_run.sh          npx playwright test --project=webkit
```

**WebKit KÖTELEZŐ a teljes zöldhöz**: a Safari ITP a first-party storage-ot
eltérően kezeli (JS-ből írt cookie-k 7 napos élettartama, eltérő
localStorage-ürítés), tehát egy csak-Chromium futás nem bizonyít semmit a
flotta Safari-forgalmára.

## Felépítés

| Fájl | Szerep |
|---|---|
| `fixture/index.html` | a storage-access műszer (monkey-patch) + a bundle betöltése |
| `fixture/main.ts` | a VALÓDI libet köti a `window.__t` teszt-API-ra |
| `serve.mjs` | függőség nélküli statikus szerver; a `/api/event/conversion` POST-okat 204-gyel elnyeli és megjegyzi (`/__posts`) |
| `storage-access.spec.ts` | a mátrix: döntés nélkül / marketing ON / visszavonás / analytics visszavonás / bfcache |

A fixture semmilyen harmadik felet nem tölt (nincs GTM, Pixel, gtag), ezért a
tesztek bármely kimenő külső kérést hibának vesznek.
