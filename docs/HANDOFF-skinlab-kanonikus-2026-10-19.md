# Átadó — 6.13 → 6.16 kit, skinlab kanonikus átállás (2026-10-19)

Állapot: 2026-10-19 ~11:30 UTC. Következő lokális vagy felhős Claude-munkamenetnek.
A CLAUDE.md szabályai érvényesek. Lokális Mac: Node 26 (`export PATH=/opt/homebrew/bin:$PATH`)
a Serverside-hoz; a site-repókhoz (befilo, skinlab) Node 24 (`/usr/local/bin`), a CI-juk Node 22.

---

## 1. Ami ma elkészült (élesben)

| Mi | Hol | Állapot |
|---|---|---|
| Worker 6.13.0 (R7 lánc-kulcs sütiben) | event-gateway | élő, ellenőrizve (version, tail, befilo + skinlab `sbo_consent_key` süti, `consent_chain` sorok) |
| Piros main-CI javítva (TRK-000-008 / TRK-700-002 determinisztikus teszt) | #143 | beolvasztva |
| Node 26 az eszközláncban (enum → `as const`, vitest `--no-experimental-webstorage`) | #144 | beolvasztva |
| `training_signup_submitted` + `consultation_request_submitted` kanonikus (6.13.1) | #145 | beolvasztva, worker élesítve, élő próbával igazolva (TRK-EVT-001 megszűnt) |
| Kit 6.14.0 — K1 konzultáció/képzés helperek, K4 állítható consent-végpont, K5 banner `lang`, K6 smoke site-id env-ből | #146 | beolvasztva (worker-kód nem változott) |
| Kit 6.15.0 — advanced Consent Mode + süti nélküli pingek + opt-in kiemelt Elfogadom (a #140 átvezetése) | #147 | beolvasztva; a worker `2559b8d`-n fut (lásd 4.1) |
| Befilo kliens 6.9.0 → 6.13.0 + `TRACKING_CONSENT_PROVIDER=sbo` | befilo #4 | élő (consent_log: `client_lib_version=6.13.0`, `verified=1`) |
| Skinlab szerver-láb: gbraid/wbraid/msclkid/utm_term/utm_content/landing_page/referrer a gatewaynek | skinlab #98 | élő (master deploy zöld) |
| Skinlab Meta Pixel `autoConfig=false` („Invalid parameter format for currency” megszűnt) | GTM-NW7DKC2D v10 | publikálva |

**Élő hiba, javítva:** a skinlab konzultáció- és képzés-leadjei 2026-09-15 → 2026-10-19 08:38 UTC között
nem jutottak el a Metához (a gateway ismeretlen névként némán eldobta őket; a `6f08675`
`meta-conversion-mapping` ág sosem olvadt be). Utólag nem pótolható.

## 2. Nyitott PR-ok — mi a teendő

| PR | Tartalom | Teendő |
|---|---|---|
| **Serverside #148** | Kit 6.16.0 — K2 `external_id` (`sb_uid`, consent-kapuval, süti-leltár `2026-10-b`), K3 csak külső hivatkozó + `setEntryContextProvider`, K7 first-touch click-ID összevonás + gbraid/wbraid rejtett mező | CI után beolvasztás. **Előtte**: a `sb_uid` süti-tábla szövegét (cél, `transfer: USA (Meta…; SHA-256 hashed only), SCC`) László hagyja jóvá. |
| **befilo #5** | perf-gate csak az azonnal betöltődő képeket számolja; `/blog/` rejtett h1; címsorok `overflow-wrap: break-word` (320px kilógás 3 oldalon) | CI fut a `90ec25c`-n. Zöld után beolvasztás (László jóváhagyta). Beolvasztás = élesítés (Workers Builds). |
| **befilo #1** (2026-09-26, régi) | UGYANEZ a perf-gate + `/blog/` h1 javítás, más megvalósítással | **Duplikátum** — a #5 beolvasztása után lezárandó (László döntse el). |
| Serverside #140 | advanced consent, 6.10.0 alapon | **Elavult**, a #147 átvette (kommentelve). Lezárható. |
| Serverside #137 | gbraid/wbraid rejtett mezők + consent-sorrend (6.9.1) | Átfed a #148 K7-tel és a 6.10–6.15 munkával. Átnézendő: ami nincs még main-en, azt át kell vezetni, a többit lezárni. |
| Serverside #138, #139 | tracking-skill doksi; sbo mint új-site alap, Clarity granted-jelzés | Régi, nem ennek a munkának a része. Átnézendő. |
| skinlab #94 | advanced consent 6.10.0 port | **Elavult** — az F2/F4 a 6.15+ kitet hozza. Lezárandó, ha F2 kész. |
| skinlab #95, befilo #3 | Workers Logs bekapcsolás | Független. |

## 3. A skinlab kanonikus átállás terve (maradék)

Részletes mátrix és indoklás: a munkamenet port-mátrixa (lent összefoglalva). Alapelv:
**a kit bájtra azonos másolata** `src/lib/soborbo-tracking/` alatt (befilo-minta, `check:vendored` CLEAN),
site-kiegészítésként marad: `ecommerce.ts`, `entry-attribution.ts`.

**Kész:** F0 (skinlab #98), F1 (kit 6.14), advanced mode (kit 6.15), F3 (kit 6.16 — PR #148).

**F2 + F4 — skinlab átállás a kit 6.16.0-ra** (egy PR, vagy F2 előre, ha gyorsabb):
1. Kit-fa változatlanul `src/lib/soborbo-tracking/`; `src/lib/tracking/` = site-barrel (`export *` a kitből + `ecommerce` + `entry-attribution`) + vékony shimek (`config.ts`, `gateway-dispatch.ts`, `smoke.ts`), hogy a meglévő importok éljenek.
2. Env: `PUBLIC_TRACKING_CONSENT_ENDPOINT=/api/consent/` (trailingSlash: always + a meglévő Astro-proxy), `PUBLIC_TRACKING_CONSENT_MODE=advanced` (László kérte), `TRACKING_SITE_ID=skinlab`; wrangler.jsonc: `TRACKING_CONSENT_PROVIDER="sbo"`, `TRACKING_POLICY_VERSION="2026-09-18-a"`.
3. Route-ok (`contact.ts`, `consultation.ts`, `order.ts`): `readConsentFromCookie(cookie, { provider: consentProviderFromEnv(env), expectedPolicyVersion: env.TRACKING_POLICY_VERSION })` és `readSboConsentCookieHeader(…, { expectedPolicyVersion })` — **kötelező**, különben régi tájékoztatóra adott „igen” átmegy a szerver-lábon. + `consentSources`, `/api/order`-hez `orderId` + `contents`.
4. `entry-attribution.ts`: import a kitből (`getMarketingConsentState`, `ATTR_STORAGE_KEY`); boot: `setEntryContextProvider(() => ({ landing_page: getEntryLandingUrl(), referrer: getEntryReferrer() }))`. **Döntés (meghozva): a döntés előtti localStorage-olvasást kapuzzuk** (UNKNOWN alatt nem olvas; az URL-átvitel megmarad).
5. Űrlapok (ContactForm, TrainingSignupForm, ConsultationWizard, ContactPage, CheckoutPageContent): az **5** nyers `localStorage.getItem('sb_tracking')` → `getAllTrackingData()`; valódi `<input name="external_id">` (a kit csak meglévő inputot tölt); `trackConsultationSubmit`/`trackTrainingSignupSubmit` a kitből, `eventId`-vel (a route a rejtett mező event_id-jét használja — dedup).
6. `ecommerce.ts`: `normalizeEmail` undefined-ág; `'HUF'` → `trackingConfig.currency`.
7. BaseLayout: komponens-importok a vendorolt útra; `<ConsentBanner lang=…>` marad.
8. **GTM (advanced módhoz):** minden nem-Google tag consent NEEDED (a Meta-tagek már azok); a Meta Pixel Base (tag 29) kapjon `sbo_consent_update` Custom Event triggert, `ONCE_PER_LOAD`.
9. `consent-sbo-parity.test.ts` törölhető (kit paritás-teszt fedi); 2 tesztfájl vitest-globals importja hiányzik → `astro check` 40 hibája.

**F5 — élő ellenőrzés** konverziónként (contact, training, consultation, order, begin_checkout, add_to_cart, phone/email, consent 9 nyelven, negatív reject-all): böngésző dataLayer, Meta Events Manager dedup + EMQ, D1 `events_raw`/`deliveries`/`consent_receipts` (`client_lib_version` = 6.16.0). + 24h log, napi smoke `smoke-skinlab-YYYYMMDD`.

**Meghozott döntések:** rendelés → Meta **Lead** marad; banner 7 nyelven angol = elég; `external_id` a kitbe (consent-kapuval); entry-attribution kapuzva; kiemelt Elfogadom gomb **KI** (NAIH-kockázat, külön döntés).

## 4. Figyelmeztetések

1. **Más is deployolja az event-gatewayt.** 2026-10-19-én wrangler-deployok golaxo@gmail.com-ról: 07:25 + 08:38 (ez a munkamenet), **07:58, 08:37, 10:13, 11:17** (nem ez). Az élő worker most `2559b8d` (#147). Deploy előtt: `wrangler deployments list --name event-gateway` + `/api/event/version`, és egyeztetés.
2. **Skinlab PR-ágakon a Cloudflare Workers Build mindig 0 mp alatt bukik** (#94–#98) — nem kódhiba; a master build zöld. Dashboard-beállítás (preview/non-production branch builds).
3. **Befilo CI** a #5 előtt hónapok óta piros volt (perf-gate) → a `deploy.yml` skippelt, az élesítés a Workers Buildsen megy.
4. **Skinlab consent_log 2026-09-18 → 10-16 üres** (a KV `consent.provider=sbo` későn került be). Consent-arány csak 10-16-tól értékelhető.
5. **Skinlab Google Ads szerver-láb nincs** (KV `gads.conversion_actions` üres) — másik munkamenet dolgozik rajta.
6. Gateway `lang` validáció szigorú (`^[A-Za-z]{2}(-[A-Za-z]{2})?$`): rossz érték az EGÉSZ consent-döntést 400-zza. A kit 6.14 óta elsődleges subtagre szűkít; a skinlab 9 locale-ja (`hu-HU`, `en-US`, …) megfelel.
7. Lokális worktree-k: `~/dev/.cmp-work/Serverside-{main,614,615,616}`, `~/dev/skinlab-6.13`; a fő checkoutok (`~/dev/.cmp-work/Serverside` a #140 ágán, `~/dev/skinlab-hungary`) érintetlenek. A kész worktree-k törölhetők.

## 5. Mellékes, nyitott
- Befilo 3 nehéz homepage-kép: `CallbackBand.astro:68` nyers `<img>`-et renderel `<SiteImage>` helyett (a master képek megvannak) → egy komponens-javítás, AVIF/WebP jönne.
- Skinlab `.github/workflows/ci.yml` lockfile-kommentje ellentmond a valóságnak; `astro check` nem kapu.
