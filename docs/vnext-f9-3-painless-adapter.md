# F9/3 — Painless: leltár és adapter-szerződés (1–2. lépés)

**Állapot:** 1–5. lépés KÉSZ, a 6. részben. A **böngésző-láb** és a szerver-láb
**payload-építője + süti-olvasói** a kanonikus **6.6.1** magon futnak (vendorolva,
bitre azonosan). Ami MÉG fork: a szerver-láb **transzportja** — `GatewayEnv`,
binding-feloldás, `sendGatewayConversion` —, mert az átvétel deploy-koordinációt
igényel (a binding neve `EVENT_GATEWAY` ↔ `GATEWAY`), nem kódcserét. A 8–9. lépés
ezért nyitva. Bizonyítékok a 6–7. szakaszban.

**A jóváhagyott sorrend, amiből ez a dokumentum az első kettő:**

```
1. Painless public tracking API leltár        ← KÉSZ (ez a dokumentum)
2. compatibility adapter API megtervezése     ← KÉSZ (ez a dokumentum)
3. paritás-harness a MAI fork ellen           ← KÉSZ (painless #50)
4. kanonikus mag az adapter mögé              ← KÉSZ (painless #51–#56)
5. ugyanazok a paritás-tesztek GREEN          ← KÉSZ (21/21)
6. fork-fájlok eltávolítása                   ← RÉSZBEN: a böngésző-láb kész,
                                                 a szerver-lábból a payload-építő
                                                 + süti-olvasók átmentek (578 →
                                                 340 sor); a transzport áll
7. build/test                                 ← KÉSZ (build zöld · 450 + 1148)
8. deploy                                     ← a binding-átnevezés itt dől el
9. smoke ledger version = 6.6.x               ← a terv 6.3.x-et írt; a csomag
                                                 azóta 6.6.1 (#99–#102 + a
                                                 szerver-szelet találatai)
```

Külön PR-ben, utána: **P5 `commitOnSuccess` rollout.** CMP flip nem keverhető hozzá.

---

## 1. Leltár — mit exportál a fork, és ki használja

A `src/lib/tracking/index.ts` **27 nevet** exportál 7 modulból. A site-ban
**28 import-hely, 20 fájlban** — köztük React-komponensek (`.tsx`), Astro-oldalak
és API-route-ok.

| Modul | Exportok | Mi ez valójában |
|---|---|---|
| `tracking.ts` (440 sor) | `trackEvent`, `trackEventBeforeNavigate`, `setUserDataOnDOM`, `clearUserDataOnDOM`, `readUserDataFromDOM`, `restoreUserDataFromStorage`, `adStorageConsent`, `normalizePhoneE164`, `normalizeUserData` | dataLayer-push + PII-oldalcsatorna. **Nem** azonos a kanonikus `events.ts`-szel. |
| `conversion-state.ts` (252) | `fireQuoteConversion`, `fireQuoteCompletedEvent`, `wasQuoteCompletedRecently`, `getRecentQuoteDetails`, `cleanupLegacyQuoteState`, `markViewContentFired`, `hasViewContentFired` | A kalkulátor konverzió-állapotgépe. **Nincs kanonikus párja.** |
| `form-tracking.ts` (147) | `trackFormStart`, `trackFormFieldFocus`, `trackFormStep`, `trackFormSubmitted`, `registerFormForAbandonment`, `markActiveFormsAsHandedOff` | Űrlap-életciklus + **abandonment beacon**. **Nincs kanonikus párja.** |
| `global-listeners.ts` | `initGlobalListeners` | Telefon/e-mail klikk + görgetés-mélység. Részben fedi a kanonikus `PhoneLink`/`RevealContact`. |
| `utm-capture.ts` (164) | `captureUTMs`, `readAttribution`, `readAffiliateCode`, `buildAttribution` | Attribúció. A kanonikus `persistence.ts` fedi, **más tárolási alakkal**. |
| `worker-dispatch.ts` | `dispatchWorkerConversion` | Böngésző→gateway POST. A kanonikus `gateway.ts` fedi. |
| `uuid.ts`, `config.ts` | `generateUUID`, `CURRENCY`, `DEFAULT_COUNTRY` | Triviális; a kanonikusban is van. |

