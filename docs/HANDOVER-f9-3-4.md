# HANDOVER — F9/3.4 lezárva (2026-08-27)

**Egymondatos állapot:** a painless tracking-fork **elfogyott** — mindkét láb a
kanonikus `soborbo-tracking@6.6.2` magon fut —, és a menet közben talált
lead-vesztő hiba a **teljes flottán** javítva, deployolva.

---

## 1. Hol tart az F9/3

```
1. Painless public tracking API leltár        KÉSZ
2. compatibility adapter API megtervezése     KÉSZ
3. paritás-harness a MAI fork ellen           KÉSZ  (painless #50)
4. kanonikus mag az adapter mögé              KÉSZ  (painless #51–#56, #60)
5. ugyanazok a paritás-tesztek GREEN          KÉSZ  (21/21)
6. fork-fájlok eltávolítása                   KÉSZ  (szerver-láb 578 → 353 sor)
7. build/test                                 KÉSZ  (451 + 411 + 1148)
8. deploy                                     KÉSZ  (2026-08-27 07:44–07:46 UTC)
9. smoke ledger version = 6.6.x               KÉSZ  (a szám a magból származik)
```

**A `BACKEND_LIB_VERSION` már nem literál**, hanem re-export a vendorolt magból.
A ledger `client_lib_version` sorai a `NULL → 0.0.0-painless-fork → 6.6.2` úton
haladtak; a 6.6.2 megjelenése a migráció kívülről, gépileg igazolható jele.

### ✅ Ledger-verifikáció — LEFUTOTT, MINDKÉT LÁB 6.6.2 (2026-08-27)

A handover ezt hagyta egyetlen nyitott bizonyítékként (nem volt hitelesítés).
Azóta lefutott a `event-gateway-ledger` D1-en, csak olvasással:

| mikor (UTC) | ingress | `client_lib_version` | `source_used` | `finding_codes` | |
|---|---|---|---|---|---|
| 11:04:10 | server | **6.6.2** | cookieyes_cookie | – | kézi teszt-lead |
| 09:44:33 | server | **6.6.2** | cookieyes_cookie | – | **organikus** |
| 08:31:25 | browser | **6.6.2** | cookieyes_cookie | – | |
| 04:51:58 | server | `0.0.0-painless-fork` | none | `TRK-910-006` | deploy ELŐTTI cron-smoke |

Két megerősítő jel a verziószámon túl: a **`TRK-910-006` verzió-drift őr eltűnt**
minden deploy utáni sorról, és a `source_used` `none` → `cookieyes_cookie`-ra
váltott — tehát nemcsak a verzió stimmel, a consent-forrás feloldása is működik
a kanonikus magon. **A migráció produkciós adaton igazolt.**

> ⚠️ **A napi cron-smoke NEM újrafuttatható ugyanaznap.** Az `event_id`
> determinisztikus (`smoke-painless-YYYYMMDD`), a gateway idempotencia-ága pedig
> KORÁBBAN tér vissza (`src/routes/conversion.ts:669`), mint ahol a receipt
> íródik (`:834`) — az ismételt tüzelés „duplicate"-ként elnyelődik, és **nem ír
> új sort**. Új proofhoz friss `event_id` kell: valódi űrlap-beküldés a
> `TRACKING_TEST_LEAD_EMAIL` címmel (Meta TEST stream,
> `TRACKING_TEST_EVENT_CODE=TEST_PAINLESS`), vagy a másnapi cron.

> ⚠️ A lekérdezéshez `npx wrangler d1 execute event-gateway-ledger --remote --json
> --command "..."` kell; az `mcp__cloudflare__d1_query` `[object Object]`-et ad vissza.

---

## 2. Mi történt a csomaggal: 6.6.0 → 6.6.2

### 6.6.1 — a site-backend süti-olvasói elejthettek egy leadet

Három hiba **a kanonikus magban**, amit a painless fork NEM tartalmazott:

| # | Hiba | Következmény |
|---|---|---|
| 1 | `decodeURIComponent` őrizetlenül, 3 helyen | Hibás percent-szekvencia `URIError`-t dob a **lead-útvonalon** → 500-as válasz a beküldött űrlapra |
| 2 | `raw_cookie` csonkítatlanul a receiptre | A teljes consent-süti a `consent_debug`-ba |
| 3 | `readMetaCookies` → `{ fbc: undefined }` | `'fbc' in cookies` igazat ad nem létező klikk-ID-re |

**A degradáció hívónként MÁS** — ezt a javítás első alakja összemosta:

| hívó | kérdés | degradáció |
|---|---|---|
| **kapu** (`readConsentFromCookie`, `readSboConsentCookieHeader`) | „milyen jogalapra hivatkozhatunk?" | `undefined`/`null` → `require_consent`, **fail closed** |
| **telemetria** (`buildConsentSources`) | „mit láttunk?" | a **nyers** értékre esik vissza, és jelent tovább |

Két helper: `safeDecodeCookieValue` (kapu) és `decodeCookieValueLossy` (telemetria).

### 6.6.2 — a `service` címke a szerver-lábon is

A böngésző-láb küldte, a gateway fogyasztja (`src/lib/ga4.ts`), csak a szerver-láb
hagyta ki. Mivel a CLAUDE.md 10. pontja szerint MINDEN high-value konverzió a
szerver-ingressen jön, a címkét pont ott vesztettük el, ahol a pénz van.

