# Fázis 0 — Production stabilizálás (push-olható munkacsomag) · v1.1

**Dátum:** 2026-07-20 · **v1.1:** külső review (ChatGPT) beépítve + replay-készlet élő D1-ből mérve
**Forrás:** SOBORBO_TRACKING_RENDSZER_AUDIT v1.0 + élő repó- és ledger-ellenőrzés
**Elv:** csak az kerül ide, ami a mostani adatvesztést állítja meg vagy a munkát menti. Semmi új architektúra.

---

## 0. Kiindulási állapot — élő D1-ből mérve (`event-gateway-ledger`)

| Mérés | Érték | Az audit állítása |
|---|---|---|
| lomtalan Meta idővonal | 07-14: 2× accepted → 07-15-től csak skipped | ✅ igazolt |
| accepted + `http_status NULL` | 3 db, mind 07-15 előtti; utána **0** | ✅ igazolt, a runtime guard él |
| undispatched / consent receipt | 0 / 62 esemény · 62 receipt | ✅ igazolt |
| `lead_status` | 7 sor, 5 upload — mind júniusi dm-validate szintetikus | valódi lead lifecycle: **nulla** |
| **Replay-készlet (07-20-i mérés)** | 9 skipped = **4 smoke + 2 consent-denied + 3 jogosult** | dry-run nélkül 6 hibás replay lett volna |
| `fix/smoke-expected-platforms` ág | ~~nincs a remote-on~~ → **07-20: pusholva + mergelve `main`-be (36ee9d9)** | ✅ elvégezve |
| deployolt CRM forrás (`tracking-worker.ts`) | ~~egyik GitHub-ágon sincs~~ → **az audit téves: benne VAN a `Soborbo/Szelloztesscrm` `origin/main`-jében** (`astro/src/lib/integrations/tracking-worker.ts`) | ❌ az audit állítása cáfolva |

**Határidő-figyelmeztetés:** a legrégebbi replay-jogosult esemény (2026-07-15 19:34) Meta 7 napos CAPI-ablaka **~07-22-én zárul** — a C blokk replay-lépése emiatt nem halasztható.

---

## A blokk — Git-mentés (ELŐSZÖR, minden más előtt)

### A-1 · Lokális javító ág pusholása
```bash
cd <lokális Serverside worktree>
git log --oneline fix/smoke-expected-platforms -5   # c4e353d és 36ee9d9 megvan-e
git push -u origin fix/smoke-expected-platforms
gh pr create --title "fix(smoke+delivery): expected platforms + accepted type guard" --base main
```
Ha az ág lokálisan sincs meg: újraimplementálás az audit 4.3–4.4 szerint (a runtime-fél, a `normalizeDelivery` guard már a mainen él — a smoke-elvárás és a típusszint hiányzik).

### A-2 · Deploy-metaadatok rögzítése (a forrás MEGVAN)

