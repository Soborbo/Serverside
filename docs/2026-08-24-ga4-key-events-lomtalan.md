# GA4 kulcsesemények — lomtalan (270977444) · 2026-08-24

**Rövid válasz: nincs gateway-hiba. A GA4 „nulla kulcsesemény" tisztán GA4-admin
konfigurációs hiány — a webhely-újraépítéskor (2026-07) a kulcsesemény-regisztráció
nem költözött át a régi eseménynevekről a kanonikusakra.**

A brief két premisszája megdőlt; mindkettőt bizonyíték cáfolja (lásd 1. és 6. szakasz).
A tervezett 2. feladatot (GA4 MP-láb bekapcsolása a lomtalan tenantra) **nem hajtottam
végre**, mert a mai állapotban **dupla számolást okozna** — indoklás a 3. szakaszban.

---

## 1. Mi történt valójában (a bizonyíték)

GA4 Data API, property 270977444, `eventName` × `yearMonth`:

| hónap | `email_kuldes_esemeny` | `ads_conversion_Ismer_s_1` | `quote_calculator_submitted` | `phone_number_clicked` | `contact_form_submitted` |
|---|---|---|---|---|---|
| 2026-01 | 80 (**kulcs**) | 68 (**kulcs**) | – | – | – |
| 2026-02 | 104 (**kulcs**) | 85 (**kulcs**) | – | – | – |
| 2026-03 | 104 (**kulcs**) | 89 (**kulcs**) | – | – | – |
| 2026-04 | 61 (**kulcs**) | 46 (**kulcs**) | – | – | – |
| 2026-05 | 54 (**kulcs**) | 51 (**kulcs**) | – | – | – |
| 2026-06 | 11 (**kulcs**) | 10 (**kulcs**) | – | – | – |
| 2026-07 | – | – | 19 (kulcs: **0**) | 3 (kulcs: **0**) | 2 (kulcs: **0**) |
| 2026-08 | – | – | 26 (kulcs: **0**) | 8 (kulcs: **0**) | – |

A property **nem** „sosem látott kulcseseményt": összesen 763 kulcsesemény van benne,
de mind a **régi** eseményneveken. 2026-07-ben a régi nevek egy nap alatt megszűntek
(a régi oldal kivezetése), a kanonikus nevek elindultak — és **egyiket sem regisztrálta
senki kulcseseményként**. Innen a „nulla kulcsesemény az elmúlt hetekben".

Ez tehát nem kézbesítési hiba: **az események MEGÉRKEZNEK**, csak nincsenek
kulcseseménynek jelölve.

---

## 2. A GA4 MP-láb állapota a gatewayben (1. feladat)

| kérdés | válasz |
|---|---|
| implementálva? | **igen**, `src/lib/ga4.ts` — teljes, működő MP-kliens |
| per-tenant konfigurálható? | **igen**, `SiteConfig.ga4 { measurement_id, api_secret }` (`src/lib/config.ts:27`) |
| mely tenantokon aktív? | **egyiken sem** — egyetlen KV-configban sincs `ga4` blokk |
| miért nulla a kézbesítés? | **soha nem hívódik meg a konverziós úton** |

A `sendToGA4MP` hívói: `src/routes/debug-ga4.ts` (diagnosztika) és
`src/scheduled/retry.ts` (régi DLQ-rekordok). **A `src/routes/conversion.ts` fan-outban
nincs GA4-ág.** Ez szándékos, két külön döntésből:

- **Modell 2** (`src/routes/conversion.ts:16-19`): az on-site fan-outból a GA4 és a
  Google Ads láb is kikerült. *„On-site GA4 = csak böngésző (GA4 nem dedup-ol
  event_id-re → dupla lenne)."*
- **Offline GA4 kikapcsolva (Run 6)** (`src/routes/lead-status.ts:574-577`):
  `uploaded_to_ga4: false` — a CRM-státuszoknál nincs `client_id`, minden esemény új
  szintetikus GA4-clientbe esne.

Kanonikus megerősítés — `CLAUDE.md` 8. szakasz:

> **Státusz (Run 6): a szerver NEM küld GA4-et.** Az on-site GA4 a böngészőé (GTM);
> az offline GA4-leg kikapcsolva.

A `docs/archive/05-sprint-ga4-mp.md` a fejlécében **archivált**
(`do_not_use_for_implementation: true`), és külön nevesíti, hogy az offline GA4 azóta
törölve lett. Implementációs forrásnak nem használható.

**Nincs `skip_reason` és nincs TRK-9xx kód, mert nincs kihagyott kézbesítés sem** — a
GA4 nem szerepel a fan-out platformlistájában, így ledger-sor sem keletkezik róla.
A Fázis D műszerezettség itt nem „hallgat": nincs mit mérnie.

### Volt-e augusztusi GA4-láb audit/javítás? (0. feladat)

