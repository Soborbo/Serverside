# Google Ads OAuth — állapot-audit + helyreállítási runbook

**Dátum:** 2026-08-24 · **vNext P2 (első batch „D" fázis)** · **Státusz:** az audit
és a kapuk kész (agent-oldal); **a secret-beírás és a Google-consent user-kezű.**

> Ez a dokumentum a Google-ág EGÉSZ auth-felületét leltározza, mert a vNext-terv P2
> pontja a live worker OAuth-állapotát 🔴-nak jelölte („`GADS_OAUTH_CLIENT_ID` +
> `GADS_DEVELOPER_TOKEN` 2026-07-15 óta hiányzik"). **Az audit ezt részben cáfolta** —
> lásd §1. Az itteni megállapítások mind kódból/konfigból származnak; amit csak a
> live worker tud megmondani, az §4-ben van, futtatható parancsokkal.

---

## 1. Audit — mi kell, hol él, és mi bukik nélküle

| Név | Hol él MA | Kötelező mihez | Mi történik nélküle |
|---|---|---|---|
| `GADS_OAUTH_CLIENT_ID` | **`wrangler.toml` `[vars]`** (committed, `:45`) | minden token-refresh + `/oauth-init` | a refresh `client_id` nélkül indul → Google `invalid_client` → **TRK-800-001**, néma offline-vesztés |
| `GADS_OAUTH_CLIENT_SECRET` | worker **secret** (`wrangler secret put`) | ugyanaz | ugyanaz |
| `GADS_DEVELOPER_TOKEN` | worker **secret** | **CSAK** a reconciliation GAQL-lába (`lib/cross-check.ts:189`) | a Data Manager UPLOAD **változatlanul megy**; a napi Ads-oldali cross-check vakul |
| per-customer `refresh_token` | `OAUTH_TOKENS` KV (`gads:<cid>:refresh_token`) | a customer offline feltöltése | `TRK-800-002` / nincs access token → az adott site offline lába áll |
| per-customer `access_token` | `OAUTH_TOKENS` KV, TTL ≤ 55 perc | — (cache) | csak egy extra refresh |

### 1.1 A terv 🔴-jának pontosítása

**`GADS_OAUTH_CLIENT_ID` már NEM „hiányzó secret".** 2026-08-11 óta a
`wrangler.toml` `[vars]` blokkjában él (kommentelve is: a dashboardon kezelt példány
egy deploynál elveszett, és a beautyflow offline lába **hetekig némán bukott**
TRK-800-001-gyel). Mivel `[vars]`, **minden `wrangler deploy` újra kikényszeríti** —
ezt már nem lehet „elveszíteni", csak commit-tal kivenni.

Ami tényleg csak secretként létezhet, tehát tényleg hiányozhat: a
**`GADS_OAUTH_CLIENT_SECRET`** és a **`GADS_DEVELOPER_TOKEN`**.

**A terv „minden Google offline verifier és reconciliation értelmetlen enélkül"
állítása is finomítandó.** A két láb NEM ugyanazon a titkon lóg:

- **Offline UPLOAD (a pénzút)** — Data Manager API. Kell: client id + client secret +
  a customer refresh tokenje. **Developer token NEM kell** — a `datamanager.ts`
  szándékosan nem küld `developer-token` headert (a Data Manager self-serve).
- **Reconciliation GAQL-láb (a mérés)** — a Google Ads API-t hívja, és **ahhoz kell**
  a developer token.

Ezért a health-check a kettőt KÜLÖN kezeli: hiányzó OAuth-secret → **FAIL**,
hiányzó developer token → **WARN**. Egy hiányzó developer token miatt nem szabad
pirosra festeni egy site-ot, aminek a pénzútja megy.

### 1.2 Scope-ellenőrzés (Data Manager!)

`src/routes/oauth-init.ts` a következő scope-hármassal kér consentet:

```
https://www.googleapis.com/auth/datamanager        ← a Modell-2 offline út (KÖTELEZŐ)
https://www.googleapis.com/auth/adwords            ← GAQL cross-check
https://www.googleapis.com/auth/analytics.readonly ← recon GA4-lába (2026-07-16 óta)
```

**A scope-bővítés visszamenőleg NEM hat.** Egy korábban kiadott refresh token a
RÉGI scope-készletével él tovább; az új scope-ot igénylő láb 403-mal bukik és
skippel. Ha egy customer refresh tokenje 2026-07-16 ELŐTTI, a GA4-recon lába vak,
és **újra kell futtatni az `/oauth-init`-et** arra a `customer_id`-ra.

> A `prompt=consent` + `access_type=offline` páros benne van a kérésben, tehát az
> újrafuttatás ténylegesen ÚJ refresh tokent ad (különben a Google csak access
> tokent adna vissza). A `storeRefreshToken` a beíráskor **törli a cache-elt access
> tokent**, hogy ne éljen tovább a régi scope-készlettel — enélkül a re-consent után
> még ~55 percig 403-ok jönnének, mintha nem sikerült volna.

### 1.3 Ami ebben a fázisban ÚJ (és amit ellenőrizni kell utána)

1. **`gads_oauth_secrets` health-check** — `gads.customer_id` mellett FAIL, ha a
   client id/secret hiányzik a workerről. A szöveg kimondja, hogy **az OAuth-flow
   újrafuttatása NEM segít** — a régi üzenet („no access token (run OAuth flow)")
   misdiagnózis volt, és a hiba valódi helyétől terelte el az operátort.
2. **`gads_developer_token` health-check** — WARN, a fenti indoklással.
3. **„OFFLINE MONEY PATH DOWN" jelölés** — ha a site-nak van `conversion_actions`-je
   VAGY az `expected_platforms.offline` nevesíti a `gads`-ot, a törött OAuth
   üzenete ezt explicit kiírja. Ez a terv hard health rule-ja: nem warning, nem
   silent skip.
4. **`/oauth-init` fail-fast** — hiányzó worker-secret esetén **503** a megnevezett
   secrettel, ahelyett hogy `client_id=undefined`-dal redirectelne a Google
   hibaoldalára (ahol az operátor a saját Google-fiókjában kezdi keresni a hibát).

Tesztek: `tests/gads-oauth-health.test.ts` (a fix visszavonásával 6/7 bukik).

---

## 2. Amit NEKED kell megtenned (a runbook)

> A gateway repo gyökeréből futtatandó. Ahol `<...>` van, oda a valódi érték jön.
> **Egyik parancs kimenetét se commitold.**

### 2.1 Állapotfelmérés — mi van most a live workeren

```bash
# 1) Milyen secretek vannak egyáltalán a workeren? (értéket SOHA nem ír ki)
npx wrangler secret list

# Elvárt sorok: GADS_OAUTH_CLIENT_SECRET, GADS_DEVELOPER_TOKEN, ADMIN_API_TOKEN
# A GADS_OAUTH_CLIENT_ID NEM itt van — az a wrangler.toml [vars]-ában (helyes).
```

```bash
# 2) Site-onkénti health — ez mondja meg, MI a valódi baj
for HOST in painlessremovals.com beautyflow.pro lomtalan.hu olcsokontenerhaz.hu \
            trapezlemezes.hu skinlabhungary.hu szelloztessokosan.hu agykontroll.co.uk; do
  echo "── $HOST"
  curl -s -H "X-Admin-Token: <ADMIN_API_TOKEN>" \
    "https://$HOST/api/event/admin/health-check" \
  | grep -E '"overall"|gads_oauth|gads_developer_token|gads_conversion_actions' -A2
done
```

Olvasat:

| Amit látsz | Mit jelent | Mit csinálj |
|---|---|---|
| `gads_oauth_secrets: FAIL` | worker-secret hiányzik | **2.2** (OAuth újrafuttatása itt NEM segít) |
| `gads_oauth_secrets: PASS` + `gads_oauth: FAIL` | nincs refresh token EHHEZ a customerhez | **2.3** |
| `gads_developer_token: WARN` | a Data Manager upload MEGY, a recon GAQL-lába vak | **2.4** (nem sürgős) |
| `gads_conversion_actions: WARN` | van customer_id, de nincs action-térkép — az offline láb nem tud hova tölteni | Ads-fiókban hozd létre az offline actiont, majd `scripts/patch-site-config.mjs` |

### 2.2 Hiányzó worker-secret pótlása

```bash
# TOP-LEVEL (nem --env production) — a worker egyetlen environmentben fut
npx wrangler secret put GADS_OAUTH_CLIENT_SECRET
# Forrás: Google Cloud Console → APIs & Services → Credentials → az OAuth 2.0
# Client ID-hoz tartozó „Client secret". A CLIENT ID-nak egyeznie kell a
# wrangler.toml [vars] GADS_OAUTH_CLIENT_ID értékével:
#   798228321713-2pji8f6c399520l0ifnfq9255c2a6kqs.apps.googleusercontent.com
```

**Ha a client secret nem található meg** (elveszett): a Google Cloud Console-ban
generálj újat UGYANAHHOZ a klienshez (`Add secret`), írd be ide, és **ne töröld a
régit, amíg ez nem működik**. A client ID nem változik, tehát a meglévő refresh
tokenek érvényben maradnak.

Ellenőrzés (deploy nem kell — a secret request-időben olvasódik):
```bash
curl -s -H "X-Admin-Token: <ADMIN_API_TOKEN>" \
  "https://painlessremovals.com/api/event/admin/health-check" | grep -A2 gads_oauth_secrets
# elvárás: "status": "PASS"
```

### 2.3 Per-customer OAuth (re-)consent

```bash
# Böngészőben nyisd meg — a Google consent-képernyő kell hozzá.
# Az X-Admin-Token header miatt a legegyszerűbb egy böngésző-kiegészítővel
# (ModHeader) vagy a curl -L kimenetéből a Location URL-t átmásolva.
curl -s -D - -o /dev/null -H "X-Admin-Token: <ADMIN_API_TOKEN>" \
  "https://painlessremovals.com/api/event/oauth-init?customer_id=<10_JEGYU_CID>" \
| grep -i '^location:'
```

Fontos:
- a `customer_id` **10 számjegy, kötőjel nélkül** (az Ads UI `123-456-7890`-t mutat);
- a consentet **azzal a Google-fiókkal** add meg, aminek van hozzáférése ahhoz az
  Ads-fiókhoz;
- ha manager (MCC) alatt van, a `login_customer_id` a KV-configba tartozik, nem ide;
- a callback után a health-check `gads_oauth` sora **PASS**-ra vált.

**Kikre kell újrafuttatni akkor is, ha „működik":** minden olyan `customer_id`-ra,
aminek a refresh tokenje **2026-07-16 előtti** — különben a recon GA4-lába
(`analytics.readonly`) vak marad. Ezt a health-check nem tudja megmondani (a scope
nem olvasható ki a tokenből); ha bizonytalan, a re-consent olcsó és idempotens.

### 2.4 Developer token (csak a reconciliation GAQL-lábához)

```bash
npx wrangler secret put GADS_DEVELOPER_TOKEN
# Forrás: Google Ads → Tools → API Center (a MANAGER fiókban). Jóváhagyott
# (Basic/Standard) token kell; a „Test account" szintű token éles fiókon 
# DEVELOPER_TOKEN_NOT_APPROVED-ot ad.
```

### 2.5 Validate-only füst-teszt (élő konverzió NÉLKÜL)

A Data Manager úton van beépített dry-run: `DATAMANAGER_VALIDATE_ONLY=1` mellett a
Worker `validateOnly=true`-val küld — a Google **validálja, de nem rögzíti**.

```bash
# 1) kapcsold be a dry-runt
npx wrangler deploy --var DATAMANAGER_VALIDATE_ONLY:1   # vagy dashboard var

# 2) szintetikus lifecycle-esemény a szerver-ingressen (per-site token kell)
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "https://painlessremovals.com/api/event/lead-status" \
  -H "X-Admin-Token: <PER_SITE_CRM_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"lead_id":"dm-validate-<YYYYMMDD>","status":"lead_qualified",
       "occurred_at":"<ISO8601>","ad_allowed":true,
       "user_data":{"email":"<TRACKING_TEST_LEAD_EMAIL>","country":"gb"}}'
# elvárás: 200 (NEM 204 — a szerver-szerver úton a hívónak tudnia kell retry-olni)

# 3) a ledgerben ez a sor legyen (accepted + NEM NULL http_status):
#   SELECT platform,status,http_status,error_code,created_at
#   FROM deliveries WHERE event_id LIKE 'dm-validate-%' ORDER BY created_at DESC LIMIT 5;

# 4) KAPCSOLD VISSZA — különben egyetlen valódi konverzió sem rögzül
npx wrangler deploy   # a var nélkül
```

> ⚠️ A 4. lépés kihagyása a legdrágább hiba ebben a runbookban: a rendszer minden
> mérőszáma zöld marad (accepted + 200), miközben a Google **semmit nem rögzít**.
> A `DATAMANAGER_VALIDATE_ONLY` visszakapcsolása nem opcionális lépés.

---

## 3. PROD CHECK — mit nézünk utána

**Az elfogadás kritériuma NEM a health-check zöldje, hanem egy VALÓDI `accepted`
Data Manager-upload a ledgerben.**

```sql
-- 1) valódi (nem szintetikus) offline upload, vendor HTTP-státusszal
SELECT site_id, event_id, platform, status, http_status, error_code, created_at
FROM deliveries
WHERE platform = 'gads' AND origin = 'offline'
  AND event_id NOT LIKE 'smoke-%' AND event_id NOT LIKE 'dm-validate%'
ORDER BY created_at DESC LIMIT 10;
-- elvárás: legalább 1 sor, status='accepted', http_status NOT NULL

-- 2) INV-010 nem sérült (accepted SOHA nem lehet vendor-státusz nélkül)
SELECT COUNT(*) FROM deliveries WHERE status='accepted' AND http_status IS NULL;

-- 3) a lifecycle-oldal is látja
SELECT lead_id, status, uploaded_to_gads, gads_error_code, created_at
FROM lead_status
WHERE lead_id NOT LIKE 'smoke-%' AND lead_id NOT LIKE 'dm-validate%'
ORDER BY created_at DESC LIMIT 5;
```

Google-oldali visszaigazolás: **Ads → Goals → Conversions** — az offline action
státusza „Recording conversions"-re vált (a first upload után akár több órával).

### Token-lejárat monitorozás

A refresh token akkor jár le, ha (a) a user visszavonja a hozzáférést, (b) 6 hónapig
nem használják, vagy (c) a Google-fiók jelszava változik. Mai állapot: ezt **semmi
nem figyeli proaktívan** — a hiba a napi digest offline-lábán jelentkezne. Amíg a
P1 reconciliation business-lába nincs kész (`offline_zero_delivery` finding), a
gyakorlati őr a fenti §2.1 health-loop **heti** lefuttatása.

---

## 4. Amit ez a fázis SZÁNDÉKOSAN nem csinált

- **Nem írt be egyetlen secretet sem** — az user-kezű (a terv így osztja).
- **Nem futtatott OAuth-consentet** — Google-fiókos böngésző-interakció kell hozzá.
- **Nem kapcsolta be a `DATAMANAGER_VALIDATE_ONLY`-t** élesben — deploy-hatás.
- **Nem épített token-expiry monitort** — az a P1 reconciliation business-lábára
  épül (`offline_zero_delivery`), külön riasztás-forrást nem gyártunk mellé.
