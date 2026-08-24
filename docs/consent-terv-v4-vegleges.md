# Soborbo Consent — teljes terv v4 (VÉGLEGES A KÓDIG)
## Diagnózis → döntési kapu → (feltételesen) CMP → rollout

Státusz: terv, nincs implementálva. **Ez az utolsó terviteráció — a következő review tárgya futó kód és adat, nem ez a dokumentum.**
Változás v3 → v4: 17 pontos külső review beépítve (15 elfogadva, 2 korrigálva), a review repó-állításai ellenőrizve a tényleges kód ellen.

---

# 0. A review állításainak ellenőrzése (2026-08-16)

| Állítás | Eredmény |
|---|---|
| `do_not_replay` létezik az idempotency sémában | ✅ **Megerősítve** (D1: `do_not_replay INTEGER NOT NULL DEFAULT 0`) |
| `readStoredAttribution()`/`writeStoredAttribution()` törött purge | ⚠️ **A függvénynevek nem léteznek** (valódi: `getStoredData`/`persistTrackingParams`); az írás kapuzott, a leírt mechanizmus nem áll |
| localStorage olvasás consent előtt | ✅ **Megerősítve**: `getStoredData/getGclid/getAttribution` kapuzatlan; PLUSZ `getFbp()/getFbc()` kapuzatlan _fbp/_fbc süti-olvasás (a review nem látta) |
| Több consent-forrás fut párhuzamosan | ✅ **Megerősítve, súlyosabb**: (1) kliens `consent.ts` → `getCkyConsent()` API; (2) kliens `gateway.ts` → süti-parse; (3) szerver-ingress → HTTP Cookie header parse. + `if (!c) return isDevMode()` → prod-ban DENY-ALL, amíg a CookieYes szkript be nem töltött |
| CookieYes sütiben nincs timestamp | ✅ a kliens-parser nem olvas timestampet → `consent_age_s` CookieYes alatt NULL |

**Elsőszámú hipotézis a 9 GRANTED-skipre:** betöltési verseny. Az event a CookieYes szkript betöltése ELŐTT sül el → az API-alapú kapu deny-t mond, miközben a süti-alapú receipt GRANTED-et rögzít. Három fordítás, két igazság. A Fázis D ezt méri.

---

# 1. MOST — a CMP-től független javítások (~fél nap)

1. `painless` → `require_consent=true` (4 consent nélküli `ad_allowed=1` zárása). Egysoros KV.
2. `TrackingNoscript.astro` → GTM noscript iframe ki.
3. **Storage-olvasás kapuzása + purge-huzalozás** a `persistence.ts`-ben:
   - `getStoredData()` és minden hívója (getGclid, getAttribution, getAllTrackingData, getSourceType) marketing-consent kapu mögé; `getFbp()/getFbc()` szintén (süti-OLVASÁS is PECR-hatály).
   - `getSession()` már jól kapuzott (analytics) — minta a többihez.
   - Ellenőrizni: a `clearTrackingData()` meghívódik-e consent-visszavonáskor (`onConsentChange` → DENIED ágon). Ha nincs bekötve: bekötni, kategóriánként bontva (`purgeMarketingStorage()`: sb_tracking, sb_first_touch, _fbp/_fbc first-party törlés ahol lehet; `purgeAnalyticsStorage()`: sb_session).
   - URL-paramok memóriában tartása consent előtt (`captureUrlParams`) helyes és marad — az URL olvasása nem terminál-storage-hozzáférés.

---

# 2. FÁZIS D — Diagnosztika (2-3 nap munka)

## 2.1 Skip-ok megnevezése

`deliveries.skip_reason TEXT`, kötelező minden skipnél. **A `SkipReason` típus már létezik a kódban** (`skip-reason.ts`: `consent_denied | not_expected | not_configured`), csak nem perzisztálódik a ledgerbe — a Fázis D a meglévő típust bővíti és kiírja a D1-be. A `not_expected` (terminális) vs `not_configured` (az EGYETLEN retryable skip: DLQ + CRITICAL riasztás) szétválasztás a 2026-07-15-i lomtalan-adatvesztés tanulsága — **összevonni TILOS**. Végleges enum: `consent_denied | consent_missing_failclosed | consent_missing_legacy | consent_uncertain_failclosed | no_identifiers | dedup | not_expected | not_configured | eea_rule | template_guard`.

## 2.2 Több-forrás consent-összevetés (a v3 raw-dump HELYETT)

A `consent_receipts` bővítése — **parse-olt booleanok forrásonként, nem nyers dump**:

```sql
ALTER TABLE consent_receipts ADD COLUMN src_cookie_analytics INTEGER;   -- kliens süti-parse
ALTER TABLE consent_receipts ADD COLUMN src_cookie_marketing INTEGER;
ALTER TABLE consent_receipts ADD COLUMN src_api_analytics INTEGER;      -- getCkyConsent()
ALTER TABLE consent_receipts ADD COLUMN src_api_marketing INTEGER;
ALTER TABLE consent_receipts ADD COLUMN src_server_analytics INTEGER;   -- HTTP Cookie header (ingress)
ALTER TABLE consent_receipts ADD COLUMN src_server_marketing INTEGER;
ALTER TABLE consent_receipts ADD COLUMN source_used TEXT;               -- cookieyes_cookie|cookieyes_api|override|sbo_cookie|server_cookie|none
ALTER TABLE consent_receipts ADD COLUMN source_consistent INTEGER;      -- minden jelen lévő forrás egyezik?
ALTER TABLE consent_receipts ADD COLUMN ingress_kind TEXT;              -- browser|server
ALTER TABLE consent_receipts ADD COLUMN client_lib_version TEXT;
ALTER TABLE consent_receipts ADD COLUMN consent_age_s INTEGER;          -- NULL CookieYes alatt; sbo_consent-nél számolt
```

NULL = az adott forrás nem volt elérhető abban a pillanatban (pl. API még nem töltött be) — **maga a NULL-mintázat a betöltési verseny bizonyítéka.**

**Nyers süti-dump csak mismatch esetén**, külön `consent_debug` táblába (event_id, mind a három nyers string, created_at), 14 napos purge-dzsel. Normál eventnél nincs verbatim consent-ID-duplikálás a ledgerben.

## 2.3 TRK-9xx hibakódok — VISELKEDÉSSEL, nem csak megfigyeléssel

A review 5-ös pontja elfogadva: **bizonytalan consentből soha nem lesz GRANTED.** A diagnosztika non-destruktív abban, hogy naplóz — de a kiküldési döntés fail-closed.

| Kód | Jelentés | Viselkedés (ad-platformokra: Meta/gads) |
|---|---|---|
| TRK-900-001 | consent objektum hiányzik | jelenlegi `require_consent` szabály |
| TRK-900-002 | jelen van, parse-olhatatlan | **fail-closed** (skip: `consent_uncertain_failclosed`) |
| TRK-900-003 | források ellentmondanak (pl. süti DENIED, API GRANTED) | **fail-closed** + consent_debug sor |
| TRK-900-004 | consent lejárt | **fail-closed + reprompt** — *csak sbo_consent alatt élesíthető; CookieYes alatt nem tüzelhet (nincs ts — a review 4-es pontja)* |
| TRK-900-005 | jelek belül inkonzisztensek | **fail-closed az érintett célra** |
| TRK-900-006 | client_lib_version < minimum | WARN, később block |

GA4-re a fail-closed = jelek nélküli/denied jelekkel küldés a mai szabály szerint (a GA4-kapuzás maga a CMP-fázis része, lásd 4.).

## 2.4 Napi cross-check + riasztás

Cron (`cross-check.ts` minta): GRANTED-de-skipped darabszám skip_reason szerint; TRK-9xx eloszlás site×lib-verzió bontásban; `source_consistent=0` arány; null-forrás mintázat (betöltési verseny trend). Eltérés → `notify.ts`.

## 2.5 Döntési kapu — idő ÉS adatmennyiség

**Minimum 14 nap ÉS (≥500 GRANTED receipt VAGY ≥10 GRANTED-skip teljes attribúcióval), maximum 30 nap.**
Kalibrálás a mai volumenre: a flotta ~24 event/nap, ~19 GRANTED/nap → az 500 GRANTED ≈ 26 nap; a 10 attribuált GRANTED-skip a mostani rátával ≈ 2-3 hét. Reálisan a kapu **3-4 hétre** nyílik.

**Kimenetelek (előre definiálva):**
- **A — a saját bekötések csúsznak szét** (TRK-900-003/005/006 dominál, null-mintázat = betöltési verseny): a CMP NEM épül. Javítás: kliens-egységesítés a kanonikus package-re + a verseny megszüntetése (süti-parse mint egyetlen igazságforrás, API csak kiegészítő). CookieYes marad, újraértékelés 3 hónap múlva.
- **B — a CookieYes a hibás** (a süti maga hordoz rossz/hiányzó állapotot konzisztens lib mellett): a CMP épül (4. szakasz).
- **C — mindkettő**: sorrend: előbb kliens-egységesítés, aztán CMP.

