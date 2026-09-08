# Beautyflow eseménynév-cutover — mérési csomag

**Státusz: MÉRVE, nem végrehajtva.** Ez a dokumentum azt írja le, mi történne ma egy
naiv cutovernél, és milyen sorrendben biztonságos. Minden szám az élő GTM-konténerből
(`GTM-W8V3BVGD`, workspace 45) és az `origin/master` kódjából származik, 2026-09-08-án.

A cutover a `tracking-kit` fork-migrációjának **előfeltétele**: a maradék három közös
fájl (`events.ts`, `index.ts`, `gateway.ts`) mind a kanonikus eseményneveket hozza.

---

## 1. Miért nem lehet a maradékot szeletenként cserélni

A korábbi terv három független szeletként kezelte a maradékot, és csak a `gateway.ts`-t
tekintette blokkoltnak (mert az importálja az `event-contract.ts`-t). **A mérés ezt
cáfolja:** az `events.ts` és az `index.ts` is a kanonikus neveket írja a dataLayerbe.

| fájl | importál `event-contract`-ot | kanonikus nevet push-ol | szeletelhető? |
|---|---|---|---|
| `events.ts` | nem | **igen** (11 név) | ❌ |
| `index.ts` | nem (csak re-exportál) | **igen** (5 név) | ❌ |
| `gateway.ts` | **igen** | payload-nevek | ❌ |

**A maradék tehát egy atomi cutover, nem három szelet.**

## 2. A pontos névtérkép (mérve, függvényenként)

| kit függvény | KIT dataLayer név | KANONIKUS dataLayer név |
|---|---|---|
| `trackPhoneClick` | `phone_click` | `phone_number_clicked` |
| `trackEmailClick` | `email_click` | `email_address_clicked` |
| `trackWhatsappClick` | `whatsapp_click` | `whatsapp_button_clicked` |
| `trackCallbackClick` | `callback_click` | `callback_request_submitted` |
| `pushContactConversion` | `contact_submit` | `contact_form_submitted` |
| `pushLeadConversion` | `lead_submit` | **`quote_calculator_submitted`** |
| `trackCalculatorComplete` | `calculator_complete` | **`quote_calculator_submitted`** |
| `trackCalculatorStart` | `calculator_start` | `quote_calculator_opened` |
| `trackCalculatorStep` | `calculator_step` | `quote_calculator_step_completed` |
| `trackCalculatorOption` | `calculator_option` | `quote_calculator_option_selected` |
| `initFormAbandonTracking` | `form_abandon` | `form_abandoned` |
| `initScrollTracking` | `scroll_depth` | `scroll_depth` (**változatlan**) |

12-ből 11 változik.

## 3. 🔴 A csomag fő lelete: két esemény EGY névbe olvad

`pushLeadConversion` és `trackCalculatorComplete` **ugyanazt** a kanonikus nevet
push-olja (`quote_calculator_submitted`). A kanonikus mag ezt tudja, és a saját
kommentjében ki is mondja:

> „the conversion-grade emission (event_id + value + PII side-channel + gateway) comes
> from trackLeadSubmit/trackServerEvent; this milestone shares the canonical name.
> **Wire ONE of them as the actual quote conversion per site.**"

**A Beautyflow mind a kettőt hívja, feltétel nélkül, közvetlenül egymás után**, mind a
három konverziós folyamatban (`origin/master`):

| fájl | sor | hívások |
|---|---:|---|
| `src/components/quiz/QuizApp.astro` | 533–536 | `trackCalculatorComplete('boranalizis_kviz')` → `trackLeadSubmit({…})` |
| `src/pages/ingyenes-konzultacio.astro` | 847–851 | `trackCalculatorComplete(FORM_NAME)` → `trackLeadSubmit({…})` |
| `src/pages/en/free-consultation.astro` | 847–851 | ugyanaz |

Mindkettő `hasAnalyticsConsent()`-gated, mindkettő a `result.success` ágban van —
tehát **együtt futnak, mindig**.

