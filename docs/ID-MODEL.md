# ID-modell — melyik azonosító mit köt

**Státusz:** a VALÓSÁGOT írja le (2026-07-20-i kódellenőrzés alapján), nem a kívánt állapotot.
Minden állítás mellett ott a fájl:sor, ahol ellenőrizhető.

> ⚠️ **A FAZIS-1-6-TERV.md F1-3 tábláját ne vedd át szó szerint.** A benne szereplő
> `source_event_id`, `tracking_event_id` és `lifecycle_event_id` nevek **egyik repóban sem
> léteznek** (0 találat a Serverside `src/`-ben és a CRM `src/`-ben egyaránt). Csak a `lead_id`
> valós. Ez a dokumentum a tényleges neveket használja; a terv nevei legfeljebb jövőbeli
> átnevezési szándékként olvasandók.

---

## 1. A négy SZEREP (és a valódi nevük)

| # | szerep | valódi név | ki mintázza | élettartam / stabilitás |
|---|---|---|---|---|
| 1 | **Kézbesítés-idempotencia** — ugyanaz a HTTP-hívás ne dolgozódjon fel kétszer | `event_id` (a signed webhook envelope-jában) → CRM `webhook_events.event_id` | a **site backendje** | a retry-kon át **azonosnak KELL lennie** |
| 2 | **Böngésző ↔ szerver dedup** — a Meta Pixel és a CAPI egy Leadnek lássa | `event_id` (gateway `/api/event/conversion*`, Meta CAPI `event_id`) | a **böngésző** (vagy determinisztikusan a `ref`-ből) | felületfüggő — lásd 3. szakasz |
| 3 | **CRM-rekord** | `lead_id` → `leads.id` (UUID) | a **CRM**, `createLead` | örök |
| 4 | **Ledger ↔ CRM join-kulcs** | `lead_id` a gateway ledgerben (`lib/ledger.ts:315`) | a **site backendje** | lásd lentebb — **NEM azonos a 3-mal** |

**A név-ütközés a rendszer legfőbb zavarforrása:** az 1. és a 2. szerepet **mindkettőt
`event_id`-nek hívják**, pedig más a garanciájuk. Az 1-nek retry-stabilnak kell lennie, a 2
viszont beküldési kísérletenként új.

---

## 2. A gateway `lead_id` NEM a CRM `leads.id`

Ez a leggyakoribb félreértés. A ledgerbe írt `lead_id` a **site által gyártott kulcs**, nem a
CRM lead UUID-ja — a site a gateway-hívás pillanatában még nem ismeri a CRM lead id-jét
(a CRM-hívás párhuzamosan fut).

Például a callback-úton (`painlessremovals/src/pages/api/callbacks.ts:267`):

```
crmEventId = `cb-${fingerprint}`      // tartalomból származtatott, determinisztikus
  ├─► CRM signed webhook  event_id    (1. szerep — kézbesítés-idempotencia)
  └─► gateway            lead_id      (4. szerep — join-kulcs)

validated.event_id                     // a böngésző UUID-ja
  └─► gateway            event_id     (2. szerep — Meta dedup)
```

### A teljes join-lánc (a Fázis 1 / F1-1 óta záródik)

```
gateway ledger.lead_id
   └─ egyenlő ─► CRM webhook_events.event_id
                    └─ (F1-1, 0037 migráció) ─► webhook_events.entity_id
                                                   └─ egyenlő ─► leads.id
```

**Az utolsó ugrás az F1-1 előtt NEM LÉTEZETT.** A `webhook_events` nem tárolt entity-azonosítót,
ezért a ledger-sort nem lehetett a konkrét CRM-leadhez kötni — csak a beérkezett kézbesítéshez.
Az `entity_id` oszlop ezt a hiányt zárja be.

---

## 3. A tényleges invariáns (három flow-n ellenőrizve)

