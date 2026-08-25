# F9 · P4 — Verziózott csomag: 1. lépcső (verzió-tekintély + terjesztési manifeszt)

**Állapot:** 1. lépcső KÉSZ. A 2. lépcső (painless migráció) külön PR, külön repó.
**Viselkedés-változás éles forgalomra: nincs.**

---

## A mért kiindulóhelyzet (2026-08-25)

Nem becslés — a `event-gateway-ledger` D1 lekérdezése:

```sql
SELECT site_id, COALESCE(client_lib_version,'(NULL)') AS v, COALESCE(ingress_kind,'(NULL)') AS ingress,
       COUNT(*) AS n, MIN(received_at), MAX(received_at)
  FROM consent_receipts GROUP BY site_id, v, ingress ORDER BY n DESC;
```

| Tény | Érték |
|---|---|
| consent-receipt összesen | **1392** |
| ebből `client_lib_version` KITÖLTVE | **1** (olcsokontenerhaz, böngésző, 2026-08-24, `6.2.0`) |
| ebből NULL | **1391** |
| NULL-t jelentő site-ok | painless, trapezlemezes, beautyflow, lomtalan, olcsokontenerhaz, skinlab, agykontroll, szelloztetes |
| NULL **szerver-ingressen is** | igen — 2026-08-25-i sorokon is |

**Miért ez a döntő bizonyíték.** A kanonikus kliens (`lib/gateway.ts`
`collectConsentSources`) és a kanonikus backend (`server/backend/gateway-dispatch.ts`
`buildConsentSources`) is **feltétel nélkül** beleteszi a verziót a payloadba. A
gateway pedig hűen eltárolja, amit megkap (`parseConsentSources` nem dob el
érvényes verziót). Tehát a NULL egyetlen dolgot jelenthet: **a site olyan kódot
futtat, ami ezt a mezőt nem küldi** — vagyis a bemásolt példány régebbi vagy más,
mint a kiadás.

Következmény, ami eddig néma volt: a **`TRK-910-006` (CONSENT_CLIENT_LIB_OUTDATED)
őr soha nem tüzelhet.** Deklarálva van, be van kötve, és nulla adatot lát.

## A painless nem elavult másolat, hanem fork

```
$ node scripts/check-vendored-copy.mjs d:/painlessremovals/src/lib/tracking

   FORK — A kiadás 27 fájljából 22 egyáltalán NINCS MEG ebben a példányban.
   Összesen: 0 azonos · 5 eltér · 22 hiányzik · 8 idegen
```

A példányban `tracking.ts`, `boot.ts`, `form-tracking.ts`, `conversion-state.ts`,
`global-listeners.ts`, `utm-capture.ts`, `server.ts` van — a kiadásban
`gateway.ts`, `consent.ts`, `events.ts`, `persistence.ts`, `submit.ts`. **Nulla
verzió-konstans.** Ez nem frissítés-kérdés: a migráció csere.

---

## Amit az 1. lépcső ad

### 1. Egy verzió-tekintély (`npm run check:package-version`)

A verzió három helyen él, és a duplikáció **szerkezeti**:

| Hely | Miért nem importálhatja a package.json-t |
|---|---|
| `package.json` `version` | — **ez a forrás** |
| `lib/config.ts` `CLIENT_LIB_VERSION` | böngésző-bundle-be fordul |
| `server/backend/gateway-dispatch.ts` `BACKEND_LIB_VERSION` | ÖNÁLLÓAN másolódik a site repójába, ahol nincs package.json |

Az őr az **első futásán elkapott egy valódi driftet**: `6.2.1 / 6.2.1 / 6.2.0`.
Ma még ártalmatlan (`MIN_CLIENT_LIB_VERSION` = 6.1.0), de pontosan az a minta,
ami a #93-ban már elsült — két igazság ugyanarról.

A hiányzó konstans **nem** számít egyezésnek: az a verzió-jelentés elvesztése.