> ⚠️ **A MIGRÁCIÓS FELÜLET NAGYOBB, MINT A KÖNYVTÁR.** A böngésző-ág transzportja
> — `sendToWorker`, `collectAttribution`, `trackConversion` — a
> **`src/lib/worker-tracking.ts`-ben** él, a `src/lib/tracking/` KÖNYVTÁRON KÍVÜL:
> 518 sor, 22 import-hely. A `check-vendored-copy` ezt nem látta, mert a
> vendorolt könyvtárat nézi. A cserénél ez is a hatókör része.
>
> 🛑 **NE TÉPD KI a Turnstile-t ebből a fájlból.** A `getTurnstileToken` /
> `prewarmTurnstileToken` NEM a törölt gateway-kapu maradványa: a site SAJÁT
> `/api/contact/` végpontjának bot-védelme (`EquityCalculator.astro`,
> `later-life-moves.astro`). A CLAUDE.md 10. pontja a GATEWAY Turnstile-járól
> szól — aki a kettőt összekeveri, kiveszi a site űrlap-védelmét.

**Szerver-oldal:** `gateway-dispatch.ts` (578 sor) + `server.ts` + `smoke.ts`, 5 élő
API-hívási ponton. Ez a réteg a **legközelebb** áll a kanonikushoz — a
`buildGatewayPayload` mezőkészlete mechanikus diff szerint mindössze
`consent_id`-ban és az ecommerce-mezőkben tér el (utóbbiak lead-gen site-on
jogosan hiányoznak). A `consent_sources` hiánya a #48-ban már zárva.

### Amit a leltár megmutatott, és amiért nem szabad vakon cserélni

A fork **nem elmaradt másolat, hanem más architektúra**: a kalkulátor-állapotgép,
az abandonment-beacon és az űrlap-életciklus a site sajátja, ezeknek a kanonikus
csomagban **nincs megfelelője**. Egy „másoljuk be a kanonikus `lib/`-et" lépés
nem frissítés lenne, hanem funkcióvesztés.

---

## 2. A megőrzendő INVARIÁNSOK (a paritás-harness tárgya)

Ezek nem stílus-kérdések: mindegyik mögött egy megtörtént, mért hiba áll. Az
adapternek **bizonyítottan** meg kell tartania őket.

### INV-A · GA4 foglalt kampány-paraméterek átnevezése

A fork a `source` / `medium` / `campaign` nevű event-paramétert `cta_context` /
`cta_medium` / `cta_campaign`-re nevezi át, mielőtt a dataLayerbe tolná.

**Miért:** a GA4 az ilyen nevű paramétert MANUÁLIS KAMPÁNY-JELZÉSNEK veszi — a
címke a MUNKAMENET forrása lesz, és felülírja a valódi akvizíciót, az egész
munkamenetre, a benne lévő konverziókkal együtt.

**Mérve** (painless GA4 property 413271735, 2026-08-25):

| sessionSourceMedium | munkamenet (90 nap) |
|---|---|
| `standalone / (not set)` | 57 |
| `server / (not set)` | 23 |
| `after_calculator / (not set)` | 9 |
| `email_click / (not set)` | 4 |

A javítás **hatását is mérni lehet**: napi bontásban `standalone / (not set)`
08-15 (5), 08-16 (1), 08-17 (3) — **08-18 óta nulla**.

🔴 **A KANONIKUS CSOMAGBAN EZ A VÉDELEM NINCS MEG.** A `lib/gateway.ts` ma is
tolja a `source`-ot a dataLayerbe, a GTM-konténer pedig `DLV - source`-ként
GA4-paraméterré teszi. **Egy vak csere visszahozná a hibát a painlessre.**

A kanonikus oldalon ez `check:ga4-params` racsniként rögzítve (a két meglévő
előfordulás nevesített alapvonalon; új foglalt név CI-hiba). A tényleges
átnevezés kód + GTM-konténer EGYÜTTES változása, minden site-on
újrapublikálva — **külön rollout, nem az F9/3 része**.

### INV-B · PII soha nem megy a dataLayerbe

Mindkét oldalon megvan (fork: `PII_KEYS` szűrő; kanonikus: `events.ts` strip +
`PII_IN_DATALAYER` jelentés). A harness kösse le, hogy a csere után is áll.

### INV-C · A böngésző- és a szerver-láb UGYANAZT az `event_id`-t hordozza

Meta dedup az `(event_name, event_id)` páron. A fork a rejtett mezőből viszi át;
a kanonikus ugyanígy. Eltérés = duplikált Lead.

