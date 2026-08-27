# soborbo-tracking — változásnapló

A verzió három helyen él, és mind a háromnak egyeznie kell (`npm run
check:package-version` a repó gyökeréből): `package.json` · `lib/config.ts`
`CLIENT_LIB_VERSION` · `server/backend/gateway-dispatch.ts` `BACKEND_LIB_VERSION`.

Ez a napló a **6.3.0-tól** vezetett. A korábbi verziókról nincs rekonstruált
bejegyzés — a git-történet az egyetlen forrás rájuk, és nem írunk ide olyat,
amit nem tudunk bizonyítani.

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
