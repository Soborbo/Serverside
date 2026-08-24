# Flotta-konformancia felmérés — 2026-08-24

**Ez MÉRÉS, nem javítás.** A dokumentum egyetlen kérdésre válaszol: a flotta
egyenetlen kézbesítése (a) hiányzó szabványból, (b) meglévő szabvány melletti
nem-konform site-okból, vagy (c) hibás gateway-lábakból ered — és milyen
arányban site-onként. Kódváltozás nem történt; a felmérés kizárólag olvasott.

- **Mérés napja:** 2026-08-24
- **Gateway git-állapot:** `origin/main` = `b27fd0d` (2026-08-23)
- **Deployolt worker:** `build_commit=b27fd0dd…`, `build_dirty=false`, `built_at=2026-08-23T07:47:53Z`
  → **a deployolt kód ÉS a main azonos**, kód-drift nincs (F4-1(b) drift-őr, `/api/event/version`).
- **Ledger:** D1 `event-gateway-ledger` (`8c7774d1-2eea-40ba-b99c-92e73055460f`), `deliveries` + `consent_receipts`, 30 napos ablak
- **Platform-igazság:** Google Ads API (élő), GA4 Data API (élő), GTM API (élő), valós böngésző-mérés (Playwright/Chromium)

## A műszer korlátai — olvasd el, mielőtt egy számra döntést építesz

1. **A GA4 `keyEvents` és a Google Ads `conversions` NEM ugyanaz a mérőszám.** A
   gateway Modell 2 szerint egyiket sem táplálja on-site (lásd §1.3); a
   platform-számok a böngésző GTM-lábából származnak.
2. **A `(pre-instrument)` sorok.** A Fázis D oszlopok (`ingress_kind`,
   `source_used`, `client_lib_version`) 2026-08-17 után keletkezett soroknál
   értelmesek; a régebbieknél NULL. A NULL itt „nem volt műszer", nem „nincs adat".
3. **Az agykontroll és a szelloztessokosan GA4 propertyje NEM elérhető** a
   csatlakoztatott konnektorról — ott a GA4-oldali állítás mérés nélküli, jelölve.
4. **A `consent-terv-v4-vegleges.md` NINCS a repóban** (csak egy nyomon nem
   követett lokális fájl `„consent-terv-v4-vegleges - ez volt az eredeti terv.md"`
   néven). A befagyasztott tervet NEM rekonstruáltuk emlékezetből — hiányként
   rögzítve (§6).

---

## 0. Terv vs. main — mi van tényleg bent

### 0.1 PR-ek #59–#63

| PR | Cím | Állapot | Merge |
|---|---|---|---|
| #59 | 2026-08-16 kód-audit — guardok a pénz-úton | **MERGED** | 2026-08-17 |
| #60 | Fázis D — consent-diagnosztika műszerezés (S1–S3) | **MERGED** | 2026-08-17 |
| #61 | PECR storage-megfelelőség (olvasás consent mögé + purge) | 🔴 **NYITVA** | — |
| #62 | Consent compliance harness + 2026-08-17-i flotta-baseline | **MERGED** | 2026-08-17 |
| #63 | CMP Fázis 1 (szerveroldal, inert) | **MERGED** | 2026-08-23 |

### 0.2 A négy éjszakai brief — landolt vagy sem

| Brief | Tárgy | Main-en? | Bizonyíték |
|---|---|---|---|
| 1 | Fázis D műszerezés | ✅ **igen** | `migrations/0004_…`, `src/lib/skip-reason.ts`, `src/lib/consent-crosscheck.ts`, 8× `TRK-910` az `error-codes.ts`-ben, `"30 8 * * *"` cron a `wrangler.toml`-ban |
| 2 | PECR storage-gating | 🔴 **nem** | `0005` migráció HIÁNYZIK a mainről; `storage_read_blocked` sehol a `src/`-ben |
| 3 | Playwright compliance harness | ✅ **igen** | `tests/compliance/**` + két dátumozott baseline (`2026-08-17`, `2026-08-17-webkit-norelay`) |
| 4 | CMP build | ✅ **igen, de INERT** | `src/routes/consent.ts`, `migrations/0006_consent_log.sql`, `consent-texts/2026-08-a/{hu,en}.json` — a `consent_log` tábla **0 sor** |

### 0.3 🔴 SÉMA-DRIFT: a production D1 ELŐRÉBB van, mint a main

```
d1_migrations (production):  0001 · 0002 · 0003 · 0004 · 0005_storage_read_blocked · 0006
migrations/ a mainen:        0001 · 0002 · 0003 · 0004 ·        (0005 HIÁNYZIK)      · 0006
```

A `0005_storage_read_blocked.sql` **2026-08-17-én alkalmazva lett a production
adatbázisra**, de a fájlja csak a nyitott #61 ágon él. Következmények:

- a main friss klónjából a production séma **nem reprodukálható**;
- a `consent_receipts.storage_read_blocked` / `_keys` oszlopok LÉTEZNEK, de az
  őket író kód nincs deployolva → **1112 receiptből 1112 NULL** az elmúlt 30 napban;
- a migrációs számozásban lyuk van (0004 → 0006), amit egy jövőbeli
  `d1 migrations apply` csendben félreértelmezhet.

### 0.4 A Fázis D műszer landolt — de gyakorlatilag VAK

A brief oszlopai megvannak, a sites-oldali adaptáció nincs meg:

| Fázis D jel | Elvárt | Mért (30 nap, minden site) |
|---|---|---|
| `source_used` | `cookieyes_cookie` / `cookieyes_api` / `override` / `server_cookie` / `none` | **kizárólag `server_cookie` (43) vagy `none` (356)** — kliens-forrás EGYSZER SEM |
| `client_lib_version` | site-onkénti verzió | **NULL, mind az 1112 soron** → a TRK-910-006 (elavult kliens-lib) sosem tüzelhet |
| `source_consistent` | 0 = források ütköznek | `0` **egyszer sem**; csak `1` (43) vagy NULL |
| `finding_codes` | TRK-9xx darabszám | 30 nap alatt **2 sor** (`TRK-910-001`, painless + trapezlemezes 1-1) |