---

# 3. Architektúra-elv (pontosítva)

Nem „a fordítási réteg megszűnik", hanem: **egy kanonikus fordítási implementáció marad.** A süti → belső ConsentState átalakítás browserben és szerveren továbbra is kell — de ugyanaz a package-beli, tesztelt függvény csinálja mindkét helyen. A `client_lib_version` minden payloadban; a gateway minimumot enforce-ol.

A consent modul a `soborbo-tracking` package része: ugyanaz a csomag adja a `consent-boot`-ot, a bannert és a `sendToWorker`-t. Egy site = egy package-verzió + egy config.

---

# 4. A CMP (csak B/C kimenetel esetén)

## 4.1 Azonosító-modell (review 9)

- `consent_id` — a browser/preference-lánc stabil azonosítója (sütiben él)
- `consent_event_id` — egy konkrét döntés UUID-ja; **ez az idempotencia-kulcs** (nem timestamp)
- `revision INTEGER` — döntésenként nő; fordított sorrendben beérkező beaconök nem cserélik fel az állapotot
- `client_decided_at` + `server_received_at` külön

## 4.2 Két tábla: döntés ≠ mérés (review 6)

**`consent_log` — CSAK döntések, append-only** (consent proof):

```sql
CREATE TABLE consent_log (
  id TEXT PRIMARY KEY,
  consent_id TEXT NOT NULL, consent_event_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  decision TEXT NOT NULL,           -- accept_all | reject_all | custom | withdrawn
  cat_analytics INTEGER NOT NULL, cat_marketing INTEGER NOT NULL,
  ad_user_data TEXT, ad_personalization TEXT, ad_storage TEXT, analytics_storage TEXT,
  consent_mode TEXT NOT NULL, policy_version TEXT NOT NULL,
  banner_version TEXT NOT NULL, consent_text_version TEXT NOT NULL,
  lang TEXT, country TEXT, client_lib_version TEXT,
  client_decided_at TEXT NOT NULL, server_received_at TEXT NOT NULL
);
```

Aktuális állapot = az adott `consent_id` legmagasabb `revision`-je. (A `reprompt_shown` NEM ide megy.)

**`consent_metrics` — banner-megjelenések** (UX-mérés): site_id, banner_version, lang, device-osztály, shown_at, `interaction_ms` (ha lett döntés, a döntés-sor is hordozza). **Szigorúan ID-mentes**: a megjelenéskor még nincs consent, tehát a ping nem vihet consent_id-t, user-azonosítót, fingerprint-elemet — különben a mérőműszer sérti meg, amit mér.

## 4.3 `/api/consent` — őszinte státuszkódok + kliens-retry (review 8)

`204` = tényleg eltárolva vagy idempotens duplikátum; `400/403/429/503` a valódi hibákra. A UI nem vár — a döntés lokálisan azonnal érvényes (süti + gtag update). De a kliens `receipt_synced=false` flaget tart a sütiben, és következő oldalletöltéskor újraküldi a `consent_event_id`-t, amíg 204 nem jön. A consent proof nem veszhet el némán — „a veszély a csend" elv magára a consent-rögzítésre is áll.

*Acceptance criteria (implementációs):* a pending receipt a **teljes újraküldhető döntést** őrzi (decision, kategóriák, jelek, revision, policy/banner/text verzió, client_decided_at) — sbo_consent részeként vagy külön `pending_receipt`-ben. 503 után nem csak azt kell tudni, HOGY újra kell küldeni, hanem hogy pontosan MIT.

## 4.4 Boot — javított folyamat (review 7)

```
default = mind DENIED (gtag consent default)
nincs döntés   → banner; GTM NEM töltődik
reject_all     → GTM NEM töltődik (Basic Mode definíció szerint semmi nem megy a Google-nek)
analytics csak → consent update → GTM betölt → GA4 tüzel, Ads/Meta tag NEM
marketing csak → consent update → GTM betölt → marketing tagek tüzelnek, GA4 NEM
mindkettő      → minden engedélyezett tag
```

`wait_for_update` elhagyva — pure Basic Mode-ban a GTM el sem indul a döntés előtt, nincs mit várakoztatni.

**GA4-kapuzás**: a szerveroldali `consent.ts` „GA4 mindig megy" szabálya megszűnik; `analytics_storage='GRANTED'` kell. (DUAA statisztikai kivétel GA4-re nem áll.)

