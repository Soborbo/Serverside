# soborbo-tracking — változásnapló

A verzió három helyen él, és mind a háromnak egyeznie kell (`npm run
check:package-version` a repó gyökeréből): `package.json` · `lib/config.ts`
`CLIENT_LIB_VERSION` · `server/backend/gateway-dispatch.ts` `BACKEND_LIB_VERSION`.

Ez a napló a **6.3.0-tól** vezetett. A korábbi verziókról nincs rekonstruált
bejegyzés — a git-történet az egyetlen forrás rájuk, és nem írunk ide olyat,
amit nem tudunk bizonyítani.

---

## 6.17.4 (2026-10-30)

A consent-proof nem veszhet el konfig-lemaradás miatt (CMP pilot-review, A3/B3).
Gateway-változás is van, lásd lent.

### Javítva — 404-re a döntés megmarad a pending sorban (`lib/consent-sbo.ts`)

A kliens minden 4xx-re (429 kivételével) törölte a még nem nyugtázott döntést. A
SkinLabon 2026-09-18 → 10-16 a KV még nem volt `provider: 'sbo'`, a végpont
elutasított, és a négy hét összes consent-bizonyítéka némán elveszett — a süti
közben élt és konverziókat kapuzott (gazdátlan `consent_id`-k a receiptekben). A
404 (hiányzó site-proxy vagy host-config) mostantól retryable: a pending marad, és
a következő oldalletöltés újraküldi. A 400 (hibás payload) továbbra is végleges.

### Gateway (`src/routes/consent.ts`) — 503 a saját kliens config-lemaradására

Ha a `POST /api/consent` kérés `sbo_consent` sütit hoz, de a host configja hiányzik
vagy nem `provider: 'sbo'`, a válasz **503 + `Retry-After: 3600`** (TRK-910-011,
critical), nem 403/404. Ez a MÁR kint lévő klienseket is védi (a 6.9.0–6.17.3 az
5xx-et eddig is újraküldte). Süti nélküli hívóra és CookieYes-site-ra a végpont
változatlanul inert 403.

## 6.17.3 (2026-10-30)