**Értelmezés:** a döntési kaput hivatott mérés nem tud dönteni, mert a
kliensek nem küldik a bemeneteit. A műszer nem hibás — nincs bekötve.

---

## 1. A kontraktus — mi a szabvány, és hol él

### 1.1 Kanonikus események (`src/events.json`, 26 db)

`events.contract.json` szándékos-szerkesztés lock őrzi (`contract_hash`), a
`soborbo-tracking/` csomag **közvetlenül ezt a fájlt** olvassa (nincs vendor-másolat).

| modul | esemény | kind | GA4 key | Meta | csatorna | `server_ingress_only` |
|---|---|---|---|---|---|---|
| leadgen | `quote_calculator_submitted` | conversion | ✅ | Lead | browser+server | ✅ |
| leadgen | `callback_request_submitted` | conversion | ✅ | Lead | browser+server | ✅ |
| leadgen | `contact_form_submitted` | conversion | ✅ | Contact | browser+server | ✅ |
| leadgen | `phone_number_clicked` | conversion | ✅ | Contact | browser+server | — |
| leadgen | `email_address_clicked` | conversion | ✅ | Contact | browser+server | — |
| leadgen | `whatsapp_button_clicked` | conversion | ✅ | Contact | browser+server | — |
| ecommerce | `view_item`, `add_to_cart`, `add_payment_info` | ecommerce | — | ViewContent / AddToCart / AddPaymentInfo | browser | — |
| ecommerce | `begin_checkout` | ecommerce | — | InitiateCheckout | browser+server | — |
| ecommerce | `order_request_submitted` | conversion | ✅ | Lead | browser+server | ✅ |
| ecommerce | `purchase` | conversion | ✅ | Purchase | browser+server | ✅ |
| leadgen/core | `quote_email_return`, `quote_calculator_opened`, `quote_calculator_step_completed`, `quote_calculator_option_selected`, `form_abandoned`, `scroll_depth`, `video_play` | engagement | — | részben ViewContent | browser (+`video_play` server is) | — |
| crm | `lead_validated`, `lead_qualified`, `quote_sent`, `booking_confirmed`, `job_completed`, `revenue_confirmed`, `lead_disqualified` | offline | részben ✅ | — | server | — |

### 1.2 Alias-térkép (`soborbo-tracking/event-aliases.json`, 14 db — GENERÁLT)

`quote_calculator_conversion`·`calculator_complete` → `quote_calculator_submitted` ·
`callback_conversion`·`callback_click` → `callback_request_submitted` ·
`contact_form_submit`·`contact_submit` → `contact_form_submitted` ·
`phone_conversion`·`phone_click` → `phone_number_clicked` ·
`email_conversion`·`email_click` → `email_address_clicked` ·
`whatsapp_conversion`·`whatsapp_click` → `whatsapp_button_clicked` ·
`booking_click` → `begin_checkout` · `quote_calculator_first_view` → `quote_calculator_opened`

A `cutover_date` **`null`** — egyetlen site-ra sincs beállítva, tehát riporting
szinten sehol nincs kijelölve, hol állnak le a legacy nevek.

A gateway az ingressen **normalizál** (`canonicalizeEventName`), tehát a legacy
néven érkező event kanonikus néven kerül a ledgerbe.

### 1.3 ⚠️ Architektúra-tény, ami a hipotézis megítélését eldönti: „Modell 2"

`src/routes/conversion.ts:16-19, 915-916` — **az on-site fan-outból a GA4 ÉS a
Google Ads láb ki van véve.** A böngésző-út platformjai: `meta`, `tiktok`,
`linkedin`, `msads`. A Google Ads a szerverről **kizárólag offline-ként** megy
(`src/routes/lead-status.ts` → Data Manager API).

Ebből következik, hogy **egy űrlapbeküldésből a gateway soha nem csinál Google
Ads konverziót.** A Google Ads on-site konverzió a böngésző GTM-lábának (AWCT +
Enhanced Conversions) a dolga. Ezt a ledger igazolja: `gads` platformú sor
30 napban csak `beautyflow`-nál (21) és `trapezlemezes`-nél (12) van, és
mindkettő **CRM-lifecycle** eseményre (`revenue_confirmed`, `booking_confirmed`).

### 1.4 Kötelező payload-alak (`src/types.ts:231` `isValidConversionPayload`)

| mező | kötelező | szabály |
|---|---|---|
| `event_name` | ✅ | benne kell legyen az `ALLOWED_EVENT_NAMES`-ben (kanonikus **vagy** alias) |
| `event_id` | ✅ | `[A-Za-z0-9_-]+`, 1…40 char |
| `event_time` | ✅ | **Unix másodperc**, `MIN_EVENT_TIME` … `now+600` |
| `value` | — | ha jelen: szám ≥ 0; `currency` kötelező mellé |
| `client_ip_address` / `client_user_agent` / `test_event_code` | — | **csak szerver-ingressen** érvényesül, böngésző-ágon eldobva |
| `lead_id`, `lead_provenance`, `client_id`, `session_id` | — | hibás formátum → **mező eldobva, az event MEGY** (drop-not-reject) |

Kapuk: a `server_ingress_only: true` események böngésző-úton **403 / TRK-400-017**;
a szerver-ingress per-site tokent kíván (`X-Admin-Token` ↔ KV `crm_token_sha256`).

---

## 2. Flotta-konformancia mátrix

### 2.1 Bérlők (KV `SITE_CONFIG`, `edd34e28…`)

9 kulcs-pár (site + `www.`) + a `event-gateway.golaxo.workers.dev` debug-host.
**A `femkeriteslec.hu` NEM bérlő** — nincs KV-configja, nincs route-ja.
~~A `trapezlemezes.hu` hiányzik a `src/site-manifest.json`-ból~~ — **KORREKCIÓ
(2026-08-24 esti ellenőrzés):** a manifest a `ba01d86` (2026-08-16) óta
TARTALMAZZA a `trapezlemezes.hu` + `www.` kulcsokat; az állítás a 08-17-i
compliance-riport elavult site-listájából öröklődött. A P2-2.4/P5-ös teendő
okafogyott.