## 4.5 Visszavonás — végig a láncon (review 10, 12)

A visszavonás három helyen hat, és mindhárom tesztelt:
1. **Kliens**: purge — `purgeMarketingStorage()` / `purgeAnalyticsStorage()` (sb_tracking, sb_first_touch, sb_session, _fbp/_fbc first-party törlés ahol technikailag lehet), a további tagek nem tüzelnek.
2. **Gateway, valós idejű**: új `withdrawn` sor a consent_log-ban → a következő eventek fail-closed.
3. **Offline/replay/DLQ ág**: minden offline upload, retry és replay ELŐTT a lead `consent_id`-jának **legfrissebb revision-jét** kell feloldani — nem a capture-kori receiptet. Ha az aktuális állapot DENIED/withdrawn: skip + `do_not_replay=1` (az oszlop létezik, huzalozandó). A nap-1 GRANTED / nap-3 visszavonás / nap-10 revenue_confirmed eset így helyesen skip.

## 4.6 UI (review 14, 15)

Első réteg, **három rendes gomb**: `Elfogadom` / `Elutasítom` / `Beállítások`. Accept és Reject pixelre azonos méret/kontraszt/font/kattintásszám; a Beállítások lehet vizuálisan másodlagos akció, de gomb, nem apró textlink.

Copy — tényszerű, emberi, ígéret nélkül:
- Analytics: „hogyan használják a látogatók az oldalt"
- Marketing: „Google- és Meta-hirdetéseink mérése és személyre szabása"
- Harmadik felek névvel elérhetők a folyamatból (Google, Meta + link a részletes tájékoztatóra).
- A „nem kapsz irreleváns hirdetést" típusú ígéret TILOS a copyban.

180 nap süti + 180 nap reject-reprompt — dokumentációban így: *„default policy, az ICO általános hat hónapos ajánlásával összhangban"* (nem „jogszabály szerint").

## 4.7 A/B — ugyanazon a site-on (review 13)

Cross-site A/B törölve (traffic/brand/geo/eszköz konfound). Helyette: első renderkor `crypto.getRandomValues()` → A/B variáns, **tárolás nélkül**. A döntéskor a `banner_version` rögzíti, mi volt kint; a `consent_metrics` a megjelenéseket variánsonként. Ismert zaj: nem-perzisztált variánsnál a döntés előtti oldalváltáson a látogató variánst válthat — elfogadjuk, a döntéskori érték a mérvadó. Baseline: **a CookieYes Consent Log tényleges accept/reject aránya** ugyanazon site-on, ugyanazon időszakban — a receipts-alapú 78% event-szintű szám, baseline-nak érvénytelen.

---

# 5. Playwright mátrix (bővítve: review 11, 12)

```
friss böngésző, döntés nélkül:
  nincs non-essential süti/localStorage ÍRÁS ÉS OLVASÁS
    (Storage.prototype.getItem/setItem monkey-patch + document.cookie elfogás)
  nincs GA4/Meta/Ads kimenő request; GTM nem töltődik
  a consent 'default' bizonyíthatóan minden tag előtt fut
analytics-only: GA4 megy, Ads/Meta tag+request NEM; sessionStorage igen, marketing localStorage NEM
marketing-only: fordítva
reject_all: GTM be sem töltődik; 180 napig nincs re-banner
visszavonás (marketing OFF):
  sb_tracking/sb_first_touch törlődik; _fbp/_fbc törlődik ahol lehet
  további Meta/Ads request nincs; offline replay-teszt: do_not_replay=1
HU és EN render; A/B variáns-kiosztás determinisztikátlan, de döntéskor rögzített
```

---

# 6. Rollout (változatlan mag)

Pilot: **olcsokontenerhaz.hu** (saját, közepes forgalom). Per-site: package-verzió + config → 7 nap párhuzamos futás CookieYes mellett → napi kapu (accept-arány a CookieYes Consent Log baseline ±10 pontján, TRK-9xx nulla, konverziós volumen tartja) → CookieYes ki + policy frissítés → 7 nap utómegfigyelés. Hullámok: saját HU → saját UK (agykontroll csak a [phone]-fix után) → ügyfél-site-ok utolsóként. Teljes rollout 4-6 hét.

Párhuzamos, nem-kód tételek (jogi audit): süti/adatvédelmi tájékoztatók HU/EN harmadik felek NÉVVEL; Art. 28 DPA-k + Meta Controller Addendum + Google Ads DPT; consent_log retention dokumentálva (3 év felülírás után, purge-cron); DUAA panaszkezelés. Kontrollerség-allokációhoz jogász.

