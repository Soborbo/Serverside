# vNext operátori átadás — 2026-08-25

<!-- TRUTH-ANCHOR: vnext-operator-handover-2026-08-25 -->

**Ez a dokumentum azt a néhány lépést írja le, amit a felhő-ügynök NEM tudott elvégezni,
mert wrangler-hitelesítést vagy per-site titkot igényelnek.** Minden más kész és élesben van.

A dokumentum **állapot-leíró, nem terv**: amit „KÉSZ"-nek jelöl, az ellenőrzött tény,
a hivatkozott parancsokkal újramérhető.

---

## 1. Ami KÉSZ és élesben van (nem kell megismételni)

| tétel | bizonyíték |
|---|---|
| Serverside `main` = `e37b5c3` (PR #72 merge) | `git rev-parse origin/main` |
| A gateway **deployolva** erre a commitra | `GET /api/event/version` → `build_commit: e37b5c3…`, `build_dirty: false`, `built_at: 2026-08-25T07:40:14Z` |
| `0007_business_counts.sql` élesen | `d1_migrations` id=7, `applied_at 2026-08-25 06:45:55` |
| `0008_business_count_snapshots.sql` élesen | `d1_migrations` id=8, `applied_at 2026-08-25 07:40:36` |
| CRM `main` = `474fe1a` (PR #96 merge) | `git rev-parse origin/main` a soborbo-crm repóban |

A gateway azért ment ki magától, mert Workers Builds git-integráció figyeli a `main`-t.
**A CRM-nek nincs deploy workflow-ja** (csak `ci.yml`), ezért az kézi deployt igényel — lásd §3.

### Ellenőrző parancsok

```bash
# gateway build-bélyeg (publikus, nem kell token)
curl -s https://painlessremovals.com/api/event/version

# D1 migrációk (wrangler-rel, ha be vagy jelentkezve)
npx wrangler d1 execute event-gateway-ledger --remote \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
```

D1 database: `event-gateway-ledger` / `8c7774d1-2eea-40ba-b99c-92e73055460f`.

---

## 2. Ami ebben a körben javult (kontextus a következő olvasónak)

Öt hiba, mind ugyanabba az osztályba tartozik: *a mérőréteg látszólag fut, közben vagy
sosem fejeződik be, vagy szintetikus adaton ad zöldet.*

1. **Végtelen ciklus a SITE_CONFIG-felsorolóban** (`countSiteConfigs`,
   `listMonitoredSiteConfigsWithCompleteness`, `collectManifestDrift`). A `for(;;)`
   `list_complete: false`-nál a `page.cursor`-t vette át; cursor nélküli válasznál a
   ciklus ugyanazt a lapot kérte örökké. Workerben ez **nem kivétel**, hanem CPU-limit
   kill: a cron sosem fejeződik be, riasztás nem megy ki. Mindhárom az őrzött
   `paginateSiteConfigKeys`-re állt át (cursor-őr + lap-plafon), és a visszatérési érték
   a **teljesség** — megszakadt felsorolásból negatív következtetés (kizárás) tilos.
   Tünet volt: a #72 `typecheck + test` job 6 óra után `cancelled`. Most 26 másodperc.
2. **Lyukas szintetikus-szűrő.** A minta `lead_id NOT LIKE 'smoke-%'` volt, de az éles
   azonosítók `e2e-smoke-leadstatus-000X` és `ga4-smoke-test-001` alakúak — öt füst-teszt
   valódinak számított, és az ARMED horgony füst-teszt adaton átbillenthetett egy site-ot
   „bizonyítottan él"-be. Mostantól `%smoke%` / `%dm-validate%`, egyetlen forrásból
   (`SYNTHETIC_ID_PATTERNS`) generálva a SQL-be és a JS-szabályba.
3. **Két teszt-garancia** utód nélkül maradt a #72 összevonásakor („sosem jelentett site
   nem riaszt", „hiányzó LEDGER → `null`, nem `[]`") — visszatéve.
4. **CRM: lint-error + 3 bukó teszt.** A suite `@cloudflare/vitest-pool-workers`-ben fut,
   aminek a virtuális fájlrendszere `astro/`-ra van zárva; a cron-driver a repo
   gyökerében él. A szerződés-teszt mostantól `?raw` / `import.meta.glob` build-idejű
   inline-olással olvas.
5. **A CRM ts2339 „kézenfekvő" javítása néma no-op lett volna.** A
   `buildLifecycleTracking` egy beágyazott `input.clickIds = {…}` objektumot állított be.
   A `clickIds?: {…}` mező felvétele a típusra **lefordult volna**, de a
   `buildOutboxInsert` a **top-level** `input.gclid`-et olvassa — a click ID-k sosem
   érték volna el az immutable snapshotot. A hozzárendelés ezért a top-level mezőkre megy.

---

## 3. TEENDŐ — CRM deploy (wrangler-auth kell)

**Érintett kliensek: `painless` és `beautyflow`.**

> A `beautyflow` TRACKING-configja **secretként** van, nem a `clients/beautyflow.toml`-ban.
> Ezért a `TRACKING_ENABLED` grep alulmérne — az `EVENT_GATEWAY` service binding a
> megbízható jel. Ha új klienst kötsz be, ez alapján keresd, ne a `[vars]` alapján.

```bash
cd soborbo-crm
npx wrangler whoami          # előbb legyen bejelentkezve

./deploy-all.sh painless beautyflow    # CRM kód: click-ID fix + business-count sender
./deploy-cron.sh painless              # cron-driver Worker
./deploy-cron.sh beautyflow
```

Mindkét kliens `cron-driver/clients/*.toml`-ja már tartalmazza a két ütemezést
(`45 7 * * *` és `5 8 * * *`), és a driver route-olja őket a
`/api/cron/tracking-business-counts`-ra — ezt strukturális teszt őrzi
(`astro/test/tracking/business-counts-cron-contract.test.ts`).

**Sorrend számít:** a két cron 07:45 és 08:05 UTC-kor fut, a gateway reconciliation
08:15 GMT-kor. Ha a deploy 07:45 után történik, a mai snapshot kimarad — az nem hiba,
csak egy nappal később lesz adat.

**Titkok** (nem ebben a repóban, a Workereken ülnek):
- `TRACKING_ADMIN_TOKEN` a CRM Workeren — a gateway per-site `crm_token_sha256`-jához tartozó plaintext
- `CRON_SECRET` a cron-driver Workeren — egyeznie kell a CRM ugyanezen titkával, különben
  a `checkCronAuth` minden hívást elutasít és a sorok némán pending-ben maradnak

---

## 4. TEENDŐ — `/api/event/business-counts` kézi proof (per-site token kell)

```bash
curl -i -X POST https://painlessremovals.com/api/event/business-counts \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Token: $TRACKING_ADMIN_TOKEN" \
  -d '{"date":"2026-08-24",
       "generated_at":"2026-08-25T08:00:00.000Z",
       "counts":[{"event_name":"lead_qualified","count":3}]}'
```

Várt: `200 {"ok":true,"site_id":"painless","date":"2026-08-24"}`.

**Buktatók:**

- A `generated_at` **kanonikus** ISO kell legyen, ezredmásodperccel. A validátor szabálya
  `new Date(Date.parse(v)).toISOString() === v`, tehát `"2026-08-25T08:00:00Z"`,
  `"…+00:00"` és a szóközös alak **mind 400**. A CRM sender `new Date().toISOString()`-et
  küld, ami megfelel — a két oldal szerződése ellenőrizve.
- Érvényes `event_name` (kanonikus offline lista): `lead_validated`, `lead_qualified`,
  `quote_sent`, `booking_confirmed`, `job_completed`, `revenue_confirmed`,
  `lead_disqualified`.
- `date` nem lehet jövőbeli és valós naptári nap kell legyen.
- A payload **strukturálisan** nem tartalmazhat azonosítót — csak `(event_name, count)`.

Utána ellenőrizhető:

```sql
SELECT * FROM business_counts WHERE date = '2026-08-24';
SELECT * FROM business_count_snapshots WHERE date = '2026-08-24';
```

A `__report__` nevű sor a **heartbeat** (életjel, nem darabszám) — ez különbözteti meg a
„nulla esemény volt" napot a „meg sem szólalt a CRM" naptól. Sosem termel driftet.

---

## 5. TEENDŐ — éles Google offline conversion proof

Ez a lánc utolsó, még nem teljesült bizonyítéka.

**Jelenlegi állapot (2026-08-25-i lekérdezés):** egyetlen valóban valódi offline gads
`accepted` + nem-NULL `http_status` sor létezik —
`b8f619a5-c3f5-4908-8e81-59fdb2664a2d` / `beautyflow` / `revenue_confirmed` / `200` /
`2026-08-16`. **Click ID nélkül**, mert jóval a most mergelt CRM click-ID fix előtti.

```sql
-- valódi (nem szintetikus) offline gads kézbesítések
SELECT lead_id, site_id, event_name, status, http_status, created_at
FROM deliveries
WHERE origin='offline' AND platform='gads'
  AND lead_id NOT LIKE '%smoke%' AND lead_id NOT LIKE '%dm-validate%'
ORDER BY created_at DESC;
```

A teljes proofhoz kell:
1. **`GADS_OAUTH_CLIENT_SECRET`** worker-secret megléte (a `GADS_OAUTH_CLIENT_ID` már a
   `wrangler.toml [vars]`-ban van — lásd `docs/gads-oauth-repair-runbook.md`).
2. Egy **új, valódi lead** a CRM deploy UTÁN, gclid/gbraid/wbraid-es beérkezéssel.
3. Lifecycle-státuszátmenet → `/lead-status` → Data Manager → `accepted` + nem-NULL
   `http_status`.
4. A click ID jelenléte a CRM `crm_tracking_events` snapshotjában — **a gateway
   ledgerben nem látszik**: sem a `deliveries`, sem a `lead_status`, sem az `events_raw`
   nem tárol click ID-t (az `events_raw` csak `fbc_present`/`fbp_present` flageket, azok
   Meta-oldaliak). A bizonyítékot CRM-oldalon vagy a Data Manager kérés-payloadban kell nézni.

---

## 6. TILOS ebben a körben

- **CMP pilot flip: NO-GO.** A `consent.provider: 'sbo'` átállítás egyetlen KV-flag, és
  addig nem mehet, amíg §3–§5 nincs kész.
- **`meta.test_event_code` KV-configba írása** — a config edge-cache-elt (300 s), és a
  cache-ablakban valódi konverziók mennének a Meta Test streambe. Két production leak
  történt már így.
- **Az `ADMIN_API_TOKEN` (globális) betétele a CRM-be.** A CRM per-site tokent használ;
  a globális token blast-radiusa az egész flotta.

---

## 7. Nyitott, nem-blokkoló tétel

`revenue_confirmed ≠ won` — a `VNEXT-TERV.md` P10 szakaszában rögzített HARD OPEN ITEM.
A jelenlegi egyetlen valódi offline sor éppen `revenue_confirmed`, tehát ez a
megkülönböztetés a következő körben mérendő, nem most.
