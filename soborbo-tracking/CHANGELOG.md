# soborbo-tracking — változásnapló

A verzió három helyen él, és mind a háromnak egyeznie kell (`npm run
check:package-version` a repó gyökeréből): `package.json` · `lib/config.ts`
`CLIENT_LIB_VERSION` · `server/backend/gateway-dispatch.ts` `BACKEND_LIB_VERSION`.

Ez a napló a **6.3.0-tól** vezetett. A korábbi verziókról nincs rekonstruált
bejegyzés — a git-történet az egyetlen forrás rájuk, és nem írunk ide olyat,
amit nem tudunk bizonyítani.

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
