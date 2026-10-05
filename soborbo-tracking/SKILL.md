---
name: soborbo-tracking
description: >-
  Conversion tracking and cookie consent for Soborbo's Astro + Cloudflare
  Workers lead-gen sites (UK and HU). Use when installing, auditing or fixing
  GA4, Google Ads (Enhanced Conversions, offline uploads), Meta Pixel / CAPI,
  GTM dataLayer events, the own consent banner (sbo) or CookieYes, Consent
  Mode v2 or Microsoft Clarity on a site; when wiring a form, phone or
  callback click as a conversion; or when conversion numbers look wrong.
  Code and runbook live in Soborbo/Serverside soborbo-tracking/. Not for
  changing the event-gateway worker itself (src/), ad-account or campaign
  work, or non-Astro sites.
---

# Soborbo tracking

A kód és a teljes runbook egy helyen van: a `Soborbo/Serverside` repó
`soborbo-tracking/` mappája (kliens: `lib/` + `components/`, site-backend:
`server/backend/`, GTM: `gtm/`), a gateway-worker pedig ugyanebben a repóban
(`src/`). Ez a skill nem másolja a kódot: megmondja, mi a szabály, miért, és
hol a forrás. Az útvonalak a `soborbo-tracking/` mappához képest értendők, a
`../` a Serverside gyökér.

**Első lépés mindig:** `git -C <Serverside> fetch origin`, és az
`origin/main`-ről olvass. Egy lemaradt lokális checkoutból tett állítás
érvénytelen (egyszer már hamis „nincs ilyen job” megállapítást szült).

## Mikor melyik fájl

| Feladat | Nyisd meg |
|---|---|
| Új site bekötése | `INSTALL.md` (egyetlen, számozott út, ellenőrző parancsokkal) |
| Consent, CMP, Consent Mode, Clarity | `references/consent.md` |
| Meta-dedup, fbc, Google Data Manager, click ID-k, Safari | `references/platform-contracts.md` |
| Eseménynevek, GA4-nevek, ismert névütközések | `references/events.md` |
| Telepítés utáni ellenőrzés, hibakeresés („miért 0 a konverzió?”) | `references/verification.md` |
| Verziófüggő, avuló tények (API, dátum, limit) | `references/perishable-facts.md` |
| Teljes doktrína, incidensekkel | `docs/INVARIANTS.md` |

## Architektúra (Model 2)

```
Böngésző (Astro komponensek)               Szerver
FORM: TrackedForm ── dataLayer ─→ GTM ─→ GA4 / Meta Pixel / Google Ads (AWCT+EC)
          └─ rejtett event_id (+ gclid|gbraid|wbraid) ─→ form POST
                                   SITE BACKEND (API route)
                                     ├─→ CRM (válasz id = lead_id)
                                     └─→ gateway /api/event/conversion-server
                                         per-site token, service binding,
                                         UGYANAZ az event_id → Meta CAPI
KLIKK (telefon/email/WhatsApp/videó):
  dataLayer ─→ GTM   +   böngészőút /api/event/conversion ─→ Meta CAPI
CRM státusz ─→ /api/event/lead-status ─→ Google Ads offline (Data Manager API)
```

Három szabály tartja az egészet:

1. **Pénzes esemény csak szerverúton.** `quote_calculator_submitted`,
   `callback_request_submitted`, `contact_form_submitted`,
   `order_request_submitted`, `purchase` a böngészőúton 403-at kap
   (TRK-400-017), a kliens-lib el sem küldi (TRK-1005). Ok: a böngésző
   Origin-fejléce curl-lel hamisítható, a pénzes eseményhez per-site token
   kell. A szerverlábat a site backendje küldi a böngésző `event_id`-jével.
2. **GA4 csak böngészőből.** A GA4 nem dedupol `event_id`-re, tehát ha a szerver
   is küldene, minden lead kétszer számolódna. A gateway semmilyen GA4-et nem
   küld (offline sem).
3. **Google Ads a szerveren csak offline**, a Data Manager API-n
   (`../src/lib/datamanager.ts`, OAuth `datamanager` scope). Az on-site Ads
   böngészős (AWCT + Enhanced Conversions). A Meta CAPI viszont on-site
   szerverről megy, a Pixel ↔ CAPI dedup a közös `event_id`-n és eseménynéven
   múlik.

## Szabályok, amiket magadtól nem tudnál

- **Consent: a saját CMP (sbo) a célállapot, Consent Mode basic az alap.**
  Új site sbo-val települ (`INSTALL.md`); a CookieYes csak a még át nem
  kapcsolt, meglévő site-okon fut, átmenetileg. Részletek, sorrend, háromállapotú
  logika: `references/consent.md`.
- **CookieYes kategória-kulcs: `advertisement`, sosem `marketing`.** A
  `marketing` kulcs `undefined`-ot ad, így minden marketing-kapuzott láb némán
  kiesik; ez élesben 0 konverziót okozott (beautyflow, lomtalan), fejlesztés
  közben pedig nem látszott.
- **Ismeretlen consent = nem küldünk (fail-closed), de nem is törlünk.** Csak a
  kifejezett elutasítás vagy visszavonás purge-öl.