### INV-D · A navigáció megvárja a tageket

`trackEventBeforeNavigate` `eventCallback` + `eventTimeout` + biztonsági
`setTimeout`. Szinkron navigáció a push után **félbevágja** az Ads/GA4/Meta
kéréseket. A kanonikus `submit.ts` ezt más alakban oldja meg — a paritásnak a
MEGFIGYELHETŐ viselkedésre kell vonatkoznia (navigál-e, és mikor), nem a
megvalósításra.

### INV-E · A szerver-láb NEM viszi tovább a `source` címkét

A fork szándékosan nem adja át a `dispatchWorkerConversion`-nek: az a leg
megkerüli a `buildSafePush`-t, és a gateway GA4 MP felé literál `source`
paraméterként továbbította — ez nyitotta a `standalone / (not set)`
munkameneteket minden cookieless hiten.

---

## 3. Az adapter-szerződés

**Elv:** a site hívási felülete (`@/lib/tracking` 27 exportja) **nem változik**.
Az adapter mögött cserélődik a mag.

```
        site (20 fájl, 28 import)
                  │
                  ▼
   @/lib/tracking  ← VÁLTOZATLAN felület (adapter)
                  │
      ┌───────────┴───────────┐
      ▼                       ▼
 kanonikus mag          site-specifikus réteg
 (soborbo-tracking)     (a site tulajdona)
 · dataLayer push       · kalkulátor-állapotgép
 · consent              · űrlap-életciklus
 · gateway payload      · abandonment beacon
 · attribúció/tárolás   · INV-A átnevezés (amíg a
 · uuid                   kanonikus nem tudja)
```

### Melyik export hova kerül

| Export | Cél | Megjegyzés |
|---|---|---|
| `trackEvent`, `trackEventBeforeNavigate` | **adapter a kanonikus fölé** | az INV-A átnevezés az adapterben marad, amíg a kanonikus nem viszi |
| `setUserDataOnDOM` / `read` / `clear` / `restore` | **kanonikus** | a P6 (#87) `getUserDataForEC` package-owned getterje ezt már fedi |
| `normalizePhoneE164`, `normalizeUserData` | **kanonikus** | a #87 telefon-paritás miatt KÖTELEZŐ a kanonikusé |
| `adStorageConsent` | **kanonikus** | `consent.ts` |
| `dispatchWorkerConversion` | **kanonikus** | `gateway.ts` |
| `generateUUID`, `CURRENCY`, `DEFAULT_COUNTRY` | **kanonikus** | |
| `captureUTMs`, `readAttribution`, `buildAttribution` | **kanonikus** | ⚠️ eltérő tárolási alak → migrációs olvasó kell a régi kulcsokra |
| `readAffiliateCode` | **site** | nincs kanonikus párja |
| `fireQuoteConversion` és a `conversion-state` társai | **site** | kalkulátor-állapotgép |
| `trackForm*`, `registerFormForAbandonment`, `markActiveFormsAsHandedOff` | **site** | abandonment-szemantika |
| `initGlobalListeners` | **site**, kanonikus primitívekre | a klikk-eventek a kanonikusból |

### A `normalizePhoneE164` külön figyelmet kér

A #87 talált egy néma kliens↔szerver telefon-hash-divergenciát (a korai return
miatt `+44 (0)7123…` → `+4407123456789` a böngészőben, `+447123456789` a
szerveren). A forknak **saját** `normalizePhoneE164`-e van. A paritás-harness
első kötelező esete: ugyanaz a bemenet → ugyanaz a normalizált alak. Eltérés
esetén a fork implementációja megy a kukába, nem a kanonikusé.

---

## 4. A paritás-harness (3. lépés) — KÉSZ, és mit talált

`painless: src/lib/tracking/parity-harness.test.ts`, 19 eset. **Az első futása
egy néma, éles hibát talált**, ami a #87 osztálya:

```
bemenet:   +44 (0)7123-456.789
böngésző:  +4407123456.789     ← ez ment a Meta Pixelnek
szerver:   +447123456789       ← ez ment a CAPI-nak
```

Két oka volt: a takarítás nem vitte el a **pontot**, és a `+`-szal kezdődő szám
**korai return**-nel kilépett, bent hagyva a `(0)` trunk-nulláját.

