> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: a `soborbo-tracking` package (Soborbo/claudeskills, `soborbo-tracking/` —
> `lib/` + `components/`, v5.x), + README.md / CLAUDE.md / docs/HANDOVER-run6.md.
>
> Ez egy Sprint-9 kori kliens-oldali (frontend) tracking-spec, ami a TÖRÖLT `client-lib/`
> köré épült, és részben már megdőlt premisszákat tartalmaz (pl. Turnstile-token — a
> gateway-ből KIKERÜLT). A kanonikus Astro kliens-lib mostantól a fenti package. NE
> implementálj ez alapján.
> ---

# Painless Removals — weboldali tracking-integráció (onboarding az oldal-agentnek)

Ez a dokumentum önállóan elég ahhoz, hogy a `painlessremovals.com` Astro-oldalt
kezelő agent **betonbiztosan** bekösse a szerver-oldali konverziókövetést a Soborbo
event-gateway workerhez. Kövesd pontosan; ne improvizálj a szerződésen (event-nevek,
`event_id`, PII-szabály).

---

## 0. Mit csinál ez a rendszer (Model 2 — KÖTELEZŐ megérteni)

A konverziók kétfelé mennek, és **élesen szét van osztva, ki mit küld**:

| Jel | KI küldi | Hogyan |
|---|---|---|
| **GA4** (on-site) | **BÖNGÉSZŐ** | a meglévő GTM/gtag (Google tag) — **marad, ne nyúlj hozzá** |
| **Google Ads** (on-site konverzió) | **BÖNGÉSZŐ** | a meglévő GTM/gtag (AWCT + Enhanced Conversions) — **marad** |
| **Meta CAPI** (szerver-oldali) | **SZERVER** (a worker) | a `trackConversion(...)` hívás POST-ol a workernek |
| **Meta Pixel** (böngésző) | **BÖNGÉSZŐ** | a meglévő GTM Pixel — **marad**, a `trackConversion` `dataLayer.push`-a táplálja |

**A te feladatod: bekötni a `trackConversion(...)` hívást** a konverziós pontokon.
Ez egyszerre (1) `dataLayer.push`-ol a böngésző Meta Pixelnek **és** (2) POST-ol a
szervernek a Meta CAPI-hoz — **ugyanazzal az `event_id`-vel**, ami a Meta dedup
kulcsa. **NE** állíts be új GA4/Google Ads szerver-küldést — azt a böngésző (GTM)
csinálja, a szerver Model 2-ben szándékosan NEM küld on-site GA4/Ads-et.

> ⚠️ A leggyakoribb hiba: a GA4/Google Ads konverziót „még egyszer" elküldeni a
> szerverről. **Ne.** A szerver csak Meta CAPI-t küld on-site. A duplikálás torzítja
> az adatot.

---

## 1. Előfeltételek (ezek már készen vannak a worker oldalán)

- A `painlessremovals.com/api/event/*` route **él** a workerhez (same-origin POST).
  → tehát a kliens a saját domainjére POST-ol (`/api/event/conversion`), nincs CORS.
- A worker SITE_CONFIG-ja Painlessre kész (Meta pixel + token, GA4, Google Ads).
- A Painless Meta pixel ID: **292656820246446** (a böngésző Pixelhez, ha kell).

Amit NEKED kell biztosítani az oldalon:
- **Cloudflare Turnstile** widget + a hozzá tartozó **site key**.
- Az Astro env-ben: `PUBLIC_TURNSTILE_SITE_KEY=<a Painless Turnstile widget SITE key-e>`.
  (A site key + a worker `TURNSTILE_SECRET_KEY`-je **ugyanahhoz a Turnstile
  widgethez** kell tartozzon — egy összetartozó pár.)

---

## 2. Lépés — másold be a kliens-libet

A Soborbo `Serverside` repó `client-lib/` mappájából másold az Astro projekt
`src/lib/`-jébe **változtatás nélkül**:

- `client-lib/worker-tracking.ts`  → `src/lib/worker-tracking.ts`
- `client-lib/uuid.ts`             → `src/lib/uuid.ts`

Ez a lib mindent elintéz: Turnstile-token, consent (CookieYes-ból), attribúció
(UTM + click ID-k URL-ből/cookie-ból), `fbp`/`fbc`/GA `client_id` kiolvasás,
`sendBeacon` + `fetch` fallback. Neked csak a `trackConversion(...)` hívásokat kell
elhelyezned.

---

## 3. Lépés — Turnstile invisible widget

A `trackConversion` szerver-oldali fele Turnstile-tokent kér. Tegyél az oldalra:

1. A Turnstile scriptet (a `<head>`-be vagy a layoutba):
   ```html
   <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
   ```
2. Egy **láthatatlan** widget-konténert (pontosan EZ az id kell):
   ```html
   <div id="cf-turnstile-invisible"></div>
   ```
   A lib `size: 'invisible'` módban maga rendereli/futtatja ezt a `PUBLIC_TURNSTILE_SITE_KEY`-jel.

> Megjegyzés: a `tel:` / `mailto:` / WhatsApp kattintások a workerben **degraded
> módban token nélkül is** átmennek (hogy a telefon-lead ne vesszen el), de a
> form-submit típusú konverziókhoz a Turnstile token kell. Tedd fel a widgetet.

---

## 4. Lépés — hívd a `trackConversion`-t a konverziós pontokon

