# Offline-loop + lomtalan attribúció audit — 2026-07-16

Élő rendszerek ellenőrzése (Cloudflare deployolt bundle-ök, CRM D1 adatbázisok,
D1 ledger, Google Ads API), a 2026-07-16-i brief nyomán. **A brief két központi
állítása közül az egyik ELAVULT volt** — ez a doksi a mért állapotot rögzíti.

## 1. A CRM → lead-status bekötés MÁR LÉTEZIK (a brief tévedett)

A brief azt állította, hogy sem a `painlesscrm`, sem a `lomtalan-crm` workerben
nincs lead-status hívás. **A 2026-07-16-án deployolt bundle-ökben van**:

- `lomtalan-crm` (deploy: 2026-07-13) és `painless` (az aktív Painless CRM,
  deploy: 2026-07-15) egyaránt tartalmazza a
  `src/lib/integrations/tracking-worker.ts` modult:
  `forwardLeadStatusToWorker` → POST `TRACKING_WORKER_URL`,
  `X-Admin-Token: TRACKING_ADMIN_TOKEN`, TRK-FWD-001..004 hibakódokkal.
  (A brief valószínűleg a RÉGI `painlesscrm` workert grepelte — az tényleg üres,
  de 2026-06-23 óta nem az az élő CRM.)
- A `lead_id` kapocs ÉP: a 2026-07-15-i két valódi lomtalan lead gateway-beli
  `lead_id`-je (`780a1d0c-…`, `9d9d8d80-…`) SZÓ SZERINT a CRM `leads.id` PK-ja.
- A CRM-séma kész az attribúcióra: `lead_attribution` tábla gclid/gbraid/
  wbraid/fbclid/fbc/fbp/msclkid oszlopokkal.

### Miért nulla mégis a ledger `lead_status` táblája 06-28 óta?

Három együttes ok, MINDHÁROM operatív, nem kód-hiba a gateway-ben:

