# Átadó — 6.13.0 telepítése (lokális Claude Code-nak)

Másold be a lokális Claude Code-nak (a `Soborbo/Serverside` repóban, ahol a
`wrangler` be van jelentkezve). A CLAUDE.md szabályai érvényesek.

---

## Feladat

Telepítsd az `event-gateway` Workert a `main` aktuális állapotáról (6.13.0),
ellenőrizd, majd készítsd elő a site-csomagok frissítését. Éles adatbázis-
migrációt NE futtass — az már megtörtént (lásd lent).

## Kiinduló állapot (2026-10-18 19:06 UTC)

- `origin/main` = `94e49ac` (#142, „R7 — szerver kiadta lánc-kulcs…"). Ez a
  teljes 6.13.0: worker + `soborbo-tracking` kliens 6.13.0.
- Élő worker: `build_commit = 9273788` (6.12-es kód, 2026-10-18 12:55 óta).
- Éles D1 (`event-gateway-ledger`, `8c7774d1-2eea-40ba-b99c-92e73055460f`):
  a `0011`, `0012` és `0013` migráció **2026-10-18 ~18:58 UTC-kor lefutott**
  (MCP-n keresztül, kézzel). **NE futtasd újra**: az `ALTER TABLE … ADD COLUMN`
  „duplicate column" hibával elbukna. A `wrangler d1 migrations` ezekről nem
  tud (nem a wrangler futtatta), ezért `wrangler d1 migrations apply`-t se
  indíts.
- Incidens (lezárva): 12:55 és 18:58 között a 6.12-es worker a hiányzó
  oszlopok miatt egyetlen consent-döntést sem tudott tárolni (503; a kliens
  őrzi és újraküldi). A migráció után az írás helyreállt (19:05-től újra jönnek
  sorok).

## Lépések

1. **Előkészítés**
   ```bash
   git checkout main && git pull --ff-only
   git rev-parse --short HEAD          # 94e49ac (vagy újabb, de 94e49ac-t tartalmazó)
   git status --porcelain              # ÜRES legyen — a build_dirty=true deploy drift-riasztást ad
   npm ci && npm run typecheck && npm test
   (cd soborbo-tracking && npm ci && npm run typecheck && npm test)
   npm run check:package-version && npm run check:dist-manifest && npm run check:error-codes
   ```
   Várt: 1440 worker-teszt, 512 kliens-teszt zöld.

2. **Séma-ellenőrzés (csak olvasás)**
   ```bash
   npx wrangler d1 execute event-gateway-ledger --remote --command \
     "SELECT (SELECT COUNT(*) FROM pragma_table_info('consent_log') WHERE name IN ('key_hash','verified')) AS cols, (SELECT COUNT(*) FROM pragma_table_info('consent_chain')) AS chain_cols"
   ```
   Várt: `cols = 2`, `chain_cols = 5`. Ha nem: ÁLLJ MEG és jelezd.

3. **Deploy**
   ```bash
   npx wrangler deploy
   ```
   (A `[build]` a `scripts/stamp-build-info.mjs`-sel beégeti a commitot.)

4. **Ellenőrzés**
   - `curl -s https://thebespokejoinery.co.uk/api/event/version` →
     `build_commit` = a main HEAD, `build_dirty: false`.
   - `curl -s https://tracking.soborbo.co.uk/api/event/health` → `ok`.
   - `npx wrangler tail event-gateway --format json` ~10 percig: nincs új
     `TRK-000-007` (`readConsentChainAuth` / `recordConsentDecision` /
     `readConsentState.successors`) és nincs `TRK-910-009` hullám.
   - D1: a consent_log-ba továbbra is jönnek sorok, és az új láncoknál
     megjelenik a `consent_chain` sor:
     ```sql
     SELECT COUNT(*) FROM consent_log WHERE server_received_at >= '<deploy ideje>';
     SELECT COUNT(*) FROM consent_chain WHERE bound_at >= '<deploy ideje>';
     ```
   - Egy sbo-site-on (befilo: thebespokejoinery.co.uk) a banner-döntés után a
     `POST /api/consent` válasza 204, és van `Set-Cookie: sbo_consent_key=…;
     Path=/api/consent; HttpOnly; SameSite=Strict; Secure` (DevTools → Network).

5. **Visszaállítás, ha baj van**
   `npx wrangler rollback` az előző (9273788) verzióra. A migrációk additívak,
   a 6.12 velük is működik; a `consent_chain` sorait a 6.12 nem használja (a
   6.13 alatt kötött láncok védelme visszaállítás alatt szünetel).

6. **Site-csomagok (6.13.0) — külön lépés, a deploy UTÁN**
   - Érintett: az sbo-CMP-s site-ok (befilo, nonmono.hu, nonmono.org, és ami
     még `consent.provider = "sbo"`). A CookieYes-site-oknál a kliensváltozás
     nem hat, de a verzió frissíthető.
   - A `soborbo-tracking` csomag másolása a site `src/lib/tracking`-jébe az
     INSTALL.md szerint, utána a repó gyökeréből:
     `npm run check:vendored -- <site>/src/lib/tracking` → CLEAN.
   - **nonmono (paywall_boilerplate `lib/tracking/gateway-proxy.ts`)**: a
     proxynak a `/api/consent*` kérésnél a `Cookie` fejlécet tovább kell adnia,
     a válasz `Set-Cookie` fejlécét pedig vissza kell adnia a böngészőnek.
     Ezt ELLENŐRIZD (ebből a repóból nem látszott). Ha nem adja vissza, a lánc
     minden engedély-bővítésnél forgatni fog (működik, de zajos).
   - A süti-leltár változott (`sbo_consent_key`, `sbo_consent_pending`,
     inventory `2026-10-a`): a közzétett süti-táblát (`<CookiePolicy>`) is
     frissíteni kell a site-okon.

## Nyitott, döntést / élő próbát igénylő pontok

- gbraid/wbraid 90 napos (click ID) besorolása feltételezés.
- A műveletenkénti Google konverziós ablakot (1–90 nap) a kód nem ellenőrzi.
- Saját CMP alatt a webes döntés nélküli (pl. telefonos) leadek offline
  konverziója nem töltődik fel — üzleti jóváhagyás kell.
- `compliance:selftest` (Playwright-verzió) és `check:roundtrip` /
  `check:fleet-contract` (élő KV) a felhőben nem futott — lokálisan futtasd.

Részletek: `soborbo-tracking/CHANGELOG.md` (6.13.0), `docs/CONSENT-DECISIONS.md`,
`docs/REVENUE-SEMANTICS.md` (D4).
