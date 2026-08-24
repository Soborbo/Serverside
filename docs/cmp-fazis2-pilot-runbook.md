# CMP Fázis 2 — pilot-élesítési runbook (olcsokontenerhaz.hu)

**Ez a dokumentum EMBERI végrehajtásra készült.** A kód (Fázis 2, `feat/soborbo-cmp-fazis2`)
merge után is inert: minden viselkedésváltozás két kapcsoló MÖGÖTT van, és mindkettő
átállítása kézi művelet:

- kliens: `PUBLIC_TRACKING_CONSENT_PROVIDER=sbo` (site build-env)
- szerver: SITE_CONFIG KV `consent.provider = "sbo"`

⚠️ **A main-merge automatikusan deployol** (Workers Builds, ~20 mp). A Fázis 2 merge-e
ettől még biztonságos (provider-default `cookieyes` mindenhol), de a lenti lépések
sorrendje kötelező, és a pilot-flip NEM lehet ugyanaznap más éles változtatással
(pl. gads-javítás) — különben egy anomália nem attribútálható.

---

## 0. Előfeltételek (merge előtt ellenőrizni)

- [ ] Diff-ellenőrzés: a `provider` default tényleg `cookieyes` mindenhol; a másik
      14 site kódjához/configjához nem nyúlt a PR.
