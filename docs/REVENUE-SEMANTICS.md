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

## 5. Nyitott ÜZLETI döntések — ezek nem kódkérdések

1. **Mi számít konverziónak site-onként?** A megnyert ajánlat (korai, zajos, jól
   optimalizál) vagy a befolyt pénz (késői, pontos, kevesebb jel)? A kettő **együtt**
   is mehet, két külön konverzió-akcióként.
2. **Részfizetés.** Egy `partial` számla küldjön-e jelet, és mekkorát? (Előleg gyakori.)
3. **Visszavonás modellje.** `credit_note` / storno / won→lost esetén: korrekció
   (Google conversion adjustment), vagy tudatos „nem küldünk semmit"?
4. **Visszamenőlegesség.** A Google offline feltöltésnek ablaka van; egy hónapokkal
   későbbi fizetés lehet, hogy már nem köthető a kattintáshoz. Ilyenkor a `wonAt`
   marad a jobb időpont — de akkor az érték a helyesbített legyen?

**Amíg ezek nincsenek eldöntve, a jelenlegi viselkedés MARAD** — de mostantól
kimondva, nem feltételezve.

---

## 6. Amit a döntés után építeni kell (vázlat)

- a lifecycle-hook forrása bővül: lead-státusz **mellett** fizetési esemény;
- új `lifecycleEventId`-séma, hogy a fizetés ne ütközzön a won-eseménnyel;
- a gateway-oldalon korrekciós út (a Google Data Manager támogat adjustmentet, ma
  nincs bekötve);
- a ledger `deliveries` háromállapotúságát (`accepted`/`skipped`/`rejected`) a
  korrekció nem boríthatja — a CLAUDE.md §11 szabálya érvényben marad.

---

*Írta: Claude Opus 5 · 2026-09-08 · minden szám és állítás a megadott fájl:sor
hivatkozásokkal reprodukálható.*