1. **Csak a `lezart_nyert` státusz forwardol** (`STATUS_EVENT_MAP =
   { lezart_nyert: "revenue_confirmed" }`). A tölcsér többi állomása
   (kvalifikált → `lead_qualified`, stb.) szándékosan nincs bekötve („itt
   bővíthető").
2. **Egyetlen lead sem jutott el a `lezart_nyert`-ig.** Lomtalan: 9 lead, MIND
   `uj` státuszban ül (senki nem adminisztrálja a CRM-et). Painless: 8 lead,
   mind `kiosztva`. Nulla TRK-FWD-* hiba a CRM `error_events` táblákban — a
   forwarder soha nem kapott okot tüzelni, és sosem hibázott.
3. **`marketing_consent` szinte mindenhol 0** (lomtalan: 9/9, painless: 7/8).
   A CRM `ad_allowed: lead.marketingConsent === true`-t küld, a gateway
   fail-closed → megnyert lead esetén is `consent_blocked` lenne az upload.
   Figyelem: a 07-15 19:34-es lomtalan lead a gateway-ledgerben `ad_allowed=1`
   (Consent Mode: granted), a CRM-ben mégis `marketing_consent=0` — a weboldal
   → CRM lead-capture NEM viszi át a consent-jelet. Ha ez így marad, a bekötött
   offline loop élesben is némán nullát fog termelni.

### Teendők (CRM/weboldal repo — NEM ez a repo)

- [ ] A lomtalan/painless lead-capture vigye át a marketing-consent jelet a CRM
      `marketing_consent` mezőjébe (a gateway-nek küldött consent-tel azonosan).
- [ ] CRM-folyamat: a leadeket ténylegesen státuszolni kell (`uj` → … →
      `lezart_nyert`), különben a loopnak nincs mit feltöltenie.
- [ ] Mérlegelendő: `STATUS_EVENT_MAP` bővítése (`kvalifikalt: lead_qualified`)
      — az events.json szerint a `lead_qualified` „a bid-optimalizáció elsődleges
      offline célja", és a Google Ads oldalon már létezik hozzá conversion action
      (lásd lent).
- [ ] Ellenőrzés a CRM deployban: `TRACKING_WORKER_URL` + `TRACKING_ADMIN_TOKEN`
      env be van-e állítva (MCP-ről nem olvasható ki). Ha nincs: TRK-FWD-001
      jelenik meg az error_events-ben az ELSŐ nyert leadnél — előbb érdemes
      tesztelni, mint éles nyert leadre várni.

### Gyors élő teszt (amikor a token kéznél van)

```bash
curl -sS -X POST https://lomtalan.hu/api/event/lead-status \
  -H "X-Admin-Token: $LOMTALAN_CRM_TOKEN" -H "Content-Type: application/json" \
  -d '{"lead_id":"780a1d0c-76d3-45fd-8f71-f047feeb2d27","status":"lead_qualified",
       "ad_allowed":true,"occurred_at":"2026-07-16T12:00:00Z",
       "user_data":{"email":"<a lead valós emailje a CRM-ből>"}}'
```
(A 19:16-os lead — `9d9d8d80-…` — consent-DENIED volt capture-kor, azt ne.)

## 2. Google Ads oldal (KV-audit eredménye)

MCC: `Soborbo` = **3063851682** (megerősítve). Lomtalan = `6763949425`
(„Flóri - lomtalan.hu"), Painless = `4886655031`.

- **Painless**: működő offline cél van — `Revenue confirmed (server)`
  (UPLOAD_CLICKS, id `7665215416`), a júniusi `dm-validate-*` 4/6 sikeres
  uploadja bizonyítja, hogy a KV `gads` blokk él. On-site (GTM) célok:
  `Callback requested` (7607816151), `Quote calculator finished` (7607796871),
  `Contact form submit` (7607812689).
- **Lomtalan**: NEM volt semmilyen upload-típusú (ECL) conversion action. Az
  auditban LÉTREHOZVA (a painless mintájára: UPLOAD_CLICKS, ONE_PER_CLICK,
  90 nap, data-driven, `primary_for_goal=false` → bidding-hatás nélkül):
  - `Lomtalan - Revenue confirmed (server)` = **7687649967** (category: PURCHASE)
  - `Lomtalan - Lead qualified (server)` = **7687649970** (category: QUALIFIED_LEAD)
  On-site (GTM/webpage) célok: `Lomtalan - Telefonhivas (tel kattintas)`
  (7683359194), `Lomtalan - Kapcsolat urlap` (7683359197),
  `Lomtalan - Arkalkulator ajanlatkeres` (7683359200).

### KV-patch (kézzel futtatandó — a sessionben nincs wrangler auth)

A jelenlegi értékek kiolvasása:

```bash
wrangler kv key get --binding=SITE_CONFIG "lomtalan.hu" --remote | jq .gads
wrangler kv key get --binding=SITE_CONFIG "painlessremovals.com" --remote | jq .gads
```

A lomtalan `gads` blokk elvárt állapota (a `www.lomtalan.hu` kulcson is!):

```json
"gads": {
  "customer_id": "6763949425",
  "login_customer_id": "3063851682",
  "conversion_actions": {
    "revenue_confirmed": "7687649967",
    "lead_qualified": "7687649970"
  }
}
```

Az új cross-platform reconciliationhöz (lásd 3. pont) mindkét site-ra:

```json
// painlessremovals.com (+ www)
"recon": {
  "ga4_property_id": "413271735",
  "gads_onsite_actions": {
    "callback_request_submitted": "Callback requested",
    "quote_calculator_submitted": "Quote calculator finished",
    "contact_form_submitted": "Contact form submit"
  }
}

// lomtalan.hu (+ www) — a ga4_property_id-t ki kell deríteni: a lomtalan GA4
// property NEM látszik a golaxo@gmail.com fiókból (a Google Ads-ben a linkelt
// "Lomtalan.hu (web)" célok léteznek, tehát property van — hozzáférés kell).
"recon": {
  "gads_onsite_actions": {
    "quote_calculator_submitted": "Lomtalan - Arkalkulator ajanlatkeres",
    "contact_form_submitted": "Lomtalan - Kapcsolat urlap",
    "phone_number_clicked": "Lomtalan - Telefonhivas (tel kattintas)"
  }
}
```

Patch után 5 percig a régi config propagálhat (KV edge-cache TTL 300s).

**GA4-leg élesítése**: a meglévő refresh tokenek scope-ja datamanager+adwords.
Egyszeri re-consent kell customer-enként:
`/api/event/oauth-init?customer_id=4886655031` (admin tokennel) — az új consent
már az `analytics.readonly`-t is adja. Addig a GA4-láb 403-mal logolt-skippel
(TRK-950-006), a Google Ads-láb viszont azonnal megy.

### TRK-840-003 (a júniusi 2 elbukott dm-validate)

A `dm-validate-painless-001` és `-002` bukott, a `-003..-006` és a július 16-i
állapot szerint minden későbbi sikeres. A hibarészletek nem tárolódnak a
ledgerben (csak a kód), a Workers-log már nem elérhető. A mintázat (első két
próbálkozás bukik, minden későbbi megy) validálás közbeni config/payload-
iterációra utal, nem élő hibára. A datamanager.ts azóta logolja az
`error.details[]`-t (dm_error_details) — ha újra előjön, a log diagnosztikus.

## 3. Ledger ↔ GA4 ↔ Google Ads kereszt-ellenőrzés (EBBEN a repóban leszállítva)

Lásd `src/lib/cross-check.ts` + a napi reconciliation cron kiegészítése
(`src/scheduled/reconciliation.ts`), hibakódok: TRK-950-005/006
(docs/error-codes.md). Konfiguráció: a SITE_CONFIG `recon` blokkja (fent).

Mérési tanulság az implementációból: a Google Ads „aznapi" száma NAGYON függ a
számítás módjától — kattintás-dátum szerint (UI default) vs konverzió-dátum
szerint. A check a `metrics.all_conversions_by_conversion_date`-et használja
(élőben validált query-alak), mert az hasonlítható a ledger fogadás-idejéhez.
Pl. 2026-07-15-re konverzió-dátum szerint a Painless fiókban 0 konverzió van,
07-16-ra 2 callback + 3 kalkulátor — a brief táblázata (2+2 „aznap")
kattintás-attribúciós nézetből származott.

## 4. Lomtalan click-ID capture (lomtalan-weboldal repo — NEM ez a repo)

Megerősítve: a deployolt `lomtalan-weboldal` bundle-ben nincs gclid-kezelés, és
a CRM `lead_attribution` tábláján mind a 8 lomtalan sor gclid/fbclid/utm nélkül
áll (a painless oldalon 3/8 sorban van gclid — ott a capture működik).

A CRM-séma kész, a gateway kész — KIZÁRÓLAG a weboldal front-endje hiányzik.
A painlessremovals-website `mapAttribution`-jét kell portolni:

1. Landoláskor: URL-paraméterek (`gclid`, `gbraid`, `wbraid`, `fbclid`,
   `msclkid`, `utm_*`) + `document.referrer` + landing URL → localStorage
   (first-touch megőrzéssel, last-touch frissítéssel).
2. Cookie-olvasás: `_fbp`, `_fbc` (ha a Meta pixel él majd).
3. Form-submitkor: a tárolt attribúció rejtett mezőkként / payload-mezőként
   megy a CRM lead-capture-be (a `lead_attribution` oszlopnevek 1:1 megvannak)
   ÉS a gateway konverziós eventjébe.
4. Enhanced Conversions for Leads gclid NÉLKÜL is működik (email-hash match),
   tehát nem blokkoló — de gclid-del jobb a match rate, és a Data Manager
   TRK-840-007 (no identifiers) skipje ellen is véd.

## 5. wrangler.toml

`SMOKE_SITES` vs hiányzó lomtalan route: tisztázó komment + kikommentezett
lomtalan route-blokk került a fájlba (a lomtalan service bindingon hívja a
gateway-t, zóna-route szándékosan nincs).
