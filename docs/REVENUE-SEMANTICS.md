# `revenue_confirmed` — mit jelent MA, és mit NEM

**Státusz:** mérés, nem javaslat. Minden állítás mögött fájl:sor van, és a vNext
roadmap **P10** ezt kérte első lépésként: *„a `revenue_confirmed` szemantikát addig
dokumentálni kell, hogy ne jelentsen többet a valóságnál."*

**Mérve:** 2026-09-08, `Serverside@main` és `soborbo-crm@origin/main` (`85c1773`).

---

## 1. Mit jelent ma — a tényleges lánc

| lépés | hol | mit csinál |
|---|---|---|
| kiváltó | `crm astro/src/lib/integrations/tracking-worker.ts:27` | `lead.status === 'lezart_nyert'` (**Lezárt — nyert**) → `revenue_confirmed` |
| érték | `crm astro/src/lib/tracking/lifecycle.ts:71-74` | `lead.finalValue`, csak ha `> 0` **és** van `TRACKING_CURRENCY` |
| időpont | `crm .../lifecycle.ts:40` | `lead.wonAt` (a megnyerés ideje, nem fizetésé) |
| idempotencia | `crm .../lifecycle.ts:41` | `lifecycleEventId = "<leadId>:revenue_confirmed"` → **leadenként egyszer** |
| egység | `crm astro/src/lib/utils/money.ts:5-6, 29-30` | minor → major, **pénznem-tudatosan** (`HUF`/`JPY` = 0 tizedes) |
| felküldés | `Serverside src/routes/lead-status.ts:431, 596, 628` | a `value`-t **készpénznek veszi**; a gateway nem értelmezi újra |
| vendor | `Serverside src/lib/datamanager.ts:229, 234` | `conversionValue` + `currency` a Google Data Manager felé |

**Egy mondatban: `revenue_confirmed` = „a leadet megnyertnek jelölték, és valaki
kézzel beírt egy végösszeget".**