### Mi történne naiv cutovernél

A dataLayerbe **kétszer** kerülne `quote_calculator_submitted` ugyanabban a folyamatban:
először a mérföldkő (**`event_id` NÉLKÜL**), aztán a konverzió (event_id + value).
A névre kötött trigger mindkettőre tüzelne (`oncePerEvent` = eseményenként egyszer):

- **Meta Pixel — Lead: kétszer.** Az első `eventID` nélkül → a CAPI-láb nem tudja
  deduplikálni → **duplikált Lead a Metában.**
- **GAds Conversion — Quote Request: kétszer**, az első `orderId` (`{{DLV - event_id}}`)
  nélkül → duplikált, attribúció nélküli konverzió.
- GA4 `quote_request`: kétszer.

**Ezt a hibaosztályt ezen a konténeren egyszer már kijavították.** A 91-es tag
(`GAds Conversion - Quote Request`) saját jegyzete: *„2026-07-17 audit-fix: 48
(calculator_complete, event_id nélkül) → 76 (lead_submit) — a Quote-konverzió a
tényleges lead-submiten tüzel, orderId-val."* A naiv cutover **visszahozná** azt,
amit az az audit eltávolított.

### Feloldás

**Ajánlott (A): a mérföldkő-hívás elhagyása a három call site-on.** A kanonikus
névtérben a „kalkulátor kész" ÉS a „quote elküldve" ugyanaz az esemény; a
mérföldkő-push szigorúan kevesebb adatot hordoz, és a hívások amúgy is szomszédosak.
Ez a mag saját utasítása („wire ONE of them").

**(B) GTM-oldali szétválasztás** — ha a „kalkulátor kész" külön metrika kell: két
trigger ugyanarra a névre, `{{DLV - event_id}}` jelenléte szerint (nem üres =
konverzió, üres = mérföldkő). Több mozgó alkatrész, de megőrzi a mai GA4-bontást.

**(C) mag-szintű döntés** — a mérföldkő kapjon saját kanonikus nevet. Ez az
`events.json`/alias-tábla szerződését érinti, tehát flotta-hatású: **külön döntés**,
nem ennek a cutovernek a része. → lásd §7.

## 4. Az élő GTM-leltár (mit érint a névváltás)

15 trigger, mind `customEvent` + `equals`. Ebből **11-et** érint a cutover:

| trigger | mai név | új név | a rajta lógó tagek |
|---:|---|---|---|
| 78 | `phone_click` | `phone_number_clicked` | GA4 phone_click · Meta Pixel Contact · GAds Phone Click |
| 113 | `email_click` | `email_address_clicked` | GA4 email_click · Meta Pixel Contact |
| 114 | `whatsapp_click` | `whatsapp_button_clicked` | GA4 whatsapp_click · Meta Pixel Contact |
| 30 | `callback_click` | `callback_request_submitted` | GA4 callback_request · Meta Pixel Lead · GAds Callback Request |
| 112 | `contact_submit` | `contact_form_submitted` | GA4 contact_form · Meta Pixel Contact · GAds Contact Form |
| 76 | `lead_submit` | `quote_calculator_submitted` | GA4 quote_request · Meta Pixel Lead · **GAds Quote Request** |
| 48 | `calculator_complete` | ⚠️ ütközik a 76-tal — lásd §3 | GA4 calculator_complete |
| 82 | `calculator_start` | `quote_calculator_opened` | GA4 calculator_start |
| 93 | `calculator_step` | `quote_calculator_step_completed` | GA4 calculator_step |
| 26 | `calculator_option` | `quote_calculator_option_selected` | GA4 calculator_option |
| 87 | `form_abandon` | `form_abandoned` | GA4 form_abandonment |

**Nem érinti a cutover:** 121 `scroll_depth` (a név változatlan), 81 `booking_click`,
122 `newsletter_signup`, 123 `calculator_result_view` (site-specifikus push-ok, nem a
kit `events.ts`-éből jönnek).

## 5. Amit NEM kell elintézni — mérve

- **A szerver-láb MÁR kanonikusan beszél.** A `src/pages/api/contact.ts` a
  `quote_calculator_submitted` / `contact_form_submitted` neveket küldi a gateway-nek
  (753. sor). A cutover tehát **csak a böngésző-lábat** érinti.
- **A gateway alias-táblája nem szűk keresztmetszet.** A `phone_conversion`,
  `contact_form_submit` stb. legacy neveket a szerver ma is kanonikusra normalizálja,
  tehát a párhuzamos futás alatt egyik irány sem szakad el.
- **A `lead_submit`, `calculator_start|step|option`, `form_abandon` hiánya az
  alias-táblából NEM hiba:** ezek dataLayer-only nevek, sosem érkeznek az ingressre
  (a böngésző-út csak `phone/email/whatsapp` klikket enged át, a form-konverziókat
  a site backendje küldi kanonikus néven).
- **A `trackLeadSubmit` szándékosan nem hívja a gateway-t** (a form-konverziók
  server-ingress-only-k) — tehát a csere nem termel `GATEWAY_SERVER_ONLY_EVENT` zajt.

## 5.1 A GA4-riportok NEM neveződnek át — mérve

Mind a 15 `gaawe` (GA4 Event) tag **bedrótozott** `eventName`-et használ, egyik sem
küldi tovább a `{{_event}}`-et:

| GA4 tag | GA4 eseménynév | trigger |
|---|---|---|
| callback_request · quote_request · contact_form | `generate_lead` | 30 · 76 · 112 |
| phone_click · email_click · whatsapp_click | `phone_click` · `email_click` · `whatsapp_click` | 78 · 113 · 114 |
| calculator_start · _step · _option | `calculator_start` · `calculator_step` · `calculator_option` | 82 · 93 · 26 |
| form_abandonment · scroll_depth | `form_abandonment` · `scroll_depth` | 87 · 121 |

**Következmény:** a cutover tisztán dataLayer-név-csere. A GA4-eseménynevek, a Meta
standard eseménynevek és a Google Ads conversion label-ek **változatlanok**, tehát a
riport-folytonosság megmarad. Egyetlen kivétel a §3 feloldásából adódik: a
`GA4 Event - calculator_complete` tag elnémul (lásd §5.2).

## 5.2 Amit a §3 (A) feloldása riportban jelent

A mérföldkő-hívás elhagyása után a `calculator_complete` **nem kerül többé a
dataLayerbe**, tehát a 48-as trigger és a rajta lógó `GA4 Event - calculator_complete`
tag néma lesz. Ez tudatos: a kanonikus névtérben a „kalkulátor kész" és a „quote
elküldve" ugyanaz a felhasználói akció, és ma **két** GA4-eseményt küldünk rá.
A takarítás lépésben a trigger és a tag törölhető.

Ha a külön metrika mégis kell, az a §3 (B) útja — `{{DLV - event_id}}` jelenléte
szerint két trigger ugyanarra a névre.

## 6. A biztonságos sorrend

A cutover **nem** kezdődhet a kód-cserével: a GTM-triggerek `equals`-szel néznek egy
nevet, tehát a kliens-váltás pillanatában minden érintett tag elnémulna.

1. **GTM — kettős elfogadás.** ✅ **ELőKÉSZÍTVE, publikálásra vár** — `GTM-W8V3BVGD` **workspace 46** („Esemenynev-cutover 1. lepes”): 10 trigger `equals` → `matches RegEx`, + a 48-as kap egy magyarázó jegyzetet (szándékosan marad legacy-n). Tag és változó nem módosult. A 11 trigger `equals` → `matches RegEx`
   `^(legacy|kanonikus)$` (pl. `^(phone_click|phone_number_clicked)$`). Publikálás.
   *Ekkor még semmi nem változik: a kliens a legacy nevet küldi, a trigger elfogadja.*
2. **Ellenőrzés Preview-ban** a régi kliensen: mind a 11 tag változatlanul tüzel.
3. **§3 feloldása** (ajánlott: a mérföldkő-hívás elhagyása a 3 call site-on) — ugyanabban
   a PR-ben, mint a fájlcsere.
4. **Kliens — a fájlcsere + a hívási helyek** (⚠️ bővebb, mint hittük — lásd §6.1) (`events.ts` + `index.ts` + `gateway.ts`), egy PR.
   Ez a fork-migráció utolsó szelete; a `CLIENT_LIB_VERSION` jelentése is ekkor válik
   igazzá.
5. **Ellenőrzés élesben:** Meta Test Events (Lead pontosan egyszer, event_id-val),
   GA4 DebugView, GAds konverzió orderId-val, és a ledger `finding_codes` üres marad.
6. **`cutover_dates.beautyflow`** = a 4. lépés deploy-dátuma (`event-aliases.json`).
7. **Takarítás** (külön, később): a triggerek RegEx-e visszaszűkíthető a kanonikus névre,
   ha a legacy forgalom elfogyott.

Minden lépés önmagában visszafordítható; az 1. lépés után a rendszer **mindkét** nevet
elfogadja, tehát nincs olyan pillanat, amikor egy konverzió sehol nem landol.

## 6.1 🔴 A kliens-PR NEM fájlcsere — a kit API-ja is eltért

A cserét egy worktree-ben elvégeztem, és **a lib-oldal működik**: a hét fájl bemásolása
után a kit `lib/`-je **15/15 fájlon bitre a kanonikus 6.6.7**. Két részlet, ami a
tervben nem szerepelt:

- **A csere négy ÚJ kanonikus fájlt is behúz:** `event-contract.ts` (a `gateway.ts`
  importálja), illetve `conversion-commit.ts` · `submit.ts` · `consent-sbo.ts` (az
  `index.ts` re-exportálja). Az utóbbi három a site számára **inert** — a
  `stagePendingConversion` csak az új, opt-in `stageLeadSubmit`/`stageContactSubmit`
  ágakban fut, amiket a site nem hív; az `initTracking` consent-handlerében lévő
  `discardPendingConversions()` üres halmazon dolgozik.
- **A `config.ts` `CLIENT_LIB_VERSION`-je 6.6.6 → 6.6.7.** Ez most válik igazzá: a
  böngésző-láb libje ezzel teljes egészében kanonikus. A szerver-dispatch
  (`src/lib/tracking/gateway-dispatch.ts`) továbbra is fork, ezért a
  `BACKEND_LIB_VERSION = '6.6.4-beautyflow-fork'` jelölés érvényes marad.

### Ami viszont eltörik — öt hívási hely, kettő konverzió-vesztő

A kit forkja **kibővítette** a kanonikus API-t, és a site erre a bővítésre épít. A
típusdeklarációkból mérve:

| # | hívás | helyek | mi törik |
|---|---|---|---|
| 1 | `trackLeadSubmit({… eventName, eventId})` | 3 | a kanonikus `LeadSubmitParams`-ban **nincs `eventId` és `eventName`**; a kanonikus **mindig maga generál** id-t |
| 2 | `trackContactSubmit({… firstName, lastName, eventName, eventId})` | 1 | a kanonikus csak `Pick<'email' \| 'phone'>`-t vesz át — **négy mező elesik** |
| 3 | `trackServerEvent('booking_click', {eventId})` | 1 | a `booking_click` **nincs** a kanonikus `BROWSER_GATEWAY_EVENTS`-ben → a kliens-oldali őr **eldobja** |

**Miért konverzió-vesztő az 1. és a 2.:** a site a szerver-lábbal **megosztott**
`event_id`-t ad át (a `/api/contact` ugyanazzal az id-vel küldi a CAPI-t). Ha a
böngésző-láb saját id-t generál, a **Meta Pixel↔CAPI dedup elszakad** — minden
konzultációs lead kétszer kerül könyvelésre. Ez a CLAUDE.md §16 szabálya.
A 2.-nál ráadásul a `firstName`/`lastName` is elesik → gyengébb advanced matching.

**A 3. csendben öli meg a booking szerver-lábát:** a dataLayer `booking_click` push
site-kód (marad), tehát a 81-es trigger és a rajta lógó GA4/Meta/GAds tagek
változatlanok — de a `trackServerEvent` gateway-lába a kanonikus őrön fennakad.
A hívásnak `begin_checkout`-ra kell váltania (az alias-tábla is ezt mondja).

**Egy consent-szemantika is változik:** a fork a lead-push-t ANALYTICS consenthez
kötötte (`if (analytics) pushLeadConversion(...)`), a kanonikus MARKETING-hez
(`if (!hasMarketingConsent()) return`). Marketing-konverzióra a kanonikus a helyes,
de ez viselkedésváltozás, nem átnevezés.

### Mi a kanonikus szándék, és mi a három út

A kanonikus mag erre a helyzetre a **P5 staging**-et adja: `stageLeadSubmit`
(a böngésző generálja és leteszi az id-t) → submit a szervernek UGYANAZZAL az
id-vel → sikerkor `commitPendingConversion(eventId)` tüzeli el a push-t. Van rá
same-document változat is (`submitTrackedFormAsync`, P5.2). A fork ehelyett egy
egyszerűbb mintát választott: kívülről kapott `event_id`.

1. **(i) A három folyamat átállítása P5 stagingre.** Ez a kanonikus szándék, és
   ráadásként megoldja a navigáció közbeni consent-visszavonást is. Cserébe a három
   konverziós folyamat érdemi átírása, futó appon ellenőrizendő.
2. **(ii) `submitTrackedFormAsync`** — a same-document fetch-útra szabott P5.2
   wrapper; a Beautyflow mindhárom folyamata pontosan ilyen.
3. **(iii) Mag-változtatás: opcionális `eventId` a `LeadSubmitParams`-ban.**
   A legkisebb beavatkozás, és **nem idegen a magtól**: a `trackServerEvent`
   *már ma is* elfogad `eventId`-t ugyanezért. Ez lenne a harmadik eset ebben a
   körben, amikor a fork volt előrébb.

**Ez döntést igényel** — ezért a kliens-PR NEM készült el. A lib-csere maga
elvégezve és mérve; a hívási helyek átírása a döntés után egy menetben mehet.

### Következmény a §6 sorrendre

A GTM 1. lépése (workspace 46) **változatlanul érvényes és publikálható** — a
`booking_click` triggert nem érinti, mert annak a dataLayer-neve site-kódból jön.
A 4. lépés (kliens-PR) viszont bővül: a fenti API-döntés + a `booking_click` →
`begin_checkout` váltás a **fájlcserével egy PR-ben**.

## 7. Nyitott mag-szintű kérdés (nem ennek a cutovernek a része)

A kanonikus `events.ts`-ben két emitter osztozik egy néven, és a helyes használatot ma
**csak egy komment** őrzi („wire ONE of them"). Semmi nem méri, ha egy site mind a
kettőt hívja — a Beautyflow pontosan ezt teszi, és a hibát csak élesben, duplikált
Lead-ként lehetne észrevenni.

**Kérdés a következő körnek:** kapjon-e a mérföldkő saját kanonikus nevet, vagy legyen
egy szerződés-teszt, ami elbukik, ha egy site mindkét emittert hívja? Ez a
flotta-szerződést érinti (`events.json` + alias-tábla), ezért külön döntés.

---

*Mérve: 2026-09-08. Forrás: GTM `GTM-W8V3BVGD` workspace 45 (15 trigger, 27 tag),
`Soborbo/Beautyflow_website@origin/master`, `soborbo-tracking/lib/` (kanonikus 6.6.7).*