**Mi romlott el pontosan:** a Pixel és a CAPI ugyanarról a látogatóról KÉT KÜLÖN
hash-elt identitást adott a Metának. A hatás tehát **identity parity / user
matching / EMQ / Enhanced Conversions match-rate** — nem a deduplikáció. A dedup
az `(event_name, event_id)` páron áll, azt külön az **INV-C** védi, és az ép
volt. (Egy korábbi megfogalmazásom „a dedup elromlott"-at írt; ez pontatlan.)

A hívási pontok mind a `normalizeUserData`-n mennek át, tehát ez valódi
felhasználói bemeneten futott.

Miért nem derült ki: a meglévő `normalize.test.ts` **csak tiszta alakokat**
fedett (`+447700900123`, `+44 7700 900123`) — `(0)`-t és pontot egyet sem.
Javítva a painless #50-ben (a kanonikus `stripTrunkPrefix` portja).

**Rögzített szerződés, ami lábon lövős:** a `readUserDataFromDOM()` törlés után
ÜRES OBJEKTUMOT ad, nem `undefined`-ot. Egy `if (readUserDataFromDOM())` igazat
adna egy üres objektumra is — a csere után ennek azonosnak kell maradnia.

### A harness eredeti terve (megvalósítva)

Karakterizációs teszt a **MAI fork** ellen, három megfigyelhető kimenetre:

1. **dataLayer-push** — a pontos objektum minden money-eventre (kulcsok, sorrend
   nem számít, értékek igen), a foglalt-név-átnevezéssel együtt;
2. **gateway-payload** — a `buildGatewayPayload`/`dispatchWorkerConversion` által
   előállított JSON;
3. **tárolt állapot** — mit ír localStorage/sessionStorage/DOM-ba.

A harness a fork ellen fut RED→GREEN sorrendben: előbb rögzíti a mai
viselkedést (GREEN a forkon), majd a 4. lépés után **ugyanaz a teszt** fut a
kanonikus mag fölött. Ami eltér, az vagy adapter-hiba, vagy tudatos döntés — de
nem maradhat észrevétlen.

**Nem** a belső hívásláncot pinneljük: az adapter célja épp az, hogy az megváltozzon.

---

## 5. F9/3.4 — mi landolt (painless #51–#56)

A 4. lépés **hat szeletben** ment át, nem egyben. A sorrend nem esztétika: minden
szelet egy authority-t szüntetett meg, és a paritás-harness minden szelet után
futott.

| PR | Mit vitt a kanonikusba |
|---|---|
| #51 | a mag **vendorolva és igazolva** — az első levél már rá delegál |
| #52 | a **böngésző-transzport** (`worker-tracking.ts`) — nincs többé második authority |
| #53 | újravendorolás **6.4.1**-re — a delegálás visszahozott egy klikk-ID-regressziót |
| #54 | `utm-capture` → kanonikus primitív, és nem ír consent előtt az eszközre |
| #55 | `adStorageConsent` → kanonikus consent-osztályozás |
| #56 | **e-mail-identitás** → kanonikus mag, vendorolás **6.6.0**-ra |

**#53 önmagában igazolja a módszert.** A delegálás — tehát a *helyes* irányba tett
lépés — visszahozott egy klikk-ID-regressziót, mert a vendorolt példány elmaradt
a csomag mögött. Nem a terv volt rossz; a verzió volt régi. Egy „cseréljük ki, aztán
nézzük meg" menetrendben ez élesben derült volna ki.

### Ami a cserével SZÁNDÉKOSAN megváltozott

Két megfigyelhető viselkedés más lett, és mindkettő **ratifikált** döntés, nem
adapter-hiba:

- **Telefon:** a fork saját `normalizePhoneE164`-e eltűnt, a függvény ma tiszta
  delegálás a kanonikus `normalizePhone`-ra. A `+44 (0)7123-456.789` mindkét lábon
  `+447123456789`. (A doksi 4. szakasza ezt előre kimondta: eltérés esetén a fork
  megy a kukába.)
- **E-mail:** a `normalizeUserData` a 6.6.0 `normalizeEmailIdentity`-jét hívja,
  tehát `@` nélküli vagy 254 oktetnél hosszabb cím **eldobásra kerül**, nem megy
  tovább csonkítva. A painless korábbi szabálya (`trim → lowercase`, se cap, se őr)
  pont az egyik volt a 6.6.0-ban felszámolt három divergens láb közül.

---

## 6. Az öt korlát ellenőrzése — gépi bizonyíték

A 4. lépés öt kikötéssel indult. Mind az öt tartott; alább az, ami ezt **méri**,
nem az, ami állítja.

| # | Korlát | Bizonyíték | Ítélet |
|---|---|---|---|
| 1 | a 27-exportos felület ne változzon | `index.ts` diff `88b9e4ec` (#50 feje) ↔ `93f2b94` (main): **semmi nem tűnt el, nem lett átnevezve, nem változott a szignatúra**. Egyetlen additív sor: `claimContactConversion` + `ContactClickKind` — az is a **#57**-ből (A7 klikk-dedup), nem a migrációból | ✅ |
| 2 | INV-A–E zöld ugyanazzal a harness-szel | `parity-harness.test.ts` **21/21**; teljes painless suite **448 passed / 1 skipped / 0 failed**; Serverside **1148 passed** | ✅ |
| 3 | `worker-tracking.ts` a hatókör része, ne maradjon második transport-authority | **518 → 208 sor**; a `collectAttribution` és a `sendToWorker` ma `export … from '@/lib/soborbo-tracking/gateway'`. A `worker-dispatch.ts` is ezen a láncon megy → **egy authority** | ✅ |
| 4 | a site `/api/contact/` Turnstile-védelme ne sérüljön | `getTurnstileToken` / `prewarmTurnstileToken` **változatlanul exportált** a `worker-tracking.ts`-ből; az `EquityCalculator.astro` és a `later-life-moves.astro` hívási pontja áll | ✅ |
| 5 | se P5 `commitOnSuccess`, se CMP flip, se globális GA4-fix | `commitOnSuccess`: **nulla hívási hely**. SBO-CMP bekötés a site-on: **nulla**. `check:ga4-params`: **2 ismert előfordulás az alapvonalon, új nincs** — az INV-A átnevezés adapter-lokális maradt (`tracking.ts` `RESERVED_PARAM_REMAP`) | ✅ |

### A vendorolt példány sodródása: nulla

```
$ node scripts/check-vendored-copy.mjs \
    <painless>/src/lib/soborbo-tracking --paths=lib/

   Kiadás: soborbo-tracking@6.6.0
   Szűkítve: lib/ — 11 fájl a vizsgálaton KÍVÜL
   CLEAN — A példány bitre a 6.6.0 kiadás (18 fájl).
   Összesen: 18 azonos · 0 eltér · 0 hiányzik · 0 idegen
```

A `--paths=lib/` szűrő a **#98**-ban épült, pont ehhez: a painless React-alapú, az
Astro-komponensekre nincs szüksége. A riport ezért is írja ki mindig, hány fájl
maradt kívül — a szűkítés látható marad.

### Ami NYITVA van

**A szerver-láb még a fork.** A `gateway-dispatch.ts` + `server.ts` + `smoke.ts`
(**879 sor**) nem ment át, és ezt a kód maga is bevallja:

```ts
export const BACKEND_LIB_VERSION = '0.0.0-painless-fork';
```

Ez **szándékos és igaz**: a `0.0.0-` előtag a gateway `MIN_CLIENT_LIB_VERSION`-je
(6.1.0) alatt van, tehát valósan kivált egy információs `TRK-910-006`-ot. A ledger
sorai a `NULL → 0.0.0-painless-fork → 6.6.0` úton haladnak, és a **6.6.0-ra váltás
lesz a migráció kívülről, gépileg igazolható jele** — ez a 9. lépés.

> ⚠️ **A 9. lépés célszáma elavult volt.** A terv `6.3.x`-et írt; a csomag azóta
> **6.6.0** (#99 klikk-ID kölcsönös kizárás, #100 elavult `_gcl_aw`, #101 klikk-ID
> + háromállapotú consent primitív, #102 e-mail-identitás). A smoke-nak `6.6.x`-et
> kell látnia, nem `6.3.x`-et.

---

## 7. A szerver-szelet — és három hiba A KANONIKUS MAGBAN

A szerver-láb (`gateway-dispatch.ts` + `server.ts` + `smoke.ts`) volt az utolsó
fork. A leltár után **578 → 340 sor**: a payload-építő és a süti-olvasók átmentek
a kanonikus magra, a transzport maradt.

### Ami átment, és ami szándékosan nem

| Rész | Hova került | Miért |
|---|---|---|
| `buildGatewayPayload` | kanonikus (burkolóval) | tiszta függvény, ez feji a Metát |
| `readConsentFromCookie`, `readMetaCookies`, `buildConsentSources`, `resolveTestEventCode` | kanonikus | tiszta függvények, nincs env-függésük |
| `GatewayEnv`, `gatewayBaseUrl`, `isGatewayConfigured`, `sendGatewayConversion` | **marad site** | deploy-kötött — lásd lent |
| `splitFullName`, `deliverGatewayConversion`, `service` | **marad site** | nincs kanonikus párjuk |

🛑 **A TRANSZPORT NEM KÓDCSERE, HANEM DEPLOY-KOORDINÁCIÓ.** A service binding neve
a site-on `EVENT_GATEWAY` (`wrangler.toml:61`), a kanonikus magban `GATEWAY`. Egy
vak csere itt nem fordítási hibát adna, hanem **néma nullát**: a kanonikus küldő
`env.GATEWAY`-t keresne, nem találná, a lead-végpont továbbra is 200-at adna, és
a gateway sosem látná az eventet. Ugyanígy: a `TRACKING_GATEWAY_URL` felülírás a
kanonikusban nem létezik, és a kanonikus `isGatewayConfigured` megköveteli a
bindingot. Ezért a transzport a **8. lépéshez** tartozik, nem ehhez.

### A `service` — és miért két teszt pinneli

A kanonikus payload-építő webshop-bérlőkre készült (`contents`, `order_id`); a
lead-gen `service`-t nem ismeri. A painless HÁROM élő pontról küldi. A burkoló
visszateszi, és **két** teszt őrzi: egy a builder kimenetén, egy pedig **a
DRÓTON**. A második azért kell, mert a kanonikus `sendGatewayConversion` a SAJÁT
payload-építőjét hívja — egy teljes delegálásnál a builder-szintű pin zölden
hazudna, miközben a mező lecsúszik a kérésről.

### A verzió, ami nem hazudhat

A kanonikus `buildConsentSources` a mag verzióját írja a receiptre. Ezen a
site-on ez hazugság lenne: a transzport még fork, és **a küldő-úton él a néma
nulla**. A burkoló ezért visszaírja a site igaz értékét (`0.0.0-painless-fork`).
A szám akkor vált `6.6.1`-re, amikor a transzport is átment — ez a 9. lépés.

### Három hiba, amit a paritás A KANONIKUS MAGBAN talált

Eddig minden találat a forkot marasztalta el. Itt **fordult az irány**: három
ponton a fork volt a helyes, és a vak migráció REGRESSZIÓT vitt volna a site-ra.
Javítva a csomagban — **6.6.1**.

| # | A kanonikus mag hibája | Következmény |
|---|---|---|
| 1 | `decodeURIComponent` **őrizetlenül, 3 helyen** | Egy hibás percent-szekvencia `URIError`-t dob. Ezek a függvények a **lead-útvonalon** futnak → **500-as válasz a beküldött űrlapra**. Az ügyfél leadje vész el egy elrontott süti miatt, amit nem is ő írt. |
| 2 | `raw_cookie` **csonkítatlanul** a receiptre | A teljes consent-süti a `consent_debug` táblába. A fork 200 karakteren vágott; a mag nem. Adatminimalizálási visszalépés. |
| 3 | `readMetaCookies` → `{ fbc: undefined }` | Egy `'fbc' in cookies` ellenőrzés igazat ad egy **nem létező** klikk-ID-re, és a gateway `fbclid → fbc` rekonstrukciója épp ilyenkor marad ki. |

Az 1. a súlyos: nem mérési hiba, hanem **elveszett konverzió**. A `safeDecodeCookieValue`
mostantól úgy kezeli a hibás kódolást, mintha a süti ott sem lenne — a hívó a
szokásos „nincs jelzés" ágra megy. Ez a helyes GDPR-tartás: nem találgatunk, de
nem is ejtünk leadet.

> **Amit ez a módszerről mond.** A `#53` azt mutatta meg, hogy a vendorolt példány
> elmaradhat a csomag mögött. Ez a szelet a fordítottját: **a csomag is elmaradhat
> egy site mögött.** Egy „a kanonikus mindig jobb" feltevés mind a hármat átvitte
> volna regresszióként. A harness nem azért van, hogy a forkot marasztalja el —
> azért, hogy a KÜLÖNBSÉG látszódjon, bármelyik irányba mutat.
