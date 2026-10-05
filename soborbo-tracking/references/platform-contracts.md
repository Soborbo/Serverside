# Platform-szerződések: Meta, Google, click ID-k, Safari

A hash- és normalizálási szabályok kanonikus helye a Serverside `CLAUDE.md` §1–§9
és a gateway kódja. Itt csak az van, ami site-oldali bekötésnél dönt.
Verziófüggő tények: `perishable-facts.md`.

## Meta (Pixel + CAPI)

- **Dedup két kulcson:** a Pixel `eventID` = a CAPI `event_id` **és** a Pixel
  eseményneve = a CAPI `event_name`, ugyanarra a pixelre. Ha a GTM Meta-tagje
  `Contact`-ot küld, a gateway pedig `Lead`-et ugyanarra az `event_id`-re, a Meta
  két külön eseménynek látja. A Meta-név forrása az `../src/events.json` `meta` mezője;
  a GTM-konténer (`gtm/gen-container.mjs`) és a gateway ebből dolgozik.
- **Egy konverzió = egy `event_id`.** A form a rejtett mezőben viszi a backendnek;
  klikknél a kliens ugyanazt az id-t adja a dataLayernek és a böngészőútnak.
- **fbc:** a `_fbc` sütiből, ennek hiányában `fb.1.<első rögzítés ms>.<fbclid>`
  (`persistence.ts`); az fbclid kis/nagybetűjét tilos módosítani, és nem hasheljük.
  A gateway is képez fbc-t, ha csak fbclid érkezik. `fbp`, `fbc`, `event_id`,
  IP, user agent sosem hashelt.
- `value` csak valós értékkel, `currency`-vel együtt; `0` helyett elhagyjuk.
- Lead-gen leképezés: quote és callback → `Lead`, contact form és klikkek →
  `Contact`, kalkulátor megnyitása → `ViewContent`.

## Google Ads

- **On-site:** böngészőből, GTM-ben AWCT + Enhanced Conversions; az EC-adat a
  `window.sbTracking.getUserDataForEC()` getterből jön (rövid életű, marketing
  consenthez kötött), nem a dataLayerből. A régi `window.__sbUserData` CJS-változó
  elavult.
- **Offline:** a CRM státusz-webhookja (`/api/event/lead-status`) után a gateway a
  **Data Manager API**-n tölt fel (`../src/lib/datamanager.ts`, `events:ingest`,
  OAuth `datamanager` scope). A régi Google Ads API `uploadClickConversions` út
  törölve; új fejlesztőtokennel már nem is működne.
- Száraz futtatás: `DATAMANAGER_VALIDATE_ONLY=1` a gatewayen.
- A Google e-mail-hash eltér a Metáétól (gmail.com / googlemail.com címen a pontok és
  a `+…` utótag törlődik). A két normalizálót ne vond össze.
- `gads.conversion_actions` kulcsai az offline CRM-események kanonikus nevei
  (`lead_qualified`, `booking_confirmed`, `revenue_confirmed` …); a generátor a régi
  aliasokat elutasítja.

## Kattintás-azonosítók

- `gclid` > `gbraid` > `wbraid`: egy kattintás egy azonosítót ad, egyszerre csak egy
  megy tovább (`lib/google-click-id.ts`). iPhone-os hirdetéskattintásnál gyakran
  `gbraid`/`wbraid` jön `gclid` helyett.
- A rejtett form-mezők a PR #137 óta a `gbraid`/`wbraid`-et is viszik. Ha a site
  backendje saját kóddal olvassa a mezőket, ott is add tovább mindhármat az
  `attribution`-ben és a CRM felé, különben az iOS-kattintás offline feltöltése nem
  párosul.
- Tárolás 90 nap, csak marketing consenttel (olvasni is csak akkor szabad).
- `ttclid`, `li_fat_id`, `msclkid`: a gateway továbbítja a TikTok / LinkedIn /
  Microsoft API-nak, ha a site-configban van hozzá blokk; ugyanaz az `event_id`-dedup.

## Safari: a localStorage nem tartós attribúció

- A WebKit ITP minden szkriptből írható tárolót (localStorage, sessionStorage,
  IndexedDB, JS-ből írt süti) töröl, ha a látogató 7 napig nem lépett interakcióba a
  site-tal. Hirdetésből érkező (link-dekorált) látogatásnál a JS-ből írt sütik
  élettartama 24 órára rövidül.
- A Link Tracking Protection privát módban, Mailben és Messagesben a gclid/fbclid
  paramétert már az URL-ből eltávolítja.
- Következmény: a 90 napos localStorage-attribúció Safarin csak „legfeljebb” 90 nap.
  A tartós forrás a szerverláb: a lead pillanatában a backendhez eljuttatott click ID
  és az e-mail/telefon-hash (EC for Leads, Meta `em`/`ph`). Ez nem ITP-megkerülés,
  hanem a Model 2 lényege.

## Site-config (gateway KV)

Mindig a generátorral: `node scripts/generate-site.mjs` (Serverside gyökér). Kézzel
írt JSON nem megy KV-ba. A séma: `server/site-config.schema.json`. Titok (CAPI-token,
per-site token) csak KV-ba / worker secretbe, gitbe soha.
