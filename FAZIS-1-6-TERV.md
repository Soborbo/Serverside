# Soborbo tracking — Fázis 1–6 megvalósítási terv · v2.0

**Dátum:** 2026-07-20 · **Felváltja:** KOVETKEZO-FAZISOK-TERV v1.1
**v2.1 (2026-07-20):** a CRM- és starter-repók **teljes felderítése átvezetve** — a Fázis 1,
3, 4A és 5 szakaszai mostantól a *tényleges* fájlnevekre, sémákra és szerződésekre
hivatkoznak. Négy terv-premissza dőlt meg (`handler.ts` nem létezik · a signed siker-ág
visszaadja az azonosítót · a közvetlen CRM→Meta út **létezik** · az outbox ráülhet egy
meglévő atomikus batch-re). **Döntés rögzítve:** a CRM-beli Meta CAPI **kivezetésre kerül**
(F3-0 „a" opció), a Fázis 0 lezárása után, külön go-ahead-del.

**v2.0:** a második külső review (ChatGPT) 8 tétele átvezetve, kódból ellenőrizve;
3 további tétel hozzávéve, 1 review-javaslat elutasítva (lásd *Review-eltérések*).

> **Őszinte keret.** Ez terv, nem működő rendszer. Az egyetlen empirikusan igazolt
> rész a Fázis 0-ban élőben mért ledger-adat és a most már zöld regressziós tesztek.
> Minden más javaslat, amíg egy valódi lead végig nem fut a láncon. A polírozott
> szerkezet ne tévesszen meg: a kód nagy része még nincs megírva.

---

## Státusz — Fázis 0 RÉSZBEN teljesítve

**A Fázis 1 csak a Fázis 0 lezárási kritériumainak teljesülése után indul.** A
„Fázis 0 kész" akkor írható ide, ha minden checkbox kipipálható.

| Fázis 0 tétel | Állapot |
|---|---|
| A-1 · `fix/smoke-expected-platforms` remote-on, mergelve | ✅ `36ee9d9` a `main`-en |
| A-2 · deployolt CRM forrás | ✅ megvan (`Soborbo/Szelloztesscrm` `origin/main`) — az audit állítása téves volt |
| A-2 · deploy-metaadatok rögzítve | ❌ |
| Gyökérok — config-hiányos skip ne legyen csendes adatvesztés | ✅ `055ea15`, 13 új teszt, suite 458 zöld — **nincs pusholva** |
| lomtalan Meta config visszaállítva (B-2) | ❌ **a recovery előfeltétele** |
| A 3 történelmi esemény visszanyerve | ❌ script kész + dry-run futtatva; CRM-export és `--execute` hátravan · **ablak: 07-22 19:34** |
| Google client ID (B-1) · lomtalan OAuth (B-3) · „Lead qualified (server)" action (B-4) | ❌ |
| Legalább 1 valódi `lead_qualified` (D) | ❌ |
| Tokenrotáció + GA4 secret kivezetés (E) | ❌ |

---

## Rögzített sorrend

```
Fázis 0   tényleges lezárás és production-bizonyítás     ← ITT TARTUNK
Fázis 1   contract-tulajdonos, webhook v2, attribution, consent, ID-modell
Fázis 2   duplikátum-irtás
Fázis 3   outbox (initial + lifecycle, immutable payload, lease)
Fázis 4A  starter bekötése a valódi tracking/CRM úthoz
Fázis 4   site-manifest + drift + build-metaadat/health
Fázis 5   determinisztikus CI + külön éles drill
Fázis 6   monorepo-migráció — KÖTELEZŐ, funkcióváltozás nélkül
```

A Fázis 1 és 2 párhuzamosítható. A **3 → 4A** a kritikus út.

---

## Fázis 1 — Szerződés-tulajdonos, webhook v2, attribution, consent

### F1-0 · A contractnak PONTOSAN egy tulajdonosa

**Döntés: a `soborbo-tracking` skill az egyetlen kanonikus otthon** — adat ÉS
validátor együtt. (Ellenőrizve: `events.json`, `repos.json`,
`server/check-event-contract.mjs` mind ott vannak.)

```
kanonikus eseménylista:  claudeskills/soborbo-tracking/events.json
kanonikus schema-verzió: ugyanott (schema_version mező)
kanonikus validátor:     claudeskills/soborbo-tracking/server/check-event-contract.mjs

fogyasztók (vendored, hash-ellenőrzött másolat):
  Serverside/src/events.json · CRM webhook-sémák · starter · GTM container snapshot
```

**Tradeoff kimondva:** a gateway a saját `events.json`-ját build-időben vendorozza a
skill *rögzített* verziójából — runtime-függőség NEM keletkezik, csak a build köt egy
pinned contract-verzióhoz. (`d:\Serverside\server\check-event-contract.mjs` ma külön
másolat — ez a Fázis 2 alatt válik vendored példánnyá.)

### F1-1 · CRM webhook response v2

> **A v1.0 premisszája téves volt** (`handler.ts` / `handler-v3.ts` **nem létezik** ebben a
> repóban — más repóra hivatkozott az audit). A valós út:
> `astro/src/lib/webhooks/signed/{route,ingest,schemas,verify}.ts`, hat vékony route-tal
> (`src/pages/api/webhooks/{quote,contact,callback,clearance-callback,affiliate,partner-register}.ts`).
> A hiba **valós, de más alakú**, és nagyobb: nem egy törött handler, hanem **három
> versengő válaszkonvenció**.

| út | siker-alak |
|---|---|
| signed webhook (6 felület) | `{ ok: true, id }` — `route.ts:135` |
| legacy `/api/webhook/lead` | `{ success: true, id }` |
| `/api/intake/submit`, `/api/chat/capture` | `{ success: true, lead_id, submission_id }` |

**Négy konkrét defektus:**

1. **A duplicate ág elejti az azonosítót** — `route.ts:103` `{ ok: true, duplicate: true }`,
   pedig az `ingest.ts:113` belül már kiszámolta a `dup.id`-t.
2. **A siker-ág eldobja az `attached` flaget.** A `SignedIngestResult` hordozza
   (`ingest.ts:45-49`), a route nem adja vissza → a hívó nem tudja, hogy a lead a 24 órás
   üzleti dedup miatt egy meglévőhöz csatolódott-e.
3. **`webhook_events` nem tárol entity_id-t** (`platform.ts:105-126`: `id, source, event_id,
   raw_payload, headers, processing_status, error_message, created_at`). Egy sikeres esemény
   újrajátszása ezért `{ok:true,duplicate:true}`-t ad **azonosító nélkül**.
4. **`webhook_events.event_id` NULLABLE**, és SQLite-ban az unique index több NULL-t is
   átenged → **`event_id` nélkül a dedup némán nem működik**.

**Teendő:** egységes siker-alak `{ ok: true, lead_id, duplicate, attached }` minden úton;
hiba-ág `{ ok: false, error_code, retryable }`; `webhook_events` + `entity_id` oszlop
(a duplicate-ág innen olvassa vissza); `event_id` kötelezővé tétele a signed úton.

*Megjegyzés a `source`-ra:* a `WEBHOOK_SOURCES` enum négyértékű (`platform.ts:13`), ezért
mind a hat painless felület `'lead'`-ként megy be, a felület csak a `headers` JSON-ban van.
Ez ma nem okoz ütközést (az `event_id` globálisan egyedi), de a dedup-kulcs olvashatóságát rontja.

**Bizonyíték:** hibateszt #1 (elveszett első válasz → retry ugyanazt a `lead_id`-t adja) és
#2 (párhuzamos duplicate → egy lead) zölden. A `test/webhooks/signed-webhooks.test.ts` már
ma tükrözi a teljes wire-contractot — ezt kell kiterjeszteni, nem nulláról írni.

### F1-2 · Lead-intake szerződés: attribution + granuláris consent

**Attribution.** A `lead_attribution` **tábla tényleg kész** (`leads.ts:103-131` — landingUrl,
referrer, utmSource/Medium/Campaign/Content/Term, gclid, gbraid, wbraid, fbclid, fbc, fbp,
msclkid). A szűk keresztmetszet feljebb van, és **a régi út bővebb, mint az új**:

| | mezők |
|---|---|
| `lead_attribution` tábla | teljes készlet ✅ |
| legacy `/api/webhook/lead` mappere | teljes készlet ✅ |
| **signed** `intakeAttributionSchema` (`schemas.ts:87-97`) | **8** — `source, heard_about, utm_source/medium/campaign, gclid, landing_page, session_id`; **fbclid nincs** |
| **signed** `ingest.ts:64-75` mapper | **6** — `landingUrl, utmSource, utmMedium, utmCampaign, gclid, fbclid` |

Teendő: a signed séma + mapper felhozása a tábla szintjére. (Az `affiliateAttributionSchema`
`fbclid`-et már ismer, és az `ingest.ts:62` `LooseAttribution` trükkje ezt kerüli meg — ez a
workaround eltűnhet.)

*Adatintegritás:* a `lead_attribution`-ön **nincs unique index a `lead_id`-n**, pedig a
doc-komment „≈1:1 lead-enként"-et ír, és a kód csak insert-el (soha nem update-el). Ha az
attribution valaha frissül, ide unique index vagy explicit upsert kell.

**Consent — nem egyetlen boolean, és HÁROMÁLLAPOTÚ:**

```
analytics_consent · advertising_consent · ad_user_data · ad_personalization ·
marketing_comms_consent · consent_source · observed_at
```

Minden consent-dimenzió értékkészlete **`GRANTED | DENIED | UNSPECIFIED`**.

> **A CRM-oldali gyökérok is megvan.** Consent-mező **kizárólag a quote felületen** létezik
> (`consentSchema`, `schemas.ts:75-78` — két boolean: `gdpr`, `marketing`). A **contact,
> callback, affiliate, partner-register** ágak **hardkódolják**:
> `consentGiven: true, marketingConsent: false` (`ingest.ts:258-259, 297-298, 334-335, 377-378`).
> Ezért az F1-2 ezen a négy felületen nem „bővítés", hanem a mező **bevezetése**.
>
> Tárolás ma háromféle, egyik sem platform-granuláris: (1) két boolean a `leads`-en
> (`consent_given`, `marketing_consent` — ez az operatív store); (2) `consent_log` append-only
> audit szabadszöveges `consent_text`-tel, `source_url` NÉLKÜL; (3) `customer_consents`
> (`customers.ts:136-152`) — az egyetlen csatorna-granuláris modell, `source_url`-lel, de
> **customer-scope-ú és egyetlen webhook-út sem írja**. A `tracking-worker.ts:76` mindezt
> egyetlen bitre présli: `ad_allowed: lead.marketingConsent === true`.

> ⚠️ **Eltérés a review-tól.** A review `UNKNOWN`-t javasolt. **Ez hiba lenne:** a
> production `ConsentSignal` típus (`src/lib/consent.ts`) már ma
> `'GRANTED' | 'DENIED' | 'UNSPECIFIED'`, a Google Consent Mode v2 szótárával
> egyezően. Egy harmadik szó bevezetése két fordítási réteget csinálna ott, ahol
> ma egy sincs — és pont a consent az a terület, ahol egy néma félrefordítás
> GDPR-kockázat. **`UNSPECIFIED` marad.**

A form adatkezelési checkboxa **nem** automatikusan Google/Meta ads-consent.

**Bizonyíték:** teszt-lead `fbclid` + `advertising_consent=GRANTED` → `lead_attribution`
sor a helyes mezőkkel; `DENIED` → a gateway ads-küldése skipel, de a lead rögzül.

### F1-3 · Négy azonosító, élesen elkülönítve

`docs/current/ID-MODEL.md`:

| azonosító | mit köt |
|---|---|
| `source_event_id` | formbeküldés idempotenciája (site backend) |
| `tracking_event_id` | browser Pixel ↔ server CAPI dedup |
| `lead_id` | CRM-rekord |
| `lifecycle_event_id` | CRM-státuszátmenet |

### F1-4 · Hash-alapú sync-guard

Minden vendored másolat mellé metaadat:

```json
{ "contract_version": "…", "contract_hash": "sha256:…", "schema_version": "…",
  "generated_at": "…", "source_repository": "Soborbo/claudeskills",
  "source_commit": "…" }
```

**A `contract_hash` determinisztikus:** kizárólag a *normalizált contracttartalomból*
képződik. NEM része `generated_at`, `source_commit`, fájlformázás, JSON-kulcssorrend.
Azonos szerződésből mindig azonos hash. (A `generated_at`/`source_commit` a metaadat
része, de nem hash-bemenet — különben minden build „driftet" jelentene.)

Háromrétegű ellenőrzés: (1) a skill-repo CI-je a saját generált fájljait; (2) a fogyasztó
CI-je a vendored tartalmat a deklarált hash ellen; (3) napi ütemezett összevetés a
repók közt a már élő digest-infrán — eltérés → CRITICAL.

---

## Fázis 2 — Duplikátum-irtás

- **F2-1 · Egy generátor.** Kanonikus: a skill `server/generate-site.mjs`-e; a
  Serverside-é törlődik. **Új guard** (mindkettőből hiányzik): meglévő KV-site esetén
  `--rotate-token` flag nélkül a generátor **megtagadja** az új token gyártását.
- **F2-2 · `Serverside/client-lib/` törlés** (elárvult másolat; README-pointer a skill libjére).
- **F2-3 · Egy onboarding skill.** Otthon: `claudeskills/soborbo-tracking`; a Serverside
  `.claude/skills/onboard-site` Run-6 tanulságai beolvadnak, a helyén 3 soros pointer.
- **F2-4 · Sprint-doksik archívba.** 11 gyökér-sprintfájl + GO-LIVE/ASTRO-FRONTEND-SPEC
  → `docs/archive/`, fejléccel: `status: archived`, `superseded_by:`, `do_not_use_for_implementation: true`.

**Bizonyíték:** repo-grep — 1 generátor, 0 client-lib, 1 onboarding SKILL.md; minden
archív fájlon fejléc; a generátor meglévő site-on rotate-flag nélkül hibázik.

---

## Fázis 3 — CRM outbox (initial + lifecycle, immutable payload, lease)

### F3-0 · A közvetlen CRM→Meta út — MEGVAN, és kivezetjük

A v1.0 „keressük meg, ha van" feladata **lezárult: van.**
`src/lib/integrations/meta-capi.ts:77` posztol a `graph.facebook.com/v21.0/{pixel}/events`-re,
`event_name: 'Purchase'`, és — ez a lényeg — **`event_id = leadId`**.

Nem maradék kód: az `offline-conversions.ts:13-17` **szándékosan** osztja szét a lábakat —
Google ECL + GA4 a Workeren át, **a Meta a CRM-ben marad**; `Promise.allSettled`,
`lead.status === 'lezart_nyert'`-re kapuzva, `lead.conversionUploadedAt`-tal idempotensen.

**A probléma:** két párhuzamos Meta-forrás él, és a CRM-oldali `event_id`-je a `leadId`, a
gateway-é a `tracking_event_id`. **A kettő soha nem dedupál egymással** — ez szemben áll a
Modell 2-vel és a CLAUDE.md §16-tal („egy konverziós eventnek EGY event_id-je van").

**Döntés: (a) kivezetés** — a Meta is a gateway-re megy, egységes `tracking_event_id`-vel,
dedupálva a böngésző-Pixellel. Feltételek, kimondva:
- **csak a Fázis 0 lezárása és egy működő `lead_qualified` UTÁN** — előtte nem nyúlunk a
  Painless élő Purchase-konverzióihoz;
- az átállás **külön go-ahead**, saját ellenőrzési ablakkal (nem eshet ki nap);
- amíg tart, a `conversionUploadedAt` idempotencia-kapu marad a duplázás ellen.

Emellett marad: `TRACKING_WORKER_URL` + token env jelenlét-ellenőrzés.

### F3-A · Outbox: EGY tábla, ÁLTALÁNOS ID-modellel

> **Javítva a review nyomán.** A korábbi séma `lifecycle_event_id TEXT NOT NULL UNIQUE`-ot
> írt elő minden sorra — de a kezdeti `contact_form_submitted` / `quote_calculator_submitted`
> **nem lifecycle-esemény**, így nem tudna bekerülni ugyanabba a táblába. Az outbox
> saját, általános kulcsot kap; a kezdeti és a lifecycle azonosító külön, **opcionális** mező.

```sql
CREATE TABLE crm_tracking_events (
  id                 TEXT PRIMARY KEY,
  outbox_event_id    TEXT NOT NULL UNIQUE,

  source_event_id    TEXT,          -- formbeküldés idempotenciája
  tracking_event_id  TEXT,          -- Pixel ↔ CAPI dedup (kezdeti konverzió)
  lifecycle_event_id TEXT,          -- CRM-státuszátmenet (ULID)
  lead_id            TEXT NOT NULL,

  event_kind         TEXT NOT NULL, -- initial_conversion | lifecycle
  event_name         TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,

  -- immutable, létrejöttkor rögzített (NYERS PII SOHA):
  email_sha256       TEXT,
  phone_sha256       TEXT,
  consent_receipt_id TEXT,
  ad_allowed         INTEGER,
  gclid TEXT, gbraid TEXT, wbraid TEXT, fbc TEXT, fbp TEXT,
  value_minor        INTEGER,
  currency           TEXT,
  payload_hash       TEXT NOT NULL,
  contract_version   TEXT NOT NULL,

  -- állapot + konkurencia:
  status             TEXT NOT NULL, -- pending | accepted | skipped_<ok> | failed_retryable | failed_permanent
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT, last_attempt_at TEXT, last_error_code TEXT,
  gateway_request_id TEXT,
  lease_token        TEXT, lease_until TEXT,
  created_at         TEXT NOT NULL, completed_at TEXT
);

-- Ugyanaz a kezdeti konverzió és ugyanaz a lifecycle-átmenet sem kerülhet be kétszer.
CREATE UNIQUE INDEX uq_initial_tracking_event
  ON crm_tracking_events(tracking_event_id, event_name)
  WHERE tracking_event_id IS NOT NULL;

CREATE UNIQUE INDEX uq_lifecycle_event
  ON crm_tracking_events(lifecycle_event_id)
  WHERE lifecycle_event_id IS NOT NULL;
```

PII-hash retention: N nap után az elküldött sorok hash-mezői nullázódnak.

#### PII-korrekció — a helyes szabály

> **Javítva a review nyomán.** A v1.0 azt írta: „ha az email később javul, az új
> lifecycle-eseményként megy fel". **Ez dupla konverziót okozna** — egy emailcím
> javítása nem üzleti esemény, nem keletkezhet tőle új `lead_qualified` vagy
> `booking_confirmed`.

Helyes szabály:
- a már **`accepted`** esemény immutable marad;
- a **`pending` / `failed_retryable`** esemény a saját rögzített snapshotjával próbálkozik újra;
- **PII-javítás önmagában NEM hoz létre új conversion eventet;**
- külön `identity_enrichment` folyamat csak akkor, ha egy platform támogat ilyen,
  **nem konverziós** frissítést. Amíg nincs ilyen út, a javítás a következő *valódi*
  üzleti eseménnyel megy fel.

#### F3-A/2 · Prehashed PII contract a gateway felé — ÚJ, kötelező

> **A review helyesen szúrta ki, és kódból megerősítettem.**
> `soborbo-tracking/server/backend/gateway-dispatch.ts` **nyers** PII-t küld
> (`GatewayUserData { email?, phone_number?, first_name?, … }`, semmi `sha256_*`), a
> gateway pedig **feltétel nélkül hashel**: `conversion.ts:413` `await hashUserData(payload.user_data || {}, …)`.
> **Ma nincs prehashed input-út.** Ha az outbox csak hasht tárol és azt küldi a mai
> szerződésen, az eredmény **dupla hash** → a Meta match rate csendben nullára esik.

Ezért a gateway **explicit, dokumentált prehashed contractot kap** (a review A+C
kombinációja):

```json
{ "user_data_hashed": { "sha256_email": "…", "sha256_phone": "…" } }
```

Kötelező szabályok:
- `user_data` és `user_data_hashed` **kölcsönösen kizáró** — mindkettő jelenléte 400.
- `user_data_hashed` jelenlétében a gateway **NEM hashel újra**, csak validál
  (64 hosszú lowercase hex; bármi más → 400, nem néma átengedés).
- A normalizálás felelőssége ilyenkor a CRM-é → a CRM-nek **ugyanazt** a normalizálót
  kell futtatnia (`lib/hash.ts` vendorozva, F1-4 hash-guard alá véve). Enélkül a
  `Pécs`/`pecs` és a `+36`/`06` eltérések némán rontják a match ratet.
- Regressziós teszt: azonos lead nyers és prehashed úton **azonos** hash-eket ad.

### F3-B · Lease-alapú konkurenciavédelem

A `sending` köztes állapot kimarad (cron-crash beragadt `sending`-et hagyna) — helyette
atomikus lease:

```sql
UPDATE crm_tracking_events
   SET lease_token = ?, lease_until = ?
 WHERE id = ?
   AND status IN ('pending','failed_retryable')
   AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP);
-- csak a sikeresen frissített sor küldhető
```

**Arányosság kimondva:** egyetlen cron + a mai volumen mellett az átfedő futás esélye
közel nulla — ez korrektségi biztosítás, nem sürgős szükség. De olcsó, és a `sending`
elhagyását igazolja. Bekerül.

### F3-C · A kezdeti leadkonverzió tartós handoffja

Nemcsak a lifecycle-események veszhetnek el: **maga a kezdeti lead-konverzió is**, ha a
CRM létrehozza a leadet, de a gateway épp nem elérhető és a request-en belüli retry
elfogy. Ez nem elmélet: a Fázis 0-ban mért lomtalan Meta-blokk **5 napig** skipelt — ha
az gateway-kiesés lett volna egy sima request-retry mögött, azok az események ma sehol
nem lennének.

**Döntés — CRM outbox, ugyanez a tábla** (`event_kind = 'initial_conversion'`): a site
backend átadja a `source_event_id` + `tracking_event_id` + attribution + consent +
`event_name`-et; a CRM **egy tranzakcióban** (a) létrehozza/visszakeresi a leadet,
(b) az outboxba írja a kezdeti tracking-eseményt, (c) visszaadja a `lead_id`-t.

**Az „egy tranzakció" konkrétan mit jelent itt** — jó hír, egyszerűbb a vártnál:
`db.transaction()` a D1-en **sehol nincs**, de a `createLead`
(`src/lib/db/repositories/leads.ts:193-230`) **már ma egyetlen `db.batch()`-ben** írja a
leadet + attribution + consent_log + activity sorokat, ezzel a kommenttel:
*„M2: atomikus létrehozás EGY D1-batch-ben — részleges hibánál sem marad árva lead."*
**Az outbox-insert ebbe a meglévő batch-be fűzhető** — nem kell új konkurencia-modell.

⚠️ **Amit viszont javítani kell:** a webhook-route maga **három külön, batch-eletlen
körfordulót** csinál — `logWebhookEvent` (`route.ts:109`) → `createLead` (`:133`) →
`updateWebhookEventStatus` (`:134`). Itt ma crash-ablak van: a lead létrejöhet úgy, hogy a
`webhook_events` sor `received` állapotban ragad. Ezt az F3-C-vel együtt kell rendezni,
különben az outbox garanciáját egy szinttel feljebb elfolyatjuk.

*Idempotens-insert minta már létezik a repóban:* `review/repo/sends.ts:18-23` —
`.onConflictDoNothing().run()` + `res.meta.changes` vizsgálat. Az outbox unique indexei
ugyanezzel a mintával kezelhetők.

*(Alternatíva, elvetve: site-oldali Cloudflare Queue — a CRM amúgy is a kanonikus
leadforrás, egy tartós tároló elég, nem kettő.)*

### F3-D · Lifecycle-szemantika és -mapping

> **Kiindulás, ellenőrizve:** a `STATUS_EVENT_MAP` (`tracking-worker.ts:34-36`) **ma egyetlen
> bejegyzés** — `lezart_nyert: 'revenue_confirmed'`. A Fázis 0 D-1-e (`kvalifikalt:
> 'lead_qualified'`) tehát **nincs meg**, ez még hátralévő Fázis 0 munka.
>
> Ugyanitt: a `tracking-worker.ts`-ben **nincs retry** — egyetlen `fetch`, 6 s
> `AbortController` timeout, fire-and-forget; minden hibaág csak logol (`TRK-FWD-001..004`),
> se queue, se backoff, se perzisztencia. A modul a retry-t a Worker oldalára feltételezi.
> **Ez pontosan az F3-C létjogosultsága**, és `URL` env-en megy (`TRACKING_WORKER_URL`), nem
> service bindingon.

`kvalifikalt → lead_qualified` (Fázis 0) mellé: `lezart_nyert → booking_confirmed`,
`kifizetve/számla → revenue_confirmed`, a hozzájuk tartozó Google-actionökkel; a
Painless élő „Revenue confirmed (server)" actionjének megfeleltetése az új
szemantikának. `lifecycle_event_id` = ULID státuszátmenetenként; retry újrahasznál,
valódi új esemény újat kap.

**Bizonyíték:** lokális gateway-leállás szimuláció → 0 elveszett esemény (kezdeti ÉS
lifecycle), visszajátszás azonos ID-val; #1, #2, #6, #7 zöld.

---

## Fázis 4A — A starter bekötése (plugin-modell)

A cél **nem** új tracking skill és **nem** mega-repo, hanem a starter bekötése a már
meglévő szerveroldali rendszerbe.

> **Kiindulási állapot, kódból ellenőrizve — rosszabb, mint a v1.0 feltételezte.**
> A starter **egyáltalán nincs bekötve** a skillhez: nincs benne `gateway-dispatch.ts`,
> nincs benne `TrackedForm.astro`, és az `/api/contact` + `/api/track` pár **semmilyen**
> szerveroldali konverzió-dispatchet nem végez (`crm|webhook|GATEWAY|conversion-server|
> tracking_event_id` grep az egész starterre: **nulla találat**). Pontosan az a hibamód,
> amire a TrackedForm saját kommentje figyelmeztet: *„A form wired without the backend
> dispatch ships leads with NO server-side ad conversion."* Ez tehát nem „stub-törlés",
> hanem a szerver-láb **megírása**.

#### A dedup már ma eltörik a starterben

`ContactForm.astro:194-195` **újragenerálja az `event_id`-t közvetlenül a submit előtt**, a
`contact.ts` pedig soha nem olvassa ki. A `submit.ts` beteszi a `submission.eventId`-be,
majd **eldobja** — nincs a Sheets-sorban, nem megy emailben, nem tér vissza. A böngésző és a
szerver azonosítója így szükségszerűen eltérne. A skill szerződése (#2) ezt tiltja:
*„A fresh id does not 'add' a conversion — it DOUBLE-COUNTS the lead."*
(Ráadásul a `generateEventId()` `${Date.now()}-${base36}`-ot ad, nem `crypto.randomUUID()`-t,
amit a skill README fallbackje feltételez.)

#### A starter az astro-forms-v3 elágazása, nem fogyasztója

A `src/lib/forms/` fájlnévre tükrözi a skill boilerplate-jét, de **mind a 10 fájl
különbözik**, és a két válaszszerződés **kölcsönösen inkompatibilis**:

| | astro-forms-v3 | starter |
|---|---|---|
| endpoint | `/api/submit` | `/api/contact` |
| body | JSON | `formData()` |
| siker | `{success, redirect, leadId}` 200 | **302 + Location, üres body** |
| honeypot | néma 200 | **400 „Spam detected"** — közli a bottal, hogy lebukott |
| időkapu | kötelező (3 s) | **nincs, `formStartTime` mező sincs** |
| dedup | néma 200 | 400 `{error:'Duplicate submission detected'}` |
| IP | hashelt, sózva | **nyersen tárolva** (`submit.ts:94`) |
| Sheets | `ctx.waitUntil` | blokkoló `await` |
| ügyfél-visszaigazoló email | kötelező | **nincs**, csak üzleti értesítés |

A 302-es válasz **az oka** az `opaqueredirect`-sniffelésnek: a kliens azért kényszerül a
redirect *alakjából* következtetni, mert a szerver nem mond semmit. Egyetlen szerződéshiány
két vége, nem két külön bug. **Az egységesítés iránya: az astro-forms-v3 JSON-kontraktusa**
(`{success, redirect, leadId}`), mert az F1-1 egységes `lead_id`-jével ez illeszkedik.

#### Két CLAUDE.md-sértés a starterben

- **`pushLeadConversion` `value: 0`-t és hardkódolt `GBP`-t küld** (`tracking/events.ts`) —
  a **§3** kifejezetten tiltja: *„Ha véletlenül `value: 0`-t küldenél: ne."* Magyar site-on
  a `GBP` külön is hibás. *(A függvény ma exportált, de senki nem hívja — a javítás olcsó.)*
- **A kliensoldali `hashPii` csak lowercase + trim** (`events.ts:27-33`) — **nincs E.164
  normalizálás** a telefonra. A **§1** szerint `+36…` alakban hashelendő; enélkül a Meta
  telefon-match csendben romlik.

#### Egyéb, amit a bekötés közben rendezni kell

- Az `astro-forms-v3` `assets/boilerplate/astro/api-handler.ts` a `../../lib/errors`-ból
  importál `errorResponse`/`logCode`-ot, **ami sem a skillben, sem a starterben nem létezik**
  — a boilerplate ma nem fordulna le.
- A starter event-nevei sajátok (`contact`, `generate_lead`), **nem** a kanonikus
  `contact_form_submitted` / `quote_calculator_submitted` — F1-0 alá kell hozni.
- `.env.example`-ben deklarált, de **sehol nem olvasott**: `META_ACCESS_TOKEN`,
  `META_PIXEL_ID`, `IP_HASH_SALT`. A `wrangler.jsonc`-ban **nincs KV binding**, pedig a
  `contact.ts` `env.RATE_LIMIT_KV`-t olvas.
- A route-ok a `siteConfig.example`-ből importálnak, nem az éles configból.

#### `gateway-dispatch.ts` — egy hiányosság, amit át kell venni

Nincs benne **timeout**: se `AbortSignal`, se `AbortController`. A `[400, 1200] ms` backoff
csak a *próbálkozások számát* korlátozza, egyetlen beragadt hívást nem — miközben a modul
saját kommentje szerint *„this runs inside the lead request."* Egy beteg gateway a
lead-kérést fogja tartani. **Az F3-C-vel együtt javítandó** (a CRM `tracking-worker.ts`-ében
van 6 s timeout, itt nincs — a kettőt egy szintre kell hozni).

**Feladatok:**

1. Kanonikus források: `astro-forms-v3` = form-backend · `soborbo-tracking` = tracking ·
   `leadgen-starter-build` = ezek ellenőrzött összeszerelése.
2. A starter `/api/track` stub **törlése** — ma két TODO és hazug `{ok:true}`
   (`src/pages/api/track.ts:71-80`: a validált `data` hozzá sincs rendelve semmihez).
3. A starter API-route hívja a CRM-webhookot, a válasz adja a `lead_id`-t.
4. A kezdeti konverzió tartós handoffba (F3-C).
5. A browser GTM-esemény **csak backend-siker után** fut (lásd időrend lent).
6. Browser és server **ugyanazt** a `tracking_event_id`-t használja.
7. A starter tracking- és form-másolatai forrás-metaadatot / hash-ellenőrzést kapnak (F1-4).

**Preset-gazda:** `leadgen-starter-build` (vagy vékony `soborbo-leadgen-preset`) —
**NEM** a tracking skill. Ez mondja ki a „mindig innen indulj" szabályt.

### A TrackedForm.astro szerepe — pontosítva

> **Javítva a review nyomán, kódból megerősítve.** A v1.0 „bekötött TrackedForm.astro"-t
> írt. A komponens saját fejléce ennek az ellenkezőjét mondja: *„Form wrapper with
> conversion tracking (BROWSER leg only). THE SERVER LEG IS NOT HERE — and that is
> load-bearing."* Ráadásul: *„This component assumes classic HTML form submission. If
> your form uses fetch/XHR submit, use `trackLeadSubmit()` directly."* — a starter form
> viszont **AJAX/fetch** submitot használ.

Helyes megfogalmazás: **a `TrackedForm.astro` böngésző-oldali referenciaimplementáció.**
A közös tracking-azonosító és a hidden mezők kezeléséből indulunk ki, de a starter
AJAX-formjához adaptálni kell (`trackLeadSubmit()` közvetlen hívásával). A CRM- és
gateway-lábat az **API route** valósítja meg.

### A böngésző-esemény helyes időrendje

Kódból igazolt bug (`ContactForm.astro:181-221`): a `pushContactConversion` akkor tüzel,
ha a válasz `opaqueredirect`. `redirect: 'manual'` mellett az ilyen válasz **átlátszatlan**
— státusza 0, fejlécei és teste olvashatatlan. A kód tehát **nem tudja megkülönböztetni**
a valódi mentést bármely más redirecttől, és a `response.headers.get('Location')` mindig
`null`, így mindig a `/thank-you`-ra esik vissza. A konverzió pusztán a redirect
*alakjára* tüzel.

```
browser submit → backend validáció → CRM siker → gateway accepted VAGY tartós pending
→ backend 200 (JSON, nem redirect) → browser GTM-esemény → köszönőoldal
```

Nem küldünk browser-konverziót, mielőtt a backend eldöntötte, hogy a beküldés valódi,
nem spam és sikeresen elmentett.

### F4A-8 · dataLayer hashed-PII döntés — ÚJ

> **Egyik review sem vette észre.** A starter `pushContactConversion`-je
> (`src/lib/tracking/events.ts:56-72`) **`sha256_email` / `sha256_phone` mezőket tol a
> `dataLayer`-be**, böngészőoldali hasheléssel. Ez (a) ellentétes iránya a skill
> szerveroldali konvenciójának, és (b) súrolja a **CLAUDE.md §15**-öt („a kliensoldali
> `dataLayer.push` **soha** nem tartalmaz PII-t").

A hashelt email nem nyers PII, de GDPR-értelemben továbbra is személyes adat
(pszeudonimizált, nem anonim). Fázis 4A-ban **explicit döntés kell**, két épkézláb út:
- **(a)** a hash marad a dataLayerben, mert a Meta Advanced Matching így kéri → a
  §15-öt pontosítani kell („nyers PII soha; hashelt azonosító csak a nevesített
  Advanced Matching mezőkben"), vagy
- **(b)** a dataLayer csak eseménymetaadatot kap, a matching a szerver-lábra megy.

Amit **nem** szabad: a mai állapot, ahol a szabály és a kód ellentmond, és egyik sem
hivatkozik a másikra.

**Határ (változatlan):** a webshop/rendelés nem fér ide — tranzakciós modell (purchase
értékadattal), külön preset, saját szerződéssel.

---

## Fázis 4 — Site-manifest + drift + build-metaadat

- **F4-1 · Manifest** = commitolt site-input + drift-check. A minta él
  (`server/site-inputs/trapezlemezes.json`) — kiterjesztés minden élő site-ra,
  secretek helyett fingerprinttel. Napi drift-check a digestben.
- **F4-2 · Kötelező build-metaadat + health-endpoint.** Minden Worker build-je beégeti:
  `SOURCE_REPOSITORY`, `SOURCE_COMMIT`, `BUILD_TIMESTAMP`, `RELEASE_VERSION`.

  ```json
  { "service": "event-gateway", "source_repository": "Soborbo/Serverside",
    "source_commit": "abc123", "release_version": "6.1.0",
    "build_timestamp": "2026-07-20T14:00:00Z" }
  ```

  Kell: Event Gateway, lomtalan CRM, Painless CRM, később a starterből származó
  site-workerek. A drift-check ezt a **remote Git-állapottal** veti össze — nem a
  Wranglerből következtet.
- **F4-3 · Scaffold-platform zaj.** A fan-out ne írjon delivery-sort olyan platformra,
  amihez nincs config ÉS nem expected. *(A Fázis 0 skip-osztályozása ehhez már megadta a
  szemantikát — `not_expected` — csak a delivery-sor elhagyása van hátra.)*
- **F4-4 · Kalibrált lifecycle-jelzés.** „X napja nincs valódi lifecycle-esemény" → ezen
  a volumenen **INFO**, nem CRITICAL.

**Bizonyíték:** szándékos KV-eltérés → másnapi digest CRITICAL; nem-gitelt vagy
eltérő-commitú deploy → digest CRITICAL; új esemény csak értelmes platform-sorokat ír.

---

## Fázis 5 — Két tesztcsoport

**(A) Determinisztikus tesztcsomag** — a CI ezt futtatja, mock adapterrel:

```
starter form → site backend → CRM webhook → lead_id → outbox → gateway → MOCK Meta/Data Manager
```

Négy kötelező teszt: (1) teljes sikeres út; (2) elveszett első CRM-válasz → retry azonos
`lead_id`; (3) gateway-kiesés → outbox megtart és később kézbesít; (4) duplikált
lifecycle-esemény → egyszer platformra.

**(B) Külső platformteszt** — külön, manuális havi/negyedéves drill:
production/staging gateway → Meta test event → Google teszt conversion action.

> **Kiindulás, ellenőrizve — aszimmetrikus.**
> A **CRM tesztinfrája erős**: `@cloudflare/vitest-pool-workers`, **valódi workerd +
> miniflare D1** (nem mock), `applyD1Migrations` a `test/apply-migrations.ts`-ben,
> `isolatedStorage` per teszt, ~85 tesztfájl. Már van
> `test/webhooks/signed-webhooks.test.ts` (a teljes wire-contract tükre),
> `test/integrations/tracking-worker.test.ts`, `test/infra/idempotency.test.ts`. Az (A)
> csomag CRM-fele tehát **kiterjesztés, nem nulláról írás**. *(A signed-webhook tesztek
> `enableModule()`-lel írják be a `painless_webhooks` kulcsot a `module_settings`-be —
> minden új teszt ugyanezt igényli.)*
>
> A **starterben nulla teszt van**: se `*.test.*`, se `vitest.config`, se test script,
> semmilyen tooling. Ott az (A) csomag **a tesztinfra felállításával kezdődik**.
>
> A **gateway** (Serverside) 458 tesztnél tart — ez a rész kész.

A Google/Meta pillanatnyi hibája ne tegye pirossá a normál CI-t — így a „külső API-hiba"
és a „belső kódhiba" nem keveredik.

---

## Fázis 6 — Monorepo-migráció (KÖTELEZŐ)

> **Javítva a review nyomán.** A v1.0 ezt feltételesnek jelölte, `>3 aktív
> contract-fogyasztó` triggerrel — miközben az **F1-0 négyet sorol fel** (Serverside,
> CRM, starter, GTM snapshot). A terv saját definíciója szerint a trigger **már ma
> teljesül**, tehát a feltételesség önellentmondás volt.

**Kötelezően Fázis 1–5 után.** Tiszta szerkezeti refaktor, **új funkció nélkül**;
minden pre-migration tesztnek változatlanul zöldnek kell maradnia előtte és utána.

```
soborbo-platform/
├── apps/       event-gateway/ · crm/ · leadgen-starter/
├── skills/     soborbo-tracking/ · astro-forms-v3/ · leadgen-starter-build/ · lead-gen-calculator/
├── contracts/  events/ · lead-intake/ · crm-webhooks/
├── tools/      generate-site/ · validate-site/ · drift-check/
└── fixtures/
```

A triggerlista **továbbra is trigger marad**, de már csak arról dönt, hogy *később*
kell-e npm-csomagosítás, automatikus release vagy összetettebb workspace tooling —
magát a migrációt nem teszi feltételessé.

---

## Elhagyva / halasztva — visszavételi triggerekkel

| Elem | Miért marad ki most | Visszavételi trigger |
|---|---|---|
| npm contract-csomagok | a hash-snapshot (F1-4) elég | külső fejlesztő vagy 5. fogyasztó |
| Provisioning plan/apply CLI + AST-patch | a plan-mag = F4-1 drift-check | >10 site vagy havi >2 onboarding |
| Capability registry | `status` mező a platform-configban elég | tiktok/msads tényleges élesítése |
| Kétfázisú secret-rotáció | rotáció ritka; runbook + verify elég | első rotáció, ami kiesést okoz |
| 95%-os coverage-küszöbök | a kritikus-modul tesztlista él és bővül | csapatbővülés |
| 12 ADR | egy dátumozott `ARCHITECTURE.md` | – |
| Operátori dashboard | a napi digest lefedi ezt a méretet | >20 site vagy napi >100 esemény |
| 7 napos canary site-onként | smoke + reconciliation már él | – |

---

## Hibakategória-lefedettség

| Hibakategória | Kezelő fázis |
|---|---|
| Elveszett forráskód | Fázis 0 (A-2) + Fázis 4 (F4-2) |
| Nem reprodukálható deploy | Fázis 4 (F4-2 build-metaadat ↔ git) |
| Konfigurációs drift | Fázis 4 (F4-1) |
| Secretvesztés | Fázis 0 (E) + Fázis 2 (F2-1 rotate-guard) |
| Hibás platformkonfiguráció | **Fázis 0 (kész: skip-osztályozás + DLQ)** + Fázis 4 (F4-3 zaj) |
| Elveszett CRM-válasz / hiányzó `lead_id` | Fázis 1 (F1-1) |
| Duplicate lead | Fázis 1 (F1-1 dedup + `entity_id`) |
| Elveszett kezdeti konverzió | Fázis 3 (F3-C) |
| Elveszett lifecycle-esemény | Fázis 3 (F3-A/C) |
| Duplicate konverzió | Fázis 3 (F3-B lease + egyedi indexek) |
| **Dupla hash / néma match-rate esés** | **Fázis 3 (F3-A/2 prehashed contract)** |
| Consent-keveredés | Fázis 1 (F1-2 granuláris, tri-state) |
| Tracking event ID drift | Fázis 1 (F1-3) + Fázis 4A |
| Félrevezető stub | Fázis 4A (2.) |
| Eltérő form-/tracking-másolatok | Fázis 1 (F1-4) + Fázis 4A (7.) |
| Browser konverzió backend-siker nélkül | Fázis 4A (időrend) |
| **Hashed PII a dataLayerben ↔ §15** | **Fázis 4A (F4A-8)** |
| Külső API-hiba ↔ belső kódhiba keveredése | Fázis 5 |
| Szerződés-drift / kettős tulajdon | Fázis 1 (F1-0) |

---

## Review-eltérések — amit NEM vezettem át, és miért

1. **`UNKNOWN` consent-állapot → elutasítva.** A production `ConsentSignal` már
   `GRANTED | DENIED | UNSPECIFIED` (Consent Mode v2 szótár). Harmadik szó = felesleges
   fordítási réteg a legkockázatosabb ponton. A tri-state *elve* átvezetve,
   `UNSPECIFIED` néven.

## Amit egyik review sem vett észre — hozzáadva

2. **F3-A/2 · prehashed PII contract.** A review helyesen jelezte a kockázatot, de
   opciókat sorolt. Kódból megerősítve, hogy ma **nincs** prehashed út
   (`conversion.ts:413` feltétel nélkül hashel), és rögzítve a konkrét szerződés a
   kölcsönös kizárással, hex-validációval és a CRM-oldali normalizáló-kötelezettséggel.
3. **F4A-8 · hashed PII a dataLayerben.** A starter `sha256_email`/`sha256_phone`-t tol a
   dataLayerbe, ami feszül a CLAUDE.md §15-tel. Explicit döntést igényel.
4. **A starter nincs bekötve** — nem `gateway-dispatch.ts`-t kell *használni*, hanem a
   szerver-lábat **megírni**. A Fázis 4A terjedelme ettől nagyobb, mint a v1.0 sugallta.