Ez blokkolta a painless transzport-delegálását is: a kanonikus
`sendGatewayConversion` a SAJÁT payload-építőjét hívja.

---

## 3. Mi maradt site-lokális a painlessben — és miért

`GatewayEnv` (env-változók NEVEI) · `gatewayBaseUrl` / `isGatewayConfigured`
(config-politika) · `deliverGatewayConversion` (logging + `waitUntil`) ·
`splitFullName` (nincs kanonikus párja) · `toCanonicalEnv` / `toCanonicalInput`
(a nevek leképezése).

Ez **nem könyvtár-logika**. A payload-építés, a süti-olvasók, a transzport, a
retry-politika és az auth mind a magé.

> 🛑 **A `toCanonicalEnv` LÉTFONTOSSÁGÚ.** A service binding neve a site-on
> `EVENT_GATEWAY` (`wrangler.toml`), a magban `GATEWAY`. Ha valaki ezt a
> leképezést kiveszi, a kanonikus küldő nem találja a bindingot, a lead-végpont
> **továbbra is 200-at ad**, és a gateway sosem látja az eventet. Néma nulla.

---

## 4. Flotta — a lead-vesztő hiba mindenhol javítva

| Site | vendorolt kiadás | őrizetlen dekódolás | PR |
|---|---|---|---|
| `lomtalan.hu` | régi | 1 | #18 |
| `skinlab-hungary` | régi | 1 | #37 |
| `trapezlemezes-webshop` | régi | 1 | #60 |
| `beautyflow_website` | régi | 1 | #66 |
| `agykontrollanglia` | régi | 1 | #4 |
| `olcsokontenerhaz` | **6.2.0** | **3** | #20 |
| `szelloztessokosan` | — | — | nem érintett |

Mind merge-elve és deployolva. Részletek:
`docs/2026-08-26-fleet-consent-cookie-guard.md`.

> ⚠️ **A flotta NEM 6.6.2-n van.** Ezek a PR-ek a **sebészi guardot** vitték, nem
> verzió-emelést: a másolatok jóval régebbi kiadásból valók, és egy 6.6.2-re
> ugratás könyvtár-upgrade lenne — saját migrációval, saját paritás-harness-szel,
> saját kockázattal, site-onként. Ez külön munkacsomag.

---

## 5. Nyitva maradt tételek

| Tétel | Megjegyzés |
|---|---|
| ~~Ledger-verifikáció~~ | ✅ **LEZÁRVA** — mindkét láb `6.6.2`, a drift-őr eltűnt (lásd 1. szakasz) |
| **Flotta felzárkóztatása 6.6.2-re** | Site-onkénti könyvtár-upgrade, nem hibajavítás |
| **`lomtalan.hu` lockfile** | `npm ci` elhasal, `@emnapi/*` hiányzik. A PR nem nyúlt hozzá |
| **`szelloztessokosan`** | Régebbi, Zaraz-alapú kliens-modell; nincs szerver-láb |
| **P5 `commitOnSuccess` rollout** | Külön PR, nulla hívási hely ma |
| **CMP flip** | Külön PR; a site ma nem használ SBO-CMP-t |
| **Globális GA4 foglalt-név átnevezés** | `source` → `cta_context` kód + GTM-konténer EGYÜTT, minden site-on. A `check:ga4-params` racsni tartja a status quót |

---

## 6. Négy tanulság, amit érdemes átvinni

**1. A `not.toThrow()` nem viselkedést rögzít.** A painless
`consent-sources.test.ts` robusztusság-tesztje zöld maradt egy változás fölött,
ami consent-jelzést semmisített volna meg — mert csak a kivétel hiányát
állította, a degradáció CÉLJÁT nem. Ha robusztusságot tesztelsz, mondd ki, **mire
degradál**.

**2. A kanonikus mag is elmaradhat egy fork mögött.** Az F9/3.4-ig minden
paritás-találat a forkot marasztalta el. A szerver-szeleten megfordult: három
ponton a fork volt a helyes. Egy „a kanonikus mindig jobb" feltevés mind a hármat
regresszióként vitte volna át.

**3. A GitHub kód-keresés hamis negatívot ad.** A flotta-felmérés
`search_code`-dal indult, és **hat repóból hármat kihagyott volna** — egyiküknél
`incomplete_results: false`-szal, tehát még a „teljes" nemleges sem megbízható. A
hatókört közvetlen könyvtár-olvasás (`get_file_contents`) és
`--filter=blob:none` sparse-klónok döntötték el.

**4. A verziószám ne legyen kézzel karbantartott.** Egy literál pont azt a
driftet fedi el, amit mérni hivatott. A `BACKEND_LIB_VERSION` most re-export a
vendorolt magból: **vendorolt mag → konstans → receipt**, végig gépi.

---

## 7. A használt módszer, egy sorban

```
leltár → karakterizáció → csere        NEM:  csere → nézzük meg, mi romlott el
```

Ez a menet ebben a fázisban **öt** olyan production hibát fogott meg, amit a vak
migráció vagy benn hagyott, vagy visszahozott volna: a telefon-normalizálás
divergenciáját, a GA4 foglalt-név regressziót, a klikk-ID sorrendet (#53), a
consent-süti `URIError`-t, és a `service` címke elvesztését.