---

# 7. Idő

```
MOST:        1. szakasz — 0,5 nap
1. hét:      Fázis D séma+kód+cross-check — 2-3 nap
2-5. hét:    adatgyűjtés → DÖNTÉSI KAPU (idő ÉS volumen; reálisan 3-4 hét)
             közben: 4 javító prompt (beautyflow OAuth, trapez INVALID_ARGUMENT,
             agykontroll [phone], GA4-láb) — a gads-stabilitás CMP-előfeltétel marad
B/C ág:      CMP build — 9-11 fókuszált nap (a v3 8-9 + retry-logika + offline-huzalozás)
utána:       rollout 4-6 hét
```

**Terv-freeze: ez a v4 a végleges terv a kódig.** A CMP nem projektcél, hanem a diagnosztika egyik lehetséges kimenetele. Ha a Fázis D az A kimenetelt adja, a helyes döntés a CookieYes megtartása és a kliens-package rendbetétele — és az is siker, mert a valódi nyereség nem a banner tulajdonlása, hanem hogy ugyanaz a consent state hajtja a browser-, server-, Meta-, Ads- és offline-ágat.

---

# 8. Függelék: Basic vs Advanced Consent Mode — döntési keret (2026-08-16)

Config-döntés, nem architektúra — a freeze-t nem nyitja. A `consent_mode` per-site KV-érték.

## Default: `basic`. Az advanced site-onkénti opt-in, feltételekkel.

**A tények (nem vitatottak):**
- Advanced: denied mellett a Google tag betölt, cookieless ping megy (timestamp, UA, referrer, consent-state, és a teljes URL — GCLID-del együtt). Cookie-t nem ír/olvas. Cserébe advertiser-specifikus konverzió-modellezés a denied-kohorszra.
- Basic: consent előtt semmi nem megy a Google-nek; a modellezés általános.
- Az Enhanced Conversions MINDKÉT módban teljes értékű, ha marketing consent van — a mód-választás a denied-kohorszt érinti, a granted-et nem.

**Miért basic a default:**
1. A modellezési uplift a tag-alapú webes konverziókövetésre dokumentált; a Soborbo-konverziók szerveroldalon mennek (Data Manager / EC for Leads). A denied-kohorsz (~18%) modellezési haszna erre az architektúrára kvantifikálatlan.
2. A 2026-08-i jogi audit: a pre-consent ping az EEA-ban vitatott, a szigorú DPA-irány ellene; a portfólió fele HU (NAIH aktív). A default az, amihez nem kell jogász.
3. A denied-ping a teljes URL-t viszi, GCLID-del — kattintásazonosító consent előtt: pont a vitatott pont.

**Advanced opt-in feltételei (mindhárom):**
1. A gads láb 30 napja stabil (a javítópromptok után).
2. 30-60 napos advanced-pilot EGY saját UK site-on (foamoffice/agykontroll; nem HU), a Google Ads-ben mérhető modellezett-konverzió delta a basic-baseline ellen.
3. Érdemi delta esetén dokumentált jogászi kockázatelfogadás a skálázás előtt.

**Trigger az újraértékelésre:** az ICO folyamatban lévő PECR Reg 6 online-advertising felülvizsgálatának kimenetele (UK-oldali enyhítés esetén a UK-site-ok kalkulációja újranyílik).

*Acceptance criteria advanced-pilothoz:* külön, explicit boot-branch (basic: default denied → GTM vár → grant → load; advanced: default denied → GTM azonnal load → cookieless ping → choice → update) — a két mód nem lehet egy kódág flag-gel. Az advanced-pilot `ads_data_redaction=true`-val indul: ad_storage=denied mellett a Google az ad-click azonosítókat is redaktálja a pingekből — pont a GCLID-átvitel kockázatát csökkenti, ami miatt az advanced óvatos kezelést kap.

**Módtól független, MOST beépülő szabályok (a 2026-08-16-i review-ból):**
- Copy-tiltás: „elutasítás esetén semmilyen adat nem kerül harmadik félhez" — advanced mellett hamis, ezért sehol nem írható le, amíg egyetlen site is advanced.
- Kód-invariáns: denied-state Google pingbe saját user_id / custom dimension / PII SOHA nem kerülhet.
- Playwright mód-profilok: basic-reject → nulla Google request; advanced-reject → Google ping megengedett, DE Google cookie NINCS, localStorage NINCS, Meta NINCS, EC user_data NINCS, CAPI NINCS, saját PII a pingben NINCS.