| site | site_id | meta | gads.customer_id | gads.conversion_actions | require_consent | expected_platforms |
|---|---|---|---|---|---|---|
| painlessremovals.com | painless | ✅ | 4886655031 | **5 db** | ✅ | smoke:meta, offline:gads |
| beautyflow.pro | beautyflow | ✅ | 9796138635 | **4 db** | ✅ | smoke:meta, offline:gads |
| lomtalan.hu | lomtalan | ✅ | 6763949425 | **5 db** | ✅ | smoke:meta, offline:gads |
| trapezlemezes.hu | trapezlemezes | ✅ | 3415114700 (+MCC 3063851682) | **2 db** | ✅ | smoke:meta, offline:gads |
| olcsokontenerhaz.hu | olcsokontenerhaz | ✅ | 6797699997 | 🔴 **HIÁNYZIK** | ✅ | smoke:meta, **offline:gads** |
| skinlabhungary.hu | skinlab | ✅ | 1892748552 | 🔴 **HIÁNYZIK** | ✅ | smoke:meta, **offline:gads** |
| szelloztessokosan.hu | szelloztetes | ✅ | 5475295678 | 🔴 **HIÁNYZIK** | ✅ | smoke:meta, **offline:gads** |
| agykontroll.co.uk | agykontroll | ✅ | `null` | — | ✅ | smoke:meta |

> Az `expected_platforms.offline: ["gads"]` + hiányzó `conversion_actions`
> kombináció **beépített hazugság**: a site VÁRJA az offline gads-lábat, a config
> pedig nem tudja kiszolgálni. A `lead-status.ts:474` ezt `PLATFORM_NOT_CONFIGURED`-del
> jelzi — de csak akkor, ha a CRM egyáltalán hív. Három site-nál sosem hívott.

### 2.2 Kliens-integráció generációja

| site | generáció | bizonyíték |
|---|---|---|
| painless | **kanonikus csomag** | `src/lib/tracking/{gateway-dispatch,worker-dispatch,smoke}.ts`, `sb_tracking` |
| lomtalan | **kanonikus csomag** | `src/lib/tracking/{gateway,index,persistence,smoke}.ts`, `soborbo-tracking` ×2 |
| olcsokontenerhaz | **kanonikus csomag** | `src/lib/{gateway,events,event-contract,index}.ts`, `soborbo-tracking` ×4 |
| skinlab | **kanonikus csomag** | `sb_tracking` ×6, `soborbo-tracking` ×4 |
| beautyflow | **vendorolt `tracking-kit/`** (a csomag RÉGI másolata) | `tracking-kit/{lib,server,tests,gtm}` — a 2026-07-21-i beolvasztás ELŐTTI állapot; `tracking-beacon` maradvány + Zaraz ×4 |
| trapezlemezes | **csak szerver-ingress** | 1 fájl érinti a gateway-t; böngésző-láb nincs bekötve |
| agykontroll | **kézzel írt** | `src/lib/{tracking,gateway-dispatch}.ts` — nem a csomag |
| szelloztessokosan | 🔴 **pre-gateway „zero-cost" minta** | Zaraz ×2 + `tracking-beacon`; `api/event/*` hívás **0 fájl** |
| femkeriteslec | 🔴 **nincs** | Zaraz ×2; sem csomag, sem gateway-hívás, sem bérlő |

### 2.3 Emitált nevek vs. kontraktus

**A ledgerbe érkező MINDEN esemény kanonikus.** 30 nap, 7 site, 29 (site, event_name)
pár — **nulla ismeretlen név**, nulla `TRK-EVT-001`. Ez a hipotézis szempontjából
a legfontosabb egyetlen tény.

| site | ledger event-nevek (30 nap) | repo-beli nem-kanonikus nevek |
|---|---|---|
| painless | `quote_calculator_submitted` 224 · `callback_request_submitted` 60 · `contact_form_submitted` 45 · `phone_number_clicked` 28 · `email_address_clicked` 22 · `whatsapp_button_clicked` 7 | legacy aliasok jelen (GTM/GA4 oldal) |
| trapezlemezes | `quote_calculator_submitted` 690 · `callback_request_submitted` 71 · `order_request_submitted` 23 · `booking_confirmed` 12 · `contact_form_submitted` 9 | — (a szerver-láb tiszta) |
| olcsokontenerhaz | `quote_calculator_submitted` 122 · `phone_number_clicked` 27 · `callback_request_submitted` 22 · `email_address_clicked` 4 · `contact_form_submitted` 2 | `guide_requested` (dataLayer-only) |
| beautyflow | `begin_checkout` 58 · `quote_calculator_submitted` 50 · `contact_form_submitted` 31 · `revenue_confirmed` 21 · `phone_number_clicked` 8 | **legacy dominancia a repóban**: `contact_form_submit` 17 fájl, `phone_conversion` 12, `callback_conversion` 9, `booking_click` 6 |
| skinlab | `contact_form_submitted` 40 · `quote_calculator_submitted` 20 · `phone_number_clicked` 20 · `order_request_submitted` 14 · `email_address_clicked` 2 | elszórt aliasok (3 fájl) |
| lomtalan | `quote_calculator_submitted` 76 · `contact_form_submitted` 31 | 1 alias-fájl |
| agykontroll | `begin_checkout` 80 | — (teljesen kanonikus névkészlet a repóban) |
| szelloztessokosan | 🔴 **nincs egyetlen sor sem, soha** | csak `video_play` |

### 2.4 🔴 A VALÓDI névkáosz a GA4/GTM oldalon van, nem a gateway felé

