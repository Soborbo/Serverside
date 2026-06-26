# DEPLOY — telepítési runbook (Claude Code-nak optimalizálva)

Ez a dokumentum úgy van megírva, hogy **Claude Code a lehető legkevesebb emberi
inputtal** fel tudja telepíteni a Workert. A telepítés két fázisra bomlik:

- **A. fázis — deployolható Worker** (health-válasz): **teljesen automatizálható**, nulla
  emberi input. Cloudflare MCP + `wrangler` elég.
- **B. fázis — működő konverziós Worker**: irreducibilis emberi inputot igényel
  (Turnstile secret + per-site reklám-platform hitelesítők). Ezek nagy része a
  csatlakozott ad-platform MCP-kből **kiolvasható**, így a tényleges kézi input minimális.

A rendszer szándékosan **graceful-degradation**: minden opcionális binding/secret guardolt,
egy input nélküli `wrangler deploy` is élő health-endpointot ad.

---

## Előfeltétel (egyszeri)

Cloudflare hitelesítés: `wrangler login` **VAGY** `CLOUDFLARE_API_TOKEN` env var
(Workers Scripts: Edit + D1/KV/R2 Edit jogokkal). Ha Claude Code Cloudflare MCP-vel
fut, a D1/KV/R2 provisioning a MCP-toolokkal megy (parse-mentes, strukturált ID-k).

---

## A. fázis — deployolható Worker (autonóm, 0 emberi input)

> Cél: `GET /api/event/health` → 200 egy `*.workers.dev` URL-en. Ehhez **nem kell
> egyetlen secret vagy KV-adat sem** — a health route semmilyen bindinget nem érint.

A `wrangler deploy` viszont **elhasal, ha egy AKTÍV binding nem létező erőforrásra
mutat**. Négy aktív binding van: `SITE_CONFIG` (KV), `OAUTH_TOKENS` (KV),
`DEAD_LETTER` (R2), `LEDGER` (D1). A `wrangler.toml` ezekhez **valós ID-kat** tartalmaz
a jelenlegi fiókra — **friss fiókon ezeket újra kell provisionálni.**

### A1. Friss fiók: erőforrások + toml-patch

**Claude Code (Cloudflare MCP) útja — előnyben részesített, parse-mentes:**
1. `kv_namespace_create` "SITE_CONFIG" → kapott `id` a `wrangler.toml` első `[[kv_namespaces]]` blokkjába.
2. `kv_namespace_create` "OAUTH_TOKENS" → a második `[[kv_namespaces]]` blokkba.
3. `r2_bucket_create` "soborbo-tracking-dlq" (a toml a nevet használja, nem ID-t).
4. `d1_database_create` "event-gateway-ledger" (`primary_location_hint: weur` az EU/GDPR-hez) → `database_id` a toml `[[d1_databases]]` blokkjába.
5. `d1_database_query`-val futtasd le a `migrations/0001_ledger.sql` tartalmát (5 tábla + 10 index). Verifikáció: `SELECT name FROM sqlite_master WHERE type='table'`.
6. Patcheld a `wrangler.toml` `account_id`-t is (a MCP fiók account-ja).

**CLI út (ember/CI):** `./scripts/bootstrap-cloudflare.sh` ugyanezt elvégzi
(`--dry-run` előbb). Igényli: `wrangler` + auth.

> **Ugyanazon a fiókon** (a jelenlegi `wrangler.toml`), ahol az erőforrások már
> léteznek, **A1 kihagyható** — ugorj A2-re.

### A2. Deploy + health-verifikáció
```bash
npm install
wrangler deploy
# verify:
curl -s https://<worker>.workers.dev/api/event/health   # → {"status":"ok",...}
```

Ezzel a Worker él. **Ennél a pontnál még semmilyen konverzió nem megy ki** (Turnstile +
KV config hiányában 403/404).

---

## B. fázis — működő konverziós Worker (minimális emberi input)

Három input-csoport. A `*` jelöli, ami **MCP-ből kiolvasható** (kézi gépelés helyett).