### 2. Terjesztési manifeszt (`npm run check:dist-manifest`)

`soborbo-tracking/dist-manifest.json` — a 27 terjesztendő fájl (lib + components +
server/backend) tartalom-hash-e a verzióval. Tesztfájl sosem kerül bele.

A hash **sorvég-normalizált** (CRLF→LF): a repót Windowson és Linuxon is
szerkesztjük, és egy sorvég-különbség önmagában driftnek látszana — mire a riport
megtanulná, hogy mindent pirosnak mutat, senki nem nézné.

CI-őrzött: ha a csomag tartalma változik és a manifeszt nem, a build bukik.

### 3. Drift-riport bemásolt példányra (`npm run check:vendored -- <dir>`)

Egy site vendorolt könyvtárát veti össze a kiadással, fájlonként:
`identical` / `drifted` / `missing` / idegen. Az ítélet háromállapotú:

- **CLEAN** — a példány bitre a kiadás;
- **DRIFTED** — n fájl eltér / hiányzik;
- **FORK** — a kiadás fájljainak többsége nincs meg → **csere, nem frissítés**.

Felismeri a **lapos** vendorolt elrendezést is (`lib/gateway.ts` → `gateway.ts`),
mert az INSTALL.md így másoltat. Az idegen fájl látszik, de **nem buktat**: lehet
a site saját kódja — a kimenet bizonyíték, nem verdikt.

---

## Amit az 1. lépcső SZÁNDÉKOSAN nem ad

**Nem szünteti meg a másolást.** A csomag `private: true`, a site-ok külön repók,
amiket a Cloudflare Workers Builds épít — egy privát registry minden site
build-környezetébe tokent kívánna. A manifeszt ennél olcsóbb első lépcső: nem
váltja ki a másolást, de **auditálhatóvá teszi**, és ez az, ami ma teljesen
hiányzik. A registry-döntés a 2. lépcső része, valódi migrációs igény mellett.

**Nem javít semmit a site-okon.** A riport mér.

---

## A jóváhagyott lépcsősor (a 2. lépcsőtől)

```
Serverside kanonikus csomag        ← 1. LÉPCSŐ (ez a PR)
        ↓
verziózott kiadás                  ← 1. LÉPCSŐ (manifeszt + verzió-őr)
        ↓
Painless adapter/migráció          ← 2. lépcső, MÁSIK REPÓ, külön PR
        ↓
paritás + RED/GREEN                ← a migráció kapuja
        ↓
előbb NULLA viselkedés-változás
        ↓
KÜLÖN rolloutban: P5 commitOnSuccess
```

**Egy PR-ban tilos: F9 + P5 élesítés + CMP flip.**

### A 2. lépcső kapuja (mit kell tudni, mielőtt a painless hozzáér)

1. A `check-vendored-copy` riport FORK-ot mond → a migráció **csere**. Az
   adapter-réteg feladata, hogy a site meglévő hívási pontjai (`tracking.ts`
   export-felülete) változatlanul működjenek a kanonikus lib fölött.
2. **Paritás-teszt kell a csere ELŐTT**: ugyanaz a bemenet → ugyanaz a dataLayer
   push, ugyanaz a gateway-payload. RED a mai fork-viselkedésre, GREEN a
   kanonikusra.
3. A `client_lib_version` megjelenése a ledgerben a **kimeneti bizonyíték**: a
   painless sorai NULL-ról `6.3.0`-ra váltanak. Ez az egyetlen olyan jel, ami
   kívülről, gépileg igazolja a migrációt.
4. A P5 `commitOnSuccess` **nem ebben a lépésben** kapcsol be.

---

## Parancsok

```bash
npm run check:package-version          # három hely, egy verzió
npm run gen:dist-manifest              # a manifeszt újragenerálása
npm run check:dist-manifest            # CI: szinkronban van-e
npm run check:vendored -- d:/painlessremovals/src/lib/tracking
npm run check:vendored -- <dir> --json # gépi alak
```