| site | GA4-ben tüzelő nevek (14 nap) | kontraktus-státusz |
|---|---|---|
| **trapezlemezes** | `primary_conversion_complete` 839 (**key**) · `primary_first_view` 309 · `visszahivast_kert` 93 · `phone_conversion` 129 (key) · `callback_conversion` 47 (key) · `email_conversion` 4 (key) · `contact_form_submit` 1 (key) · `scroll_50`/`scroll_90` · `ads_conversion_Submit_lead_form_Page_l_1` | `primary_conversion_complete`, `primary_first_view`, `visszahivast_kert`, `scroll_50/90` — **SEM kanonikus, SEM alias**. `visszahivast_kert` W1-ben még key event volt (34), W2-ben már nem (0), de **tüzel tovább** (47/hét) |
| **painless** | `quote_calculator_complete` 28 (**key**) · `quote_calculator_conversion` 27 · `quote_calculator_complete_server` 36 · `contact_form_conversion` 3 · `form_step_complete` 526 · `form_abandonment` 44 · `video_start/progress/complete` · `attribution_selected/skipped` | `quote_calculator_complete`, `…_complete_server`, `contact_form_conversion`, `form_step_complete`, `form_abandonment` — **nem kanonikus, nem alias** |
| **beautyflow** | `booking_click` 42 (**key**) · `generate_lead` 3 (key) · `phone_click` 3 (key) · `calculator_complete` 3 · `calculator_step` 18 · `calculator_option` 11 · `newsletter_signup` 2 | `generate_lead`, `calculator_step`, `calculator_option`, `newsletter_signup` — nem kanonikus, nem alias |
| **olcsokontenerhaz** | `quote_calculator_submitted` (key) · `callback_request_submitted` (key) · `phone_number_clicked` · `email_address_clicked` · `contact_form_submitted` · `quote_calculator_*` | ✅ **teljesen kanonikus** |
| **lomtalan** | `quote_calculator_submitted` 7 · `phone_number_clicked` 6 | ✅ kanonikus, de **`keyEvents = 0` MINDENEN** |

### 2.5 Consent-forrás, betöltési sorrend, GTM-út

Minden site CMP-je **CookieYes**. Minden site-nál a saját snippet sorrendje
helyes a kiszolgált HTML-ben (`cookieyes` → `dataLayer` init → `gtag('consent','default', …denied…, wait_for_update:2000)` → GTM loader).

| site | GTM | Google tag gateway (first-party út) | GA4 | valós sorrend |
|---|---|---|---|---|
| painless | GTM-PXTH5JJK | `/f807/…` | G-05GFQ1XQFH | GTM a döntés ELŐTT tölt (advanced CM) |
| lomtalan | GTM-P5D2P8RT | `/meres/…` | G-68EJ2V86V6 | ua. |
| beautyflow | GTM-W8V3BVGD | `/i9xo/…` | G-774BY4X64P | ua. |
| skinlab | GTM-NW7DKC2D | `/meres/…` | G-ZBFGRNKE3Y | ua. |
| szelloztessokosan | GTM-KWDMHGBX | `/fdok/…` | — | ua. |
| **olcsokontenerhaz** | GTM-5DQH5CD5 | `/analitika/…` | G-XN8XP3YZ63 | 🔴 **lásd lent** |
| trapezlemezes | GTM-MPGKFHFX | `/iddq/…` | G-5M0YZ8WPPK | ua. |
| agykontroll | GTM-PQFHHCQ | nincs (direkt) | G-TTZEYC461Q | ua. |

**olcsokontenerhaz — valós böngésző-mérés (Chromium, 2026-08-24, `?gclid=…` landolással):**

```
dataLayer sorrend:
  [1] gtm.start   (uniqueEventId 4)   ← a Cloudflare zóna-szintű gateway injektált snippetje
  [2] consent default (minden denied) ← a site SAJÁT snippetje
  [3] gtm.start   (uniqueEventId 15)  ← a site saját GTM loadere
google_tag_manager példány: 1  (GTM-5DQH5CD5)   → NINCS duplamérés
gtm.js kérés: 2  (direkt + …&gtg_health=1)
_gcl_aw cookie: GCL.1787564147.TeStClAuDeAuDiT001   ← MEGÍRVA
cookieyes-consent: advertisement:no, analytics:no   ← DÖNTÉS NÉLKÜL / ELUTASÍTVA
```

Két megállapítás, mindkettő ellentmond egy-egy korábbi feltevésnek:

1. **A curl NEM hazudik injektálás miatt** — a kiszolgált HTML tartalmazza a
   site saját GTM-snippetjét, helyes sorrendben. Az injektált snippet
   *ráadás*, és futásidőben a `gtm.start`-ot a consent-default **elé** teszi.
   Ez PECR-szempontból kifogásolható sorrend, **de nem okoz duplamérést**
   (egyetlen konténer-példány, `page_view` nem duplázódik).
2. 🔴 **A `_gcl_aw` hirdetési süti megíródik `advertisement:no` mellett.** Ez
   PECR/GDPR-kifogás — ugyanakkor **bizonyítja, hogy a klikk-azonosító
   megőrzése NEM a szűk keresztmetszet** az olcsókonténerháznál.

---

## 3. Ledger mélyellenőrzés (30 nap, 2026-07-25 … 2026-08-24)

### 3.1 Kézbesítés láb × státusz

| site | meta acc | meta rej | meta skip | gads acc | gads rej | esemény/30 nap | utolsó kézbesítés |
|---|---:|---:|---:|---:|---:|---:|---|
| trapezlemezes | 377 | 0 | 104 | 2 | 10 | 487 | 2026-08-24 09:37 |
| painless | 138 | 0 | 62 | — | — | 200 | 2026-08-24 08:53 |
| beautyflow | 111 | 0 | 9 | 4 | 17 | 124 | 2026-08-24 04:47 |
| olcsokontenerhaz | 105 | 0 | 18 | — | — | 124 | 2026-08-24 09:26 |
| skinlab | 80 | 0 | 4 | — | — | 85 | 2026-08-24 09:28 |
| lomtalan | 63 | 0 | 11 | — | — | 74 | 2026-08-24 04:43 |
| agykontroll | 17 | **43** | 5 | — | — | 24 | 2026-08-23 21:16 |
| **szelloztessokosan** | **0** | **0** | **0** | — | — | **0** | 🔴 **soha** |

