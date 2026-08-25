# F9/3 — Painless: leltár és adapter-szerződés (1–2. lépés)

**Állapot:** 1–3. lépés KÉSZ (leltár + adapter-felület + paritás-harness).
A következő munka a 4. lépés: a kanonikus mag az adapter mögé.

**A jóváhagyott sorrend, amiből ez a dokumentum az első kettő:**

```
1. Painless public tracking API leltár        ← KÉSZ (ez a dokumentum)
2. compatibility adapter API megtervezése     ← KÉSZ (ez a dokumentum)
3. paritás-harness a MAI fork ellen           ← KÉSZ (painless #50)
4. kanonikus mag az adapter mögé
5. ugyanazok a paritás-tesztek GREEN
6. fork-fájlok eltávolítása
7. build/test
8. deploy
9. smoke ledger version = 6.3.x
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
