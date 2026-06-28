---
name: onboard-site
description: Bind a new website to the event-gateway server-side tracking worker. Use when the user wants to "connect"/"onboard"/"bekötni" a site (Trapézlemez, Skinlab, fémkerítés, olcsó kerítés, stb.) to the Soborbo Tracking worker — gathers Meta/GA4/Google Ads IDs from the connected MCP connectors, generates the KV site-config + route + client snippet via scripts/generate-site.mjs, and prepares the deploy.
---

# Onboard a site to the event-gateway worker

Ez a skill egy új site-ot köt be a `event-gateway` workerhez. A repó a source of
truth: a tényleges generálást a determinisztikus `scripts/generate-site.mjs`
végzi — te (az agent) az ID-ket gyűjtöd össze az MCP-connectorokból, és levezényled
a lépéseket. **Ne improvizáld a config-formátumot — mindig a scriptet futtasd.**

## Háttér
- Worker tenant-kulcs = a hostname, ahová a POST megy (`getSiteConfig(url.hostname)`).
- SITE_CONFIG KV namespace id: `edd34e28eee847c09c26f9d9e3ea04ab`.
- A client-lib (`client-lib/worker-tracking.ts`) mindent automatikusan küld
  (consent CookieYes-ból, attribúció URL+cookie-ból). A site-on alig van egyedi kód.

## Lépések

### 1. Gyűjtsd össze az ID-ket (MCP-connectorok)
Kérdezd meg a hostname-eket (apex + www) és a site_id-t, majd:

- **Meta pixel_id** — Meta Ads connector (`get_pixels` / business assets). Ha nem
  található, kérd be az Events Managerből.
- **Meta CAPI access_token** — NEM lekérhető API-ból. Kérd be a usertől (Events
  Manager → Settings → Conversions API → Generate access token). Ez secret.
- **GA4 measurement_id (G-XXXX)** — GA4 connector: a property data stream-jéből
  (web stream → Measurement ID). FIGYELEM: a property-szám (pl. 449987171) NEM ez.
- **GA4 api_secret** — NEM lekérhető API-ból. Kérd be: GA4 Admin → Data Streams →
  <stream> → Measurement Protocol API secrets → Create. Secret.
- **Google Ads customer_id** — Google Ads connector (`list_google_ads_customers`).
  10 számjegy KÖTŐJEL NÉLKÜL. login_customer_id csak ha MCC alatt van.
- **Google Ads conversion_actions** — Ads connector: a konverzió-akciók ID-jai,
  event-névre képezve. Engedett event-nevek: quote_calculator_conversion,
  callback_conversion, contact_form_submit, phone_conversion, email_conversion,
  whatsapp_conversion, quote_calculator_first_view, video_play.
- **country_code / currency** — a site piaca szerint (HU/HUF, GB/GBP, …).
- **require_consent** — EEA (HU/EU/DE/FR/IT/ES) site-on állítsd `true`-ra.

### 2. Építsd meg az input JSON-t és futtasd a generátort
Írd ki egy temp fájlba (NE a repóba a secretekkel), majd:

```bash
node scripts/generate-site.mjs --input /tmp/<site>.json --out /tmp/<site>-out
```

Az input alakja (lásd a validátort a scriptben):
```json
{
  "site_id": "trapezlemez",
  "hostnames": ["trapezlemezes.hu", "www.trapezlemezes.hu"],
  "country_code": "HU",
  "currency": "HUF",
  "require_consent": true,
  "meta": { "pixel_id": "...", "access_token": "..." },
  "ga4": { "measurement_id": "G-XXXX", "api_secret": "..." },
  "gads": { "customer_id": "1234567890", "login_customer_id": null,
            "conversion_actions": { "callback_conversion": "...", "phone_conversion": "..." } }
}
```
A generátor validál (hibás ID → exit 1) és kiírja: `site-config.json`, `routes.toml`,
`kv-put.sh`, `crm-secret.env`, `INTEGRATION.md`. Ha validációs hiba van, javítsd az inputot,
ne a scriptet.

**Per-site CRM token:** ha a site CRM-et köt be (offline-loop), a generátor egy per-site
tokent állít elő — a KV-be CSAK a `crm_token_sha256` kerül, a plaintext a `crm-secret.env`-be.
Ezt add át a CRM-deploynak (`TRACKING_WORKER_URL` + `TRACKING_ADMIN_TOKEN` secret); a stdout-on
kiírt generált token CSAK egyszer látszik. Determinisztikus újrafuttatáshoz add meg az inputban
a `crm_token`-t (≥16 char), különben minden futás új tokent generál. Ezzel a globális
ADMIN_API_TOKEN már nem ír ehhez a site-hoz → tenant-izoláció.

### 3. Töltsd fel a KV-t
A `kv-put.sh`-ban lévő parancsokkal (wrangler), VAGY a Cloudflare MCP `kv_put`
tooljával (namespace id fent), hostname-enként egy bejegyzés.

### 4. Route + deploy
Fűzd hozzá a `routes.toml` blokkját a `wrangler.toml`-hoz (a kikommentezett
rollout-szekció mintájára), majd branch + PR (ne pushold közvetlenül main-re).
A user `wrangler deploy`-jal élesíti.

### 5. Google Ads OAuth (ha van customer_id)
Egyszer customer_id-nként: `GET /api/event/oauth-init` admin-tokennel (X-Admin-Token),
hogy az OAUTH_TOKENS KV feltöltődjön. Enélkül a Google Ads upload elbukik.

### 6. Astro site oldal
Add át a usernek az `INTEGRATION.md` ellenőrzőlistát. Lényeg: client-lib bemásolása,
Turnstile widget + PUBLIC_TURNSTILE_SITE_KEY, és `trackConversion(...)` a konverziós
pontokon. A consent (CookieYes) és az attribúció (UTM/click ID) automatikus.

### 7. Verifikáció
A generált `INTEGRATION.md` "Ellenőrzés" szakasza szerint: health, Meta Test Events
(dedup azonos event_id), GA4 DebugView, Google Ads Conversions, Workers Logs 24h.

## Fontos szabályok
- A secrets (CAPI token, GA4 api_secret) NE kerüljenek be a git-be — csak KV-be.
- EEA site-on `require_consent: true` + CookieYes bekötve.
- test_event_code-ot élesítés előtt KÖTELEZŐ kivenni (a generátor figyelmeztet rá).
- Mindig a generátort futtasd a config formátumhoz — ne kézzel írd a JSON-t.