**A v1.1 állítása („a deployolt CRM forrás egyik GitHub-ágon sincs") téves — 07-20-án ellenőrizve.** A forrás a `Soborbo/Szelloztesscrm` repóban van, `astro/src/lib/integrations/tracking-worker.ts`, és **benne van az `origin/main`-ben**. A lokális `main-track` ág 6 committal *le van maradva*, pusholatlan commit nincs; egyedül az `astro/wrangler.toml` módosított a munkafájában. Tehát **nincs elveszett production forrás, és nem kell sem `git init`, sem új repó** — a korábbi döntési fa tárgytalan.

Ami valóban hiányzik: a **deployolt verzió ↔ Git commit** kapcsolat. Rögzítendő (pl. `docs/DEPLOY-STATE.md`):
```text
Worker név · deployment/version ID · deploy időpont ·
source repository (Soborbo/Szelloztesscrm) · source commit SHA ·
build command · wrangler verzió
```
**Elfogadás:** a production bundle egy konkrét, pusholt commitból reprodukálható.

---

## B blokk — Gateway-config javítások

### B-1 · `GADS_OAUTH_CLIENT_ID`
```bash
cd Serverside
npx wrangler secret put GADS_OAUTH_CLIENT_ID   # top-level, NEM --env production
```
**Elfogadás:** `/admin/health-check` a Google-ágra nem jelez hiányzó client ID-t.

### B-2 · lomtalan Meta blokk célzott visszaállítása
Pixel ID: Events Managerből. Token: ha a régi nincs jelszókezelőben → új system user token.
```bash
node scripts/patch-site-config.mjs lomtalan.hu \
  '{"meta":{"pixel_id":"<PIXEL>","access_token":"<TOKEN>"},"expected_platforms":{"smoke":["meta"]}}'
node scripts/patch-site-config.mjs www.lomtalan.hu \
  '{"meta":{"pixel_id":"<PIXEL>","access_token":"<TOKEN>"},"expected_platforms":{"smoke":["meta"]}}'
```

### B-3 · lomtalan Google OAuth refresh token
OAuth consent az `oauth-init` route-on a **6763949425** („Flóri - lomtalan.hu") accountra (a scope a #31 óta `analytics.readonly`-t is tartalmaz).

### B-4 · Offline conversion action — CSAK lifecycle-esemény, a bizonyítandó úthoz igazítva
Modell 2 szerint a gateway Google-ága **kizárólag offline lifecycle-eseményeké** (`lead_qualified`, `booking_confirmed`, `revenue_confirmed`) — browser-esemény (`quote_calculator_submitted` stb.) nem kerülhet a KV gads-mappingbe. (A kanonikus validáció a #28 óta el is dobná az on-site neveket — ez itt megerősítés, nem javítás.)

Mivel az első valódi bizonyítás a D blokkban `lead_qualified` (lásd ott), a lomtalan accountban létrehozandó action: **„Lead qualified (server)"** (UPLOAD_CLICKS típus), és ennek ID-ja kerül a KV `gads` blokkjába `patch-site-config.mjs`-sel. Booking/revenue actionök: Fázis 3.

---

## C blokk — Deploy + biztonságos replay

1. A-1 PR review → merge → deploy. (Lockfile-szabály: dependency-változásnál `npx npm@10.9.2 install`, különben a Workers Build elhasal.)
2. Kontrollált smoke mindkét lomtalan hoston.
3. **Replay — a dry-run már megvan, az eredmény kötelező szűrő:**

| Esemény (skipped, lomtalan meta) | Minősítés | Replay? |
|---|---|---|
| 4× `smoke-lomtalan-202607*` | napi szintetikus | ❌ soha |
| 07-15 19:16 · 07-19 02:51 (`ad_allowed=0`) | consent-denied | ❌ tilos |
| **07-15 19:34 · 07-18 16:40 · 07-18 20:58** (`ad_allowed=1`) | valódi quote-lead | ✅ eredeti `tracking_event_id`-val |

Állandó replay-szabály (minden jövőbeli replayre): eredeti event_id megvan + `ad_allowed=1` + nincs későbbi accepted ugyanarra az eseményre + nem szintetikus + a platform időablakán belül.

**A 3 jogosult esemény — konkrét azonosítók (D1-ből, 2026-07-20):**

| event_id | lead_id | event_time (UTC) | Meta-ablak zár |
|---|---|---|---|
| `38467d39-d9a0-4fb0-9285-c36761f2cfd3` | `780a1d0c-76d3-45fd-8f71-f047feeb2d27` | 2026-07-15 19:34:47 | **07-22 19:34** |
| `7fe88f90-5033-4742-8a77-e27ca6938720` | `8d2bd6ed-0fd4-4846-ac3b-dd46d407e44d` | 2026-07-18 16:40:34 | 07-25 16:40 |
| `44db0115-5f95-4960-a4ab-e379e8814546` | `3a521376-76c4-4f6b-bf7a-59707e4afb88` | 2026-07-18 20:58:22 | 07-25 20:58 |

Kizárva — consent-denied (`ad_allowed=0` a receiptben ÉS az `events_raw`-ban):
`a40174cb-79d4-4382-a6b7-56742fec3e3c` (07-15 19:16), `92a773dc-a746-4137-8548-0a82a725f312` (07-19 02:51).
Kizárva — szintetikus: `smoke-lomtalan-20260716` … `-20260720` (**5 db**, nem 4 — a 07-20-i azóta lefutott).

**Elfogadási query — event_id-alapú, NEM dátum+darabszám:**
```sql
SELECT event_id, event_name, status, origin, http_status, error_code, created_at
FROM deliveries
WHERE site_id = 'lomtalan'
  AND platform = 'meta'
  AND event_id IN (
    '38467d39-d9a0-4fb0-9285-c36761f2cfd3',
    '7fe88f90-5033-4742-8a77-e27ca6938720',
    '44db0115-5f95-4960-a4ab-e379e8814546'
  )
ORDER BY event_id, created_at;
```
Mindhárom event_id-nél ennek kell látszania: az eredeti `skipped` sor **és** egy új
`accepted` + `origin='retry'` + **nem NULL** `http_status` sor, azonos `event_id`-val.

Kiegészítő invariánsok (változatlanul):
```sql
SELECT COUNT(*) FROM deliveries WHERE status='accepted' AND http_status IS NULL;  -- = 3 (nem nő)
SELECT COUNT(*) FROM idempotency WHERE dispatched=0 AND do_not_replay=0;          -- = 0
```

---

### ⛔ C-3 BLOKKOLÓ — a replay a gateway adataiból NEM végrehajtható

Két egymástól független ok, mindkettő kódból igazolva:

1. **Nincs payload.** A config-hiányos skip `{success:true, skipped:true}`-t ad
   (`lib/meta.ts:77`), a fan-out pedig `if (success) return;`-gel kilép az
   `enqueueFailure` ELŐTT (`routes/conversion.ts:~692`) → a 3 esemény **soha nem
   került DLQ-ba**. Az `events_raw` csak `em_present`/`ph_present` boolean flaget
   tárol, hash-t nem. A `user_data` **sehol nincs a rendszerben**.
2. **Az idempotencia elnyelné.** Mindhárom rekord `dispatched=1`
   (a tiszta-skip fan-out is meghívja a `markDispatched`-et,
   `routes/conversion.ts:783`). A `checkIdempotency` `shouldDispatch`-e
   `!blocked && !alreadyDispatched` → egy azonos event_id-s újraküldés **204-et
   kap fan-out nélkül, csendben**.

**Következmény:** a replay egyetlen forrása a **CRM**, a fenti `lead_id`-k alapján.

### ✅ Megoldás — mindkét ág elkészült (07-20)

**(1) Gyökérok — a skip háromfelé válik** (`lib/skip-reason.ts`). Az ingress többé
nem tud csendben elveszíteni egy leadet:

| ok | ledger | DLQ | markDispatched | riasztás |
|---|---|---|---|---|
| `consent_denied` | skipped | ✗ | ✓ | — |
| `not_expected` | skipped | ✗ | ✓ | — |
| `not_configured` **elvárt** platformon | skipped + `TRK-900-008` | ✓ | ✓ *ha a DLQ-írás sikerült* | CRITICAL |

Az „elvárt-e" az `expected_platforms.smoke`-ból jön (`isExpectedPlatform`), NEM a
config meglétéből — pont a config eltűnését kell észrevennie. A `markDispatched`
szabálya változatlan és helyes: accepted VAGY terminális skip VAGY sikeresen
eltárolt retry-rekord; egyedül a „retryable hiba + DLQ-persist megbukott" esetben
marad `dispatched=0`. A retryt a DLQ birtokolja, amint a rekord bekerült.

**Tartós retry:** a konfigurációs blokk kikerüli a Queue-t (annak `max_retries`-e
és 24 órás delay-plafonja eldobná) és egyenesen R2-be megy, ahol a **7 napos**
ablak (Meta CAPI) járatja le, 24 óra helyett. A még mindig hiányzó config skipje
**nem növeli** a `retry_count`-ot — hívás nem történt, tehát kísérlet sem volt —,
így az óránkénti cron nem égeti ki a keretet a config visszaírása előtt.

**(2) A 3 történelmi event** — `scripts/recover-blocked-events.ts`. Nincs
`force_replay` / `bypass_idempotency` az ingressen; a rekord közvetlenül a DLQ-ba
kerül, az idempotencia-tábla érintetlen. A script **dry-run alapértelmezéssel**
fut, PII-t nem ír ki, a hash-t a production `lib/hash.ts`-szel készíti, és
event_idnként ellenőrzi: allowlist (kemény, 3 elemű) · nem szintetikus ·
`ad_allowed=1` **mindkét** forrásban · nincs korábbi accepted delivery · a Meta
7 napos ablakán belül · van email vagy telefon. Bemenete a CRM-ből exportált
lead-adat (a `lead_id`-k fent). Éles futás: `--execute`.

---

## D blokk — Az első VALÓDI offline konverzió: `lead_qualified`

Váltás a v1.0-hoz képest: az első bizonyítás nem a `lezart_nyert → revenue_confirmed` út, hanem **`kvalifikalt → lead_qualified`** — szemantikailag tiszta (nem nevezünk bevételnek egy nyert ügyet), a tölcsérben korábban következik be (nem kell nyert-és-fizetett ügyre várni), és az events.json szerint ez az elsődleges offline bid-optimalizációs jel.

1. **D-1 (A-2 után):** `STATUS_EVENT_MAP` bővítés a deployolt CRM forrásban: `kvalifikalt: "lead_qualified"` + CRM redeploy (immár pusholt commitból).
2. **D-2:** lead-státuszolás a CRM-napi rutinba; egy valódi lead kvalifikálása.
3. **D-3:** a `lezart_nyert → booking_confirmed` és `kifizetve → revenue_confirmed` átszemantizálás **Fázis 3** (a Painless élő „Revenue confirmed (server)" actionját addig nem bántjuk).

```sql
SELECT lead_id, status, uploaded_to_gads, gads_error_code, created_at
FROM lead_status WHERE status='lead_qualified'
  AND lead_id NOT LIKE 'smoke-%' AND lead_id NOT LIKE 'dm-validate%'
ORDER BY created_at DESC LIMIT 5;
-- elfogadás: legalább 1 sor, uploaded_to_gads=1
```
**Consent-megjegyzés:** site-capture leadeknél a #32 receipt-precedencia lefedi a CRM `marketing_consent=0`-t; a site→CRM consent-átvitel csak telefonos/manuális leadek miatt kell (P1).

---

## E blokk — Secret-higiénia

1. **E-1** Painless + Beautyflow Meta access token rotáció (`patch-site-config.mjs`-sel visszaírva).
2. **E-2** A plaintextben érintett GA4 api_secret: a GA4-ág Run 6 óta kikapcsolt, ezért **nem rotáljuk, hanem kivezetjük** — (1) visszavonás a GA4 admin felületen, (2) törlés a KV-ból, (3) törlés a site-input elvárásokból, (4) guard-teszt, hogy `ga4` blokk ne kerülhessen vissza indoklás nélkül.
3. **E-3** `prod-audit/` export alapértelmezett redaktálása + secret scanner a CI-be.

---

## Fázis 0 lezárási kritériumok

- [ ] `fix/smoke-expected-platforms` a remote-on, mergelve, deployolva
- [ ] deployolt CRM forrás pusholva **+ deploy-metaadatok rögzítve** (A-2 diagnózis-sorrenddel)
- [ ] lomtalan Meta: napi smoke accepted + HTTP-státusz mindkét hoston
- [ ] Google-ág: health check zöld (client ID + lomtalan refresh token + „Lead qualified (server)" action)
- [ ] a **3 jogosult** Meta esemény replayelve eredeti ID-val (határidő: ~07-22)
- [ ] legalább 1 valódi lead `lead_qualified`-ként feltöltve (`uploaded_to_gads=1`)
- [ ] lemezre került Meta tokenek rotálva; GA4 secret visszavonva és kivezetve

## Amit MOST NEM csinálunk

Monorepo-átszervezés, npm contract-csomagok, capability registry, kétfázisú secret-rotáció, ADR-sorozat, blanket coverage-küszöbök, operátori dashboard. Ezek a KOVETKEZO-FAZISOK-TERV v1.1 trigger-táblája szerint kerülhetnek vissza.