A `tiktok`/`linkedin`/`msads` lábak minden site-on `skipped` (nincs konfigurálva) —
ez szándékos, nem hiba.

### 3.2 Skip-okok (`skip_reason`, Brief 1 óta perzisztálva)

| site | `consent_denied` | `consent_missing_failclosed` | `(null)` = 08-17 előtti |
|---|---:|---:|---:|
| trapezlemezes | 54 | 1 | 49 |
| painless | 13 | 1 | 48 |
| olcsokontenerhaz | 6 | — | 12 |
| beautyflow / lomtalan / skinlab / agykontroll | — | — | 9 / 11 / 4 / 5 |

**Minden megnevezett skip consent-eredetű.** Nincs `no_identifiers`, `dedup`,
`not_expected`, `eea_rule` vagy `template_guard` egyetlen site-on sem.

### 3.3 Elutasítások — a teljes lista 30 napra

| site | láb | esemény | kód | HTTP | db | ablak | üzenet |
|---|---|---|---|---|---:|---|---|
| agykontroll | meta | `begin_checkout` | `TRK-600-005` | 400 | **43** | 07-27 → **08-11** | `Object with ID '[phone]' does not exist…` |
| beautyflow | gads | `revenue_confirmed` | `TRK-800-001` | — | 15 | 08-09 | `No access token available` |
| trapezlemezes | gads | `booking_confirmed` | `TRK-840-003` | 400 | 10 | 08-11 | Data Manager `INVALID_ARGUMENT` |
| beautyflow | gads | `revenue_confirmed` | `TRK-840-001` | — | 2 | 08-14 | `timeout` |

- Az agykontroll `[phone]` maszkolása a log-sanitizer műterméke; a valódi
  vendor objektum-ID elfedését a `9dcb545` javítja — **ami NINCS a mainen**
  (a `claude/meta-capi-phone-placeholder-ipy1t2` ág nem merge-elt). Maga a
  tünet 08-11-én megszűnt, 08-14-től 17 `accepted`.
