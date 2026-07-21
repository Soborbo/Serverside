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
- A kliens-tracking lib a **`soborbo-tracking` package** (Soborbo/claudeskills,
  `soborbo-tracking/` — `lib/` + `components/`, v5.x; telepítés az `INSTALL.md` szerint).
  Mindent automatikusan küld (consent CookieYes-ból, attribúció URL+cookie-ból) — a site-on
  alig van egyedi kód. A régi `client-lib/worker-tracking.ts` TÖRÖLVE (lásd `client-lib/README.md`);
  ne abból másolj. (A backend event-szerződés kanonikus otthona külön: Serverside `src/events.json`.)

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
- **Google Ads conversion_actions** — Model 2: a szerver Google Ads lába CSAK
  **offline** (Enhanced Conversions for Leads, a CRM lead-status-loopon át). A kulcsok
  kanonikus **offline** event-nevek (a generátor `src/events.json`-hoz validál):
  `lead_validated`, `lead_qualified`, `quote_sent`, `booking_confirmed`,
  `job_completed`, `revenue_confirmed`. Az érték = a Google Ads **offline** conversion
  action ID-ja (UPLOAD_CLICKS típus). Az on-site akció-ID-k (quote/callback klikk) a
  böngésző/gtag tulajdona — ide NE tedd őket (a régi on-site nevek amúgy is elbuknának
  a kanonikus-validáción, 2026-07-13-i auditfix).
- **country_code / currency** — a site piaca szerint (HU/HUF, GB/GBP, …).
- **require_consent** — EEA (HU/EU/DE/FR/IT/ES) site-on állítsd `true`-ra.

### 2. Építsd meg az input JSON-t és futtasd a generátort
Írd ki egy temp fájlba (NE a repóba a secretekkel), majd:

```bash
# ÚJ site bekötése → --new-site (a token-rotációs guard ezt kéri, ha nincs crm_token az inputban):
node scripts/generate-site.mjs --input /tmp/<site>.json --out /tmp/<site>-out --new-site
```

> **Token-rotációs guard:** ha az input nem ad `crm_token`-t, a generátor új tokent gyártana.
> Új site-nál ez rendben → `--new-site`. **Meglévő** site-on egy sima újrafuttatás felülírná a
> KV-ben élő tokent (a site backendje 401-et kapna a `/lead-status`-on) — ezért ott vagy add meg
> a meglévő tokent `crm_token`-ként (reuse), vagy szándékos rotációhoz `--rotate-token` (és utána
> deployold újra a CRM-et az új tokennel).

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

**lead_id = a CRM kulcsa:** az offline-loopban a `lead_id` a CRM webhook-válasz
`{success, id}`-jából jön (a Worker ezen joinolja a Meta/offline sorokat). Site-oldali
fallback-kulcs TILOS — egy kitöltöttnek látszó, de joinolhatatlan oszlop rosszabb a
NULL-nál (Run 6 tanulság #3). Érvénytelen `lead_id`-t a gateway eldob (warn), de a
konverziót átengedi — nem nyeli el a money-eventet (tanulság #2).

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
Add át a usernek a generált `INTEGRATION.md` ellenőrzőlistát. A konverziók **két úton**
mennek (Run 6, Model 2):
- **Böngésző-út** (kis kockázatú klikk-eventek: phone/email/whatsapp klikk, begin_checkout,
  video_play): `trackConversion('<event>', { value, currency, user_data })`. A gateway ezt
  **Origin allow-listtel** kapuzza — **Turnstile NEM kell** hozzá (a Run 6 kivette a
  gateway-ből). NE huzalozz Turnstile-t a tracking miatt; ha a site a saját formját védi
  Turnstile-lal, az független ettől.
- **Szerver-only konverziók** (form/lead/purchase — `server_ingress_only`): a SITE
  BACKENDJÉBŐL, `POST /api/event/conversion-server` + per-site `X-Admin-Token`, a böngésző
  event_id-jét újrahasznosítva (Pixel↔CAPI dedup). Böngésző-úton ezek 403-at kapnak
  (TRK-400-017) — enélkül a gate-deploy némán vesztené a form-konverziókat (tanulság #4).

A consent (CookieYes) és az attribúció (UTM/click ID) automatikus.

### 7. Verifikáció
A generált `INTEGRATION.md` "Ellenőrzés" szakasza szerint: health, Meta Test Events
(dedup azonos event_id), GA4 DebugView, Google Ads Conversions, Workers Logs 24h.

## Fontos szabályok
- A secrets (CAPI token, GA4 api_secret) NE kerüljenek be a git-be — csak KV-be.
- EEA site-on `require_consent: true` + CookieYes bekötve.
- **test_event_code SOHA nem a KV-be.** A site-config edge-cache-elt (300s) → kétszer
  okozott éles Meta-leaket (Run 6). A proof-eventek **per-request** kapják a test-kódot a
  szerver-ingressen (a smoke-cron pont ezt teszi); a generátor default HIBÁT dob KV
  test_event_code-ra (`--allow-test-event-code` csak Sprint 4-8 szándékos teszthez).
- Mindig a generátort futtasd a config formátumhoz — ne kézzel írd a JSON-t.
- **Route + deploy (Run 6 tanulságok):**
  - A default/deployolt branch **nem mindig `main`** (Beautyflow: `master`). Merge előtt:
    `git remote show origin | grep "HEAD branch"` + nézd meg, a Workers Build melyik
    branchet deployolja (tanulság #5).
  - A wrangler.toml **top-level kulcsai** (pl. `keep_vars`) MINDEN `[table]`/`[[routes]]`
    ELŐTT álljanak — különben az utolsó tábla almezője lesz, és a deploy törli a
    dashboard-varokat. Build után MINDIG ellenőrizd a generált `dist/server/wrangler.json`-t
    (tanulság #6).