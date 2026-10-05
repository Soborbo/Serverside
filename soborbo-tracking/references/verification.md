# Ellenőrzés és hibakeresés

Minden ellenőrzés megfigyelhető jelre épül, nem érzésre. Teljes listák:
`docs/CHECKLIST.md` (PR előtt / deploy után), `docs/OBSERVABILITY-CODES.md`
(TRK-kódok), `docs/MONITORING.md`, a gateway-hibakódok: `../docs/error-codes.md`.

## Három eset, külön-külön

Egy sikeres dataLayer-push semmit nem bizonyít a kézbesítésről. Minden
consent-érintő változtatás után nézd meg külön:

1. **Denied (elutasít):** basic módban nincs `gtm.js`-kérés és nincs Google-,
   Meta- vagy Clarity-kérés; localStorage-ban nincs click ID; a backend-dispatch
   receiptje denied jeleket hordoz, a gateway nem küld Metának.
2. **Granted (elfogad):** GTM betölt, a GA4 / Ads / Meta tag tüzel, a gclid
   (vagy gbraid/wbraid) megérkezik a konverzióval a backendhez; a Meta Events
   Managerben ugyanaz az `event_id` „Browser and Server” forrással.
3. **Késleltetett backend-visszaigazolás:** lassú vagy hibázó form-backend mellett
   a Meta nem számol Leadet a szerverláb nélkül (P5 commit-after-success,
   `lib/conversion-commit.ts`), és a felhasználó sem ragad be. Visszatérő, már
   elfogadott látogatóval is nézd meg: a consent default az első consent-parancs.

Az sbo-site-okon a teljes mátrix Playwrighttal fut
(`npm run compliance -- --site=<site> --browser=webkit`, és chromium is); a
csak-Chromium zöld nem bizonyíték, mert az ITP-hatások WebKitben jönnek elő.

## Telepítés után 24 órán belül

- `soborbo-tracking/server/smoke-test.sh https://<host>`: health 200, a böngészőút
  403 Origin nélkül és pénzes eseményre, a szerverút 401 token nélkül.
- Az első smoke-cron (04:4x UTC) után a D1-ledgerben:
  `SELECT platform,status,http_status FROM deliveries WHERE event_id LIKE 'smoke-<site>-%'`
  → `meta | accepted | 200` (Meta nélküli site-on `skipped`).
  **`accepted` NULL `http_status`-szal hiba (TRK-950-004), nem siker.**
- A napi digest (08:00 UTC) a site-ot a smoke-leadek között mutatja, riasztás nélkül.
- Valódi (organikus) leadnél a Meta Events Managerben Pixel + CAPI egy `event_id`-vel.
  **Élő böngészőből ne lőj tesztkonverziót**, csak passzívan figyelj.
- Google Ads: a konverziós műveletek „Recording conversions” állapotban (az első
  offline feltöltés után; az EC-diagnosztika 24–48 óráig „waiting for data”).
- Workers Logs 24 órán át tiszta (nincs TRK-4xx/9xx).
- Egy valódi oldalnézeten `window.__sbTrackingDiag`-ban nincs TRK-1005 (pénzes
  esemény böngészőből) és TRK-1006 (a gateway elutasította a böngészőutat).
- Staging/preview build ne küldjön a production GA4-be és pixelbe.

## „Miért 0 / miért kevés a konverzió?” — sorrend

1. **Consent-kulcs:** CookieYes-site-on `advertisement`-et olvas-e a vendorolt
   `consent.ts`? (`npm run check:vendored -- <site>/src/lib/tracking` a Serverside
   gyökérből; CLEAN = a kanonikus kiadás fut.) A `marketing` kulcs némán nulláz.
2. **Szerverláb létezik-e:** van-e a form API route-jában `sendGatewayConversion` a
   rejtett `event_id`-vel. A form-konverziónak e nélkül nincs szerverlába. Az audit
   a site **repóján** fusson, ne a deployolt bundle-ön.
3. **Ledger:** a `deliveries` tábla `status` / `http_status` / `skip_reason`
   mezői megmondják, kihagyás (consent, hiányzó config) vagy vendor-elutasítás
   történt.
4. **Offline Google:** van-e OAuth `datamanager` scope-pal a `customer_id`-ra
   (`GET /api/event/oauth-init`), és a `gads.conversion_actions` kulcsai kanonikusak-e.
   Lejárt vagy hiányzó tokennél: `../docs/gads-oauth-repair-runbook.md`.
5. **Sorrend:** a consent default fut-e a GTM és a CMP előtt (GTM Preview).
6. **Rejtett mezők:** jön-e `gbraid`/`wbraid` iOS-kattintásnál a backend felé.
7. **Összevetés:** a CRM/Sheets lead-darabszám vs. D1-ledger vs. GA4 Key Event, az
   első 7 napban naponta. 20% feletti eltérés: valami eldob eseményt, első gyanús a
   legutóbbi tracking-érintő deploy.

## Repó-ellenőrzések

```bash
# Serverside gyökér
npm test && npm run typecheck && npm run check:docs && npm run check:engine-events
npm run check:dist-manifest && npm run check:package-version
# soborbo-tracking/
npm test && npm run typecheck && npm run check:gtm-contract
```