Az egység-kezelés **helyes** — külön megnéztem, mert a `valueMinor` → `value` átmenet
klasszikus 100×-os hibaforrás. A `toMajor` pénznem-tudatos, és a kód kommentje maga
mondja ki a kockázatot (*„minor-ben küldve 100×-os ROAS-torzítás GBP/EUR-nál"*).

---

## 2. Amit NEM jelent

### 2.1 Nem jelenti, hogy a pénz megérkezett

A CRM-ben **van teljes számlázási alrendszer** — és a tracking **nem olvassa**:

```
crm astro/src/db/schema/invoicing.ts:21  INVOICE_TYPES    = deposit | custom | final | credit_note
crm astro/src/db/schema/invoicing.ts:24  INVOICE_STATUSES = draft | sent | partial | paid | overdue | void
crm astro/src/db/schema/invoicing.ts:58  invoices.amountPaidPence
crm astro/src/db/schema/invoicing.ts:116 payments (amountPence, method, source)
```

Vagyis a „ténylegesen befolyt összeg" **adata megvan**, de a konverzió-jel a
lead-státuszból és egy kézi mezőből származik. Egy megnyert, de soha ki nem fizetett
munka ma ugyanúgy `revenue_confirmed`-et küld, mint egy kifizetett.

### 2.2 Nem visszavonható és nem korrigálható

A gateway-ben **nincs semmilyen korrekciós út** — se Google conversion adjustment, se
retraction, se refund-fogalom:

```
grep -rniE "adjustment|retract|refund|ConversionAdjustment" Serverside/src/  →  0 találat
```

Következmény: ha egy megnyert munka meghiúsul, vagy `credit_note` (jóváírás) megy ki,
**a platform ezt sosem tudja meg**. Az idempotencia-kulcs (`<leadId>:revenue_confirmed`)
azt is garantálja, hogy egy későbbi, helyesbített érték sem menne fel.

### 2.3 A `lezart_vesztett` visszalépés sem üzen

A státusz-térkép csak két átmenetet ismer (`kvalifikalt`, `lezart_nyert`); minden más
státusz `null`-t ad, tehát nem termel eseményt. A won → lost visszalépés **néma**.

---

## 3. Mit tanul ebből a hirdetési platform

- **Amit tanul:** „ezen a kattintáson egy ajánlatot megnyertünk, ekkora becsült
  értékkel". Ez bid-optimalizációra **használható** jel — jobb, mint a puszta lead.
- **Amit NEM tanul:** befolyt-e a pénz; kevesebb lett-e; visszavontuk-e.
- **Az irány egyoldalú:** a torzítás mindig **felfelé** megy. A ROAS-riport ezért
  szisztematikusan optimista, és a mértéke ma **nem mérhető** — pontosan azért, mert a
  fizetési oldal nincs bekötve.

Ez nem hiba, amit „el kell hárítani": ez egy **kimondatlan modell**. A P10 kérése az
volt, hogy legyen kimondva. Ez a dokumentum ezt teszi.

---

## 4. A rés áthidalható — az adat megvan

A P10 két profilt vázolt:

```
Leadgen simple:            won_value_confirmed   és/vagy   revenue_confirmed
Painless / job / invoicing: paid → revenue_confirmed
```

A második ma **építhető lenne**: az `invoices.status = 'paid'` és a `payments` tábla
már létezik és karban van tartva. Nem új adatgyűjtés kell, hanem az, hogy a
lifecycle-hook ne (csak) a lead-státuszra üljön.

---

## 5. ÜZLETI DÖNTÉSEK — a user, 2026-09-09 (a kérdések LEZÁRVA)

Ez a szakasz korábban négy NYITOTT kérdést tartalmazott, és azzal zárult, hogy
„amíg ezek nincsenek eldöntve, a jelenlegi viselkedés MARAD". A négy döntés
megszületett; a szakasz mostantól a döntéseket rögzíti, az indoklásukkal.

### D1 — Mi számít konverziónak? **Mindkettő, két KÜLÖN akcióként.**

A megnyert ajánlat (`wonAt`) marad az optimalizálásra használt, korai és sűrű
jel; a **ténylegesen befolyt pénz** külön, másodlagos konverzió-akcióként megy.
A bidding a sűrű jelre tanul, a riport a pontosra.

Ez nem új infrastruktúrát jelent: a Google Ads fiókban MA IS két akció áll —
`Lead qualified (server)` (`QUALIFIED_LEAD`, primary) és `Revenue confirmed
(server)` (`PURCHASE`, nem primary). A döntés ezt a szétválasztást mondja ki, és
köti be mellé a fizetést.

> ⚠️ **Dupla-számolás veszély, és ezért van rá őr.** A `revenue_confirmed` a
> MEGNYERT ajánlat értéke, a `payment_received` a BEFOLYT pénz. Ha egy site
> configja ugyanarra a Google Ads conversion actionre képezi a kettőt, ugyanaz a
> bevétel kétszer számít — és ezt semmi más nem jelezné: a riport csak azt
> mutatná, hogy jól teljesítünk. A gateway ezért `TRK-400-025`-tel, 500-zal
> elutasítja az ilyen konfigurációt.

### D2 — Részfizetés: **igen, a ténylegesen befolyt részösszeggel.**

Minden fizetési esemény külön jelet küld a SAJÁT összegével; a platform
összegzi. Ez tükrözi a valóságot, és nem igényel utólagos korrekciót — cserébe
egy leadhez több konverzió-sor tartozik.

> 🔴 **Ez tett láthatóvá egy addig lappangó hibát.** A gateway az `orderId`-t a
> `sha256(lead_id + '_' + status)`-ból képezi. Az EGYSZERI státuszokra ez helyes
> (a retry ugyanazt küldi, a Google dedupál) — de két részfizetés így UGYANAZT az
> `orderId`-t kapná, a Google a másodikat ugyanannak a konverziónak látná, és a
> pénz **némán elveszne**. Sem hibakód, sem ledger-sor nem jelezné.
>
> Ezért az ismételhető státuszokhoz (`REPEATABLE_LEAD_STATUSES`) a hívónak
> **`occurrence_id`-t KELL küldenie** (a CRM `payments` sorának id-ja), és annak
> hiánya hangos `TRK-400-023` / 400 — nem csendes összevonás. Az `orderId` magja
> ilyenkor `lead_id_status_occurrence`, tehát a retry továbbra is idempotens.
> Az egyszeri státuszok képlete SZÁNDÉKOSAN változatlan: ha elmozdulna, minden
> korábban feltöltött konverzió `orderId`-je megváltozna, és a Google újaknak
> látná őket.

### D3 — Visszavonás: **Google conversion adjustment (RETRACT / RESTATE).**

Storno / teljes jóváírás → RETRACT; részleges jóváírás / felszorzás → RESTATE az
új értékkel. Az adjustment ÚJ ledger-sor, nem írja felül a régit — a CLAUDE.md
§11 háromállapotúsága (`accepted`/`skipped`/`rejected`) érintetlen marad.

> ⛔ **MA NEM KÉZBESÍTHETŐ, és ez tudatos.** A Data Manager `events.ingest`
> hivatalos referenciája (developers.google.com, lekérdezve 2026-09-09) az
> Event-objektumon EGYETLEN adjustment/retract/restate mezőt sem dokumentál, és a
> „Send events" devguide sem ír a helyesbítésről. Közösségi forrás szerint a
> képesség létezik — de a wire-formátumot **nem találjuk ki**: pontosan ezt a
> hibát találtuk meg ugyanezen a napon a GTM Enhanced Conversionsnél, ahol egy
> kitalált mezőnevet a szolgáltató némán eldobott.
>
> A gateway ezért `revenue_retracted` / `revenue_restated` státuszra **501-et ad
> `TRK-400-024`-gyel**, `retryable: false`-szal. A kézenfekvő rossz megoldás az
> lenne, hogy a helyesbítés a normál upload-úton megy: az egy **pozitív**
> konverziót töltene fel egy visszavonásra, vagyis a hibát a kétszeresére növelné.
>
> **Amit a bekötéshez tudni kell, ha a formátum igazolható lesz:** az adjustment
> az eredetit `conversion action id + timestamp + order id` hármassal hivatkozza,
> és **NEM idempotens** — kétszer küldve kétszer alkalmazódik. A gateway retry-je
> (DLQ + cron) ezért CSAK `markDoNotReplay` mögött futhat, különben egy tranziens
> 5xx duplán vonná vissza ugyanazt a konverziót.

### D4 — Visszamenőlegesség: **ablakon belül a fizetés ideje, azon túl a `wonAt`.**

Ha a fizetés belefér a Google offline-ablakába, az a konverzió ideje. Ha kifut, a
`wonAt`-tal küldjük — de a **már ismert, helyes értékkel**. Egy elveszett
konverzió rosszabb, mint egy pontatlan időbélyeg.

A gateway a `won_at`-hoz mér, nem a kattintáshoz: a kattintás idejét nem ismeri,
a megnyerés viszont mindig a kattintás UTÁN van, tehát ez **konzervatív** becslés
— ha a `won_at`-tól számítva belefér, a kattintástól számítva is belefért. Az
ablak `OFFLINE_WINDOW_DAYS = 90`.

**A ledger a VALÓDI `occurred_at`-et őrzi** — a helyesbítés a platformnak szól,
nem a saját könyvelésünknek.

---

## 6. Ami ebből MEGÉPÜLT, és ami hátra van

**Megépült (gateway):**

- `payment_received` kanonikus offline event (`src/events.json`), `occurrence_id`
  kötelezettséggel és ütközésmentes `orderId`-vel;
- a D4 időpont-szabály (`resolveConversionTimeIso`, `won_at` mező);
- a D1 dupla-számolás elleni config-őr;
- a D3 hangos, nevesített elutasítás — `revenue_retracted` / `revenue_restated`
  mint ÉRVÉNYES státusz, hogy a CRM ne „ismeretlen státusz" 400-at kapjon;
- mindezt 19 teszt fedi, **öt külön mutációval** igazolva (az orderId-mag, az
  `occurrence_id`-őr, az adjustment-elutasítás, a dupla-számolás őr és az
  időpont-szabály kikapcsolása egyenként bukást okoz).

**Hátra van:**

1. **CRM-oldal:** a fizetési esemény kiváltsa a lifecycle-hookot
   (`payment_received` + `occurrence_id` = a `payments` sor id-ja + `won_at`).
   Ma a hook forrása kizárólag a lead-státusz.
2. **KV-config site-onként:** `gads.conversion_actions.payment_received` egy
   **ÚJ** Google Ads conversion actionre (nem a `revenue_confirmed`-ére — lásd az
   őrt). Amíg nincs, a feltöltés `configuration_blocked` DLQ-ba megy: helyreállítható,
   nem elveszett.
3. **A `revenue_confirmed` sorsa:** amint egy site-on élnek a fizetési események,
   a `revenue_confirmed` ugyanarra a bevételre ad egy MÁSODIK, korábbi jelet. A
   döntés szerint a kettő két külön akció, tehát nem ütköznek — de a riportban ki
   kell mondani, melyik a bevétel-igazság. Ez site-onkénti kapcsolás, nem kód.
4. **Adjustment-bekötés**, ha a wire-formátum igazolható (lásd D3).

---

*Írta: Claude Opus 5 · 2026-09-08, a döntésekkel kiegészítve 2026-09-09 · minden
szám és állítás a megadott fájl:sor hivatkozásokkal reprodukálható.*