- 🟡 **A brief állítása („beautyflow gads OAuth halott 08-09 óta") ELAVULT.**
  A `TRK-800-001` sorozat 08-09-én volt; a `1b7ece1` (GADS_OAUTH_CLIENT_ID a
  `[vars]`-ba, 08-11) javította, és 08-14/08-16-án **4 `accepted`** ment ki.
  A láb él — csak alig van forgalma (a CRM ritkán hív).

### 3.4 Consent-nyugták

| site | GRANTED | DENIED | NULL | ebből `ad_allowed=1` |
|---|---:|---:|---:|---:|
| trapezlemezes | 379 | 104 | 1 | 379 |
| painless | 138 | 52 | 10 | 138 |
| beautyflow | 111 | 9 | 0 | 111 |
| **olcsokontenerhaz** | **106** | 14 | 4 | **106** |
| skinlab | 81 | 2 | 2 | 81 |
| lomtalan | 63 | 10 | 1 | 63 |
| agykontroll | 19 | 3 | 2 | 19 |

### 3.5 A Fázis D kiinduló anomáliája MEGSZŰNT

A 0004 migráció indoklása 9 olyan `skipped` sort nevezett meg, amihez GRANTED
receipt tartozott (8× lomtalan, 1× agykontroll). Az elmúlt 30 napra ugyanez a
join **0 sort ad**. A „betöltési verseny" hipotézis a **szerver oldalán nem
reprodukálódik**; a skipek ma következetesen valódi elutasításhoz tartoznak.

---

## 4. Verdikt a tulajdonosi hipotézisre

> „Minden site más időben lett vibe-kódolva, mindegyik másképp formázott
> eseményeket bocsát ki, és ezek nem illeszkednek ahhoz, amit a gateway vár —
> vagyis a site-oknak EGY API-n keresztül kellene beszélniük a szerveroldallal."

### 4.1 A hipotézis első fele — **CÁFOLVA**

- **Az egy API létezik, és a bekötött site-ok helyesen beszélik.** 30 nap
  ledgerében 29 (site, event_name) pár, **mind kanonikus**; nulla ismeretlen
  név, nulla `TRK-EVT-001`.
- **A gateway-lábak működnek.** 891 `accepted` Meta CAPI kézbesítés,
  **nulla `rejected`** 6 site-on; az egyetlen tömeges elutasítás (agykontroll,
  43) 2026-08-11-én megszűnt.
- Ahol a site nem konform (beautyflow legacy nevei), ott az ingress-normalizálás
  **elnyeli a különbséget** — a ledger kanonikus nevet lát.

### 4.2 A hipotézis második fele — **PONTOSÍTVA, nem cáfolva**

A vibe-kódolt szétcsúszás **valós**, csak nem ott, ahol a hipotézis keresi:
nem a site → gateway úton, hanem a **site → GTM/GA4/Google Ads** úton, ahol
nincs kikényszerített kontraktus. Négy külön szótár él párhuzamosan
(kanonikus · alias · `primary_conversion_complete`-féle bespoke · GA4 ajánlott
nevek), és a kontraktus-őr (`check-event-contract.mjs`) ezt **nem látja**,
mert csak a repo két oldalát hasonlítja, a GTM-konténert és a GA4 propertyt nem.

### 4.3 A tényleges hibaarány, mértékkel

| ok-kategória | érintett site-ok | súly |
|---|---|---|
| **(a) hiányzó szabvány** | — | **0 %** — a szabvány létezik, verziózott, lockolt |
| **(b) szabvány van, a site nem konform** | szelloztessokosan (bekötetlen), femkeriteslec (bekötetlen), beautyflow (legacy csomag-másolat), trapezlemezes (böngésző-láb hiányzik) | **~35 %** |
| **(c) hibás gateway-láb** | agykontroll (Meta, javítva 08-11); beautyflow gads OAuth (javítva 08-11) | **~10 %**, és mindkettő már lezárt |
| **(d) a gateway HATÁSKÖRÉN KÍVÜLI Google-oldali konfiguráció** | olcsokontenerhaz, lomtalan, skinlab, trapezlemezes, painless | **~55 %** |

A (d) az, amit a hipotézis nem tartalmazott, és ami a pénzt viszi.

### 4.4 Site-onkénti besorolás

| site | besorolás | indoklás | a javítás GAZDÁJA |
|---|---|---|---|
| **painless** | 🟢 **egészséges** | 200 esemény, 138 Meta accepted, 4 Ads konverzió-akció tüzel (22 konverzió/30 nap) | — (kivéve a GA4 névduplikációt, lásd §5 P4) |
| **lomtalan** | 🟡 **részben egészséges** | Meta 63 accepted; Ads 38,5 konverzió **böngészőből** (8 360 000 Ft érték). De **GA4 `keyEvents = 0` mindenen** → a GA4-alapú riporting és minden GA4-import vak | **site-repo + GA4 admin** |
| **beautyflow** | 🟡 **nem-konform kliens** | vendorolt, elavult `tracking-kit/`; legacy névkészlet; Ads a GA4-importon keresztül számol (`booking_click`, `generate_lead`, `phone_click`). A gads-láb ÉL (4 accepted) | **site-repo** |
| **trapezlemezes** | 🟡 **fél-bekötött + szótárhasadás** | szerver-ingress kifogástalan (377 Meta accepted, 487 esemény); böngésző-láb NINCS bekötve; a GA4 saját, kontraktuson kívüli szótárat használ (`primary_conversion_complete`, `visszahivast_kert`); hiányzik a `site-manifest.json`-ból | **site-repo + GTM/GA4** (a manifest a gateway-é) |
| **olcsokontenerhaz** | 🔴 **hibás Google-oldali kézbesítés** | **a legkonformabb kliens a flottában** (25/26 kanonikus név, teljes GTM-készlet), mégis 526 klikk / **0 Ads konverzió**. Részletes okfejtés lent | **site-repo + Google Ads** |
| **skinlab** | 🔴 **regresszió 08-17-én** | GA4 `keyEvents` 62/nap → **0** 08-17-től (08-24-én 7 tér vissza); az eseményszám 1649 → ~170/nap; a gateway-láb közben ÉL (80 Meta accepted). Ads: csak `view_item` import (8) | **site-repo (deploy-regresszió)** |
| **agykontroll** | 🟢 **javítva, ellenőrizendő** | 43 Meta `TRK-600-005` 08-11-ig, azóta 17 accepted. `gads.customer_id = null` → nincs Ads-láb egyáltalán | **gateway (log-sanitizer PR merge-elése)** |
| **szelloztessokosan** | 🔴 **bekötetlen** | KV-config + route + Meta pixel megvan; a site-kód **pre-gateway Zaraz-minta**, `api/event/*` hívás nulla fájlban; ledger 0 sor, Ads 0 konverzió | **site-repo** |
| **femkeriteslec** | ⚪ **nem bérlő** | nincs KV-config, nincs route, nincs kliens | döntés kérdése |

### 4.5 olcsokontenerhaz — a legfontosabb egyedi eset, lépésről lépésre

A tünet: **526 fizetett klikk / 0 Google Ads konverzió** (2 hét), és a
javítások (2026-08-16) óta további **343 klikk / 0 konverzió** (08-16 … 08-24).

Amit a mérés KIZÁR:

| kizárt ok | bizonyíték |
|---|---|
| rossz eseménynevek | 25/26 kanonikus név a repóban; a ledger 5 kanonikus nevet lát |
| a gateway nem kézbesít | 105 Meta `accepted`, 0 `rejected` |
| nincs consent | **106 receipt `ad_storage=GRANTED`, `ad_allowed=1`** |
| hiányzó klikk-azonosító | `_gcl_aw` **megíródik** a landoláskor (valós böngésző-mérés) |
| hiányzó GTM-tag | a konténerben ott van a `Google Ads - Conversion (Lead)` (awct, trigger 37/38/39) és a `(Phone)` (trigger 40), `orderId={{DLV - event_id}}`, EC user_data-val |
| publikálatlan workspace | `getStatus` üres → a workspace = az élő verzió |
| rossz konverziós label | a GTM-konstansok (`rVupCKyRl-0ZEIiL48U-`, `rllpCKzn9qkaEIiL48U-`) **pontosan egyeznek** az ENABLED akciók snippetjeivel (`AW-16789325192`) |
| rossz Ads-fiók | `conversionTrackingId = 16789325192` = ugyanez a fiók |

Ami MARAD (rangsorolva, ellenőrzendő — **nem javítottuk**):

1. **A kliens KÉTSZER kapuz consentre.** A `src/lib/events.ts` minden
   `dataLayer.push`-t saját `hasAnalyticsConsent()` / `hasMarketingConsent()`
   olvasás mögé tesz, *ráadásul* a GTM-tagek is `consentStatus: needed`
   kapuval mennek. Ha a kliens consent-olvasása téved vagy versenyez a
   CookieYes betöltésével, a **push meg sem történik** → a tag nem tüzel →
   0 Ads konverzió — **miközben a szerver-ingress GRANTED-et lát és rögzít**.
   Ez pontosan az a jelenség, amit a Fázis D mérni akart, és amit a
   `client_lib_version` / `source_used` hiánya miatt nem tud.
2. A GA4-importált akciók (`…quote_calculator_submitted`,
   `…callback_request_submitted`) `status: HIDDEN` → ha az AWCT-út bukik,
   nincs másodlagos út sem.
3. A site saját 2026-08-16-i auditja (`docs/manual-steps.md` §5) nyitva hagyta
   a kérdést, hogy a `gclid`-strip volt-e a teljes magyarázat, és rögzítette a
   döntési szabályt: *„ha a konverziók visszatérnek, a gclid-strip volt a teljes
   magyarázat; ha nem, a v12-es consent-gating irányában kell tovább ásni."*
   **A mérésünk eldönti: nem tértek vissza (343 klikk, 0 konverzió a javítás
   után) → a consent-gating irány a helyes.**

---

## 5. Rangsorolt teendőlista

Minden tétel gazdával és a hozzá tartozó bizonyítékkal. **A gateway kontraktusán
nem javasolunk változtatást** — a mérés szerint az a rendszer működő része.

### P1 — pénzt veszít MOST

| # | teendő | gazda | bizonyíték |
|---|---|---|---|
| 1.1 | **olcsokontenerhaz:** a kliens kettős consent-kapujának feloldása — a `dataLayer.push` menjen feltétel nélkül, a kapuzás maradjon a GTM `consentStatus: needed`-en (egy döntési pont, nem kettő) | **site-repo** (`olcsokontenerhaz/src/lib/events.ts`) | §4.5; 106 GRANTED receipt vs 0 Ads konverzió |
| 1.2 | **skinlab:** a 2026-08-17-i deploy-regresszió felderítése — `keyEvents` 62→0, eseményszám 1649→170/nap | **site-repo** | §4.4; GA4 napi bontás |
| 1.3 | **lomtalan:** GA4 kulcsesemények bejelölése (`quote_calculator_submitted`, `contact_form_submitted`, `phone_number_clicked`) | **GA4 admin** | property 270977444: `keyEvents = 0` mindenen |
| 1.4 | **szelloztessokosan:** a site bekötése a kanonikus csomagra (ma pre-gateway Zaraz-minta) | **site-repo** | ledger: 0 sor valaha |

### P2 — csendes hiba, ma nem visz pénzt, holnap igen

| # | teendő | gazda | bizonyíték |
|---|---|---|---|
| 2.1 | **`0005_storage_read_blocked.sql` felvétele a mainre** (PR #61 merge-elése vagy a migráció kiemelése) — a production séma ELŐRÉBB van a repónál | **gateway** | §0.3; `d1_migrations` id=5 applied 2026-08-17 |
| 2.2 | A Fázis D bemeneteinek bekötése a kliensekbe: `client_lib_version` + kliens-oldali consent-forrás (`cookieyes_cookie`/`cookieyes_api`) küldése | **site-repók** (mind) | §0.4; 1112 sor, 0 kliens-forrás, 0 lib-verzió |
| 2.3 | A `claude/meta-capi-phone-placeholder-ipy1t2` ág merge-elése (log-sanitizer elfedi a vendor objektum-ID-t → az agykontroll 43 elutasítása diagnosztizálhatatlan volt) | **gateway** | §3.3 |
| 2.4 | `trapezlemezes.hu` felvétele a `src/site-manifest.json`-ba | **gateway** | §2.1; a compliance-riport is jelzi |
| 2.5 | Az `expected_platforms.offline: ["gads"]` és a hiányzó `gads.conversion_actions` ellentmondásának feloldása (olcso, skinlab, szello) — vagy akciók, vagy az elvárás levétele | **gateway KV** | §2.1 |

### P3 — a mérés hitelessége

| # | teendő | gazda | bizonyíték |
|---|---|---|---|
| 3.1 | A compliance-baseline megismétlése **HU/UK kilépőpontról és Chromiumon** — a meglévő baseline US IP-ről, csak WebKiten futott, és a saját fejléce szerint 17 ✅ nem bizonyíték | **gateway** | `tests/compliance/reports/2026-08-17-webkit-norelay/report.md` |
| 3.2 | A kontraktus-őr kiterjesztése a GTM-konténerre és a GA4 kulcsesemény-készletre (ma csak a repo két oldalát hasonlítja) | **gateway** | §4.2 |
| 3.3 | `event-aliases.json` `cutover_date` beállítása **site-onként** — ma mind `null` | **gateway** | §1.2 |

### P4 — riporting-integritás (egy kanonikus mérőszám)

| # | teendő | gazda | bizonyíték |
|---|---|---|---|
| 4.1 | **painless:** `quote_calculator_complete` (28, key) + `quote_calculator_conversion` (27, alias) + `quote_calculator_complete_server` (36) — nagy valószínűséggel **ugyanaz a konverzió három néven**. Alias-döntés kell, mielőtt bárki összeadja | **site-repo + GTM** | §2.4 |
| 4.2 | **trapezlemezes:** `primary_conversion_complete` (839) és `visszahivast_kert` (93) — sem kanonikus, sem alias. Vagy alias-bejegyzés, vagy átnevezés; addig **tilos** a ledger `quote_calculator_submitted`/`callback_request_submitted` mellé adni | **site-repo + GTM** | §2.4 |
| 4.3 | **beautyflow:** `generate_lead`, `calculator_step`, `calculator_option`, `newsletter_signup` besorolása | **site-repo + GTM** | §2.4 |

### P5 — megfelelőség és higiénia

| # | teendő | gazda | bizonyíték |
|---|---|---|---|
| 5.1 | 🔴 A `_gcl_aw` hirdetési süti `advertisement:no` mellett íródik (olcsokontenerhaz, valós böngésző-mérés) — PECR/GDPR-kifogás | **site-repo / Cloudflare gateway-beállítás** | §2.5 |
| 5.2 | A Cloudflare zóna-szintű tag gateway a `gtm.start`-ot a consent-default ELÉ teszi. A site saját auditja szerint a kockázat nem igazolódott (1 konténer-példány, nincs duplamérés) — **döntés kell**: marad az ad-blocker-ellenállásért, vagy ki | **Cloudflare zóna** | §2.5 |
| 5.3 | A `femkeriteslec.hu` sorsa: bérlővé tenni vagy kivezetni a flotta-listákból | döntés | §2.1 |
| 5.4 | A CMP Fázis 1 inert (`consent_log` 0 sor) — dokumentálni, hogy ez szándékos-e, vagy elakadt élesítés | **gateway** | §0.2 |

---

## 6. Hiányok — amit NEM tudtunk megmérni

1. **`consent-terv-v4-vegleges.md` nincs a repóban.** Csak egy nyomon nem
   követett lokális fájl létezik `„… - ez volt az eredeti terv.md"` néven. A
   befagyasztott tervet **nem rekonstruáltuk**; a §5 lista a mérésből
   származik, nem abból a tervből.
2. **agykontroll és szelloztessokosan GA4 propertyje nem elérhető** a
   csatlakoztatott konnektorról → ezeknél a GA4-oldali állítás hiányzik.
3. **A GTM-konténereket csak az olcsokontenerhaz esetében nyitottuk ki**
   tagszinten (ott volt rá diagnosztikai ok). A többi hét konténer
   tag-készlete nincs átnézve — a §4.4 GTM-re vonatkozó állításai ott
   hálózati megfigyelésen és a repo-kódon alapulnak, nem konténer-auditon.
4. **A `beautyflow` lokális klónja egy feature-ágon áll**, az `origin/main`
   pedig 2026-07-15-ös. A §2 beautyflow-sorai az `origin/main`-ből származnak;
   ha az éles deploy egy ágról megy, az eltérhet.
5. **Az Ads költség-adatot nem értelmeztük.** Az API `costMicros=28 524 022`-t
   ad 526 klikkre az olcsokontenerhaz PMaxon; ez a fiók pénznemében nem
   plauzibilis, ezért a klikk- és konverziószámot használtuk, a költséget nem.

---

## Addendum 2026-08-24 — beautyflow felület-audit (élő böngészős mérés)

Teljes leltár: `Beautyflow_website/tracking/AUDIT-conversion-surfaces-20260824.md`.
A §4.4 beautyflow-sor kiegészítése mért tényekkel:

- **A gads-láb megerősítve élőnek e2e-ben is**: konszentelt teszt lead → GA4
  `generate_lead` (key, event_id) → GA4-import primary akciók érintetlenek; Meta
  Pixel + CAPI Lead AZONOS event_id-vel, ledger `accepted`/200. A soborbo-tracking
  szerver-oldali konverzió beautyflow-n bizonyított.
- 🔴 ÚJ: **Meta „Automatic events" duplázza a Leadet** (`es=automatic`, event_id
  nélkül, nem dedupolható) — Events Manager-oldali kikapcsolás kell.
- 🔴 ÚJ: `WhatsAppButton` árva komponens (felület nem létezik → whatsapp_click 0);
  `callback_click` GTM+Ads vezeték felület nélkül; EN szalon-oldalakon nincs
  kontakt űrlap.
- §P5-5.2-höz mért adalék: a beautyflow.pro-n a zóna-injektált GTM pre-consent
  `ccm/collect` page_view-t küld `gcd=13l3l3l3l1l1` + `npa=0` paraméterekkel
  (2026-08-24-i trace). Konténer-példány valóban egy (duplamérés nincs), de a
  consent-default-sorrend bizonyítottan sérül — a döntésnél ez is súlyozandó.
- A brief „gads OAuth halott 08-09 óta" állítását a §3 már cáfolta (javítva
  08-11); az Ads-architektúra döntés (GA4-import marad primary, offline upload
  secondary) az audit-doksi §3-ában rögzítve.