API:
```ts
import { trackConversion } from '../lib/worker-tracking';

await trackConversion(eventName, {
  value?: number,          // ha van pénzérték (pl. kalkulátor becslés)
  currency?: 'GBP',
  user_data?: {            // PII — a body-ban megy, a worker hash-eli, SOHA nem a dataLayer-be
    email?, phone_number?, first_name?, last_name?, city?, postal_code?, country?, external_id?
  }
});
```

### Engedélyezett event-nevek (KANONIKUS — pontosan ezeket használd)

| Konverziós pont | `eventName` | Meta event |
|---|---|---|
| Lead-kalkulátor (ajánlatkérő) beküldve | `quote_calculator_submitted` | Lead |
| Visszahívás-kérés beküldve | `callback_request_submitted` | Lead |
| Kapcsolatfelvételi űrlap beküldve | `contact_form_submitted` | Contact |
| Telefonszámra kattintás (`tel:`) | `phone_number_clicked` | Contact |
| Email-címre kattintás (`mailto:`) | `email_address_clicked` | Contact |
| WhatsApp gombra kattintás | `whatsapp_button_clicked` | Contact |

> Régi nevek (`quote_calculator_conversion`, `callback_conversion`, `phone_conversion`,
> stb.) is működnek (a worker normalizál), de **az újakat használd**.

### Példák

**Űrlap-beküldés (success ágon, a PII-vel):**
```ts
form.addEventListener('submit', async (e) => {
  // ... a saját validáció/küldés sikere után:
  await trackConversion('contact_form_submitted', {
    user_data: {
      email: emailInput.value,
      phone_number: phoneInput.value,
      first_name: firstNameInput.value,
      last_name: lastNameInput.value,
      country: 'gb'
    }
  });
});
```

**Telefon-kattintás (`tel:` link):**
```ts
phoneLink.addEventListener('click', () => {
  // ne await-old, hogy ne késleltesd a hívásindítást — sendBeacon megbízható
  trackConversion('phone_number_clicked', { user_data: {} });
});
```

**Kalkulátor beküldve (értékkel):**
```ts
await trackConversion('quote_calculator_submitted', {
  value: estimatedPrice,        // £ becslés, ha van
  currency: 'GBP',
  user_data: { email, phone_number, postal_code, country: 'gb' }
});
```

---

## 5. KRITIKUS szerződések (ezek megszegése csendes hibát okoz)

1. **`event_id` dedup.** A `trackConversion` egy `event_id`-t generál, és azt
   `dataLayer`-be is push-olja **és** a szervernek is küldi. A böngésző Meta
   Pixelnek (GTM-ben) **ezt a `dataLayer` `event_id`-t kell** átadnia a Pixel
   `eventID` paraméterének — különben a Meta a böngésző + szerver eventet **két
   külön** konverziónak látja (dupla Lead → torz ROAS). Ellenőrizd a GTM Meta
   Pixel tag `eventID` mezőjét: `{{DLV - event_id}}` (a dataLayer `event_id`).

2. **PII SOHA nem mehet a `dataLayer`-be.** A `user_data`-t kizárólag a
   `trackConversion` `user_data` paraméterébe tedd → a worker POST-body-jában megy,
   ott hash-elődik. A `dataLayer.push` szándékosan PII-mentes. (GDPR Article 32.)

3. **Ne küldj GA4/Google Ads-et a szerverről.** Azt a böngésző GTM/gtag intézi.
   A `trackConversion` szerepe on-site: Meta CAPI + a Pixel-dedup `dataLayer` push.

4. **Consent.** Ha CookieYes (GTM-ből) aktív, a lib automatikusan kiolvassa a
   `cookieyes-consent` cookie-t és a worker eldönti, mehet-e ad-platform. Painless
   jelenleg `require_consent:false` (UK), de a CookieYes-bekötés ajánlott.

---

## 6. Verifikáció (élesítés után — így tudod, hogy MŰKÖDIK)

1. **Hálózat:** egy konverzió után a Network fülön legyen egy `POST
   /api/event/conversion` → **204** válasz.
2. **Meta Events Manager → Test Events / Activity:** a Painless pixelnél (292656820246446)
   jelenjen meg a böngésző **és** a szerver event **AZONOS `event_id`-vel** → a Meta
   „Deduplicated"-ként jelzi. Ez a legfontosabb ellenőrzés.
3. **GA4 DebugView/Realtime:** a konverzió (a böngésző tag-ből) látszik.
4. **Google Ads → Conversions:** a böngésző-konverzió megjelenik (lehet pár óra).
5. Szólj a worker-csapatnak, hogy a worker `events_raw` táblájában megjelennek-e a
   valós eventek (most 0 — amíg ez a bekötés nem él).

---

## 7. Amit NE csinálj

- ❌ Ne hívd a `trackConversion`-t page-load-ra vagy nézet-váltásra (csak valódi
   konverziós akcióra). Astro View Transitions esetén a konverzió a form-success /
   click handlerből jöjjön, ne a `astro:page-load`-ból.
- ❌ Ne tedd a Meta CAPI access tokent vagy GA4 api_secretet a kliensbe — azok a
   worker oldalán élnek.
- ❌ Ne generálj külön `event_id`-t a Pixelnek és a szervernek — egy közös kell.
- ❌ Ne küldj `value: 0`-t — hagyd ki a `value`-t, ha nincs valós érték.

---

## Kérdés a worker-csapatnak (ha elakadsz)
- Turnstile site key ↔ secret párosítás, SITE_CONFIG, route-státusz, vagy a
  `events_raw` ellenőrzése — ezek a worker (Serverside repó) oldalán vannak.
