# Consent: saját CMP, Consent Mode, CookieYes, Clarity

Kód: `lib/consent*.ts`, `components/Tracking.astro`, `components/ConsentBanner.astro`,
`consent-texts/`. Terv és indoklás: `../docs/consent-terv-v4-vegleges.md`
(4. fejezet és 8. függelék). Verziófüggő tények: `perishable-facts.md`.

## Melyik CMP

- **Új site: saját CMP (`sbo`)**, Consent Mode **basic**. A telepítés lépései az
  `INSTALL.md`-ben vannak; a generátor-inputban
  `"consent": {"provider": "sbo", "mode": "basic"}`.
- **Meglévő CookieYes-site:** marad CookieYes, amíg az adott site-ot egy külön,
  emberi döntéssel át nem kapcsolják (`../docs/cmp-fazis2-pilot-runbook.md`).
  A kód alapértéke (env nincs megadva, KV-ban nincs `consent` blokk) ma is
  `cookieyes`, ezért egy meglévő site soha nem vált magától.
- Átkapcsolás előtt (Serverside gyökérből): `node scripts/check-cmp-flip-readiness.mjs <host> --config <site-config.json>`
  → `CMP_FLIP_GATE_OK`. A régi CookieYes-döntéseket nem vesszük át
  (`reconsent_all`), ezért az átkapcsolás napján mindenki újra látja a bannert;
  számolj a consent-arány átmeneti esésével.

## Háromállapotú consent

Granted / denied / unknown. **Unknown = nem küldünk, de nem is törlünk** (még nem
döntött, vagy a CMP még nem töltött be). Csak a kifejezett elutasítás vagy
visszavonás purge-öl: `purgeMarketingStorage()` / `purgeAnalyticsStorage()`
(click ID-k, UTM, `_fbp`/`_fbc`, `_ga*`, Clarity- és Hotjar-sütik). Fejlesztés közben
sincs „engedélyezett, ha nincs CMP” ág, csak explicit
`PUBLIC_TRACKING_DEV_CONSENT_ALLOW=1`-gyel, mert pont egy ilyen DEV-ág rejtette el
a `marketing`-kulcs hibát.

Mi mit kapuz:

| Művelet | Kell hozzá |
|---|---|
| click ID / UTM tárolása **és olvasása** (localStorage) | marketing |
| session (sessionStorage), engagement-események a dataLayerbe | analytics |
| lead/contact dataLayer-push, Ads/Meta tag, gateway-hívás (böngésző és backend) | marketing |
| GA4 tag | analytics |

A backend ugyanazt a sütit olvassa (`readConsentFromCookie`: `sbo_consent` v2 vagy
`cookieyes-consent`), így a két láb nem mondhat mást; a paritást
`tests/consent-backend-parity.test.ts` őrzi. A gateway a `require_consent` alapján
újra ellenőriz.

## Consent Mode: basic az alap

- **Basic (sbo-n):** a szinkron consent-boot mindent `denied`-re állít, a GTM csak
  pozitív döntés után töltődik. Döntés előtt semmi nem megy a Google-nek. Nincs
  `wait_for_update`, mert nincs mire várni.
- **Advanced:** a tag denied mellett is betölt és cookieless pinget küld (a teljes
  URL-lel, gclid-del együtt), cserébe hirdetőspecifikus modellezés. Site-onkénti
  opt-in, mindhárom feltétellel: a gads-láb 30 napja stabil; 30–60 napos pilot egy
  UK-site-on mért modellezett-konverzió deltával; érdemi delta esetén írásos jogászi
  kockázatelfogadás. Külön boot-ág, nem flag.
- Miért basic: a Soborbo-konverziók szerveroldalon mennek (Data Manager), ott a mód
  nem számít; a mód csak a böngészős GA4/Ads denied-kohorszát érinti, a
  consent előtti ping pedig az EGT-ben vitatott (a portfólió fele HU).
- **`ads_data_redaction: true`** a defaultban (PR #137): denied `ad_storage` mellett a
  Google a hirdetési kattintás-azonosítókat is kitakarja a kérésekből.
- `url_passthrough` alapból nincs (minden belső linket paramétereznél).
- Copy-tiltás: „elutasítás esetén semmilyen adat nem kerül harmadik félhez” nem
  írható le, amíg bármelyik site advanced.

## Sorrend

A Google szerint ha a consent-kód rossz sorrendben fut, a default nem működik.

1. `gtag('consent','default', …)` inline, a `<head>`-ben elsőként
2. GTM-snippet
3. CMP-szkript (CookieYes), majd a döntéskor `consent update`

A `Tracking.astro` ezt a sorrendet a PR #137 óta tartja (előtte a CookieYes-szkript a
default előtt állt). A default inline van a komponensben, nem GTM-tag: egy
konténerbeli Custom HTML tag nem fut elég korán. Ellenőrzés GTM Preview-ban /
Tag Assistantben egy **visszatérő, már elfogadott** látogatóval: az első
consent-parancs a default, az update utána jön.