## Addendum 2026-08-24 — olcsokontenerhaz Ads-állapotváltás + döntések

A §4.5/2. pont („a GA4-importált akciók HIDDEN → nincs másodlagos út") **elavult**:
a P2-agent még aznap átállította az Ads-fiókot (API-mutate, visszaolvasva):

| akció | előtte | utána |
|---|---|---|
| 7723013941 `…quote_calculator_submitted` (GA4-import) | HIDDEN / primary=false | **ENABLED / SUBMIT_LEAD_FORM / primary=true** |
| 7722756926 `…callback_request_submitted` (GA4-import) | HIDDEN / primary=false | **ENABLED / SUBMIT_LEAD_FORM / primary=true** |
| 6939855020 legacy WEBPAGE | primary=true | **primary=false / include=false** |

Dupla-count nincs (a legacy egyazon mutate-ban lefokozva). Indok: a GA4-tag
analytics consenttel tüzel, az AWCT-tag `ad_storage`+`ad_user_data`-t kíván —
a közvetlen láb 30 nap alatt 0-t rögzített, a GA4 8 nap alatt 23 kulcseseményt.

További P2-leletek (trace-doksi: `olcsokontenerhaz/docs/2026-08-24-conversion-signal-trace.md`):
- 🔴 **Turnstile-fantom:** a konverzió (dataLayer + Ads-tag + gateway-beacon) a
  beküldés *kísérletére* tüzel, nem a `/api/submit` *sikerére* — Turnstile-bukásnál
  lead nélküli konverzió keletkezik (2 fantom key event 2026-08-24-én, KV-vel
  igazoltan lead nélkül).
- A „dupla GTM" pontosítva: két loader, de EGY konténer-példány (a GTM azonos
  ID-ra összeolvaszt) → a GA4 page_view nem duplázódik; az Ads page_view igen,
  két ellentmondó consent-állapottal. A javítás a zóna-injektálás kikapcsolása,
  nem „a második konténer eltávolítása".
- A £28,52 / 526 klikk (5p CPC) költség-értelmezés a §6/5. fenntartását feloldja:
  a PMax filléres Discover-junkot vesz (64% költés, 72% klikk), ilyen forgalmon
  a 0 konverzió önmagában nem bizonyít mérési hibát.

**Döntések (Laszlo, 2026-08-24):** Tag Gateway injektálás KI, fokozatosan (először
olcso); GA4-import primary MARAD; lomtalan 3 hiányzó GTM-tag felvétele MEHET;
beautyflow árva felületek HALASZTVA. A konszolidált javítási terv fázisai a
jóváhagyott terv-fájlban; a P1.1 (olcso kettős consent-kapu átírása) a tanácsadói
felülvizsgálat nyomán **teszt-kapu mögé került**: előbb hirdetés-kattintó
szimuláció (gclid → accept → teszt-lead → AWCT tüzel? → 48h Ads), kód csak akkor,
ha a teszt bukik.