### B1. Turnstile secret (1 kézi érték)
`TURNSTILE_SECRET_KEY` — **az EGYETLEN secret, ami a core happy-path-hoz kell.**
Nélküle minden `/api/event/conversion` 403. Cloudflare dashboard → Turnstile → widget →
secret key. Beállítás: `wrangler secret put TURNSTILE_SECRET_KEY`.
(Vész-fail-open: `TURNSTILE_FAILOPEN=1` — prod-ban NE.)

### B2. SITE_CONFIG KV seed (per hostname)
A Worker multi-tenant: `SITE_CONFIG.get(hostname)`. Hiányzó config → 404 (nincs fallback).
A config JSON sablonja: `scripts/painless-config.template.json`. Mezők:
- `site_id`, `country_code`, `currency`
- `meta.pixel_id` * (Pipeboard_Meta_Ads `get_pixels`), `meta.access_token` (System User token — **kézi**), `meta.test_event_code` (prod-ban **KIVENNI** — CLAUDE.md 17)
- `ga4.measurement_id` * (Google_Analytics_4 `get_property_details`), `ga4.api_secret` (**kézi**, GA4 Admin)
- `gads.customer_id` * (Pipeboard_Google_Ads `list_customers`), `gads.conversion_actions` * (Google Ads MCP-ből), `gads.login_customer_id` (MCC vagy null)

Seedelés: `./scripts/setup-painless.sh --hostname=<host>` (interaktív vagy env-override-okkal
CI-ben — lásd a script fejlécét). Csak Meta+GA4 site-hoz a `gads` blokk elhagyható.

### B3. Google Ads OAuth (csak ha Google Ads kell)
Secret-ek: `GADS_OAUTH_CLIENT_ID`, `GADS_OAUTH_CLIENT_SECRET`, `GADS_DEVELOPER_TOKEN`
(**kézi**; a developer token jóváhagyása 2–8 hét). Majd az admin OAuth-flow:
`GET /api/event/oauth-init` böngészőből (admin-token mögött). Meta + GA4 ezek nélkül is megy.

---

## Opcionális rétegek (deploy után, igény szerint)

A `wrangler.toml`-ban kommentben, kódból guardolva — bekapcsolás = uncomment + redeploy:
- **Cron `[triggers]`** — a napi reconciliation / digest / SLO check. **Enélkül a cronok
  nem futnak**, de minden request-úti funkció (ledger, idempotencia, admin API, lead-status, UI) él.
- **`DLQ` Queues** — natív retry (különben R2-fallback + óránkénti cron).
- **`INGEST_LIMITER`** rate limit, **`ADMIN_EMAIL`** email-alert, **`[[routes]]`** zone-routing.

Admin API/UI + lead-status: `ADMIN_API_TOKEN` secret kell (`wrangler secret put`),
különben 401. Az UI: `https://<host>/api/event/admin-ui`.

---

## A tényleges kézi inputok listája (ennyit kell tőled kérni)

| # | Input | Mikor kell | Kiolvasható MCP-ből? |
|---|---|---|---|
| 1 | `TURNSTILE_SECRET_KEY` | bármilyen konverzióhoz | nem (Cloudflare dashboard) |
| 2 | `meta.access_token` (System User) | Meta CAPI-hoz | nem |
| 3 | `ga4.api_secret` | GA4-hez | nem |
| 4 | GAds OAuth client+secret+dev token | csak Google Ads | nem |

Minden más (pixel_id, GA4 measurement_id, GAds customer_id + conversion actions, az összes
Cloudflare resource ID, account_id) **autonóm** — MCP-ből kiolvasható vagy provisionálható.
A reklám-platform **titkok** (2,3,4) irreducibilisek: ezeket neked kell megadnod.

---

## Ismert korlát

A `quote_calculator_conversion` esemény a Durable Object alapú **késleltetett fan-out**
flow-t használ (60 perces upgrade-ablak), ezért **nem** jelenik meg az events_raw/deliveries
ledgerben és a reconciliation-ben — szándékosan, hogy ne generáljon hamis coverage-drift
riasztást (az event jogosan nem fan-outol azonnal). A többi esemény teljesen lefedett.