## CookieYes (átmenetileg, a még át nem kapcsolt site-okon)

- `getCkyConsent().categories`: `necessary`, `functional`, `analytics`,
  `performance`, **`advertisement`**. Nincs `marketing` kulcs.
- Események: `cookieyes_banner_load` (betöltéskor), `cookieyes_consent_update`
  (döntéskor).
- `isUserActionCompleted === false` jelenti a „még nem döntött” állapotot; a mai
  kód ezt a CMP hiányából következteti (megfontolandó javítás, nem sürgős).
- `wait_for_update: 2000` a CookieYes-ágon: ennyi idő kell a visszatérő látogató
  tárolt döntésének visszaállításához, kisebb értéknél a legjobban attribuálható
  szegmens konverziói vesznek el.
- `<TrackingNoscript />` csak CookieYes-ágon; sbo-n ki kell venni, mert noscript
  alatt nincs döntés, a GTM-iframe consent előtt futna.

## Microsoft Clarity

- A Clarity-projektben a cookie consent kötelező (Settings → Setup). A Clarity tag a
  GTM-ben **analytics consenthez** kötött (sbo-n a GTM akkor is betölt, ha csak
  marketinget fogadtak el).
- **A Clarity-loader (a site GTM-jében kézzel felvett tag) KÉT triggert kap:** All
  Pages + egy consent-update Custom Event trigger (Event name regexszel:
  `^(cookie_consent_update|sbo_consent_update)$`), tag firing option: *Once per
  page*. Ok: a GTM a kiegészítő consent-ellenőrzéssel blokkolt taget NEM indítja
  el utólag, amikor a hozzájárulás megérkezik — CookieYes-en az első elfogadás a
  `gtm.js` UTÁN jön, és All Pages-trigger mellett a Clarity csak a következő
  oldalbetöltéskor indulna. A dataLayer-eseménynevek: a CookieYes (GCM-támogatás
  bekapcsolva) `cookie_consent_update`-et push-ol; a `cookieyes_consent_update`
  csak DOM-event, GTM-trigger nem látja. Az sbo-banner `sbo_consent_update`-et
  push-ol (6.15.0 óta; basic módban a GTM amúgy is csak a pozitív döntés után
  indul, így ott az All Pages is elég). Az új trigger az analytics-consent
  ellenőrzést NEM váltja ki: a tag `analytics_storage` kapuja marad.
- API: `window.clarity('consentv2', { ad_Storage: 'granted'|'denied', analytics_Storage: 'granted'|'denied' })`
  (kis/nagybetű-érzékeny kulcsok). Két fél, két gazda:
  - **granted:** a kanonikus GTM-konténer `Clarity - Consent v2 (granted)` tagje
    (`gtm/gen-container.mjs`). A dataLayer Consent Mode-parancsaiból számolja az
    állapotot (mindkét CMP-n működik), és CSAK `analytics_storage=granted` mellett hív;
    All Pages + Window Loaded + a `cookieyes_consent_update` / `sbo_consent_update`
    DOM-eventekre szinkronizál. Consent-kapu nélküli tag, mert egy blokkolt tag
    ugyanazon az oldalon később sem tüzelne; sütit nem ír.
  - **denied:** visszavonáskor a kliens-lib küldi, és törli a `_clck`/`_clsk` sütit
    (`persistence.ts`). Elutasításkor a Microsoft szerint nincs teendő.
- Session-tagek (K14), csak PII nélküli értékkel:
  `window.clarity('set', 'page_type', 'calculator')`,
  `window.clarity('set', 'traffic_source', 'google_ads')`. Email, telefon, név,
  lead_id soha.
- Consent nélkül a Clarity oldalnézetenként új azonosítót ad, nincs munkamenet-szintű
  felvétel. Ezért relaunch előtti/utáni összevetés érvénytelen, ha közben a
  consent-setup, a menü vagy az oldalhossz változott.

## Visszavonás

Minden oldalon kell egy elérhető visszavonási út (sbo: footer-link
`data-sb-consent-open`). A visszavonás három helyen hat: kliens-purge, gateway
(új `withdrawn` sor → fail-closed), és az offline/replay ág (a lead `consent_id`-jának
aktuális revisionje dönt, nem a rögzítéskori).