Két javítás, a 6.16.0 → 6.17.x GitHubos Codex-reviewjából (Serverside #156).
Gateway-változás nincs.

### Javítva — a friss landing klikk-ID-je mellé a saját kampánya kerül (`lib/gateway.ts`)

A 6.17.1 óta a klikk-ID az `sb_tracking`-ből jön, a UTM-csoport viszont továbbra is
a gateway-tárolóból (`__sb_attribution`), ami egy KORÁBBI konverzió kampányát őrzi.
Régi vásárlás (`utm_campaign=OLD`) → új `gbraid`-es, `utm_campaign=NEW` landing →
árlap: a payload `gbraid=NEW` + `utm_campaign=OLD` volt. Most, ha az URL nem hoz
UTM-et és az `sb_tracking`-nek van kampánya, a teljes UTM-csoport onnan jön.
Kampány nélküli `sb_tracking` a tárolóét nem törli.

### Javítva — a gateway alsó határa alatti `eventTime` → most (`server/backend/gateway-dispatch.ts`)

A `resolveEventTime` csak a nem pozitív értéket cserélte. Egy `eventTime: 1` (vagy
`0.5`) változatlanul ment ki, a gateway a `1_500_000_000` alatti `event_time`-ot
400-zal elutasítja, a küldő pedig ezt nem próbálja újra — az esemény elveszett.
Most a gateway határa alatt is a mostani idő megy.

---

## 6.17.2 (2026-10-30)

Két javítás, a 6.17.1 független (Codex GPT-6 Astra xhigh) reviewjából (Serverside #156).
Gateway-változás nincs.

### Javítva — a gateway-tároló és az `sb_tracking` szinkronban marad (`lib/gateway.ts`, `lib/persistence.ts`)

A 6.17.1 a `collectAttribution`-ben feltétel nélkül az `sb_tracking`-et tekintette a
frissebb forrásnak. Ha az `initTracking` a CookieYes API elkészülte előtt futott, az
`sb_tracking` nem kapta meg az oldal kattintását, a `collectAttribution` viszont (a
süti alapján) igen — a következő URL-jel nélküli oldalon a régebbi tárolt ID írta
vissza az újabbat (Google és msclkid/fbclid egyaránt). Most a `collectAttribution`
ad-grant mellett előbb maga perzisztálja az URL-jeleket (`persistTrackingParams({ granted: true })`),
így a két tároló ugyanazt a kattintást látja.

### Javítva — változatlan Google-kattintás nem kap új bélyeget (`lib/persistence.ts`)

Ugyanaz a címkézett URL újra-perzisztálva (pl. consent-callback) a `googleClickAt`-et
a mostani időre állította, így egy közben érkezett újabb `_gcl_aw` elé került, és a
következő konverzió a régi braid-et vitte. A bélyeg most csak új klikk-ID-nél
(kulcs vagy érték változik) frissül — ahogy az `fbclidAt` is.

---

## 6.17.1 (2026-10-29)

Egy javítás, a paywalled_boilerplate #92 + #94 Codex-review-jából. Gateway-változás
nincs; a tárolt `sb_tracking` blob két új, opcionális mezőt kap.

### Javítva — a friss landing kattintása túléli a továbblépést (`lib/gateway.ts`, `lib/persistence.ts`, `lib/google-click-id.ts`)

Régi `_gcl_aw` süti → új gbraid-es landing → árlap → vásárlás: a konverzió a RÉGI
gclid-del ment. A `collectAttribution` tárolója (`__sb_attribution`) csak a
konverziós oldalon íródik, a landing kattintását az oldalmegtekintésenként írt
`sb_tracking` őrzi — de a gateway azt nem olvasta, így az árlapon (URL-jel nélkül)
a `_gcl_aw` > tároló sorrend a süti régi gclid-jét választotta. A `_gcl_aw` a
gbraid/wbraid-es kattintástól nem frissül.

- `sb_tracking` rögzíti a Google klikk-ID érkezési idejét (`googleClickAt`, ms).
- `resolveGoogleClickId` új 4. szabálya: ha a süti (`GCL.<mp>.`) és a tárolt
  kattintás ideje is ismert, az ÚJABB nyer. Időbélyeg nélküli (régi) blobnál a
  korábbi sorrend marad (URL > `_gcl_aw` > tároló).
- `collectAttribution` a Google-döntéshez az `sb_tracking` kattintását veszi
  (időbélyeggel), ha van; az `fbclid`-et és az `msclkid`-et is onnan tölti, ha az
  URL most nem hozott sajátot. Ugyanazon a marketing read-gate-en, ad-grant
  nélkül nem olvas.
- `sb_tracking` mostantól az `msclkid`-et is tárolja (eddig a landing után
  elveszett).

Teszt: `tests/fresh-landing-click.test.ts` (10 eset; a javítás nélkül 6 bukik).

---

## 6.17.0 (2026-10-29)

Három javítás, mind a paywalled_boilerplate mérési munkájából (MERESI_TERV,
PR #89 / #91). Gateway-változás nincs.

### Javítva — a marketing-azonosítók a marketing-hozzájáruláshoz kötöttek (`lib/events.ts`)

A `stripIdentifiersWithoutConsent` minden azonosítót az analytics-hozzájáruláshoz
kötött. Egy marketing-only hozzájárulású látogató konverziós pushából
(`trackLeadSubmit`, `trackContactSubmit` — ezek épp a marketing-hozzájárulás
alapján mennek ki) így kiesett a `gclid` és a teljes `first_*`/`last_*`
attribúció, basic módban is. Most két külön kapu van: `session_id`/`client_id`/
`user_id` → analytics; klikk-ID-k, `fbp`/`fbc`/`external_id`, `first_*`/`last_*`
→ marketing. A marketing-minta csak a valódi attribúció-kulcsokat fogja
(`first_|last_` + `utm_*`/klikk-ID): a `form_abandoned` `last_field` mezője
(a fókuszált mező neve) analytics-adat, megmarad. (Codex review,
paywalled_boilerplate #89 és Serverside #154.)

### Javítva — a kampány egy kattintásé (`lib/persistence.ts`, `lib/gateway.ts`)

A `persistTrackingParams()` (`sb_tracking`) és a `collectAttribution()`
(`__sb_attribution`) mezőnként olvasztotta a friss URL-t a tárolóba: egy
`utm_source=newsletter` látogatás mellett a korábbi `utm_campaign=spring`
megmaradt — egy soha nem létezett kampány ment a konverzióba. Most ha a friss
URL bármelyik UTM-et hozza, a tárolt UTM-csoport egészben kiesik
(`withoutStaleCampaign`). UTM nélküli látogatás nem törli a tárolt kampányt.
(Codex review, paywalled_boilerplate #92.)

### Hozzáadva — `GatewayConversionInput.eventTime` (`server/backend/gateway-dispatch.ts`)

A `buildGatewayPayload` eddig mindig a küldés pillanatát írta `event_time`-nak.
Egy késleltetett szerver-dispatch (Stripe-webhook, cron-retry) így a konverziót
a küldés idejére könyvelte. Az új, opcionális `eventTime` (unix mp) az eredeti
idő; hiányzó, értelmetlen vagy jövőbeli érték esetén marad a „most”.

---

## 6.16.0 (2026-10-19)

Három kis csomag-változás az attribúció köré — a skinlab kanonikus kitre
váltásának (S1) utolsó kit-oldali előfeltételei (port-mátrix K2 / K3 / K7).
Gateway-változás nincs: a Worker az `external_id`-t eddig is fogadta és
hash-elte (`src/lib/hash.ts`).

### Hozzáadva — Meta `external_id` végponttól végpontig: `sb_uid` (K2)

`getExternalId()` (`lib/persistence.ts`, exportálva a `lib/index.ts`-ből): első
féltől származó, véletlen UUID a `sb_uid` localStorage-kulcsban. **Csak
marketing-hozzájárulással jön létre**, és az OLVASÁSA is a marketing
read-gate-en megy (hozzájárulás nélkül `null`, a blokk a
`storage_read_blocked_keys` telemetriában — a skinlab-fork gate nélkül olvasott,
a kit szándékosan szigorúbb). A visszavonás (`purgeMarketingStorage`) és a
`clearTrackingData` törli.

- Böngésző-láb: a `sendToWorker` a `user_data.external_id`-t a hívó értékéből,
  ennek hiányában a `getExternalId()`-ből tölti. Hozzájárulás nélkül SEMMILYEN
  `external_id` nem megy ki — a hívóé sem. PLAIN, a Worker hash-el. Az advanced
  mód süti nélküli pingjei változatlanul azonosító-mentesek.
- Rejtett mezők: a `populateHiddenFields` / `attachEventIdToForm` az
  `external_id` mezőt is kitölti, HA az űrlapon van ilyen input (újat nem hoz
  létre); a `<TrackedForm>` rendereli.
- Szerver-láb: `GatewayUserData.external_id` — a `buildGatewayPayload`
  változatlanul továbbítja (a skinlab backendje eddig típushibát kapott volna).
- Süti-tábla: új `sb_uid` sor (localStorage, marketing, visszavonásig, törlődik
  a visszavonáskor); az inventory `version` → `2026-10-b`. A tájékoztató-/banner
  szöveg verziója NEM változik: a banner nem sorol fel kulcsokat, a táblát a
  `<CookiePolicy />` az inventoryból rendereli.

**Változott a telemetria:** megtagadott marketing mellett a
`storage_read_blocked_keys` mostantól a `sb_uid`-t is tartalmazza (az olvasás
ugyanazon a kapun megy, mint a `_fbp`/`_fbc`-é).

### Javítva — a `collectAttribution` hivatkozója csak KÜLSŐ lehet (K3)

A first-touch `attribution.referrer` nyers `document.referrer` volt, ami a 2.
oldaltól a SAJÁT előző oldalunk (skinlab CRM: 95 sorból 86 belső hivatkozó).
Most csak eltérő hosztú hivatkozó fogadható el (`www.` és apex ugyanaz a
webhely), origin+útvonal alakban (query/hash nélkül), max 500 karakter. Olvasáskor
a tárolt belső referrer törlődik (régi blobok gyógyítása). A `landing_page`
first-touch szemantikája változatlan.

Új, opcionális horog: `setEntryContextProvider(fn)` (`lib/index.ts`). A site saját
belépési-attribúció modulja adhatja a first-touch `landing_page` / `referrer`
értékét; elsőbbség: tárolt first touch > a szolgáltató nem üres értéke >
beépített fallback. A szolgáltató hivatkozója is a külső-only szűrőn megy át, a
`landing_page`-nek saját webhelyre kell mutatnia.

### Javítva — klikk-ID higiénia (K7)

- A `sb_first_touch` az összecsukott Google klikk-ID-t kapja: egy
  `?gclid=…&gbraid=…` URL eddig mindkettőt beírta (a first touch soha nem íródik
  felül). Ma csak a `first_gclid`-et olvassa bármi, tehát élő torzulás nem volt.
- A rejtett mezők `gbraid` / `wbraid` értéket is kapnak (a `getAllTrackingData()`
  kizárólagos ID-jéből), ha az űrlapon van ilyen input; a `<TrackedForm>`
  rendereli őket. Az iOS-forgalom klikk-ID-je eddig kimaradt a backend POST-ból.

### Site-teendő

- **Süti-tábla:** a `<CookiePolicy />` automatikusan mutatja az új `sb_uid`
  sort. Ahol a site KÉZZEL írt süti-táblát tart (vagy a CookieYes
  süti-listáját kézzel tölti), ott a `sb_uid` sort fel kell venni (localStorage,
  marketing, visszavonásig).
- **Backend:** a form-POST route a `form.get('external_id')`-t adja tovább
  `userData.external_id`-ként (PLAIN), a `gbraid` / `wbraid` mezőket az
  `attribution`-be — lásd `server/backend/README.md`. Saját (nem `TrackedForm`)
  űrlapon a három rejtett inputot fel kell venni.
- **Belépési-attribúció modullal rendelkező site-ok** (pl. skinlab
  `entry-attribution.ts`): bootkor
  `setEntryContextProvider(() => ({ landing_page: getEntryLandingUrl(), referrer: getEntryReferrer() }))`,
  hogy a böngésző-láb ugyanazt a belépési oldalt/hivatkozót küldje, mint a CRM.

## 6.15.0 (2026-10-19)

### Hozzáadva — advanced Consent Mode az sbo CMP alatt (`PUBLIC_TRACKING_CONSENT_MODE`)

Eddig az sbo CMP kizárólag basic módban futott: döntés előtt és elutasítás után a GTM be sem töltődött, így a Google semmilyen jelet nem kapott (nincs GA4-modellezés, nincs Ads konverzió-modellezés). `PUBLIC_TRACKING_CONSENT_MODE=advanced` mellett a boot a denied default (+ `ads_data_redaction`) után MINDIG betölti a GTM-et; egy érvényes korábbi döntés update-je szinkron, a GTM ELŐTT kerül a dataLayerbe. Default továbbra is `basic`; bármely más érték basic (elgépelés nem indíthat pre-consent GTM-et). A `consent_log.consent_mode` mostantól a ténylegesen futó módot rögzíti (eddig fixen `basic` volt). Feltétel: a GTM-konténerben minden nem-Google tag consent-kapus legyen.

### Hozzáadva — opt-in kiemelt Elfogadom gomb (`PUBLIC_TRACKING_CONSENT_ACCEPT_EMPHASIS=1`)

Eltérő szín (`--sb-consent-accept-bg`, alap `#1a7f37`, 5,1:1 kontraszt), szélesebb oszlop, nagyobb betű — a CookieYes alapbannerének mintájára. A gombparitás TUDATOS, site-onkénti kivétele; kikapcsolva a markup és a CSS bitre a régi. A banner-verzió `-e` utótagot kap (`2026-09-a-b2-e`), így az elfogadási arány külön mérhető.

### Hozzáadva — süti nélküli Google-pingek advanced módban (konverzió- és viselkedés-modellezés)

sbo + `PUBLIC_TRACKING_CONSENT_MODE=advanced` mellett hozzájárulás NÉLKÜL is megy dataLayer-push a kalkulátor-, klikk-, görgetés-, elhagyás- és a lead/kapcsolat-konverzió eseményekre, de AZONOSÍTÓK nélkül (session_id, klikk-ID-k, first_/last_ attribúció levágva; PII az EC-csatornába sem). A GTM denied default alatt fut, így a GA4 és a Google Ads süti nélküli pinget küld — ebből modellez a Google. Meta és más nem-Google tag a GTM-ben consent-kapus marad. Tárolás, gateway-lábak és a staging-ág változatlanul consent-kapus. CookieYes alatt és basic módban bitre a régi. Kapu: `isCookielessPingAllowed()`.

### Változott — kiemelt módban a nem-Elfogadom gombok keretesek

A CookieYes mintájára csak az Elfogadom kitöltött színes gomb; az Elutasítom és a panel Mentés gombja üres hátterű, keretes (a Beállítások stílusa).

### Hozzáadva — `sbo_consent_update` dataLayer-esemény minden döntéskor

`{event:'sbo_consent_update', consent_analytics, consent_marketing}` — a CookieYes `cookie_consent_update` párja. Advanced módban a GTM az oldalbetöltéskor denied állapotban indul, ezért a consent-kapus tagek (pl. Meta Pixel base) az első oldalon kimaradnak, és a GTM magától nem indítja újra őket. Erre az eseményre kötött triggerrel ugyanazon az oldalon lefutnak. Advanced módra váltáskor a GTM-ben ezt a triggert hozzá kell adni a consent-kapus betöltő tagekhez.

### Dokumentáció — a gateway KV `consent.provider=sbo` kemény ellenőrzése

Az INSTALL most kötelező, `curl`-lel ellenőrizhető lépésként írja elő. Hiánya miatt a skinlabhungary.hu 2026-09-18 óta egyetlen döntés-bizonyítékot sem tárolt (403 → TRK-4002 → eldobva).


## 6.14.0 (2026-10-19)

Négy kis, additív csomag-bővítés — a skinlab kanonikus kitre váltásának
előkészítése (a site ma a 6.13-as kit saját forkját futtatja, és pontosan ezek
a különbségek tartják a forkban). Gateway-változás nincs; a worker a 6.13-as
klienssel is változatlanul működik.

### Hozzáadva — böngésző-segédek a két leadgen-eseményhez (K1)

A 6.13.1 kanonikussá tette a `consultation_request_submitted` (Meta Schedule)
és `training_signup_submitted` (Meta CompleteRegistration) eseményt, de a
csomagnak nem volt böngésző-oldali segédje rájuk. Most: `pushConsultationConversion`
/ `pushTrainingSignupConversion` (`lib/events.ts`), `trackConsultationSubmit` /
`trackTrainingSignupSubmit` + a P5 staging-párok `stageConsultationSubmit` /
`stageTrainingSignupSubmit` (`lib/index.ts`; a `ConversionKind` két új fajtával).
A szerződés bitre a kapcsolati űrlapé: PII az EC rejtett csatornájába,
PII-mentes dataLayer, `eventId` átvétel, consent-kapu, és CSAK dataLayer-láb —
a szerver-lábat a site backendje küldi. A referencia GTM-konténer CE triggert,
GA4 taget, Meta Pixel `Schedule` / `CompleteRegistration` taget (eventID = DLV
event_id) és Google Ads conversion triggert kap rájuk; a kanonikus doksik a két
nevet a server-ingress-only listákban és a GA4 Key Event listában viszik
(`check:gtm-contract` zöld, kivétel nélkül).

### Hozzáadva — konfigurálható consent-végpont (K4)

`PUBLIC_TRACKING_CONSENT_ENDPOINT` (default `/api/consent`): minden consent-URL
egy helperből épül (`consentEndpointUrl`), a záró perjel tiszteletben tartva —
`/api/consent/` → POST `/api/consent/`, shown `/api/consent/shown/`. Erre a
`trailingSlash: 'always'` Astro-site-oknak van szüksége, ahol a `/api/consent/*`
proxy csak perjeles útvonalra illeszkedik. Perjel nélkül a kérések bájtra a
6.13-asak; a credentials és a 403-utáni lánc-forgatás változatlan.

### Hozzáadva — `<ConsentBanner lang>` (K5)

`lang?: 'hu' | 'en'` prop (default `PUBLIC_TRACKING_LOCALE`) választja a
banner-szöveget — többnyelvű, egy-buildes site oldalanként adja át. A döntés
`lang` mezője ettől függetlenül az OLDAL nyelvét kapja (`<html lang>`), és
`normalizeConsentLang` a gateway `xx` / `xx-YY` alakjára szűkíti (`zh-Hant` →
`zh`): rossz alaknál a gateway a TELJES döntés-POST-ot 400-zal utasítaná el.
Hiányzó `<html lang>` → a build-locale, mint eddig. A `readCurrentDecision()`
policy-verzió-kapuja érintetlen.

### Változott — a smoke site-azonosítója env-ből (K6)

`server/backend/smoke.ts` a `TRACKING_SITE_ID` varból olvassa a site_id-t a
`const SITE = 'REPLACE_ME_SITE_ID'` helyett, így a vendorolt példány bájtra
azonos lehet a kanonikussal (a drift-audit ezen a fájlon eddig mindenhol
pirosat adott). Hiányzó vagy rossz alakú id → hangos `console.error`, küldés
nélkül; a `smoke-<site>-YYYYMMDD` kulcs (event_id = lead_id) változatlan.
**Site-teendő:** a `TRACKING_SITE_ID` var felvétele (ugyanaz az érték, mint a
gateway `SMOKE_SITES`-ában) — enélkül a frissített smoke.ts nem küld, és a
napi digest hiányzó-sor riasztása szól.

## 6.13.1 (2026-10-19)
### Javítva — két leadgen-esemény hiányzott a kanonikus listából
A skinlab 2026-08-14 óta két saját eseménynevet küld a szerver-lábon:
`training_signup_submitted` (Meta: CompleteRegistration) és
`consultation_request_submitted` (Meta: Schedule). A gateway-oldali párjuk
(`meta-conversion-mapping`, 6f08675) sosem olvadt be, így az `events.json`-ból
hiányoztak, és a gateway ismeretlen névként (TRK-EVT-001) némán 204-gyel eldobta
őket — a konzultáció- és képzés-leadek 2026-09-15 óta nem jutottak el a
Metához / Google Adshez. Most mindkettő kanonikus, `server_ingress_only`
leadgen-konverzió (`SERVER_INGRESS_ONLY_EVENTS`, `GatewayEventName`).

A 6f08675 két további része SZÁNDÉKOSAN nincs benne: az `order_request_submitted`
→ Meta Purchase átállás (a trapezlemezest is érintené) és a `content_name`-címke
(minden site Meta-payloadját változtatná) — ezek külön döntést igényelnek.

## 6.13.0 (2026-10-18)

### Biztonság — a lánc-kulcsot a szerver adja ki; igazolatlan írás csak szigoríthat (review R7, második utóellenőrzés)

A 6.12.0 után két bizonyított rés maradt: (1) a régi, kulcs nélküli láncon az azonosító és egy hamisított süti **bővíthette** az engedélyt; (2) a kulcs a `localStorage`-ban élt — letiltott tárhelynél a lánc kulcs nélkül indult és örökre védtelen maradt, két egyidejű első döntés pedig két kulcsot köthetett.

- A kulcsot a **gateway generálja**, és HttpOnly, SameSite=Strict, Secure sütiben adja ki (`sbo_consent_key`, `Path=/api/consent`, 180 nap — ugyanannyi, mint az `sbo_consent`). A kliens JS-e nem kezeli; a payload `consent_key` mezője megszűnt (a szerver figyelmen kívül hagyja), a régi `localStorage` bejegyzést a kliens törli.
- Az első kötés és a lánc első döntése **egy tranzakcióban** íródik (0013 migráció, `consent_chain`): párhuzamos kérésnél pontosan egy kulcs nyer.
- Kulcs nélküli / rossz kulcsú írás — régi láncon is — **csak szigoríthat** (igazolatlan, de érvényes; a visszavonás így kulcsvesztés után is eljut). Bővítés: 403 `consent_key_mismatch`. A régi lánc tulajdonosa a meglévő adatokból **nem igazolható**, ezért oda kulcs utólag sem köthető.
- Kliens 403-ra: elavult döntésnél nincs teendő; versenynél (másik lap épp most kapta a kulcsot) egy újrapróba; egyébként új lánc a böngésző kulcsával, amely `previous_consent_id`-ként megnevezi az elődjét — a gateway a régi lánc állapotát az utódokéval metszi, így egy későbbi visszavonás a régi lánchoz kötött eseményekre is hat.
- A süti-leltárba bekerült az `sbo_consent_key` és a már eddig is írt `sbo_consent_pending`.

### Javítva — szerveroldali kapu (gateway, a csomagot nem érinti)

Saját CMP alatt a capture-kapu `require_consent` configtól függetlenül fail-closed, és CookieYes-forrású jelet nem fogad el; az offline és replay utak egy közös szabályt kérdeznek (`decideAdConsent`). Lásd `docs/CONSENT-DECISIONS.md`.

**Deploy-sorrend:** 0011 + 0012 + 0013 migráció → worker → site-csomagok (6.13.0). A worker a 6.12-es klienssel is működik (a body-kulcsot figyelmen kívül hagyja, a kulcsot sütiben adja ki).

## 6.12.0 (2026-10-18)

### Javítva — kulcsvesztés után sem vész el a jogos visszavonás; régi lánc nem „védhető le" (review R7, utóellenőrzés)

A 6.11.0 két rést hagyott: (1) ha a böngésző elvesztette a lánc kulcsát, a visszavonása 403-at kapott, kikerült az újraküldési sorból, és a szerveren az engedély maradt érvényben; (2) a kulcs nélküli (régi) láncot az első jelentkező kulcsa kötötte meg — a támadóé is. Az új, **aszimmetrikus** szabály (0012 migráció, `consent_log.verified`):

- Védett láncra kulcs nélkül vagy rossz kulccsal **csak szigorító** döntés írható (semmilyen kategóriát nem bővít), **igazolatlanként** — de érvényes: a replay-kapu tiltásnak veszi. Riasztási jel: TRK-910-010. A tulajdonos későbbi, kulccsal igazolt döntése felülírja (beérkezési sorrend szerint, a revisiontől függetlenül).
- Engedély-bővítés csak a lánc kulcsával. Kulcsvesztés után a kliens a 403 `consent_key_mismatch`-re **új láncot indít** (új `consent_id`, új kulcs, revision=1) a jelenlegi döntéssel — a döntés nem vész el.
- Kulcs **csak** új lánc első, kulcsos döntéséhez köthető. A régi / kulcs nélküli láncok a süti lejártáig (180 nap) a régi süti-egyezéses szabályon maradnak, igazolatlan sorokkal.

A 6.11.0 „Ismert korlát" bekezdése ezzel érvényét veszti. **Deploy-sorrend:** 0011 + 0012 migráció → worker → site-csomagok.

## 6.11.0 (2026-10-18)

### Biztonság — a consent-lánc tulajdonlási kulcsa (review R7)

A kliens a consent-lánc indulásakor véletlen titkot generál (`localStorage` `sbo_consent_key`, a `consent_id`-hez kötve), és minden döntéssel elküldi (`consent_key`). A gateway csak a SHA-256 hash-ét tárolja (`consent_log.key_hash`, 0011 migráció), és a védett láncra kulcs nélkül nem fogad el döntést (403 `consent_key_mismatch`) — egy `consent_id` ismerete és egy hamisított süti már nem elég egy hamis visszavonáshoz. A revision a lánc ismert maximumánál legfeljebb 20-szal lehet nagyobb (400 `revision_out_of_range`). A 6.11 előtti láncok az első kulcsos döntéskor válnak védetté.

**Ismert korlát:** ha egy látogató a `localStorage`-t törli, de az `sbo_consent` sütit nem, a védett lánc további döntéseit a gateway elutasítja (a kliens hangosan jelzi, TRK-4002); a döntés a böngészőben ettől még érvényes.

**Deploy-sorrend:** előbb a 0011 migráció, aztán a worker, végül a site-ok csomagja.

## 6.10.0 (2026-10-18)

A 2026-10-18-i kód-review P1-es, hozzájárulást érintő hibáinak javítása (R3, R9, R10). A worker-oldali párjuk (R1, R2: a replay-kapu) ugyanebben a változásban él.

### Javítva — a szerveroldali consent-olvasó nem esik vissza a régi CookieYes-engedélyre (R3)

`readConsentFromCookie` új, opcionális `provider` opciót kap (`GatewayEnv.TRACKING_CONSENT_PROVIDER`). `provider: 'sbo'` mellett KIZÁRÓLAG az `sbo_consent` dönt: hiányzó, lejárt vagy régi policy-verziójú süti → nincs döntés (a gateway `require_consent`-re esik), a CookieYes-„igen" nem helyettesíti. Megadás nélkül (régi másolatok) ha az `sbo_consent` süti jelen van, érvénytelensége esetén sincs CookieYes-visszaesés; sbo-süti nélkül a CookieYes-flotta viselkedése változatlan. **Site-teendő sbo-site-on:** `TRACKING_CONSENT_PROVIDER=sbo` a backend-envbe, és `provider: consentProviderFromEnv(env)` a `readConsentFromCookie` hívásba (lásd `server/backend/README.md`).

### Javítva — függő fetch alatt a második submit nem csúszik át (R9)

A `TrackedForm` két külön állapotot tart: a folyamatban lévő küldés alatt minden új submit `preventDefault`-ot kap (dupla klikk / Enter nem indít második kérést vagy navigációt); csak a saját, programozott `requestSubmit()` re-entry megy át natívan.

### Javítva — tájékoztató-verzióváltás után újra megjelenik a banner (R10)

A `ConsentBanner` megjelenítése, bezárása és a panel előtöltése az aktív `PUBLIC_TRACKING_POLICY_VERSION`-höz kötött — ugyanaz a kapu, mint a `<head>` consent-bootja és a mérés olvasói. Egy régi szövegre adott döntés többé nem rejti el a bannert. A `consent_id`/`revision` folytonossága (verziófüggetlen olvasás az `applySboDecision`-ben) változatlan.

## 6.9.0 (2026-09-17)

### Hozzáadva — banner A/B teszt (b3: site-onkénti cím + balról beúszó kártya)

`PUBLIC_TRACKING_BANNER_B_TITLE` megadásakor az oldalbetöltések fele a B-ágat látja (`banner_version = 2026-09-a-b3`, `consent_text_version = <alap>.t<cím-lenyomat>`). A választás oldalbetöltésenként véletlen, és SEMMIT nem tárol a látogatónál (döntés előtt egy A/B-süti nem lenne feltétlenül szükséges). A gombparitás a B-ágban is áll. Kiértékelés: `node scripts/consent-rate-report.mjs --site <id>` — a két ág külön sorban.

## 6.8.0 (2026-09-17)

### Hozzáadva — site-onkénti banner-szöveg egy env-sorból (`PUBLIC_TRACKING_VENDORS`)

A 2026-08-a szöveg flotta-egységes volt: a Befilón (az első sbo-site) Meta- és Google Ads-hirdetésre kért engedélyt, holott egyik sem futott, a ténylegesen futó Microsoft Clarity-t viszont nem nevezte meg. Mostantól a site felsorolja, mi fut (`PUBLIC_TRACKING_VENDORS=ga4,clarity,google_ec`), és a banner + panel szövege a `consent-texts/2026-09-a` töredékeiből áll össze (`lib/consent-vendors.ts`). Ugyanez a lista a `<CookiePolicy />` alapértéke. Bizonyíték: `consent_text_version = 2026-09-a.<rendezett vendorok>`. Üres env = a régi tartalomnak megfelelő alapkészlet (`ga4,google_ads,meta`). Ismeretlen azonosító a buildben hiba, a böngészőben néma kihagyás.

A 2026-09-a szöveg haszon-központú ("Help us improve this site"), rövidebb, és a US-transzfert cégnévvel mondja ki.

### Változott — banner-elrendezés b2 (`2026-09-a-b2`)

Mobilon kompakt alsó lap (Elfogadom/Elutasítom egymás mellett, egyforma), asztalon bal alsó kártya a teljes szélességű sáv helyett. Színek CSS-változóból (`--sb-consent-choice-bg` stb.) — a két döntés-gomb ugyanazt a változót kapja, a paritás így sem törhető.

### Hozzáadva — `scripts/consent-rate-report.mjs` (repó-gyökér)

Elfogadási arány banner-változatonként a `consent_metrics` + `consent_log` táblákból — szabályos változatok A/B-jéhez.

## 6.7.4 (2026-09-17)

### Javítva — a visszavonás a Clarity és a Hotjar sütiket is törli

`_clck`, `_clsk`, `_hj…`; a futó Clarity előbb leáll (`consentv2` denied). Az inventory új, opcionális `vendor` mezője alapján a tábla csak ott mutatja ezeket, ahol a site használja őket.

## 6.7.1 (2026-09-09)

### Javítva — az `OFFLINE_EVENTS` szinkronban a kanonikus `events.json`-nel

A P10 három új offline eventet vezetett be (`payment_received`,
`revenue_retracted`, `revenue_restated`). A kit `lib/event-contract.ts`
`OFFLINE_EVENTS` konstansa ezeket nem ismerte, és a kit saját szerződés-tesztje
(`tests/event-contract.test.ts`) ezt CI-ban azonnal ki is mutatta — pontosan úgy,
ahogy kell.

(Ez a bejegyzés a rebase során 6.6.9-ről 6.7.1-re számozódott át: a 6.7.0 —
a CMP-kör — előbb ért a mainre.)

## 6.7.0 (2026-09-09)

### Hozzáadva — a közzéteendő süti-tábla mint KÓD, kétirányú őrrel

`consent-texts/cookie-inventory.json` + `components/CookiePolicy.astro`. A
GDPR Art 13(1)(e) / PECR reg. 6 szerinti süti-tájékoztató eddig site-onként,
kézzel készült volna — a 2026-08-25-i jogi átvilágítás szerint hat site
banner-linkje a cookieyes.com termékoldalára vitt, egy site adatvédelmi oldala
pedig 404 volt.

A tábla mostantól EGY kanonikus forrásból renderel, és a
`tests/cookie-inventory-parity.test.ts` KÉTIRÁNYBAN méri a `lib/persistence.ts`
valódi purge-kódjához:

- **kód → tábla:** amit a visszavonás töröl, azt le is kell írni;
- **tábla → kód:** amit a tájékoztató töröltnek ígér, azt a kódnak törölnie kell.

Egy bejegyzés lehet „nem töröljük" (`purged_on_withdrawal: false`), de akkor a
`why_not_purged` kötelező — egy nem törölt süti lehet védhető, kimondatlan nem.

### Hozzáadva — `components/CookieYesEqualButtons.astro`

Az „Elutasítom" gomb egyenrangúsítása a CookieYes bannerén. A mért defekt:
gomb-TERÜLET arány 0.45–0.54, három site-on 3.86:1 kontraszt (WCAG AA alatt).
Ez a NAIH-TV2 hibaosztály. A CookieYes API csak SZÍNT tud állítani, területet
nem — ezért site-oldali CSS-override, szándékosan `!important`-tal (a CookieYes
a saját stílusait futásidőben, magasabb specificitással injektálja; a „szép"
override itt némán hatástalan lenne).

## 6.6.8 (2026-09-08)

### Hozzáadva — megosztott `event_id` a fetch-alapú submit-folyamatoknak

A `trackLeadSubmit` és a `trackContactSubmit` eddig **mindig maga generálta** az
`event_id`-t. Ez a klasszikus form-POST úton helyes: a lib generál, a
`populateHiddenFields` beteszi a rejtett mezőbe, a backend onnan veszi, és a
Pixel↔CAPI dedup áll.

A **fetch/XHR-alapú** folyamatokban viszont a hívó gyakran MÁR generált egy id-t,
elküldte a szervernek, és a böngésző-lábat csak a business-siker után süti el —
ott a lib saját id-je a két lábat KÉT KÜLÖNBÖZŐ kulcsra állította volna, és a
Meta minden konverziót **kétszer** könyvelt volna (CLAUDE.md §16).

- `LeadSubmitParams.eventId?: string` — ha megadod, a böngésző-láb ezt használja.
  Elhagyva a viselkedés bitre a régi (generál), tehát **visszafelé kompatibilis**.
- `trackContactSubmit` mostantól `firstName`/`lastName`/`eventId`-t is átvesz.
  A neveket eddig a típus tiltotta, pedig a `ConversionData` és a
  `buildConversionPayload` **már ma is** kezelte őket — a szűkítés valódi
  Enhanced-Conversions veszteség volt. A nevek a rejtett EC-csatornába mennek
  (`setUserDataForEC`), a dataLayerbe **nem** (CLAUDE.md §15).

Ez nem új minta: a `trackServerEvent` **ugyanezért** fogad el `eventId`-t. Ahol a
folyamat elbírja, a P5 staging (`stageLeadSubmit` → `commitPendingConversion`) a
gazdagabb út — az a navigációt is túléli, és kezeli a közben visszavont
hozzájárulást.

**Mérés:** 5 új eset a `tests/index.test.ts`-ben, 3/3 mutációs próba elbukott a
javítás nélkül (lead-id · contact-id · név-átadás). 441 csomag-teszt + 1178
worker-teszt zöld.

**Honnan jött:** a Beautyflow fork-migrációja. A fork API-ja már ismerte a
megosztott id-t; a kanonikus nem — a csere ezen akadt el.

---

## 6.6.7 (2026-09-07)

### Javítva — a klikk-ID kizárólagosság a PERSISTENCE-lábon is (konverzió-vesztő rés)

A szabály (`lib/google-click-id.ts`) eddig **csak a `gateway.ts`** last-touch
attribúcióján élt. A `persistence.ts` 90 napos `sb_tracking` blobja nem ismerte —
és ez nem elméleti rés: a `getGclid()` az `index.ts`-ből **egyenesen a konverziós
payloadba** megy (`sendToWorker`, hidden mezők).

**A hibás forgatókönyv.** A látogató korábban `gclid`-es kattintással jött, az ID a
90 napos blobban ül. Most `?gbraid=…`-dal érkezik (iOS-forgalom). A `getGclid()`
visszaadta a **tárolt gclid-et**, a `getAllTrackingData()` pedig a friss `gbraid`
mellé is odatette — vagyis a konverzió **két különböző kattintás** azonosítójából
állt össze. A Google offline / Enhanced Conversions feltöltés az ilyen sort
**elutasítja**: a konverzió nem torzul, hanem **elvész**, méghozzá némán.

Négy helyen javítva, mind a meglévő primitívre delegálva (nem új implementáció):

| hely | mi volt | mi lett |
|---|---|---|
| `persistTrackingParams` | `{...stored, ...fresh}` per-kulcs merge | a merge után `applyGoogleClickId` takarítja a testvéreket |
| `getStoredData` | a hibás korszak párosát változatlanul adta vissza | egyszeri **öngyógyítás** olvasáskor, egyszeri visszaírással |
| `getGclid` | `URL gclid \|\| tárolt gclid` | más Google-ID az URL-ben → `null` (a tárolt egy KORÁBBI kattintásé) |
| `getAllTrackingData` | kulcsonkénti merge | a Google-ID-t a primitív dönti el |

### Hogyan derült ki

A Beautyflow `tracking-kit` fork-migrációja hozta ki: ott a szabály **mindkét
lábon** élt, és a kanonikus `persistence.ts` behúzása 6 esetet pirosított. Vagyis
ezen a ponton a **fork volt előrébb** — ezért ment a javítás felfelé, a magba,
ahogy korábban a checker `EVENT_PUSH_RE`-je is.

Új teszt: `tests/google-click-id-persistence.test.ts` (10 eset). A javítás előtt
**6 bukó / 4 zöld**, és a 4 zöld pontosan a konfliktusmentes eset — a fájl a
kizárólagosságot méri, nem általában a tárolást.

---

## 6.6.6 (2026-09-06)

### Javítva — a first touch elvesztette a kulcsszót és a kreatívot

A `persistFirstTouch` négy mezőt őrzött meg: `utm_source` · `utm_medium` ·
`utm_campaign` · `gclid`. A last touch (`sb_tracking`) ezzel szemben a teljes
készletet vezeti, `utm_term`/`utm_content`/`gbraid`/`wbraid`/`fbclid` együtt.

A first touch **egyszer** íródik ki, és utána már sosem rekonstruálható. Ami
onnan kimaradt, az nem „később pótolható", hanem véglegesen nincs meg: a
`getAttribution()` így sosem tudta megmondani, melyik **kulcsszó** szerezte az
ügyfelet — pedig a `first_utm_campaign` alapján a riport azt sugallta, hogy a
szerző kampány ismert. A két mező mostantól mindkét érintésen ott van
(`first_utm_term`/`first_utm_content` és `last_utm_term`/`last_utm_content`).

### Javítva — a medium-tábla öt értéket ismert, a többi „referral" lett

A `getSourceType()` pontosan a `cpc|ppc|organic|social|referral` ötöst
ismerte fel. A valós kampány-sablonok viszont több írásmódot küldenek ugyanarra
a csatornára, és minden fel nem ismert medium átesett a `utm_source`
catch-all-on:

    utm_medium=cpm        → referral   (fizetett display)
    utm_medium=email      → referral   (hírlevél)
    utm_medium=paid_social → referral  (fizetett social)
    utm_medium=affiliate  → referral   (véletlenül helyes)

Egy hírlevél-kattintás és egy fizetett display-megjelenés így ugyanabba a
vödörbe került, mint egy másik oldalról érkező hivatkozás. Visszamenőleg nem
javítható, mert a nyers medium nem utazik a `source_type` mellett.

A tábla mostantól normalizál (trim + lowercase) és a valós írásmódokat is
ismeri; a `paid_social` a **költés** tengelyén `paid`, nem `social`.

**A catch-all maga szándékos és marad**: egy megcímkézett látogató nem
`direct`. Eddig viszont a teszt CÍME ígérte ezt (`bare utm_source → referral`),
az assert pedig hiányzott — most le van kötve.

### Bővült — az `email` visszatérési érték

`getSourceType()` unió: `paid|organic|social|`**`email`**`|referral|direct`.
Additív: a `source_type` a `buildSheetsPayload`-on át stringként utazik, hívói
nem törnek. Aki a régi uniót írja le típusban, annak bővítenie kell.

---

## 6.6.5 (2026-08-27)

### Felvéve — a Google Ads kiterjesztett UTM-jei, hogy ne site-patch legyenek

`utm_id` · `utm_source_platform` · `utm_creative_format` · `utm_marketing_tactic`

Ezek a Google Ads/GA4 **hivatalos** kiterjesztett UTM-paraméterei, amiket az
auto-taggelt kampány-sablon küld. A magban eddig nem voltak — ezért az
`olcsokontenerhaz` **vendorolt** `persistence.ts`-ébe kézzel kerültek bele, és
mellé egy jegyzet:

> „Site-specifikus (olcso ads-setup): a Google Ads kampány-sablon extra UTM-jei.
> A kanonikus lib frissítésekor EZEKET MEG KELL ŐRIZNI (vendor-diff jegyzet)."

Ez a megjegyzés maga a diagnózis. Egy vendorolt fájlba írt site-lokális bővítés
a következő re-vendorolásnál **némán eltűnik**, és csak akkor derül ki, amikor a
kampány-riportban már nincs `utm_id`. A megőrzés nem megoldás, csak halasztás.

Mind a három helyen bekötve: a típusban, a perzisztálandó kulcslistában (enélkül
az URL-ből felolvasnánk, de az oldalváltást nem élné túl), és az URL-olvasásban
tárolt fallbackkel.

**Ez szünteti meg az olcso vendor-driftjét**: a re-vendorolás után a másolat
bitre a kiadásé lehet, kézi patch nélkül.

---

## 6.6.4 (2026-08-27)

### Javítva — a NEGYEDIK őrizetlen `decodeURIComponent`, ezúttal a böngésző-lábon

A 6.6.1/6.6.2 kör három őrizetlen `decodeURIComponent`-et javított a
**szerver**-lábon: egy hibás percent-szekvencia (`%zz`, csonka `%E0`)
`URIError`-t dob, és az a lead-útvonalon 500-as választ adott a beküldött
űrlapra. A `lib/gateway.ts` `getCookie`-ja viszont **kimaradt** a körből.

Ott a dobás nem 500-at ad, hanem **csendet**. A `getCookie` a
konverzió-dispatch útján is fut (`_ga` a `sendToWorker`-ben, `_gcl_aw` a
`collectAttribution`-ben), és egy `URIError` a `sendToWorker` promise-át
utasítja el — a konverzió némán nem megy ki. A `cookieyes-consent` olvasása
szintén rajta ült, vagyis egy rossz süti a consent-kiértékelést is elvihette.

**Ugyanaz a két degradáció, mint a szerver-lábon**, mert ugyanaz a két kérdés:

- `getConsentCookie` → **fail-closed** (a jogalap). Egy fél-dekódolt stringből
  kiolvasott „advertisement:yes" hamis jogalap lenne.
- `getCookie` → **lossy**, a nyers értékre esik vissza (klikk-ID, GA client-ID).
  Ezek azonosítók, nem döntések; `_ga`/`_gcl_aw` amúgy sem tartalmaz
  percent-kódolást, tehát a nyers érték itt a helyes érték — a dobás viszont a
  teljes konverziót vinné el.

### Új őr

`tests/browser-cookie-decode-guard.test.ts`: a `lib/gateway.ts`-ben nem
maradhat csupasz `decodeURIComponent`, és a consent-olvasás nem csúszhat át a
lossy ágra. A hiba azért élhetett túl egy célzott javítókört, mert semmi nem
mérte, hogy MINDEN dekódolás őrzött-e.

---

## 6.6.3 (2026-08-27)

### Kivéve — a `street` sosem létezett a szerződés túloldalán

A transport `UserData` típusa hirdette a `street` mezőt, a Worker elfogadó
típusa (`src/types.ts` `PlainUserDataPayload`) viszont **sosem ismerte**. A hívó
tehát típushelyesen küldhette, a gateway pedig némán eldobta: se hiba, se log,
se metrika. Ez nem elméleti — a painless a rejtett DOM-oldalcsatornájára ki is
írta, és onnan az utcanév minden konverzióval kiment a hálózatra, hogy aztán a
túloldalon a földre essen.

A mező kivezetve. **Ez a szerződés szűkítése**: aki `street`-et állított be,
annak a hívása mostantól típushibát ad — pontosan azt a jelet, ami eddig
hiányzott. Adatvesztést nem okoz, mert a mező eddig sem ért célba.

### Új őr — a mezőkészlet mostantól MÉRT

`tests/user-data-fieldset-parity.test.ts`: a transport `UserData` és a Worker
`PlainUserDataPayload` mezőkészletét veti össze a két forrásfájlból. Kétirányú:
a transport nem hirdethet olyat, amit a Worker nem fogad (néma adatvesztés), és
a Worker nem fogadhat olyat, amit a transport nem tud küldeni (elérhetetlen
funkció). A `street` évekig azért maradhatott bent, mert semmi nem kötötte
össze a két oldalt.

### A `city` marad — de feltétellel

A `city` a szerződésben marad, tölteni viszont CSAK valódi strukturált
forrásból szabad; formázott címből parse-olni tilos (D1).

---

## 6.6.2 (2026-08-26)

### Javítva — a `service` címke csak a böngésző-lábon utazott

A `service` mezőt a böngésző-láb (`lib/gateway.ts`) eddig is küldte: a
dataLayerre ÉS a `sendToWorker` body-jába. A gateway fogyasztja is
(`src/lib/ga4.ts` → `params.service`). A **szerver-láb** payload-építőjéből
viszont hiányzott.

Ez nem kozmetika: a CLAUDE.md 10. pontja szerint MINDEN high-value konverzió
(form/lead/purchase) a hitelesített szerver-ingressen jön, a böngésző-úton csak
a low-risk klikk-eventek mehetnek. Vagyis a címkét pont ott vesztettük el, ahol
a pénz van — miközben a klikk-eventeken megmaradt, tehát a riportban a hiány
sem tűnt teljesnek.

A mező mostantól a szerver-payloadon is ott van; a `compact()` kihagyja, ha a
hívó nem adja (nincs kitalált érték).

Ez tette lehetővé, hogy a painless szerver-lába a TRANSZPORTOT is a kanonikus
küldőre bízza: eddig azért kellett saját `sendGatewayConversion`, mert a
kanonikus küldő a saját payload-építőjét hívja, az pedig elejtette volna a
`service`-t.

---

## 6.6.1 (2026-08-26)

### Javítva — a site-backend süti-olvasói elejthettek egy leadet

Az F9/3.4 **szerver-szelet** paritás-futása három eltérést mutatott ki a
painless fork és a kanonikus mag között, és mind a háromban **a fork volt a
helyes**. Az irány szokatlan: nem a másolat maradt el a csomag mögött, hanem a
csomag a másolat mögött — egy vak migráció ezeket REGRESSZIÓKÉNT vitte volna a
site-ra.

**1. `decodeURIComponent` őrizetlenül, három helyen.** Egy hibás percent-
szekvencia (`%zz`, csonka `%E0`) `URIError`-t dob. Ezek a függvények a site
LEAD-ÚTVONALÁN futnak: az API-route a konverzió összeállítása közben hívja őket.
Egy dobás ott nem „hiányzó telemetria", hanem **500-as válasz a beküldött
űrlapra** — az ügyfél leadje vész el egy elrontott süti miatt, amit nem is ő
írt.

A „ne dobjon" azonban még nem mondja meg, MIRE degradáljon — és a két hívó
típusnak MÁS a helyes válasza ugyanarra a bemenetre. Ezt a szétválást a Worker
`parseConsentCookieHeader`-e és a painless fork is egyformán tartotta:

| hívó | kérdés | degradáció |
|---|---|---|
| **kapu** (`readConsentFromCookie`, `readSboConsentCookieHeader`) | „milyen hozzájárulásra hivatkozhatunk?" | `undefined`/`null` → a gateway `require_consent`-re esik és **fail closed** |
| **telemetria** (`buildConsentSources`) | „mit láttunk?" | a **nyers, dekódolatlan** értékre esik vissza, és jelent tovább |

A különbség nem elméleti: egy hosszú süti EGYETLEN hibás escape-je miatt a közös
„adjunk `undefined`-et" megoldás elveszítené a mellette álló, tökéletesen
olvasható `advertisement:yes`-t — a mérés némán nullázódna, miközben a
felhasználó igenis döntött. A `kulcs:érték,` alak nem igényel dekódolást, tehát a
nyers string rendszerint ugyanúgy parse-olható.

Ezért két helper: `safeDecodeCookieValue` (kapu → `undefined`) és
`decodeCookieValueLossy` (telemetria → nyers érték). Teszt pinneli, hogy
UGYANARRA a bemenetre a kapu `undefined`-et, a telemetria pedig
`cookieyes_cookie`-t + a valódi döntést adja.

**2. `raw_cookie` csonkítatlanul került a receiptre.** A mező a gateway
`consent_debug` táblájába megy (14 napos purge), és csak akkor, ha a források
nem egyeznek — de a diagnózishoz az eleje elég. Új `RAW_COOKIE_MAX = 200`, a
fork határával azonosan.

**3. `readMetaCookies` `{ fbc: undefined }`-ot adott a hiányzó kulcs helyett.**
Egy `'fbc' in cookies` vagy `Object.keys(...)` ellenőrzés igazat adott volna egy
nem létező klikk-ID-re, és a gateway saját `fbclid → fbc` rekonstrukciója épp
ilyenkor maradt volna ki. Mostantól csak a ténylegesen meglévő kulcsok.

A dróton egyik javítás sem változtat érvényes bemenetre: a `compact()` eddig is
eldobta az `undefined`-et, a csonkítás csak a hibakereső mezőt érinti, a
dekódoló-őr pedig csak ott lép be, ahol eddig kivétel volt.

---

## 6.6.0 (2026-08-26)

### Javítva — az e-mail-identitás két lába MÁS byte-stringet hashelt

Az e-mail normalizálása három helyen élt, három különböző viselkedéssel:

| láb | szabály |
|---|---|
| böngésző-csomag (`persistence.normalizeEmail`) | `trim → lowercase → slice(0, 254)` — **csonkított** |
| Worker (`src/lib/hash.ts`) | `trim → lowercase → @-őr` — nem csonkított |
| painless site (`normalizeUserData`) | `trim → lowercase` — se cap, se őr |

A csonkítás a legrosszabb kimenet: 254 oktet fölött a böngésző egy
MESTERSÉGESEN MÁS címet állított elő (`…@exam`), és arra képzett hash-t, mint
amit a szerver ugyanabból a bemenetből. Egy identitás, két hash. A hiányzó
`@`-őr pedig aszimmetriát hagyott: egy elgépelt „e-mail" a böngésző-lábon `em`
lett, a szerver eldobta — identity matching / EMQ / EC match rate romlás. (A
Meta dedup ettől független: az az `(event_name, event_id)` páron áll.)

Új, FÜGGŐSÉG NÉLKÜLI modul: `lib/email-identity.ts` →
`normalizeEmailIdentity()`. Ezt importálja a böngésző-csomag ÉS a Worker
`src/lib/hash.ts` is — egy identitás → egy normalizált byte-string → egy hash.

A szabály: `trim → lowercase → @-őr → >254 OKTET esetén ELDOBÁS → különben
változatlan`. A 254-nek szabványos alapja van (RFC 5321 forward-path), de abból
az következik, hogy a hosszabb cím ÉRVÉNYTELEN — nem az, hogy le kell vágni.

A korlát OKTETBEN mér, nem `String.length`-ben: egy ékezetes helyi rész UTF-8-ban
két oktet karakterenként, tehát a `length`-alapú ellenőrzés átengedne egy 260
oktetes címet, és a két láb megint elválna.

Az oktetszámláló SZÁNDÉKOSAN runtime-független (`utf8OctetLength`), nincs benne
`typeof TextEncoder` elágazás. Egy feature-detect két kódutat jelent, két kódút
pedig azt, hogy ugyanarra a címre két runtime KÜLÖNBÖZŐ döntést hoz — pontosan
az az aszimmetria, amit ez a modul felszámol. Az invariáns nem az, hogy „ne
engedjen át többet, mint a másik láb", hanem hogy ugyanarra a stringre minden
runtime UGYANAZT a számot adja. A `TextEncoder` a tesztben ORÁKULUM, nem
megvalósítás.

### Breaking — `normalizeEmail` visszatérési típusa

`(email: string) => string` **→** `(email: string | null | undefined) => string | undefined`.

Üres, `@` nélküli, vagy 254 oktetnél hosszabb bemenetre `undefined` (korábban
üres string, illetve csonkított cím). A `buildConversionPayload` ennek megfelelően
csak akkor teszi be az `email` mezőt, ha van érvényes identitás.

### Változatlan

A név/város/irányítószám normalizálás **nem** változott. A `sanitizeName`
(`trim().slice(0,100)`, lowercase NÉLKÜL) SZÁNDÉKOSAN nem hash-normalizáló — a
Worker `normalizeName` lowercase-el, tehát erre delegálni némán elrontaná a
név-hasheket.

---

## 6.5.0 (2026-08-25)

### Hozzáadva — a Google klikk-ID szabálya és a háromállapotú marketing-consent PRIMITÍVKÉNT

Új modul: `lib/google-click-id.ts` — pure, DOM nélkül. Ez a szabály EGYETLEN
authorityje: kölcsönös kizárás (`gclid` > `gbraid` > `wbraid`) + forrás-sorrend
(URL > `_gcl_aw` süti > tároló). Exportok: `resolveGoogleClickId`,
`pickGoogleClickId`, `parseGclAwCookie`, `applyGoogleClickId`,
`GOOGLE_CLICK_KEYS`.

Miért pure: a szabály eddig HÁROM helyen élt (kanonikus `gateway.ts`, painless
`utm-capture.ts`, és implicit feltevésként a painless `calculator-store.ts`
kommentjében), és bizonyítottan szétsodródott — a 6.4.1 pontosan ennek az ára
volt. A site-adapterek tároló-modellje viszont JOGGAL más (a gateway last-touch
`localStorage`-ot használ, a painless first-touch `sessionStorage`-t), ezért a
primitív nem ír és nem olvas — csak DÖNT.

Új export a `gateway.ts`-ből: `getMarketingConsentState()` →
`GRANTED` / `DENIED` / `UNKNOWN`. A kétállapotú (`boolean`) olvasat az F9
visszatérő hibaforrása: az UNKNOWN-t tagadásnak véve törlünk egy korábbi grant
alatt tárolt klikk-ID-t (a CMP boot-versenye minden korai oldalbetöltésen
fennáll), tagadásnak NEM véve pedig consent nélkül írunk hirdetési azonosítót az
eszközre. A harmadik állapot mostantól nevesített, és a site-adapterek ugyanezt
az osztályozást használják.

### Változatlan viselkedés

A `collectAttribution` mostantól ezekre a primitívekre delegál. Ez REFAKTOR: a
383 meglévő teszt változtatás nélkül zöld maradt, és a lokális
`keepSingleGoogleClickId` / `dropStaleGoogleClickIds` / `gclidFromCookie`
másolatok eltűntek.

---

## 6.4.1 (2026-08-25)

### Javítva — az elavult `_gcl_aw` cookie legyőzte a friss URL-klikk-ID-t

A 6.4.0 helyesen szűkítette egyre a Google klikk-ID-ket, de a `_gcl_aw`
cookie-fallback ELŐTTE futott, és a régi őre csak a `gclid`-et nézte
(`!fresh.gclid`). Egy visszatérő fizetett látogatónál, aki `?gbraid=…`-del
landolt, miközben a böngészőjében ott volt egy korábbi kattintás
`_gcl_aw`-cookie-ja, a fallback a RÉGI gclid-et is „frissnek" jelölte — a
`keepSingleGoogleClickId` prioritása (`gclid` > `gbraid`) pedig pont azt
választotta, és a FRISS `gbraid` eldobódott.

Ez a 6.4.0-ban lett rosszabb: előtte mindkét ID kiment (ellentmondásos, de a
friss ID legalább ott volt), utána determinisztikusan az ELAVULT nyert. Az
offline / Enhanced Conversions feltöltés így a rossz kattintáshoz köt, némán.

A sorrend mostantól kötött: URL → egy ID kiválasztása → cookie CSAK akkor, ha
az URL EGYIK Google klikk-ID-t sem hozta.

**A painless forkja ezt már javította** (painless #39, 2026-07-26); a kanonikus
mag a fordított sorrendet vitte, ezért az F9/3.4 transzport-delegálása
(painless #52) a site-on REGRESSZIÓT okozott. A paritás-harness ezt nem fogta
meg — nem volt cookie-fallback esete. Most van, öt új teszttel
(`tests/google-click-id-exclusivity.test.ts`).

---

## 6.4.0 (2026-08-25)

### Javítva — a Google klikk-ID-k kölcsönös kizárását nem tartotta be a tároló

Egy kattintás `gclid`-et VAGY `gbraid`-et VAGY `wbraid`-et ad, sosem többet. A
`collectAttribution` viszont kulcsonként merge-ölt a tárolóval, ezért egy
VISSZATÉRŐ fizetett látogatónál a RÉGI `gclid` ott maradt az ÚJ `gbraid`
mellett — a payload két, egymásnak ellentmondó klikk-azonosítót vitt.

Az offline / Enhanced Conversions feltöltés ezekből köti a konverziót a
kattintáshoz: két ID mellett vagy rossz kattintáshoz köt, vagy a vendor dönt
helyettünk. Mindkettő néma attribúció-hiba, ami a riportokban egészségesnek
látszik.

Mostantól a friss jelekből determinisztikusan EGY ID marad
(`gclid` > `gbraid` > `wbraid`), és a tárolt testvérek is takarítódnak. A
legacy tároló, ami a hibás korszakból többet őriz, GYÓGYUL: a `gclid` marad.

A hibát a painless forkja már javította, a kanonikus csomag nem. Az F9/3.4
transzport-migrációja derítette ki: a delegálás enélkül REGRESSZIÓ lett volna
azon a site-on, ahol a védelem már megvolt. 6 teszt (a javítás nélkül 5 bukik).

---

## 6.3.1 (2026-08-25)

### Javítva — a csomagon belül KÉT, egymásnak ellentmondó szabály élt az `event_id`-re

A `lib/uuid.ts` elvből DOB, ha nincs biztonságos kontextus („collisions cause
silent dedup failures and ROAS distortion"), a `generateEventId()` viszont
némán egy NEM-UUID tartalékot adott:
`${Date.now().toString(36)}-${Math.random()…}`. A gateway regexe
(`[a-zA-Z0-9_-]+`) ezt átengedi, tehát SEMMI nem jelezte volna, hogy az
`event_id` nem UUID — pedig a CLAUDE.md 2. pontja annak írja le.

Mostantól a `generateEventId()` a kanonikus `generateUUID()` crypto-útjait
használja. Az utolsó mentsvár SZÁNDÉKOSAN v4-ALAKÚ és nem dobás: egy elveszett
konverzió rosszabb, mint egy gyengébb entrópiájú azonosító.

### Hozzáadva — `check:vendored --paths=` részhalmaz-ellenőrzés

Egy site jogosan vendorolhatja a csomag EGY RÉSZÉT (a painless React-alapú, az
Astro-komponensekre nincs szüksége). A szűrő EXPLICIT és szűkítő, és a kimenet
mindig kiírja, hány fájl maradt a vizsgálaton kívül — a szűrés így látható
marad, nem tünteti el a különbséget.

---

## 6.3.0 (2026-08-25)

### Javítva — a site-backend consent-parsere elvágta volna a saját CMP-s site-ok szerver-lábát

A böngésző-lib a `v2` `sbo_consent` süti-formátumra tért át (policy-verzióval),
a **kézzel duplikált** backend-parser viszont `v1`-et követelt. Egy
`provider: sbo` site-on ez azt jelentette volna, hogy minden valódi süti
`null`-ra parse-olódik a szerveren → a form-POST láb „nincs döntés"-t lát →
`require_consent: true` mellett fail-closed kihagyja a hirdetési platformokat,
némán, minden high-value konverzión.

Három további eltérés is zárva: **policy-verzió** egyezés, **lejárat** (180 nap),
**decision↔kategória** konzisztencia.

Új: `SboCookieReadOptions` (`expectedPolicyVersion`, `nowSec`) +
`GatewayEnv.TRACKING_POLICY_VERSION`. Az `sbo` site-oknak át KELL adniuk;
CookieYes-site-on nincs szerepe.

Őr: `tests/consent-backend-parity.test.ts` — ugyanaz a 15 fixture mindkét
parseren. A javítás nélkül 9 eset bukik.

### Hozzáadva — verzió-tekintély és terjesztési manifeszt (F9 1. lépcső)

- `dist-manifest.json`: a 27 terjesztendő fájl tartalom-hash-e a verzióval.
- A repó gyökerében: `check:package-version`, `check:dist-manifest`,
  `check:vendored` — az utóbbi egy bemásolt példányról megmondja, melyik
  kiadásból származik és hol tér el.

Részletek és a mért kiindulóhelyzet: `docs/vnext-f9-package-versioning.md`.

> **Miért 6.3.0 és nem 6.2.2:** a `6.2.x`-et futtató site-ok backendje a `v2`
> consent-sütit nem tudja olvasni. A verzió így ténylegesen megkülönböztet:
> `6.3.0` alatt a saját CMP szerver-lába nem működik.