Igen, és **le is szállt** — csak nem „bekapcsolás", hanem **szigorítás** volt:

```
0af457a fix(ga4): a 'source' event param session-forrássá vált
        — cta_context néven megy, client_id nélkül skip (#55)
```

A Painless 2026-08-i auditja (P0-A) azt találta, hogy a `client_id` nélküli random
fallback fantom GA4-sessionöket gyártott, amelyek a kulcsesemények 40%-át vitték. A
javítás óta `client_id` nélkül **nincs** GA4-hívás (`src/lib/ga4.ts:60-72`). A GA4-láb
tehát nem elfelejtve van, hanem **tudatosan zárva**.

A mid-augusztusi ledger-audit megállapítása („a GA4-lábnak nincs sora a `deliveries`
táblában flottaszinten") **ma már pontatlan**: hét sor van, mind `painless`,
mind `accepted`, mind 2026-06-28-ról, és mind **offline** esemény
(`revenue_confirmed` ×6, `lead_qualified` ×1) — a Run 6 előtti offline lábból. Az
on-site GA4-nek valóban nincs és nem is lesz sora.

---

## 3. Miért NEM kapcsoltam be az MP-lábat (2. feladat)

A böngésző **már most elküldi** ugyanezeket a kanonikus eseményeket ugyanerre a
property-re (1. szakasz táblázata, és az 5. szakasz GTM-tagjei). A GA4 **nem dedup-ol
`event_id` alapján**. Ha a gateway ugyanezeket MP-n is elküldené, **minden konverzió
kétszer számolódna** — pontosan az a hiba, amit a Modell 2 megelőz.

A tünetet (nulla kulcsesemény) az MP-láb **nem is orvosolná**: a kulcsesemény-jelölés
GA4-admin beállítás, független attól, honnan érkezik az esemény.

Ha később mégis kell szerveroldali GA4, a **védhető** hatókör csak az, amit a böngésző
nem tud elküldeni: az offline lifecycle-események (`lead_qualified`,
`revenue_confirmed`). Ezekhez viszont előbb a `client_id` tárolását kell megoldani a
lead mellett (`docs/ID-MODEL.md`), különben visszatér a Run 6-ban kikapcsolt
fantom-session probléma. Ez külön munka, nem ennek a hibának a javítása.

**Consent (guardrail).** Mivel nincs szerveroldali GA4-dispatch, nincs saját
consent-kapu sem, amit fenn kellene tartani vagy skip-okkal naplózni. A GA4
böngészőoldali, a Consent Mode v2 natívan kezeli: a site inline scriptje `denied`
defaultot állít, a CookieYes frissíti. `analytics_storage=denied` esetén a GA4
cookieless modellezésre vált — ezt a Google tag intézi, nem mi.

---

## 4. Amit meg kell csinálni (3. feladat) — GA4 admin

**Ezt nem tudtam végrehajtani: a GA4 connector read-only, és a gateway OAuth-scope-ja
`analytics.readonly` (`src/routes/oauth-init.ts:15`). A kulcsesemény-írás
`analytics.edit`-et igényel.**

> A scope kiterjesztését **nem javaslom**: az `oauth-init` `prompt: consent`-tel új
> refresh tokent mint, és ugyanaz a token szolgálja ki a Google Ads offline utat.
> Hat kattintásért a pénz-út tokenjét forgatni rossz csere.

**GA4 Admin → Adatmegjelenítés → Események → „Megjelölés kulcseseményként"**
(property 270977444). A forrás a `src/events.json` `ga4_key_event: true` mezője:

| kanonikus név | most érkezik? | teendő |
|---|---|---|
| `quote_calculator_submitted` | igen (26 / augusztus) | **jelöld kulceseménynek** |
| `phone_number_clicked` | igen (8 / augusztus) | **jelöld kulceseménynek** |
| `contact_form_submitted` | igen (2 / július) | **jelöld kulceseménynek** |
| `callback_request_submitted` | nem — nincs GTM-tag (5. szakasz) | vedd fel kézzel új néven |
| `email_address_clicked` | nem — nincs GTM-tag (5. szakasz) | vedd fel kézzel új néven |
| `whatsapp_button_clicked` | nem — nincs GTM-tag (5. szakasz) | vedd fel kézzel új néven |

A régi `email_kuldes_esemeny` és `ads_conversion_Ismer_s_1` kulceseményeket **hagyd
bekapcsolva** — a historikus adatot őrzik, és 2026-06 óta úgysem tüzelnek.

---

## 5. Másodlagos hiány: 3 kanonikus esemény el sem jut a GA4-be

GTM `GTM-P5D2P8RT` (fiók 6365657931 / konténer 258106310 / workspace 4) — a `gaawe`
típusú GA4-event tagek listája **pontosan három**:

- `GA4 - phone_number_clicked` (tag 16, trigger 8)
- `GA4 - contact_form_submitted` (tag 17, trigger 9)
- `GA4 - quote_calculator_submitted` (tag 18, trigger 10)

A site ezzel szemben **hat** kanonikus konverziót tol a dataLayerbe
(`src/lib/tracking/events.ts:167-239` a lomtalan.hu repóban). A
`callback_request_submitted`, `email_address_clicked` és `whatsapp_button_clicked`
eseményekhez **nincs GA4-tag**, tehát a GA4-be sosem érkeztek meg — nem alacsony
volumen, hanem hiányzó tag.

Ez nem a „nulla kulcsesemény" oka (azt a 4. szakasz javítja), de amíg nem pótolod, a
4. szakaszban kézzel felvett három név üresen áll. **Ezt szándékosan nem hajtottam
végre** — élő konténerbe új tag és trigger írása túlmutat a kiadott feladaton.

---

## 6. A pénz-út: NEM a gateway (4. feladat / guardrail)

A brief szerint „a gateway gads lába szállította a 7 konverziót". **Nem.**

`deliveries` tábla, `site_id='lomtalan'`: **nulla `gads` sor, valaha.** Csak `meta`
(77 accepted, 26 skipped), illetve `linkedin` / `msads` / `tiktok` skip.

Google Ads 6763949425, 2026-08-17..23:

| konverziós művelet | típus | konverzió | érték (HUF) |
|---|---|---|---|
| Lomtalan - Arkalkulator ajanlatkeres | `WEBPAGE` | 4 | 1 397 500 |
| Lomtalan - Telefonhivas (tel kattintas) | `WEBPAGE` | 3 | 0 |
| Lomtalan - Lead qualified (server) | `UPLOAD_CLICKS` | **0** | 0 |
| Lomtalan - Revenue confirmed (server) | `UPLOAD_CLICKS` | **0** | 0 |

A 7 konverzió **`WEBPAGE` típusú**, azaz a **böngésző AWCT-tagjeiből** jön (GTM tag
13/14/15, `conversionId` 766462638, Enhanced Conversions `user_data`-val) — pontosan
úgy, ahogy a Modell 2 előírja. A két szerveroldali `UPLOAD_CLICKS` művelet nullán áll:
a gateway offline gads lába a lomtalanon **még soha nem szállított**.

**Regressziós kockázat a 4. szakasz változtatásától: nincs.** A GA4
kulcsesemény-jelölés külön rendszer, külön tagek, külön konverziós műveletek.
Ledger-diff sem értelmezhető, mert nincs érintett `gads` ledger-sor. A 7 napos
figyelés attól még hasznos — a baseline a fenti táblázat.

---

## 7. Ellenőrzés a 4. szakasz után

1. GA4 → Jelentések → **Valós idejű**: futtasd le a kalkulátort;
   `quote_calculator_submitted` jelenjen meg, és a kulcsesemény-számláló nőjön.
2. 24–48 óra múlva: `eventName` × `keyEvents` riport — a három regisztrált néven a
   `keyEvents` egyezzen az `eventCount`-tal.
3. 7 napos figyelés: a Google Ads `WEBPAGE` műveletek konverziószáma **ne essen** a
   6. szakasz baseline-ja alá.
4. **Ne** importáld az új GA4-kulceseményeket Google Ads konverziónak, amíg a
   `WEBPAGE` AWCT-műveletek élnek — ugyanaz a konverzió kétszer kerülne be az Adsbe.
   (A property három meglévő GA4-import művelete — `email_kuldes`,
   `email_kuldes_esemeny`, `Ismerős` — mind `primaryForGoal: false` és
   `includeInConversionsMetric: false`, tehát a licitre nem hatnak.)

---

## 8. Kiterjesztés a flottára (5. feladat — NE hajtsd végre most)

Amit a lomtalan tanít, az **nem** egy gateway-konfigsor, hanem egy **audit-kérdés**
minden tenantra: *a GA4 property kulceseményei a `src/events.json` kanonikus nevein
állnak-e, vagy egy korábbi build legacy nevein?* Bármelyik site, amelyik újraépítés
alatt nevet váltott, ugyanezt a néma nullát mutatja.

A konformancia-mátrixba tenantonként három oszlop való:

| oszlop | forrás |
|---|---|
| `ga4_property_id` | KV `recon.ga4_property_id` |
| `key_events_registered` | GA4 Admin — kanonikus neveken? (i/n) |
| `ga4_tags_complete` | GTM — van-e `gaawe` tag mind a 6 kanonikus konverzióra? |

A `SiteConfig.ga4` blokk **maradjon üresen minden tenanton**, amíg a böngésző küldi a
GA4-et (Modell 2). Ez a bekapcsolás nem „ugyanaz a konfig per tenant" — dupla számolás.