- **PII sosem kerül a dataLayerbe.** Az Enhanced Conversions adatai a
  `window.sbTracking.getUserDataForEC()` oldalcsatornán mennek, rövid életűen;
  az `events.ts` push-szűrője a véletlen PII-t is eldobja (TRK-3001).
- **`value` csak valós értékkel, sosem 0**; a pénznem a site-configból jön
  (HU = HUF, UK = GBP), a backend-dispatchben nincs alapértelmezés.
- **`lead_id` csak a CRM válaszából**, soha site-on generált tartalék. Egy
  kitöltött, de párosíthatatlan id rosszabb, mint a NULL.
- **`test_event_code` sosem kerül KV-ba**, és nincs éles pixeles böngészőteszt.
  A szintetikus bizonyíték a napi smoke-cron (hitelesített szerverút,
  kérésenkénti tesztkód). A KV-ba tett tesztkód kétszer terelt valódi
  konverziókat a Meta Test-streambe.
- **Nincs Turnstile a tracking-úton, nincs Zaraz, nincs Stape, a Google Tag
  Gateway alapból KI.** A Turnstile-kapu egyszer két hétig nyelt el valódi
  klikk-konverziókat; a Tag Gateway zóna-szintű injektálása a consent-default
  elé tenné a GTM-et. A form botvédelme a site form-végpontjáé
  (`server/backend/README.md`).
- **WAF / rate limit csak a böngészőútra.** A szerverút egy egress IP-ről jön,
  ott a limit a saját leadjeidet dobná el.
- **Navigálás konverzió után csak unload-biztosan.** A gateway-POST
  `sendBeacon` / `fetch keepalive`. A GTM-pixelek kivárása a GTM
  `eventCallback` + `eventTimeout` mintával a helyes (INVARIANTS #19); a
  `TrackedForm` ma még fix `waitForTracking(600)`-at használ, ezt ne másold
  új kódba.
- **Clarity és minden analytics-eszköz consent-kapuzott.** Ha a consent-setup
  egy relaunch körül változott, a Clarity előtte/utána összevetése érvénytelen.
- **Állítást a repóforrásból ellenőrizz, ne a deployolt bundle-ből.** A kliens
  hívási helyei nincsenek a worker-bundle-ben.

## Piacok

`PUBLIC_TRACKING_COUNTRY` (GB | HU), `PUBLIC_TRACKING_CURRENCY`,
`PUBLIC_TRACKING_LOCALE` a kliensen; a gateway a KV `country_code` / `currency`
értékét használja. A kettőnek egyeznie kell. `require_consent: true` minden
consent-köteles piacon, **GB-n is** (PECR + UK GDPR); új site-nál a generátor
hibával áll meg nélküle.

## Két szerverláb-minta

- **Site backend → gateway** (a kanonikus): az API route a CRM-be ír, majd
  `sendGatewayConversion` a böngésző `event_id`-jével
  (`server/backend/gateway-dispatch.ts`).
- **CRM-outbox** (a leadgen starter README „The two legs” mintája, soborbo-crm-mel):
  a site nem beszél közvetlenül a gatewayjel, a CRM aláírt webhookja és outboxa küldi.
  A szabályok ugyanazok (közös `event_id`, `lead_id` a CRM-től, consent a
  sütiből).

Egy site-on csak az egyik fut; ha mindkettőt látod, az duplikált Meta-esemény.

## Használat (röviden)

```astro
<TrackedForm action="/api/lead" eventType="lead" contentName="Calculator">
  <input name="email" type="email" required />
  <button type="submit">Ajánlatot kérek</button>
</TrackedForm>
```

A form a dataLayer-push mellett rejtett mezőkben viszi az `event_id`-t, az
UTM-eket és a kattintás-azonosítót (gclid > gbraid > wbraid, egyszerre csak
egy; a gbraid/wbraid a PR #137-tel került be). Klikkekhez `<PhoneLink/>`,
`<CallbackButton/>`, `<RevealContact/>`; egyedi böngészőútra csak az
engedett nevek mennek `trackServerEvent('<név>')`-vel (`lib/event-contract.ts`).
Debug: `?debugTracking=1`, diagnosztika: `window.__sbTrackingDiag`.

## Gépi ellenőrzés a repóban

```bash
# Serverside gyökér
npm test && npm run typecheck && npm run check:docs && npm run check:engine-events
# soborbo-tracking/
npm test && npm run typecheck && npm run check:gtm-contract
```

A `check:docs` tiltott doksi-állításokat és kötelező horgonyokat ellenőriz
(`../scripts/check-doc-truth.mjs`); ha egy doksi-módosítás piros, a szabályban
leírt ok számít, ne a mintát kerüld ki.

## Frissítés

A Google Consent Mode, a Data Manager API, a Meta CAPI és a Clarity API
változik. Mielőtt verzió-, dátum- vagy limitfüggő dolgot állítasz, nézd meg a
`references/perishable-facts.md` dátumát; ha fél évnél régebbi, ellenőrizd a
hivatalos forrást (a fájlban linkelve) vagy a Context7-et
(`/websites/developers_google_tag-platform_security_guides`).