- [ ] `vitest` zöld MINDKÉT csomagban (`d:\Serverside` gyökér: 772+, `soborbo-tracking`: 193+).
- [ ] Fázis 1 (PR #63) élesben van és inert (a `/api/consent` 403-at ad minden site-on).
- [ ] A 0006-os migráció (consent_log + consent_metrics + consent_receipts.consent_id)
      LEFUTOTT az éles D1-en, és a `d1_migrations` könyvelés naprakész — enélkül a
      pilot első consent-POST-ja 503-at kapna (a kliens őrzi és újraküldi, de a
      flip nem indulhat így).

## 1. Serverside merge (1. nap)

1. PR merge → autodeploy. **Egy napig figyelés**: a worker logokban nem jelenhet meg
   új hibakód; a `consent_log` üres marad (nincs sbo-site).
2. KV-előkészítés (inert, explicit):
   ```bash
   node scripts/patch-site-config.mjs olcsokontenerhaz.hu '{"consent":{"provider":"cookieyes"}}'
   ```
   Ez dokumentálja a kapcsoló helyét — viselkedést nem változtat.

## 2. Pilot site-integráció (olcsokontenerhaz.hu repo, külön PR)

1. A vendorolt tracking-lib frissítése a `soborbo-tracking` v6.2.0-ra (lib + components).
2. Layout `<head>`: `<Tracking gtmId=... cookieYesId=... />` MARAD (a provider env-ből
   jön, és amíg nincs átállítva, a CookieYes-ág fut bitre azonosan).
3. Layout `<body>` vége: `<ConsentBanner policyHref="/adatkezelesi-tajekoztato" />`.
4. **`<TrackingNoscript />` eltávolítása** a pilotról (noscript alatt consent-döntés
   sincs — a GTM-iframe consent előtt futna).
5. Footer, minden oldalon: `<a href="#" data-sb-consent-open>Süti beállítások</a>`.
6. Backend lead-dispatch: a `sendGatewayConversion` inputjába
   `consentId: readSboConsentCookieHeader(request.headers.get('cookie'))?.consentId`
   (CookieYes alatt null → a mező ki sem megy).
7. Build-env (a flip NAPJÁIG): `PUBLIC_TRACKING_CONSENT_PROVIDER` NINCS beállítva
   (= cookieyes). Már most beállítandó: `PUBLIC_TRACKING_POLICY_VERSION` (az
   adatkezelési tájékoztató verziócímkéje, pl. `2026-08`).
8. **Süti-tájékoztató átírása** (HU, natívan): CookieYes mint recipient KI, a saját
   rendszer BE; harmadik felek NÉVVEL (Google, Meta, Cloudflare); süti-nevek és
   időtartamok (`sbo_consent` 180 nap, `sb_tracking` 90 nap, `_fbp`/`_fbc`, `_ga*`);
   US-transzfer említve. Tiltott frázisok: lásd `consent-texts/2026-08-a/hu.json`
   `_copy_rules`.
9. Deploy — a viselkedés még bitre a mai (CookieYes fut). Egy nap figyelés.

## 3. A pilot-flip (külön napon, reggel — hogy egész nap figyelhető legyen)

1. CookieYes dashboard: a pilot bannerének KIKAPCSOLÁSA (a szkript az oldalon marad
   — a párhuzamos mérési ablak a sütijét olvassa).
2. Site build-env: `PUBLIC_TRACKING_CONSENT_PROVIDER=sbo` → deploy.
3. KV: `node scripts/patch-site-config.mjs olcsokontenerhaz.hu '{"consent":{"provider":"sbo"}}'`
   (edge-cache 300 mp — a két kapcsoló között max 5 perc az átfedés, ez elfogadott).
4. **Azonnali ellenőrzés (Tag Assistant / GTM Preview):**
   - a `consent default` (mind denied) BIZONYÍTHATÓAN minden tag előtt fut;
   - döntés előtt a GTM el sem indul (nincs gtm.js kérés);
   - ⚠️ a kikapcsolt bannerű CookieYes NEM push-ol saját consent-parancsot a
     dataLayerbe. **Ha push-ol, a CookieYes szkriptet el kell távolítani** (a
     párhuzamos ablak a perzisztens sütiből még ~180 napig mérhető).
   - accept után: GTM betölt, GA4+Ads+Meta tag tüzel, a gclid megérkezik a konverzióval;
   - reject után: GTM nem tölt be, a gateway-konverzió receiptje DENIED jeleket hordoz.
5. `consent_log` ellenőrzés (D1):
   ```sql
   SELECT decision, COUNT(*), AVG(cky_agreement) FROM consent_log
    WHERE site_id='olcso' GROUP BY decision;
   ```

## 4. Compliance harness (a flip után)

- `tests/compliance/sites.json`: az olcso bejegyzés `"cmp": "sbo"`-ra állítása.
- Teljes mátrix futtatása **asztali** Claude Code-ban (WebKit + valódi TLS + HU IP):
  ```bash
  npm run compliance -- --site=olcso --browser=chromium
  npm run compliance -- --site=olcso --browser=webkit
  ```
- A kritikus assert: A-forgatókönyvben nulla consent-kötött kérés ÉS a consent
  default a tagek előtt; C-ben (reject) semmi; D-ben (withdrawal) a
  `remaining_non_essential` üres. **A csak-Chromium zöld nem bizonyíték** (ITP-elfedés).

## 5. Párhuzamos ablak zárása (flip + 1-2 hét)

1. `cky_agreement` egyezési arány (a fenti SQL): ha tartósan ~1.0, a két rendszer
   ugyanazt látja. Ha nem, ELŐBB megérteni, miért — nem zárni az ablakot.
2. CookieYes szkript le a pilotról (`cookieYesId` prop törlése) + CookieYes
   dashboardon a site archiválása.
3. `consent_metrics` gyorsjelentés: banner-megjelenések, medián `interaction_ms`,
   döntés-nélküli arány (interaction_ms IS NULL).

## Rollback (bármelyik ponton)

- Kliens: `PUBLIC_TRACKING_CONSENT_PROVIDER` törlése + deploy, CookieYes banner
  vissza a dashboardon.
- Szerver: `node scripts/patch-site-config.mjs olcsokontenerhaz.hu '{"consent":{"provider":"cookieyes"}}'`
- Kód-rollback main-en: `git revert` + push (NEM `wrangler rollback` — a Builds CI
  a mainből deployol).
- A `consent_log` már beírt sorai MARADNAK (append-only bizonyíték — a rollback nem
  törli, és nem is szabad).

## Amit ez a fázis SZÁNDÉKOSAN nem csinált

- Nem nyúlt a másik 14 site kódjához/configjához/süti-tájékoztatójához.
- Nem javította kódból a CookieYes gombméreteket (dashboard-tétel, mind a 15 site-on
  kézi — NE várd meg a CMP-flottakiterjesztést).
- A TRK-900-004 (lejárt consent) továbbra is inaktív `cookieyes` alatt; `sbo` alatt
  a kliens már küldi a `consent_age_s`-t, tehát élesíthetővé vált — külön döntés.
- Nem deployolt és nem futtatott éles migrációt.