Első ránézésre úgy tűnik, hogy a felületek ellentmondanak egymásnak: a `save-quote` **egyetlen**
értéket használ három szerepre, a `callbacks` viszont kettőt. **Ez nem inkonzisztencia** — a
mögöttes szabály mindenhol ugyanaz, csak a böngésző id-jének stabilitása tér el.

| flow | 1. CRM-idempotencia | 2. Meta dedup | stabil-e a 2? |
|---|---|---|---|
| **quote** (`ResultPage.tsx` → `save-quote.ts`) | `event_id` | ugyanaz az `event_id` | **IGEN** — fingerprinthez kötött |
| **callback-form** (`SimpleCallbackForm.tsx` → `callbacks.ts`) | `cb-<fingerprint>` (szerveren képzett) | böngésző-UUID | nem — beküldésenként új |
| **callback-emailklikk** (`simple-callback.astro`) | `cb-emailclick-<ref>` | ugyanaz a determinisztikus kulcs | **IGEN** — `ref`-ből |

**A szabály, ami mindhármat magyarázza:**

> Az **idempotencia-kulcs mindig stabil származtatású** (tartalom-fingerprint vagy `ref`).
> A **Meta dedup-id mindig az, amit a böngésző Pixel is küld** ugyanarra az eventre.
> Ahol a Pixel id-je maga is stabil származtatású, ott **egy érték betöltheti mindkét szerepet**.

Ezért a `save-quote` „összevonása" **szándékos és biztonságos**: az
`ResultPage.tsx:405-408` az `event_id`-t az árajánlat tartalom-fingerprintjéhez köti és
sessionStorage-ban perzisztálja, ezért **F5-ön, duplikált fülön és retry-n át ugyanaz marad**;
új id csak akkor születik, ha maga az árajánlat változik (ami szemantikailag új konverzió).

Ezzel szemben a callback-form böngésző-id-je (`SimpleCallbackForm.tsx:246`, `generateUUID()`
a submit-handlerben) **beküldésenként új** — ezért ott a CRM-idempotenciához **külön**,
szerveren képzett `cb-<fingerprint>` kell (`callbacks.ts:267`).

> **Ne „egységesítsd" ezeket egy sablonra.** A helyes kérdés új felületnél nem az, hogy hány
> azonosítót használj, hanem hogy **a böngésző id-je stabil származtatású-e**. Ha igen, egy
> érték elég; ha nem, az idempotenciához külön derivált kulcs kell.

---

## 4. Gyakorlati szabályok

1. **Kézbesítés-idempotenciára csak stabil származtatású kulcsot használj.** Egy per-submit
   mintázott UUID nem az. (A quote-út `event_id`-je azért használható, mert fingerprinthez
   kötött és perzisztált — nem azért, mert „event_id"-nek hívják.)
2. **A Meta dedup-id-nek EGYEZNIE kell azzal, amit a Pixel küld** ugyanarra az eventre —
   akármi is az. Eltérő id = két külön Lead a Metában (ROAS-torzulás, CLAUDE.md §16).
3. **A ledger `lead_id`-je opaque token, NEM PII** (`lib/ledger.ts:144`) — se email, se telefon.
4. **Egy konverziós eventnek egy `event_id`-je van** minden platformon (CLAUDE.md §16). Ez a
   2. szerepre vonatkozik.
5. Ha a CRM-lead UUID-jára van szükséged a ledgerből, a 2. pont join-láncán menj végig — ne
   feltételezd, hogy a `lead_id` már az.

---

## 5. Amit ez a dokumentum NEM állít

- Nem állítja, hogy a `lifecycle_event_id` létezik. **Nem létezik.** A CRM státuszátmeneteit ma
  a `lead_activities` és az `audit_log` sorai őrzik, önálló, kifelé hordozott azonosító nélkül.
- Nem javasol átnevezést. Az 1. és 2. szerep `event_id`-ütközésének feloldása külön döntés
  (breaking wire-change lenne mindkét repóban).
