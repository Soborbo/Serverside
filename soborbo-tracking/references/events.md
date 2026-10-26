# Eseménynevek

**Egyetlen forrás:** `../src/events.json`. Ugyanaz a név megy a
dataLayerbe, a GTM-triggerbe, a GA4-be és a gatewaynek. Ember által olvasható tábla:
`docs/CANONICAL-EVENTS.md`. Ha kódban, GTM-ben vagy egy régi doksiban más nevet
látsz (`calculator_conversion`, `phone_click`, `form_submit`, `quote_request` …),
az régi dialektus. A `generate_lead` külön eset, lásd lent (I11).

## Fő nevek

| Név | Fajta | Meta | Böngésző-láb (dataLayer → GTM) | Gateway-ingress |
|---|---|---|---|---|
| `quote_calculator_submitted` | konverzió | Lead | igen — GA4, Meta Pixel, Google Ads (`TrackedForm`) | csak szerver (site-backend) |
| `callback_request_submitted` | konverzió | Lead | igen — GA4, Meta Pixel, Google Ads | csak szerver (site-backend) |
| `contact_form_submitted` | konverzió | Contact | igen — GA4, Meta Pixel, Google Ads (`TrackedForm`) | csak szerver (site-backend) |
| `order_request_submitted`, `purchase` | konverzió | Lead / Purchase | a kanonikus konténer nem köti be | csak szerver (site-backend) |
| `phone_number_clicked`, `email_address_clicked`, `whatsapp_button_clicked` | konverzió | Contact | igen | böngészőút is |
| `quote_calculator_opened` | engagement | ViewContent | igen | — |
| `quote_calculator_step_completed`, `quote_calculator_option_selected`, `form_abandoned`, `scroll_depth` | engagement | — | igen | — |
| `lead_validated` … `revenue_confirmed`, `lead_disqualified` | offline | — | — | CRM → `/lead-status` |

A „csak szerver” CSAK a gateway-ingressre vonatkozik: a form-konverzió böngésző-lábát
(dataLayer → GTM → GA4 / Pixel / Ads) ugyanúgy be kell kötni, a két láb közös
`event_id`-vel deduplikál. A böngészőből a gatewaynek küldött form-esemény 403
(TRK-400-017).

A teljes lista, a régi GA4- és dataLayer-nevek (`legacy_ga4`, `legacy_datalayer`)
és a GA4 Key Event jelölés az `events.json`-ban van.

## Élő site átnevezése

Élő GA4-eseményt nem nevezünk át menet közben: a múltbeli összevetés megszakad, és
az Ads-konverziót is át kell kötni. Út: per-site `event-aliases.json` +
`cutover_date`, a két név legalább 7 napig párhuzamosan
(`docs/EVENT-MIGRATION.md`, `docs/MIGRATION-existing-sites.md`). A gateway a régi
GA4-neveket a belépéskor kanonikusra fordítja.

## GA4 `generate_lead` (I11): még nincs bekötve

László döntése (I11): élő site-on a mai kanonikus nevek maradnak; **új site-on** a
GA4 lead-eseménye `generate_lead` legyen, `lead_type` paraméterrel (pl.
`calculator`, `callback`, `contact`), hogy a GA4 beépített lead-riportjai működjenek.

Ez ma **ütközik** a repó szerződésével: az `events.json`-ban nincs `generate_lead`,
a GTM-generátor a GA4-nevet a dataLayer-névvel azonosra állítja, és a
`check:engine-events` / `check:gtm-contract` ezt őrzi. Amíg az `events.json` és a
`gtm/gen-container.mjs` nem kap site-szintű GA4-név-leképezést, **ne képezd át
kézzel a GTM-ben**; új site is a kanonikus nevekkel indul. (Nyitott kérdés a
PR-ban.)

## Ismert névütközések a kódban (jelzés, nem javítva)

- `trackCalculatorComplete()` (`lib/events.ts`) `quote_calculator_submitted` néven
  pushol, `event_id` nélkül. Ha a site ezt **és** a `TrackedForm` lead-pusht is
  bekötötte, a GTM két Lead-et lát, amiből az egyik dedupolhatatlan. Site-onként csak
  az egyik legyen a quote-konverzió.
- `trackCallbackClick()` (`<CallbackButton/>`) puszta kattintásra
  `callback_request_submitted` néven pushol, analytics consenttel. Ez a GA4 Key
  Event nevét viseli beküldés nélkül. Audit közben: a valódi callback-konverzió a
  form-beküldés szerverlába.
- `trackCalculatorStart()` minden hívásra tüzel, pedig az INVARIANTS #10 szerint a
  ViewContent böngészőnként egyszer menne.

## Új esemény felvétele

`events.json` → `npm run gen:gtm` és `npm run gen:aliases` (soborbo-tracking/) →
`docs/CANONICAL-EVENTS.md` → tesztek. A GTM-konténer commitolt artefaktum; új
dataLayer-esemény konténerfrissítés nélkül csendben elveszik.
