# Flotta-átvizsgálás — a hibás consent-süti elejtett egy leadet (2026-08-26)

**Állapot:** mind a hat érintett site-on javítva, PR nyitva. A kanonikus csomag
javítása a `6.6.1` (Serverside #104, #105).

## Mi a hiba

A vendorolt site-backend `readConsentFromCookie`-ja őrizetlenül hívta a
`decodeURIComponent`-et. Egy hibás percent-szekvencia (`%zz`, csonka `%E0`)
`URIError`-t dob — és ez a függvény a **lead-útvonalon** fut: az API-route a
konverzió összeállítása közben hívja.

A dobás tehát nem „hiányzó telemetria", hanem **500-as válasz a beküldött
űrlapra**. Az ügyfél leadje vész el egy elrontott süti miatt, amit nem is ő írt.

Honnan került elő: az **F9/3.4 szerver-szelet** paritás-futásából. A painless fork
kezelte az esetet, a kanonikus mag nem — tehát a migráció, ha vakon megy át,
regressziót vitt volna a site-ra. Utána derült ki, hogy a fork volt a kivétel: a
FLOTTA TÖBBI RÉSZE mind a hibás alakot futtatta.

## A mért hatókör

| Site | vendorolt kiadás | őrizetlen dekódolás | PR |
|---|---|---|---|
| `lomtalan.hu` | régi (verziószám nélkül) | 1 | [#18](https://github.com/Soborbo/lomtalan.hu/pull/18) |
| `skinlab-hungary` | régi | 1 | [#37](https://github.com/Soborbo/skinlab-hungary/pull/37) |
| `trapezlemezes-webshop` | régi | 1 | [#60](https://github.com/Soborbo/trapezlemezes-webshop/pull/60) |
| `beautyflow_website` | régi | 1 | [#66](https://github.com/Soborbo/Beautyflow_website/pull/66) |
| `agykontrollanglia` | régi | 1 | [#4](https://github.com/Soborbo/agykontrollanglia/pull/4) |
| `olcsokontenerhaz` | **6.2.0** | **3** | [#20](https://github.com/Soborbo/olcsokontenerhaz/pull/20) |
| `szelloztessokosan` | — | — | **nem érintett** (nincs szerver-láb) |

**Mind a hat szerver-lábas site-on megvolt.** A `szelloztessokosan` a régebbi,
Zaraz-alapú kliens-modellt futtatja, `gateway-dispatch` nélkül.

## Amit a javítás SZÁNDÉKOSAN nem csinál

Nem emel verziót és nem vendorol újra. Ezek a másolatok jóval régebbi kiadásból
valók (a `6.2.0` a legfrissebb közülük, a kanonikus `6.6.1`) — egy `6.6.1`-re
ugratás nem hibajavítás lenne, hanem **könyvtár-upgrade**, saját migrációval,
saját paritás-harness-szel és saját kockázattal. A PR-ek ezért a **sebészi
guardot** viszik: 10 sor, egy fájl, site-onként.

## A degradáció hívónként MÁS

Az `olcsokontenerhaz` a `6.2.0`-n van, tehát nála a `buildConsentSources` is
megvan. A „ne dobjon" azonban még nem mondja meg, MIRE degradáljon:

| hívó | kérdés | degradáció |
|---|---|---|
| **kapu** (`readConsentFromCookie`, `readSboConsentCookieHeader`) | „milyen hozzájárulásra hivatkozhatunk?" | `undefined`/`null` → `require_consent`, **fail closed** |
| **telemetria** (`buildConsentSources`) | „mit láttunk?" | a **nyers, dekódolatlan** értékre esik vissza, és jelent tovább |

Egy hosszú süti EGYETLEN hibás escape-je miatt a közös „adjunk `undefined`-et"
elveszítené a mellette álló, olvasható `advertisement:yes`-t — a mérés némán
nullázódna, miközben a felhasználó igenis döntött.

## Ellenőrzés site-onként

| Site | teszt | build |
|---|---|---|
| `trapezlemezes-webshop` | 374 zöld | zöld |
| `beautyflow_website` | 125 zöld | zöld |
| `lomtalan.hu` | nincs script | zöld |
| `agykontrollanglia` | nincs script | zöld |
| `olcsokontenerhaz` | E2E 6 bukás — **az alapvonalon ugyanaz** | zöld |
| `skinlab-hungary` | nincs script | typecheck 0 hiba; a build szándékos env-kapun áll meg |

Az `olcsokontenerhaz` Playwright-bukásait `git stash`-sel visszaellenőriztem a
javítás NÉLKÜLI fán: pontosan ugyanaz a 6/1 arány. Környezeti (nincs élő
szerver/böngésző a konténerben), nem a PR okozza.

## Módszertani megjegyzés — a GitHub kód-keresés HAMIS NEGATÍVOT adott

A hatókör felmérése `search_code`-dal indult (`BACKEND_LIB_VERSION repo:…`).
**Hat repóból hármat kihagyott volna:** a `lomtalan.hu`, `skinlab-hungary` és
`trapezlemezes-webshop` `0 találat`-ot adott, miközben mindháromban ott a
`gateway-dispatch.ts`. Kettőnél a válasz `incomplete_results: true` volt (részleges
index), egynél viszont `false` — tehát még a „teljes" nemleges sem volt megbízható.

A hatókört végül **közvetlen könyvtár-olvasás** (`get_file_contents`) és
`--filter=blob:none` sparse-klónok döntötték el. Egy „nincs találat" a
kód-keresésben NEM bizonyíték arra, hogy a kód nincs ott.

## Nyitva

- A PR-ek review + merge + deploy.
- A `szelloztessokosan` kliens-modellje külön kérdés (nem ez a hiba).
- A lomtalan `package-lock.json`-ja nincs szinkronban a `package.json`-nal
  (`npm ci` elhasal). Külön tétel; a PR nem nyúlt hozzá.
