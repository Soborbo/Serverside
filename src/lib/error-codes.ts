/**
 * Tracking Worker error code taxonomy.
 * Format: TRK-{category}-{number}
 * Categories:
 * - 000: Internal errors
 * - 400: Client validation errors
 * - 500: Configuration errors
 * - 600: Meta CAPI specific
 * - 700: GA4 MP specific
 * - 800: Google Ads specific (legacy uploadClickConversions)
 * - 810: Microsoft Ads (Bing) forwarder specific
 * - 820: TikTok Events API forwarder specific
 * - 830: LinkedIn Conversions API forwarder specific
 * - 840: Google Data Manager API specific (events:ingest — offline conversions)
 * - 900: DLQ + Cron specific
 * - 950: Reconciliation + observability
 */

export enum TrackingErrorCode {
  UNHANDLED_EXCEPTION = 'TRK-000-001',
  KV_READ_FAILED = 'TRK-000-002',
  KV_WRITE_FAILED = 'TRK-000-003',
  R2_READ_FAILED = 'TRK-000-004',
  R2_WRITE_FAILED = 'TRK-000-005',
  DURABLE_OBJECT_FAILED = 'TRK-000-006',
  LEDGER_WRITE_FAILED = 'TRK-000-007',
  FANOUT_SETUP_FAILED = 'TRK-000-008',

  INVALID_JSON = 'TRK-400-001',
  INVALID_PAYLOAD_STRUCTURE = 'TRK-400-002',
  // ── DEPRECATED (Turnstile a gateway-ről eltávolítva) ──────────────────────
  // A kód TÖBBÉ NEM BOCSÁTJA KI ezeket. Az enum-tagok szándékosan maradnak: a
  // meglévő AE-lekérdezések, Workers-log-keresések és a docs/error-codes.md
  // ezekre hivatkozik, és a historikus adat (pl. a 2026-07-13/14-i TRK-400-004
  // hullám) csak így marad visszakereshető. Új kódot NE vegyél fel ebbe a sávba.
  MISSING_TURNSTILE_TOKEN = 'TRK-400-003',
  INVALID_TURNSTILE_TOKEN = 'TRK-400-004',
  TURNSTILE_API_UNAVAILABLE = 'TRK-400-005',
  // ──────────────────────────────────────────────────────────────────────────
  INVALID_LEAD_STATUS_PAYLOAD = 'TRK-400-006',
  LEAD_STATUS_UNAUTHORIZED = 'TRK-400-007',
  // DEPRECATED (a degradált mód a Turnstile-lal együtt megszűnt — token nélkül
  // MINDEN böngésző-event jön, nincs mit „degradálni").
  DEGRADED_TOKENLESS_ACCEPTED = 'TRK-400-008',
  DEGRADED_RATE_LIMITED = 'TRK-400-009',
  TURNSTILE_SECRET_INVALID = 'TRK-400-010',
  SERVER_INGRESS_UNAUTHORIZED = 'TRK-400-011',
  SERVER_INGRESS_ACCEPTED = 'TRK-400-012',
  // A böngésző-ág ELSŐDLEGES kontrollja a Turnstile eltávolítása után.
  ORIGIN_MISSING = 'TRK-400-013',
  ORIGIN_NOT_ALLOWED = 'TRK-400-014',
  BODY_TOO_LARGE = 'TRK-400-015',
  CONVERSION_SPIKE = 'TRK-400-016',
  // High-value (hamisítható PII-s) konverzió a böngésző-ágon — csak a hitelesített
  // /api/event/conversion-server fogadhatja. Az Origin curl-ből hamisítható, a
  // Workers rate-limit binding bizonyítottan nem throttle-ol → e nélkül bárki
  // hamis lead-konverziót lőhetne tetszőleges hash-elt email/telefonnal.
  HIGH_VALUE_EVENT_BROWSER_REJECTED = 'TRK-400-017',
  // F3-A/2 prehashed PII contract. Az outbox/CRM már-hash-elt user_data-t küldhet
  // (`user_data_hashed`), hogy a gateway NE hash-eljen újra (dupla hash → néma Meta
  // match-rate esés). `user_data` és `user_data_hashed` KÖLCSÖNÖSEN KIZÁRÓ.
  PREHASHED_AND_RAW_USER_DATA = 'TRK-400-018',
  // A `user_data_hashed` bármely mezője nem 64-hosszú lowercase hex → 400, NEM néma
  // átengedés (a CRM-nek a hibát tudnia kell, hogy javíthasson/retry-olhasson).
  INVALID_PREHASHED_USER_DATA = 'TRK-400-019',
  // Admin API (/api/event/admin/*) auth/rate-limit elutasítás. KÜLÖN a lead-status
  // kódtól: egy admin-token brute-force NE a /lead-status alrendszer alatt jelenjen
  // meg a logokban/riasztásokban (rossz attribúció elrejtené a támadást).
  ADMIN_UNAUTHORIZED = 'TRK-400-020',
  // A kérés-törzs olvasása MEGSZAKADT (a stream dobott) — NEM méret-túllépés.
  // Korábban a readBoundedBody mindkettőre `null`-t adott, így egy megszakadt
  // feltöltés BODY_TOO_LARGE-ként (413) logolódott: a hibakód azt állította, hogy
  // a kliens túl nagy payloadot küldött, holott a kapcsolat szakadt meg. Külön kód,
  // hogy egy hálózati romlás ne „nagy body" hullámnak látszódjon a riportban.
  REQUEST_BODY_READ_FAILED = 'TRK-400-021',
  // A lead-status hívó olyan státuszt küldött, amihez NINCS kanonikus
  // event-leképezés. Eddig ez volt az EGYETLEN elutasítási ág az offline úton
  // kód, strukturált log és ledger-nyom nélkül: a CRM 400-at kapott, a
  // gateway-oldalon pedig semmi nyoma nem maradt, hogy egy konverzió elveszett.
  UNSUPPORTED_LEAD_STATUS_MAPPING = 'TRK-400-022',

  NO_SITE_CONFIG = 'TRK-500-001',
  MISSING_PIXEL_ID = 'TRK-500-002',
  MISSING_META_TOKEN = 'TRK-500-003',
  MISSING_GA4_CONFIG = 'TRK-500-004',
  MISSING_GADS_CONFIG = 'TRK-500-005',
  MISSING_CONVERSION_ACTION = 'TRK-500-006',
  INVALID_SITE_CONFIG_JSON = 'TRK-500-007',

  META_API_REJECTED = 'TRK-600-001',
  META_API_TIMEOUT = 'TRK-600-002',
  META_API_NETWORK_ERROR = 'TRK-600-003',
  META_INVALID_ACCESS_TOKEN = 'TRK-600-004',
  META_PIXEL_NOT_FOUND = 'TRK-600-005',
  META_RATE_LIMITED = 'TRK-600-006',
  META_INVALID_USER_DATA = 'TRK-600-007',
  META_EVENTS_RECEIVED_ZERO = 'TRK-600-008',
  // §17: KV site-config carries meta.test_event_code — detected at send time and
  // IGNORED (never applied to the request). Loud alert so the KV landmine gets
  // removed before the edge-cache window routes real conversions to the Test stream.
  META_KV_TEST_EVENT_CODE = 'TRK-600-009',

  GA4_API_TIMEOUT = 'TRK-700-001',
  GA4_API_NETWORK_ERROR = 'TRK-700-002',
  GA4_VALIDATION_FAILURE = 'TRK-700-003',
  GA4_INVALID_MEASUREMENT_ID = 'TRK-700-004',
  GA4_INVALID_API_SECRET = 'TRK-700-005',

  GADS_NO_ACCESS_TOKEN = 'TRK-800-001',
  GADS_API_TIMEOUT = 'TRK-800-002',
  GADS_API_NETWORK_ERROR = 'TRK-800-003',
  GADS_PARTIAL_FAILURE = 'TRK-800-004',
  GADS_AUTH_REJECTED = 'TRK-800-005',
  GADS_OAUTH_REFRESH_FAILED = 'TRK-800-006',
  GADS_DEVELOPER_TOKEN_INVALID = 'TRK-800-007',
  GADS_INVALID_CONVERSION_ACTION = 'TRK-800-008',
  GADS_NO_REFRESH_TOKEN = 'TRK-800-009',
  GADS_RATE_LIMITED = 'TRK-800-010',
  // 011-016 — az OAuth-bukás OKAI. Korábban mind a hat a GADS_NO_ACCESS_TOKEN
  // (TRK-800-001) gyűjtőbe esett, ami az operátornak annyit mondott: „nincs
  // token". A hat ok viszont HAT KÜLÖNBÖZŐ teendő: secretet beírni, újra
  // engedélyezni, várni, vagy Google-státuszt nézni.
  GADS_OAUTH_CLIENT_ID_MISSING = 'TRK-800-011',
  GADS_OAUTH_CLIENT_SECRET_MISSING = 'TRK-800-012',
  GADS_REFRESH_TOKEN_REVOKED = 'TRK-800-013',
  GADS_OAUTH_HTTP_ERROR = 'TRK-800-014',
  GADS_OAUTH_MALFORMED_RESPONSE = 'TRK-800-015',
  GADS_OAUTH_TIMEOUT = 'TRK-800-016',

  DATAMANAGER_API_TIMEOUT = 'TRK-840-001',
  DATAMANAGER_API_NETWORK_ERROR = 'TRK-840-002',
  DATAMANAGER_API_REJECTED = 'TRK-840-003',
  DATAMANAGER_AUTH_REJECTED = 'TRK-840-004',
  DATAMANAGER_RATE_LIMITED = 'TRK-840-005',
  DATAMANAGER_NOT_ALLOWLISTED = 'TRK-840-006',
  DATAMANAGER_NO_IDENTIFIERS = 'TRK-840-007',
  // A DATAMANAGER_VALIDATE_ONLY kapcsoló BE volt kapcsolva: a Google csak
  // validálta a payloadot, SEMMIT nem rögzített. Ez NEM kézbesítés — külön kód
  // kell, mert enélkül a 200-as validate-válasz megkülönböztethetetlen a valós
  // uploadtól (ledger 'accepted', uploaded_to_gads:true), és a rendszer csendben
  // zöldet mutatna nulla rögzített konverzió fölött.
  DATAMANAGER_VALIDATE_ONLY = 'TRK-840-008',
  // 009-014 — a TRK-840-003 (DATAMANAGER_API_REJECTED) gyűjtő felbontása.
  // Addig egyetlen `warning` súlyú kód nyelte el a validációs hibát, a
  // vendor-kiesést és a jogosultsági problémát: a ledgerben egy Google-outage
  // megkülönböztethetetlen volt egy véglegesen rossz payloadtól, holott az
  // egyik RETRYABLE, a másik TERMINAL.
  DATAMANAGER_PERMISSION_DENIED = 'TRK-840-009',
  DATAMANAGER_VALIDATION_FAILED = 'TRK-840-010',
  DATAMANAGER_SERVER_ERROR = 'TRK-840-011',
  // 2xx, de a törzs nem értelmezhető JSON. KRITIKUS: eddig `{}`-ra esett vissza,
  // és a hívás `accepted`-ként, `conversions_processed:1`-gyel könyvelődött —
  // néma siker ismeretlen vendor-állapot fölött (§17).
  DATAMANAGER_MALFORMED_RESPONSE = 'TRK-840-012',
  DATAMANAGER_INVALID_CLICK_ID = 'TRK-840-013',
  DATAMANAGER_RESPONSE_NO_REQUEST_ID = 'TRK-840-014',

  // TRK-85x — ELO GTM conformance (P7).
  // A committolt `gtm/container.json` eddig csak onmagaval volt osszevetve. Az
  // ELO kontener viszont kezzel szerkesztheto, es pont ott keletkeznek a nema
  // money-hibak: egy kikapcsolt konverzios tag, egy elirt label vagy egy
  // ismeretlen, konverzio-kepes tag semmilyen ledger-jelet nem hagy — a
  // gateway-oldalon minden zold marad, mikozben a bongeszo-lab halott.
  GTM_TAG_MISSING = 'TRK-850-001',
  GTM_TAG_PAUSED = 'TRK-850-002',
  GTM_TRIGGER_MISSING = 'TRK-850-003',
  GTM_EVENT_NAME_MISMATCH = 'TRK-850-004',
  GTM_CONVERSION_ID_MISMATCH = 'TRK-850-005',
  GTM_CONVERSION_LABEL_MISMATCH = 'TRK-850-006',
  GTM_ENHANCED_CONVERSIONS_MISSING = 'TRK-850-007',
  GTM_EC_USER_DATA_VARIABLE_MISSING = 'TRK-850-008',
  GTM_CONSENT_SETTINGS_MISSING = 'TRK-850-009',
  GTM_DUPLICATE_CONVERSION_TAG = 'TRK-850-010',
  // ISMERETLEN, DE KONVERZIO-KEPES tag: valaki kezzel vett fel egy tagtipust,
  // ami penzt tud konyvelni (awct / gaawe / Meta Custom HTML). Ez FAIL, nem
  // figyelmeztetes — a duplikalt konverzio ugyanugy torzitja a biddinget, mint
  // a hianyzo, csak felfele.
  GTM_UNKNOWN_CONVERSION_TAG = 'TRK-850-011',
  GTM_LEGACY_TRIGGER_ACTIVE = 'TRK-850-012',
  GTM_UNSUPPORTED_CUSTOM_HTML = 'TRK-850-013',
  GTM_CONTAINER_MISMATCH = 'TRK-850-014',
  // A conformance-ellenorzes SAJAT dependenciaja halt meg (nincs export, nincs
  // API-hozzaferes). §17: ez NEM "nulla finding".
  GTM_CONFORMANCE_UNAVAILABLE = 'TRK-850-015',

  MSADS_DISPATCH_FAILED = 'TRK-810-001',
  MSADS_API_TIMEOUT = 'TRK-810-002',
  TIKTOK_DISPATCH_FAILED = 'TRK-820-001',
  TIKTOK_API_TIMEOUT = 'TRK-820-002',
  LINKEDIN_DISPATCH_FAILED = 'TRK-830-001',
  LINKEDIN_API_TIMEOUT = 'TRK-830-002',

  DLQ_WRITE_FAILED = 'TRK-900-001',
  DLQ_LIST_FAILED = 'TRK-900-002',
  DLQ_DELETE_FAILED = 'TRK-900-003',
  CRON_RETRY_FAILED = 'TRK-900-004',
  MAX_RETRIES_EXCEEDED = 'TRK-900-005',
  DLQ_CORRUPT_RECORD = 'TRK-900-006',
  // Platform-hívás elbukott ÉS a retry-rekordot sem sikerült sehova (Queue + R2)
  // letenni → az event minden tárból kiesett. Ilyenkor a dispatched flag 0 marad,
  // hogy egy kliens-retry újrakézbesíthesse (vendor event_id-dedup véd).
  RETRY_PERSIST_FAILED = 'TRK-900-007',
  // ELVÁRT platform, de a site-configból hiányzik a blokkja (lomtalan Meta,
  // 2026-07-15). NEM vendor-hiba és nem is szándékos kihagyás: konfigurációs
  // blokk, ami magától SOHA nem javul meg. Ezért retryable — DLQ-rekord készül
  // az eredeti payloaddal —, de hosszú backoff-fal, hogy a config helyreállítása
  // előtt ne égesse el a retry-keretet. E kód nélkül a skip csendes adatvesztés.
  PLATFORM_NOT_CONFIGURED = 'TRK-900-008',
  // ELVÁRT platform, a config-blokk MEGVAN, de a benne lévő azonosító alakja
  // használhatatlan (kitöltetlen placeholder, elgépelt vagy rossz típusú ID).
  // Testvére a fentinek: ugyanaz a kár (a platform-láb halott), ugyanaz a
  // gyógymód (KV-javítás + replay), csak a hiányzó blokk helyett egy formahibás
  // mező okozza. Azért KÜLÖN kód, mert a teendő más: nem „írd be a blokkot",
  // hanem „javítsd az azonosítót" — és a digestben is másképp kell olvasni.
  PLATFORM_IDENTIFIER_INVALID = 'TRK-900-009',

  // ── 910: Consent-diagnosztika (Fázis D, 2026-08) ──────────────────────────
  // SÁVVÁLASZTÁS — olvasd el, mielőtt „javítanád": az éjszakai brief ezeket
  // TRK-900-001…006-ként írja le, DE a 900-as sáv 001–008 ALREADY FOGLALT
  // (DLQ + Cron: DLQ_WRITE_FAILED … PLATFORM_NOT_CONFIGURED), élesben kibocsátott
  // kódokkal, amikre a docs/error-codes.md, a Workers-log-keresések és a
  // historikus riasztások hivatkoznak. Újraszámozni őket néma diagnosztika-
  // vesztés lenne (egy TRK-900-002 találat holnap már mást jelentene, mint
  // tegnap). Ezért a consent-kódok a szabad 910-es sávot kapják, 1:1 sorrendben
  // a briefhez: 910-001 ↔ 900-001, … 910-006 ↔ 900-006. Lásd a PR nyitott kérdését.
  /** brief: TRK-900-001 — a consent objektum teljesen hiányzik a payloadból. */
  CONSENT_MISSING = 'TRK-910-001',
  /** brief: TRK-900-002 — jelen van, de egyetlen érvényes jel sem olvasható ki. */
  CONSENT_UNPARSEABLE = 'TRK-910-002',
  /** brief: TRK-900-003 — két forrás ellentmond (source_consistent=0). */
  CONSENT_SOURCE_MISMATCH = 'TRK-910-003',
  /**
   * brief: TRK-900-004 — a consent lejárt. **DEFINIÁLVA, DE NEM ÉLESÍTVE.**
   * CookieYes alatt SOHA nem tüzelhet: a `cookieyes-consent` süti nem hordoz
   * timestampet, tehát a `consent_age_s` mindig NULL. Kizárólag az sbo_consent
   * korszakban aktiválható, amikor a saját CMP a döntés idejét is rögzíti.
   */
  CONSENT_EXPIRED = 'TRK-910-004',
  /** brief: TRK-900-005 — a jelek belül inkonzisztensek (ad-hármas szétesik). */
  CONSENT_SIGNALS_INCONSISTENT = 'TRK-910-005',
  /** brief: TRK-900-006 — client_lib_version a minimum alatt (WARN, később block). */
  CONSENT_CLIENT_LIB_OUTDATED = 'TRK-910-006',
  /** A napi consent-keresztellenőrzés (S3) D1-lekérdezése elbukott. */
  CONSENT_CROSS_CHECK_FAILED = 'TRK-910-007',
  /**
   * GRANTED consent MELLETT keletkezett `skipped` delivery — pontosan az a 9
   * darab rejtély, amiért a Fázis D létezik. Nem szabadna léteznie.
   */
  CONSENT_GRANTED_BUT_SKIPPED = 'TRK-910-008',

  RECON_VENDOR_FAILURE_RATE = 'TRK-950-001',
  RECON_COVERAGE_DRIFT = 'TRK-950-002',
  RECON_QUERY_FAILED = 'TRK-950-003',
  // Invariáns-sértés: 'accepted' delivery-rekord vendor HTTP-státusz nélkül.
  // Accepted CSAK valós vendor-válasz mellett íródhat — e nélkül a "green monitor
  // over zero data" osztályú bug (lomtalan 2026-07-14) észrevétlen maradna.
  ACCEPTED_WITHOUT_VENDOR_STATUS = 'TRK-950-004',
  // Cross-platform drift: a ledger event-countja és a GA4 / Google Ads aznapi
  // konverzió-száma küszöb fölött tér el — a GTM-ág (vagy a gateway-ág) némán
  // romlott el. Ez az az osztály, amit a ledger-belső recon szerkezetileg nem
  // láthat (Modell 2: a GA4/GAds on-site konverziót a böngésző birtokolja).
  RECON_CROSS_PLATFORM_DRIFT = 'TRK-950-005',
  RECON_CROSS_QUERY_FAILED = 'TRK-950-006',
  // Meta EMQ monitorozás (daily digest). A smoke-őr kézbesítést bizonyít, match-
  // minőséget nem — a leggyakoribb csendes CAPI-regresszió (eltört fbc/fbp-
  // forwarding) csak az EMQ-esésben látszik.
  EMQ_BELOW_THRESHOLD = 'TRK-950-007',
  EMQ_QUERY_FAILED = 'TRK-950-008',
  EMQ_COVERAGE_DROP = 'TRK-950-009',
  SITE_CONFIG_DRIFT = 'TRK-950-010',
  // A cross-platform check MAGA nem fut: egyetlen site-on sincs `recon` blokk,
  // vagy minden leg kimarad (hiányzó ga4_property_id / gads_onsite_actions,
  // 403-as scope). Modell 2-ben ez az EGYETLEN monitor a böngésző/GTM-ágra,
  // tehát az álló monitor nem lehet néma: e kód nélkül a napi riport üres
  // finding-listája megkülönböztethetetlen a „nincs drift"-től (2026-08-16 audit:
  // a check a bevezetése óta EGYETLEN napon sem futott le, és ez sehol nem látszott).
  RECON_CROSS_CHECK_NOT_RUNNING = 'TRK-950-011',

  // ── P1.1 business-leg (CRM lifecycle → Google Ads offline / Data Manager) ──
  // A ledger-belso recon a BONGESZO-fan-outot meri; ezek az uzleti darabszam es a
  // tenylegesen leszallitott offline konverzio viszonyat. A `lead_status_total` mezo
  // 2026-08-24-ig LETEZETT es feltoltodott, de senki nem olvasta — egy szandekosan
  // kikapcsolt Google offline-lab mellett a monitor zolden ment at.
  /** Elvart kezbesites van, accepted NULLA — a lab halott (24h regresszio VAGY 7 napos abszolut). */
  RECON_OFFLINE_ZERO_DELIVERY = 'TRK-950-012',
  /** Reszleges kieses: az elvart kezbesitesek toredeke ert celba. */
  RECON_OFFLINE_COVERAGE_DRIFT = 'TRK-950-013',
  /** A Google elutasitja a feltolteseket (auth / allowlist / formatum). */
  RECON_OFFLINE_VENDOR_FAILURE = 'TRK-950-014',
  /**
   * A lab MERHETETLEN, mert hianyzik egy eloofeltetel (OAuth secret / refresh token /
   * customer_id / conversion action). SZANDEKOSAN NEM drift-finding: a hiba ismert es a
   * health-check mar jelzi, egy masodik riasztas ugyanarrol csak zajt termel. Viszont a
   * napi recon NEM lehet nema rola — ez a kod teszi greppelhetove es riportalhatova.
   */
  RECON_OFFLINE_BLOCKED = 'TRK-950-015',

  // ── P1.2 business-source recon (CRM aggregatum vs gateway lead_status) ─────
  /**
   * A CRM SZERINT tobb uzleti esemeny tortent, mint amennyi a gateway-be beerkezett:
   * a CRM→gateway dispatch ejt. A P1.1 ezt SZERKEZETILEG nem lathatja — ott a
   * beerkezes MAGA az elvart alap, tehat egy el sem indult hivas nulla elvarast
   * jelent, es a nulla kezbesites egeszsegesnek latszik.
   */
  RECON_BUSINESS_SOURCE_DRIFT = 'TRK-950-016',
  /**
   * Egy site-ra tegnap volt aggregatum, ma nincs — MAGA a CRM-cron allt le. A
   * megfigyelt elozmenyhez merunk, nem konfiguralt listahoz: egy sosem-jelentkezo
   * site nem riaszt (nincs bekotve), egy elhallgato igen.
   */
  RECON_BUSINESS_SOURCE_MISSING = 'TRK-950-017',
  /**
   * A SITE_CONFIG felsorolas NEM volt teljes (a KV-listazas lapozas kozben elbukott).
   * A reconciliation ilyenkor NEM szur a `monitoring` flagre — a reszlistabol NEGATIV
   * kovetkeztetest levonni azt jelentene, hogy a fel nem oldott site-ok NEMAN kiesnek a
   * meresbol. A riport degraded: bovebb es kevesbe pontos, NEM szukebb.
   */
  RECON_CONFIG_ENUMERATION_INCOMPLETE = 'TRK-950-018',
  // 019-020 — MAGA A RIASZTÁSI CSATORNA bukott el. Ez a §17 legélesebb esete:
  // ha az e-mail/SMS nem megy ki, a rendszer minden más baja NÉMA lesz, mert a
  // hír nem jut el emberhez. Eddig kód nélküli `level:'error'` sor volt, amire
  // nem lehetett riasztást kötni — vagyis a riasztás kiesése volt a legkevésbé
  // riasztható esemény.
  ALERT_EMAIL_FAILED = 'TRK-950-019',
  ALERT_SMS_FAILED = 'TRK-950-020',
  // 021 — a szintetikus smoke-lead lánc bukott. Ez a napi „él-e a pénz-út"
  // próba; kód nélkül a napi digest szövegében tűnt el.
  SMOKE_LEAD_CHECK_FAILED = 'TRK-950-021',

  RETENTION_QUERY_FAILED = 'TRK-960-001',
  RETENTION_R2_FAILED = 'TRK-960-002',

  // §8 — kanonikus event-szerződés (events.json). A *-002 kódok BUILD-IDŐBEN
  // fognak el (drift / parity / reserved-name) → CI-blokk, nem éles forgalom.
  // A többi runtime observability a gateway-en.
  UNKNOWN_EVENT_NAME = 'TRK-EVT-001',
  RESERVED_EVENT_NAME = 'TRK-EVT-002',
  GA4_ONSITE_FANOUT = 'TRK-GA4-002',
  BROWSER_SERVER_META_MISMATCH = 'TRK-META-002',
  INVALID_LEAD_PROVENANCE = 'TRK-PROV-001',
  INVALID_SITE_CONFIG_SCHEMA = 'TRK-CFG-001',
  MISSING_CONVERSION_ACTIONS_CONFIG = 'TRK-CFG-002'
}

export const ERROR_DESCRIPTIONS: Record<TrackingErrorCode, string> = {
  [TrackingErrorCode.UNHANDLED_EXCEPTION]: 'Unhandled exception in Worker fetch handler',
  [TrackingErrorCode.KV_READ_FAILED]: 'KV namespace read operation failed',
  [TrackingErrorCode.KV_WRITE_FAILED]: 'KV namespace write operation failed',
  [TrackingErrorCode.R2_READ_FAILED]: 'R2 bucket read operation failed',
  [TrackingErrorCode.R2_WRITE_FAILED]: 'R2 bucket write operation failed',
  [TrackingErrorCode.DURABLE_OBJECT_FAILED]: 'Durable Object operation failed',
  [TrackingErrorCode.LEDGER_WRITE_FAILED]: 'D1 ledger write operation failed',
  [TrackingErrorCode.FANOUT_SETUP_FAILED]:
    'fan-out setup threw before dispatch (payload build / synchronous error)',
  [TrackingErrorCode.INVALID_JSON]: 'Request body is not valid JSON',
  [TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE]: 'Payload missing required fields',
  [TrackingErrorCode.MISSING_TURNSTILE_TOKEN]: 'Turnstile token absent from payload',
  [TrackingErrorCode.INVALID_TURNSTILE_TOKEN]: 'Turnstile validation API rejected token',
  [TrackingErrorCode.TURNSTILE_API_UNAVAILABLE]: 'Turnstile validation API returned non-2xx',
  [TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD]: 'Lead-status payload missing or invalid fields',
  [TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING]:
    'Lead status has no canonical event mapping — the caller sent a status this build does not know',
  [TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED]: 'Lead-status request failed admin authentication',
  [TrackingErrorCode.ADMIN_UNAUTHORIZED]: 'Admin API request failed authentication or was rate-limited',
  [TrackingErrorCode.DEGRADED_TOKENLESS_ACCEPTED]:
    'Token-less low-risk event accepted in degraded mode (Turnstile unavailable client-side)',
  [TrackingErrorCode.DEGRADED_RATE_LIMITED]: 'Token-less degraded event dropped by the degraded-mode rate limiter',
  [TrackingErrorCode.TURNSTILE_SECRET_INVALID]:
    'Turnstile siteverify rejected OUR secret (invalid/missing-input-secret) — server misconfig, form conversions blocked until fixed',
  [TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED]:
    'X-Admin-Token present on /conversion but did not match the site crm_token_sha256 — rejected (no Turnstile fallback)',
  [TrackingErrorCode.SERVER_INGRESS_ACCEPTED]:
    'Conversion accepted via server-to-server ingress (per-site token)',
  [TrackingErrorCode.ORIGIN_MISSING]:
    'Browser conversion rejected: no Origin header (fail-closed — every non-GET browser request carries one)',
  [TrackingErrorCode.ORIGIN_NOT_ALLOWED]:
    'Browser conversion rejected: Origin is not the site own origin nor in allowed_origins',
  [TrackingErrorCode.BODY_TOO_LARGE]:
    'Request body exceeded the 16 KiB ingress cap (measured while streaming, not just Content-Length)',
  [TrackingErrorCode.REQUEST_BODY_READ_FAILED]:
    'Request body stream aborted mid-read (client disconnect / network fault) — distinct from the size cap',
  [TrackingErrorCode.CONVERSION_SPIKE]:
    'Accepted conversions for a site spiked far above its 7-day baseline — possible conversion spam on the tokenless browser path',
  [TrackingErrorCode.HIGH_VALUE_EVENT_BROWSER_REJECTED]:
    'High-value conversion rejected on the browser path — it must arrive via the authenticated /api/event/conversion-server ingress (per-site token)',
  [TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA]:
    'user_data and user_data_hashed are mutually exclusive — send exactly one (which normalizer ran is ambiguous otherwise)',
  [TrackingErrorCode.INVALID_PREHASHED_USER_DATA]:
    'user_data_hashed contains a field that is not a 64-char lowercase hex SHA-256',
  [TrackingErrorCode.NO_SITE_CONFIG]: 'No KV config exists for the request hostname',
  [TrackingErrorCode.MISSING_PIXEL_ID]: 'Site config has no Meta pixel_id',
  [TrackingErrorCode.MISSING_META_TOKEN]: 'Site config has no Meta access_token',
  [TrackingErrorCode.MISSING_GA4_CONFIG]: 'Site config has no GA4 measurement_id or api_secret',
  [TrackingErrorCode.MISSING_GADS_CONFIG]: 'Site config has no Google Ads customer_id',
  [TrackingErrorCode.MISSING_CONVERSION_ACTION]:
    'Site config missing conversion_action for this event_name',
  [TrackingErrorCode.INVALID_SITE_CONFIG_JSON]: 'Site config in KV is not valid JSON',
  [TrackingErrorCode.META_API_REJECTED]: 'Meta Graph API returned non-200 with error response',
  [TrackingErrorCode.META_API_TIMEOUT]: 'Meta Graph API call exceeded 5s timeout',
  [TrackingErrorCode.META_API_NETWORK_ERROR]: 'Network error reaching Meta Graph API',
  [TrackingErrorCode.META_INVALID_ACCESS_TOKEN]: 'Meta access token rejected (expired or revoked)',
  [TrackingErrorCode.META_PIXEL_NOT_FOUND]: 'Meta pixel_id does not exist or no access',
  [TrackingErrorCode.META_RATE_LIMITED]: 'Meta API rate limit exceeded',
  [TrackingErrorCode.META_INVALID_USER_DATA]:
    'Meta rejected user_data format (hash or normalization)',
  [TrackingErrorCode.META_EVENTS_RECEIVED_ZERO]: 'Meta returned 200 OK but events_received: 0',
  [TrackingErrorCode.META_KV_TEST_EVENT_CODE]: 'KV site-config carries meta.test_event_code — ignored per CLAUDE.md §17; remove it from KV',
  [TrackingErrorCode.GA4_API_TIMEOUT]: 'GA4 Measurement Protocol call exceeded 5s timeout',
  [TrackingErrorCode.GA4_API_NETWORK_ERROR]: 'Network error reaching GA4 Measurement Protocol',
  [TrackingErrorCode.GA4_VALIDATION_FAILURE]: 'GA4 debug endpoint returned validation messages',
  [TrackingErrorCode.GA4_INVALID_MEASUREMENT_ID]: 'GA4 measurement_id rejected',
  [TrackingErrorCode.GA4_INVALID_API_SECRET]: 'GA4 api_secret rejected',
  [TrackingErrorCode.GADS_NO_ACCESS_TOKEN]: 'Failed to obtain Google Ads access token',
  [TrackingErrorCode.GADS_API_TIMEOUT]: 'Google Ads API call exceeded 5s timeout',
  [TrackingErrorCode.GADS_API_NETWORK_ERROR]: 'Network error reaching Google Ads API',
  [TrackingErrorCode.GADS_PARTIAL_FAILURE]: 'Google Ads partialFailureError in response',
  [TrackingErrorCode.GADS_AUTH_REJECTED]: 'Google Ads API rejected authentication (401)',
  [TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED]: 'OAuth refresh token exchange failed',
  [TrackingErrorCode.GADS_DEVELOPER_TOKEN_INVALID]: 'Developer token rejected by Google Ads API',
  [TrackingErrorCode.GADS_INVALID_CONVERSION_ACTION]: 'Conversion action ID does not exist',
  [TrackingErrorCode.GADS_NO_REFRESH_TOKEN]: 'No refresh token in KV for customer (run OAuth flow)',
  [TrackingErrorCode.GADS_RATE_LIMITED]: 'Google Ads API rate limit exceeded',
  [TrackingErrorCode.GADS_OAUTH_CLIENT_ID_MISSING]:
    'GADS_OAUTH_CLIENT_ID secret is missing — set it on the Worker, the token request cannot succeed without it',
  [TrackingErrorCode.GADS_OAUTH_CLIENT_SECRET_MISSING]:
    'GADS_OAUTH_CLIENT_SECRET secret is missing — set it on the Worker',
  [TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED]:
    'Refresh token expired or revoked (invalid_grant) — the OAuth consent flow must be re-run',
  [TrackingErrorCode.GADS_OAUTH_HTTP_ERROR]:
    'Google OAuth token endpoint returned a non-2xx status (not invalid_grant)',
  [TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE]:
    'Google OAuth token endpoint response was not valid JSON or carried no access_token',
  [TrackingErrorCode.GADS_OAUTH_TIMEOUT]: 'Google OAuth token request exceeded the 5s timeout',
  [TrackingErrorCode.DATAMANAGER_API_TIMEOUT]: 'Data Manager API call exceeded 5s timeout',
  [TrackingErrorCode.DATAMANAGER_API_NETWORK_ERROR]: 'Network error reaching Data Manager API',
  [TrackingErrorCode.DATAMANAGER_API_REJECTED]:
    'Data Manager API returned a non-2xx error that matches no more specific class (residual bucket)',
  [TrackingErrorCode.DATAMANAGER_AUTH_REJECTED]: 'Data Manager API rejected authentication (401)',
  [TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED]:
    'Data Manager API denied permission (403) — the OAuth scope or the account access is wrong, NOT an expired token',
  [TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED]:
    'Data Manager rejected the payload as invalid (INVALID_ARGUMENT / fieldViolations) — permanent, retry cannot fix it',
  [TrackingErrorCode.DATAMANAGER_SERVER_ERROR]:
    'Data Manager API returned 5xx — vendor-side outage, RETRYABLE (distinct from a permanently bad payload)',
  [TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE]:
    'Data Manager returned 2xx with an unparseable body — the delivery state is UNKNOWN, so it is NOT booked as accepted',
  [TrackingErrorCode.DATAMANAGER_INVALID_CLICK_ID]:
    'Click identifier (gclid/gbraid/wbraid) is malformed — dropped before the send so it cannot cause a blanket 400',
  [TrackingErrorCode.DATAMANAGER_RESPONSE_NO_REQUEST_ID]:
    'Data Manager 2xx carried no requestId — accepted on the HTTP status, but the vendor trace is missing',
  [TrackingErrorCode.GTM_TAG_MISSING]:
    'An expected GTM tag is absent from the live container — that browser leg does not fire at all',
  [TrackingErrorCode.GTM_TAG_PAUSED]:
    'An expected GTM tag exists but is PAUSED — it looks configured and fires nothing',
  [TrackingErrorCode.GTM_TRIGGER_MISSING]:
    'An expected custom-event trigger is absent — the tag can never fire for that event',
  [TrackingErrorCode.GTM_EVENT_NAME_MISMATCH]:
    'A live trigger listens on an event name the code never emits (or vice versa)',
  [TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH]:
    'The live Google Ads conversion ID differs from the expected one — conversions land in the wrong account',
  [TrackingErrorCode.GTM_CONVERSION_LABEL_MISMATCH]:
    'The live Google Ads conversion label differs from the expected one — conversions land on the wrong action',
  [TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING]:
    'Enhanced Conversions is not enabled on a Google Ads conversion tag (INV-009)',
  [TrackingErrorCode.GTM_EC_USER_DATA_VARIABLE_MISSING]:
    'The Enhanced-Conversions user-data variable is missing or not wired to the conversion tag',
  [TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING]:
    'A consent-bound tag carries no consent settings — it may fire before or without consent',
  [TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG]:
    'More than one tag books the same conversion — double counting inflates the bidding signal',
  [TrackingErrorCode.GTM_UNKNOWN_CONVERSION_TAG]:
    'An unknown but CONVERSION-CAPABLE tag exists in the live container — nobody owns it and it can book money',
  [TrackingErrorCode.GTM_LEGACY_TRIGGER_ACTIVE]:
    'A retired/legacy event trigger is still active in the live container',
  [TrackingErrorCode.GTM_UNSUPPORTED_CUSTOM_HTML]:
    'A Custom HTML tag on the money path (gtag/fbq/conversion call) — unreviewable and outside the contract',
  [TrackingErrorCode.GTM_CONTAINER_MISMATCH]:
    'The live container/version is not the one the site is expected to run',
  [TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE]:
    'The GTM conformance check could not read the live container — this is DEGRADED, not zero findings',
  [TrackingErrorCode.DATAMANAGER_RATE_LIMITED]: 'Data Manager API rate limit exceeded',
  [TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS]:
    'Data Manager event skipped: no user identifiers and no click ID (would be a permanent 400)',
  [TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED]:
    'Data Manager destination/feature not allowlisted for this account (e.g. multi-source / store sales)',
  [TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY]:
    'DATAMANAGER_VALIDATE_ONLY=1 — Google validated the payload but recorded NO conversion; not a real delivery',
  [TrackingErrorCode.MSADS_DISPATCH_FAILED]: 'Microsoft Ads offline conversion upload failed',
  [TrackingErrorCode.MSADS_API_TIMEOUT]: 'Microsoft Ads API call exceeded timeout',
  [TrackingErrorCode.TIKTOK_DISPATCH_FAILED]: 'TikTok Events API call failed',
  [TrackingErrorCode.TIKTOK_API_TIMEOUT]: 'TikTok Events API call exceeded timeout',
  [TrackingErrorCode.LINKEDIN_DISPATCH_FAILED]: 'LinkedIn Conversions API call failed',
  [TrackingErrorCode.LINKEDIN_API_TIMEOUT]: 'LinkedIn Conversions API call exceeded timeout',
  [TrackingErrorCode.DLQ_WRITE_FAILED]: 'Failed to write event to R2 dead letter queue',
  [TrackingErrorCode.DLQ_LIST_FAILED]: 'Failed to list pending DLQ records',
  [TrackingErrorCode.DLQ_DELETE_FAILED]: 'Failed to delete DLQ record after successful retry',
  [TrackingErrorCode.CRON_RETRY_FAILED]: 'Cron retry handler encountered unhandled error',
  [TrackingErrorCode.MAX_RETRIES_EXCEEDED]: 'DLQ record reached max retry count',
  [TrackingErrorCode.DLQ_CORRUPT_RECORD]: 'DLQ record JSON is malformed',
  [TrackingErrorCode.RETRY_PERSIST_FAILED]:
    'Platform call failed AND the retry record could not be stored anywhere (Queue + R2) — event left undispatched; recovery needs a MANUAL resend (the caller already got its response, no automatic retry is coming)',
  [TrackingErrorCode.PLATFORM_NOT_CONFIGURED]:
    'An EXPECTED platform has no config block for this site — no vendor call was made; the event is held in the DLQ with a long backoff and replays once the config is restored',
  [TrackingErrorCode.CONSENT_MISSING]:
    'Consent object absent from the payload — the site require_consent rule decides (no behaviour change from this code)',
  [TrackingErrorCode.CONSENT_UNPARSEABLE]:
    'Consent object present but no valid Consent Mode v2 signal could be read — uncertain consent (consent_debug row written)',
  [TrackingErrorCode.CONSENT_SOURCE_MISMATCH]:
    'Two consent sources disagree (cookie / getCkyConsent API / server Cookie header) — uncertain consent (consent_debug row written)',
  [TrackingErrorCode.CONSENT_EXPIRED]:
    'Consent older than the retention policy — DEFINED BUT NOT ARMED: under CookieYes consent_age_s is always NULL, so this can never fire',
  [TrackingErrorCode.CONSENT_SIGNALS_INCONSISTENT]:
    'Consent signals internally inconsistent (e.g. ad_user_data GRANTED while ad_storage is missing or DENIED)',
  [TrackingErrorCode.CONSENT_CLIENT_LIB_OUTDATED]:
    'Reported client_lib_version is below the minimum that emits consent telemetry — warn now, block later',
  [TrackingErrorCode.CONSENT_CROSS_CHECK_FAILED]:
    'Daily consent cross-check D1 query failed — that leg is dark for the day',
  [TrackingErrorCode.CONSENT_GRANTED_BUT_SKIPPED]:
    'A delivery was skipped while its consent receipt says GRANTED — the exact anomaly Phase D exists to explain; check the skip_reason breakdown',
  [TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID]:
    'An EXPECTED platform has a config block, but its identifier is malformed (unfilled placeholder or typo) — no vendor call was made; the event is held in the DLQ with a long backoff and replays once the identifier is fixed in KV',
  [TrackingErrorCode.RECON_VENDOR_FAILURE_RATE]:
    'Vendor delivery failure rate exceeded threshold (reconciliation)',
  [TrackingErrorCode.RECON_COVERAGE_DRIFT]:
    'Eligible events did not reach the platform — coverage drift (reconciliation)',
  [TrackingErrorCode.RECON_QUERY_FAILED]: 'Reconciliation D1 query failed',
  [TrackingErrorCode.RECON_CROSS_PLATFORM_DRIFT]:
    'Ledger event count diverges from the platform-side (GA4 / Google Ads) daily conversion count beyond threshold',
  [TrackingErrorCode.RECON_CROSS_QUERY_FAILED]:
    'Cross-platform reconciliation query failed (D1 / Google Ads API / GA4 Data API) — that leg skipped for the day',
  [TrackingErrorCode.RECON_OFFLINE_ZERO_DELIVERY]:
    'Offline business leg dead: statuses received, zero conversions delivered to Google',
  [TrackingErrorCode.RECON_OFFLINE_COVERAGE_DRIFT]:
    'Offline business leg partial loss: delivered well below expected',
  [TrackingErrorCode.RECON_OFFLINE_VENDOR_FAILURE]:
    'Offline business leg: Google rejects a high share of uploads',
  [TrackingErrorCode.RECON_OFFLINE_BLOCKED]:
    'Offline business leg unmeasurable: a dependency (OAuth secret / refresh token / customer_id / conversion action) is missing',
  [TrackingErrorCode.RECON_BUSINESS_SOURCE_DRIFT]:
    'CRM reports more business events than reached the gateway: the CRM->gateway dispatch is dropping',
  [TrackingErrorCode.RECON_BUSINESS_SOURCE_MISSING]:
    'A site that used to report daily business counts has gone silent: the CRM cron itself may be down',
  [TrackingErrorCode.RECON_CONFIG_ENUMERATION_INCOMPLETE]:
    'SITE_CONFIG enumeration was incomplete: reconciliation ran unfiltered (degraded, not narrower)',
  [TrackingErrorCode.ALERT_EMAIL_FAILED]:
    'The alert email could not be sent — every other failure in the system just went silent, because the news reaches no human',
  [TrackingErrorCode.ALERT_SMS_FAILED]:
    'The critical SMS alert could not be sent — the last-resort escalation channel is down',
  [TrackingErrorCode.SMOKE_LEAD_CHECK_FAILED]:
    'The synthetic smoke-lead chain failed: the daily proof that the money path is alive did not pass',
  [TrackingErrorCode.RECON_CROSS_CHECK_NOT_RUNNING]:
    'Cross-platform reconciliation is not running (no recon config, or every leg skipped) — the Model 2 browser/GTM blind spot is unmonitored',
  [TrackingErrorCode.EMQ_BELOW_THRESHOLD]:
    'Meta Event Match Quality below threshold for a monitored event (Dataset Quality API)',
  [TrackingErrorCode.EMQ_QUERY_FAILED]:
    'Meta Dataset Quality API query failed — daily digest falls back to the ledger match-key coverage proxy',
  [TrackingErrorCode.EMQ_COVERAGE_DROP]:
    'Match-key (em/ph/fbc/fbp) 24h coverage dropped significantly vs the 7-day average — likely broken identifier forwarding',
  [TrackingErrorCode.SITE_CONFIG_DRIFT]:
    'A live KV site-config diverged from the committed site-manifest (config vanished or changed) — the money-path source-of-truth and production disagree',
  [TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS]:
    "Invariant violation: a delivery would have been recorded 'accepted' without a vendor HTTP status — recorded as 'skipped' instead",
  [TrackingErrorCode.RETENTION_QUERY_FAILED]: 'Ledger retention D1 delete query failed',
  [TrackingErrorCode.RETENTION_R2_FAILED]: 'Dead-letter R2 retention purge failed',
  [TrackingErrorCode.UNKNOWN_EVENT_NAME]: 'event_name not in the canonical ALLOWED set (events.json)',
  [TrackingErrorCode.RESERVED_EVENT_NAME]:
    'Canonical event name collides with a GA4 reserved/automatic name (build-time guard)',
  [TrackingErrorCode.GA4_ONSITE_FANOUT]:
    'GA4 MP invoked from the on-site fan-out — must never happen under Model 2 (on-site GA4 is browser-only)',
  [TrackingErrorCode.BROWSER_SERVER_META_MISMATCH]:
    'Browser vs server Meta event-name parity drift (build-time parity guard)',
  [TrackingErrorCode.INVALID_LEAD_PROVENANCE]:
    'lead_provenance not in {cold,post_quote,from_quote_email} — param dropped, event proceeds',
  [TrackingErrorCode.INVALID_SITE_CONFIG_SCHEMA]:
    'Site config failed JSON Schema validation (generator / KV load)',
  [TrackingErrorCode.MISSING_CONVERSION_ACTIONS_CONFIG]:
    'gads.customer_id present but no conversion_actions configured'
};

export type ErrorSeverity = 'critical' | 'warning' | 'info';

export const ERROR_SEVERITY: Record<TrackingErrorCode, ErrorSeverity> = {
  [TrackingErrorCode.UNHANDLED_EXCEPTION]: 'critical',
  [TrackingErrorCode.META_INVALID_ACCESS_TOKEN]: 'critical',
  [TrackingErrorCode.GADS_AUTH_REJECTED]: 'critical',
  [TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED]: 'critical',
  [TrackingErrorCode.GADS_NO_REFRESH_TOKEN]: 'critical',
  [TrackingErrorCode.DLQ_WRITE_FAILED]: 'critical',
  [TrackingErrorCode.RETRY_PERSIST_FAILED]: 'critical',
  [TrackingErrorCode.PLATFORM_NOT_CONFIGURED]: 'critical',
  // Ugyanaz a súly, mint a hiányzó blokké: a platform-láb halott, és magától
  // soha nem javul meg. A 43 elutasítás pont azért futhatott két hétig, mert
  // vendor-oldali `warning` (TRK-600-005) volt, nem konfigurációs `critical`.
  [TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID]: 'critical',
  [TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS]: 'critical',
  [TrackingErrorCode.GADS_DEVELOPER_TOKEN_INVALID]: 'critical',
  [TrackingErrorCode.DATAMANAGER_AUTH_REJECTED]: 'critical',
  [TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED]: 'critical',
  [TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED]: 'critical',
  // Egy értelmezhetetlen vendor-válasz azt jelenti, hogy NEM TUDJUK, mi történt
  // a konverzióval. Az ismeretlen állapot nem „warning", mert némán zöldülhetne.
  [TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE]: 'critical',
  [TrackingErrorCode.GADS_OAUTH_CLIENT_ID_MISSING]: 'critical',
  [TrackingErrorCode.GADS_OAUTH_CLIENT_SECRET_MISSING]: 'critical',
  [TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED]: 'critical',
  [TrackingErrorCode.FANOUT_SETUP_FAILED]: 'critical',
  // A halott offline business-lab ugyanaz a karkep, mint a hianyzo config-blokk:
  // a penz nem er celba, es magatol soha nem javul meg.
  [TrackingErrorCode.RECON_OFFLINE_ZERO_DELIVERY]: 'critical',
  [TrackingErrorCode.RECON_BUSINESS_SOURCE_DRIFT]: 'critical',

  [TrackingErrorCode.META_API_REJECTED]: 'warning',
  [TrackingErrorCode.META_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.META_API_NETWORK_ERROR]: 'warning',
  [TrackingErrorCode.META_RATE_LIMITED]: 'warning',
  [TrackingErrorCode.GA4_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.GA4_API_NETWORK_ERROR]: 'warning',
  [TrackingErrorCode.GADS_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.GADS_API_NETWORK_ERROR]: 'warning',
  [TrackingErrorCode.GADS_PARTIAL_FAILURE]: 'warning',
  [TrackingErrorCode.GADS_RATE_LIMITED]: 'warning',
  [TrackingErrorCode.DATAMANAGER_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.DATAMANAGER_API_NETWORK_ERROR]: 'warning',
  [TrackingErrorCode.DATAMANAGER_API_REJECTED]: 'warning',
  [TrackingErrorCode.DATAMANAGER_RATE_LIMITED]: 'warning',
  [TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS]: 'warning',
  [TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY]: 'warning',
  [TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED]: 'warning',
  [TrackingErrorCode.DATAMANAGER_SERVER_ERROR]: 'warning',
  [TrackingErrorCode.DATAMANAGER_INVALID_CLICK_ID]: 'warning',
  [TrackingErrorCode.DATAMANAGER_RESPONSE_NO_REQUEST_ID]: 'warning',
  [TrackingErrorCode.GADS_OAUTH_HTTP_ERROR]: 'warning',
  [TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE]: 'warning',
  [TrackingErrorCode.GADS_OAUTH_TIMEOUT]: 'warning',
  [TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING]: 'warning',
  [TrackingErrorCode.GTM_EVENT_NAME_MISMATCH]: 'warning',
  [TrackingErrorCode.GTM_EC_USER_DATA_VARIABLE_MISSING]: 'warning',
  [TrackingErrorCode.GTM_LEGACY_TRIGGER_ACTIVE]: 'warning',
  [TrackingErrorCode.GTM_UNSUPPORTED_CUSTOM_HTML]: 'warning',
  [TrackingErrorCode.GTM_CONTAINER_MISMATCH]: 'warning',
  [TrackingErrorCode.MSADS_DISPATCH_FAILED]: 'warning',
  [TrackingErrorCode.MSADS_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.TIKTOK_DISPATCH_FAILED]: 'warning',
  [TrackingErrorCode.TIKTOK_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.LINKEDIN_DISPATCH_FAILED]: 'warning',
  [TrackingErrorCode.LINKEDIN_API_TIMEOUT]: 'warning',
  [TrackingErrorCode.MAX_RETRIES_EXCEEDED]: 'warning',
  [TrackingErrorCode.NO_SITE_CONFIG]: 'warning',
  [TrackingErrorCode.MISSING_CONVERSION_ACTION]: 'warning',
  [TrackingErrorCode.META_EVENTS_RECEIVED_ZERO]: 'warning',
  [TrackingErrorCode.META_KV_TEST_EVENT_CODE]: 'warning',
  [TrackingErrorCode.META_INVALID_USER_DATA]: 'warning',
  [TrackingErrorCode.KV_READ_FAILED]: 'warning',
  [TrackingErrorCode.KV_WRITE_FAILED]: 'warning',
  [TrackingErrorCode.R2_READ_FAILED]: 'warning',
  [TrackingErrorCode.R2_WRITE_FAILED]: 'warning',
  [TrackingErrorCode.DURABLE_OBJECT_FAILED]: 'warning',
  [TrackingErrorCode.GA4_VALIDATION_FAILURE]: 'warning',
  [TrackingErrorCode.GA4_INVALID_MEASUREMENT_ID]: 'warning',
  [TrackingErrorCode.GA4_INVALID_API_SECRET]: 'warning',
  [TrackingErrorCode.GADS_INVALID_CONVERSION_ACTION]: 'warning',
  [TrackingErrorCode.MISSING_PIXEL_ID]: 'warning',
  [TrackingErrorCode.MISSING_META_TOKEN]: 'warning',
  [TrackingErrorCode.MISSING_GA4_CONFIG]: 'warning',
  [TrackingErrorCode.MISSING_GADS_CONFIG]: 'warning',
  [TrackingErrorCode.INVALID_SITE_CONFIG_JSON]: 'warning',
  [TrackingErrorCode.GADS_NO_ACCESS_TOKEN]: 'warning',
  [TrackingErrorCode.META_PIXEL_NOT_FOUND]: 'warning',
  [TrackingErrorCode.CRON_RETRY_FAILED]: 'warning',
  [TrackingErrorCode.DLQ_LIST_FAILED]: 'warning',
  [TrackingErrorCode.DLQ_DELETE_FAILED]: 'warning',
  [TrackingErrorCode.DLQ_CORRUPT_RECORD]: 'warning',
  [TrackingErrorCode.LEDGER_WRITE_FAILED]: 'warning',
  [TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED]: 'warning',
  [TrackingErrorCode.ADMIN_UNAUTHORIZED]: 'warning',
  [TrackingErrorCode.RECON_VENDOR_FAILURE_RATE]: 'warning',
  [TrackingErrorCode.RECON_COVERAGE_DRIFT]: 'warning',
  [TrackingErrorCode.RECON_QUERY_FAILED]: 'warning',
  [TrackingErrorCode.RECON_CROSS_PLATFORM_DRIFT]: 'warning',
  [TrackingErrorCode.RECON_CROSS_QUERY_FAILED]: 'warning',
  [TrackingErrorCode.RECON_OFFLINE_COVERAGE_DRIFT]: 'warning',
  [TrackingErrorCode.RECON_OFFLINE_VENDOR_FAILURE]: 'warning',
  // SZANDEKOSAN 'warning': a blokkolt lab hibaja ISMERT (a health-check jelzi), es a
  // recon csak lathatova teszi. Critical-la emelve duplan riasztana ugyanarrol.
  [TrackingErrorCode.RECON_OFFLINE_BLOCKED]: 'warning',
  [TrackingErrorCode.RECON_BUSINESS_SOURCE_MISSING]: 'warning',
  [TrackingErrorCode.RECON_CONFIG_ENUMERATION_INCOMPLETE]: 'warning',
  // A riasztási csatorna kiesése definíció szerint critical: enélkül minden
  // más baj néma marad.
  [TrackingErrorCode.ALERT_EMAIL_FAILED]: 'critical',
  [TrackingErrorCode.ALERT_SMS_FAILED]: 'critical',
  [TrackingErrorCode.SMOKE_LEAD_CHECK_FAILED]: 'critical',
  // A penz-utat erinto GTM-elteresek kritikusak: a gateway-oldalon SEMMILYEN
  // jelet nem hagynak, tehat csak itt derulhetnek ki.
  [TrackingErrorCode.GTM_TAG_MISSING]: 'critical',
  [TrackingErrorCode.GTM_TAG_PAUSED]: 'critical',
  [TrackingErrorCode.GTM_TRIGGER_MISSING]: 'critical',
  [TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH]: 'critical',
  [TrackingErrorCode.GTM_CONVERSION_LABEL_MISMATCH]: 'critical',
  [TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG]: 'critical',
  [TrackingErrorCode.GTM_UNKNOWN_CONVERSION_TAG]: 'critical',
  [TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING]: 'critical',
  [TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING]: 'critical',
  [TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE]: 'critical',
  [TrackingErrorCode.RECON_CROSS_CHECK_NOT_RUNNING]: 'warning',
  [TrackingErrorCode.EMQ_BELOW_THRESHOLD]: 'warning',
  // Info, NEM warning: a Dataset Quality API a standard CAPI (client system user)
  // tokennel dokumentáltan nem mindig kompatibilis — egy permanens token-
  // inkompatibilitás napi warningja két hét alatt zajjá válna. A digest ilyenkor
  // úgyis a proxy-metrikára esik vissza, az őrzés nem szűnik meg.
  [TrackingErrorCode.EMQ_QUERY_FAILED]: 'info',
  [TrackingErrorCode.EMQ_COVERAGE_DROP]: 'warning',
  [TrackingErrorCode.SITE_CONFIG_DRIFT]: 'critical',
  [TrackingErrorCode.RETENTION_QUERY_FAILED]: 'warning',
  [TrackingErrorCode.RETENTION_R2_FAILED]: 'warning',

  // Consent-diagnosztika. A per-event kódok INFO-k: `consent_strict: false`
  // mellett ezek NEM viselkedésváltozást jelentenek, csak megfigyelést, és egy
  // gyakori betöltési verseny warningja két nap alatt zajjá tenné a riasztási
  // láncot — pont azt a fáradtságot okozva, ami a néma hibákat elrejti. Az
  // aggregált jel a NAPI keresztellenőrzésé (S3), az riaszt.
  [TrackingErrorCode.CONSENT_MISSING]: 'info',
  [TrackingErrorCode.CONSENT_UNPARSEABLE]: 'info',
  [TrackingErrorCode.CONSENT_SOURCE_MISMATCH]: 'info',
  [TrackingErrorCode.CONSENT_EXPIRED]: 'info',
  [TrackingErrorCode.CONSENT_SIGNALS_INCONSISTENT]: 'info',
  [TrackingErrorCode.CONSENT_CLIENT_LIB_OUTDATED]: 'info',
  [TrackingErrorCode.CONSENT_CROSS_CHECK_FAILED]: 'warning',
  // Ez viszont NEM zaj: GRANTED consent mellett keletkezett skip. Nem szabadna
  // léteznie — a napi ellenőrzés ezen riaszt, ha nem nulla.
  [TrackingErrorCode.CONSENT_GRANTED_BUT_SKIPPED]: 'warning',

  [TrackingErrorCode.INVALID_JSON]: 'info',
  [TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD]: 'info',
  [TrackingErrorCode.DEGRADED_TOKENLESS_ACCEPTED]: 'info',
  [TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED]: 'warning',
  [TrackingErrorCode.SERVER_INGRESS_ACCEPTED]: 'info',
  [TrackingErrorCode.ORIGIN_MISSING]: 'info',
  [TrackingErrorCode.ORIGIN_NOT_ALLOWED]: 'warning',
  [TrackingErrorCode.BODY_TOO_LARGE]: 'info',
  [TrackingErrorCode.REQUEST_BODY_READ_FAILED]: 'info',
  // Warning (nem info): legitim forgalomból nem jöhet — vagy támadó próbálkozik,
  // vagy egy site kliens-kódja regressziósan a böngésző-útra tette a form-eventet.
  [TrackingErrorCode.HIGH_VALUE_EVENT_BROWSER_REJECTED]: 'warning',
  [TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA]: 'info',
  [TrackingErrorCode.INVALID_PREHASHED_USER_DATA]: 'info',
  // Kritikus: a tokenless böngésző-ág egyetlen visszamaradt kockázata a
  // konverzió-spam. Ha megtörténik, azonnal tudni akarunk róla (SMS is megy).
  [TrackingErrorCode.CONVERSION_SPIKE]: 'critical',
  [TrackingErrorCode.DEGRADED_RATE_LIMITED]: 'info',
  [TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE]: 'info',
  [TrackingErrorCode.MISSING_TURNSTILE_TOKEN]: 'info',
  [TrackingErrorCode.INVALID_TURNSTILE_TOKEN]: 'info',
  [TrackingErrorCode.TURNSTILE_API_UNAVAILABLE]: 'info',
  [TrackingErrorCode.TURNSTILE_SECRET_INVALID]: 'critical',

  [TrackingErrorCode.RESERVED_EVENT_NAME]: 'critical',
  [TrackingErrorCode.GA4_ONSITE_FANOUT]: 'critical',
  [TrackingErrorCode.BROWSER_SERVER_META_MISMATCH]: 'critical',
  [TrackingErrorCode.INVALID_SITE_CONFIG_SCHEMA]: 'critical',
  [TrackingErrorCode.MISSING_CONVERSION_ACTIONS_CONFIG]: 'warning',
  [TrackingErrorCode.UNKNOWN_EVENT_NAME]: 'info',
  [TrackingErrorCode.INVALID_LEAD_PROVENANCE]: 'info'
};

// ─────────────────────────────────────────────────────────────────────
// §15 — RETRYABILITY. A „mit tegyünk vele" osztályozás.
//
// A `severity` azt mondja meg, MENNYIRE fáj; a retryability azt, MI A TEENDŐ.
// A kettő független: egy `warning` súlyú 5xx magától elmúlik, egy ugyanolyan
// súlyú validációs hiba soha. E mező nélkül a retry-logika és a riasztás
// ugyanazt a döntést hozza mindkettőre — pontosan ez volt a Data Manager
// gyűjtőkód baja (TRK-840-003).
//
// A `Record<TrackingErrorCode, …>` SZÁNDÉKOSAN kimerítő: egy új kód addig nem
// fordul le, amíg valaki el nem dönti, hogy retryolható-e.
// ─────────────────────────────────────────────────────────────────────

export type Retryability =
  /** Átmeneti; egy későbbi próbálkozás sikerülhet (timeout, 5xx, rate limit). */
  | 'RETRYABLE'
  /** Végleges; ugyanez a payload sosem fog átmenni (validáció, rossz alak). */
  | 'TERMINAL'
  /** Szándékos kihagyás vagy tisztán informatív jel — nincs mit újrapróbálni. */
  | 'POLICY_SKIP'
  /** A mi konfigurációnk hiányzik/hibás (secret, KV-config, azonosító). */
  | 'CONFIG_BLOCKED'
  /** Emberi beavatkozás kell (újra-engedélyezés, allowlist, vizsgálat). */
  | 'OPERATOR_ACTION'
  /** Az eredmény ISMERETLEN. Nem „valószínűleg jó" — külön osztály. */
  | 'UNKNOWN';

export const ERROR_RETRYABILITY: Record<TrackingErrorCode, Retryability> = {
  // 000 — infrastruktúra. A Cloudflare-primitívek hibái átmenetiek.
  [TrackingErrorCode.UNHANDLED_EXCEPTION]: 'UNKNOWN',
  [TrackingErrorCode.KV_READ_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.KV_WRITE_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.R2_READ_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.R2_WRITE_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.DURABLE_OBJECT_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.LEDGER_WRITE_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.FANOUT_SETUP_FAILED]: 'TERMINAL',

  // 400 — a hívó hibája. Ugyanaz a payload újraküldve ugyanígy bukna.
  [TrackingErrorCode.INVALID_JSON]: 'TERMINAL',
  [TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE]: 'TERMINAL',
  // A Turnstile-sáv NYUGDÍJAZOTT (a gateway nem validál Turnstile-t). A kódok
  // megmaradnak, hogy a régi logok értelmezhetők legyenek — újat nem emittálunk.
  [TrackingErrorCode.MISSING_TURNSTILE_TOKEN]: 'TERMINAL',
  [TrackingErrorCode.INVALID_TURNSTILE_TOKEN]: 'TERMINAL',
  [TrackingErrorCode.TURNSTILE_API_UNAVAILABLE]: 'RETRYABLE',
  [TrackingErrorCode.DEGRADED_TOKENLESS_ACCEPTED]: 'POLICY_SKIP',
  [TrackingErrorCode.DEGRADED_RATE_LIMITED]: 'RETRYABLE',
  [TrackingErrorCode.TURNSTILE_SECRET_INVALID]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD]: 'TERMINAL',
  [TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.SERVER_INGRESS_ACCEPTED]: 'POLICY_SKIP',
  [TrackingErrorCode.ORIGIN_MISSING]: 'TERMINAL',
  [TrackingErrorCode.ORIGIN_NOT_ALLOWED]: 'TERMINAL',
  [TrackingErrorCode.BODY_TOO_LARGE]: 'TERMINAL',
  [TrackingErrorCode.CONVERSION_SPIKE]: 'OPERATOR_ACTION',
  [TrackingErrorCode.HIGH_VALUE_EVENT_BROWSER_REJECTED]: 'TERMINAL',
  [TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA]: 'TERMINAL',
  [TrackingErrorCode.INVALID_PREHASHED_USER_DATA]: 'TERMINAL',
  [TrackingErrorCode.ADMIN_UNAUTHORIZED]: 'OPERATOR_ACTION',
  // A megszakadt kérés-stream ≠ túl nagy body: a kliens újraküldheti.
  [TrackingErrorCode.REQUEST_BODY_READ_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING]: 'OPERATOR_ACTION',

  // 500 — a MI konfigurációnk. Retry sosem segít, deploy/KV-írás igen.
  [TrackingErrorCode.NO_SITE_CONFIG]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.MISSING_PIXEL_ID]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.MISSING_META_TOKEN]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.MISSING_GA4_CONFIG]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.MISSING_GADS_CONFIG]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.MISSING_CONVERSION_ACTION]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.INVALID_SITE_CONFIG_JSON]: 'CONFIG_BLOCKED',

  // 600 — Meta CAPI.
  [TrackingErrorCode.META_API_REJECTED]: 'TERMINAL',
  [TrackingErrorCode.META_API_TIMEOUT]: 'RETRYABLE',
  [TrackingErrorCode.META_API_NETWORK_ERROR]: 'RETRYABLE',
  [TrackingErrorCode.META_INVALID_ACCESS_TOKEN]: 'OPERATOR_ACTION',
  [TrackingErrorCode.META_PIXEL_NOT_FOUND]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.META_RATE_LIMITED]: 'RETRYABLE',
  [TrackingErrorCode.META_INVALID_USER_DATA]: 'TERMINAL',
  // 200 OK, de events_received: 0 — a Meta elnyelte. Újraküldve ugyanez lenne.
  [TrackingErrorCode.META_EVENTS_RECEIVED_ZERO]: 'TERMINAL',
  [TrackingErrorCode.META_KV_TEST_EVENT_CODE]: 'CONFIG_BLOCKED',

  // 700 — GA4 MP (legacy/diagnosztika; a szerver nem küld on-site GA4-et).
  [TrackingErrorCode.GA4_API_TIMEOUT]: 'RETRYABLE',
  [TrackingErrorCode.GA4_API_NETWORK_ERROR]: 'RETRYABLE',
  [TrackingErrorCode.GA4_VALIDATION_FAILURE]: 'TERMINAL',
  [TrackingErrorCode.GA4_INVALID_MEASUREMENT_ID]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.GA4_INVALID_API_SECRET]: 'CONFIG_BLOCKED',

  // 800 — Google Ads / OAuth.
  // A 001 és a 006 MARADÉK-gyűjtő: a konkrét okokat a 011-016 vitte el, tehát
  // ami még ide esik, az definíció szerint ismeretlen.
  [TrackingErrorCode.GADS_NO_ACCESS_TOKEN]: 'UNKNOWN',
  [TrackingErrorCode.GADS_API_TIMEOUT]: 'RETRYABLE',
  [TrackingErrorCode.GADS_API_NETWORK_ERROR]: 'RETRYABLE',
  [TrackingErrorCode.GADS_PARTIAL_FAILURE]: 'TERMINAL',
  [TrackingErrorCode.GADS_AUTH_REJECTED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED]: 'UNKNOWN',
  [TrackingErrorCode.GADS_DEVELOPER_TOKEN_INVALID]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.GADS_INVALID_CONVERSION_ACTION]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.GADS_NO_REFRESH_TOKEN]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GADS_RATE_LIMITED]: 'RETRYABLE',
  [TrackingErrorCode.GADS_OAUTH_CLIENT_ID_MISSING]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.GADS_OAUTH_CLIENT_SECRET_MISSING]: 'CONFIG_BLOCKED',
  // Visszavont hozzájárulás: SEM a várakozás, SEM a retry nem oldja meg.
  [TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GADS_OAUTH_HTTP_ERROR]: 'RETRYABLE',
  [TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE]: 'RETRYABLE',
  [TrackingErrorCode.GADS_OAUTH_TIMEOUT]: 'RETRYABLE',

  // 810/820/830 — klikk-ID forwarderek.
  [TrackingErrorCode.MSADS_DISPATCH_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.MSADS_API_TIMEOUT]: 'RETRYABLE',
  [TrackingErrorCode.TIKTOK_DISPATCH_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.TIKTOK_API_TIMEOUT]: 'RETRYABLE',
  [TrackingErrorCode.LINKEDIN_DISPATCH_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.LINKEDIN_API_TIMEOUT]: 'RETRYABLE',

  // 840 — Google Data Manager (a jelenlegi Google money-path).
  [TrackingErrorCode.DATAMANAGER_API_TIMEOUT]: 'RETRYABLE',
  [TrackingErrorCode.DATAMANAGER_API_NETWORK_ERROR]: 'RETRYABLE',
  // Maradék-gyűjtő a 009-014 bevezetése után.
  [TrackingErrorCode.DATAMANAGER_API_REJECTED]: 'UNKNOWN',
  // 401: a token lejárt — a következő refresh megoldja.
  [TrackingErrorCode.DATAMANAGER_AUTH_REJECTED]: 'RETRYABLE',
  [TrackingErrorCode.DATAMANAGER_RATE_LIMITED]: 'RETRYABLE',
  [TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS]: 'POLICY_SKIP',
  [TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY]: 'POLICY_SKIP',
  [TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED]: 'TERMINAL',
  [TrackingErrorCode.DATAMANAGER_SERVER_ERROR]: 'RETRYABLE',
  // Az ÁLLAPOT ismeretlen, a TEENDŐ viszont egyértelmű: próbáljuk újra —
  // ismeretlen állapotból nem könyvelünk konverziót.
  [TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE]: 'RETRYABLE',
  [TrackingErrorCode.DATAMANAGER_INVALID_CLICK_ID]: 'POLICY_SKIP',
  [TrackingErrorCode.DATAMANAGER_RESPONSE_NO_REQUEST_ID]: 'POLICY_SKIP',

  // 900 — DLQ / retry / platform-blokkok.
  [TrackingErrorCode.DLQ_WRITE_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.DLQ_LIST_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.DLQ_DELETE_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.CRON_RETRY_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.MAX_RETRIES_EXCEEDED]: 'TERMINAL',
  [TrackingErrorCode.DLQ_CORRUPT_RECORD]: 'TERMINAL',
  // A vendor bukott ÉS a retry-rekordot sehova nem sikerült letenni — az event
  // elveszhet. Ez nem „majd újra": embernek kell ránéznie.
  [TrackingErrorCode.RETRY_PERSIST_FAILED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.PLATFORM_NOT_CONFIGURED]: 'POLICY_SKIP',
  [TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID]: 'CONFIG_BLOCKED',

  // 910 — consent-diagnosztika.
  [TrackingErrorCode.CONSENT_MISSING]: 'POLICY_SKIP',
  [TrackingErrorCode.CONSENT_UNPARSEABLE]: 'TERMINAL',
  [TrackingErrorCode.CONSENT_SOURCE_MISMATCH]: 'OPERATOR_ACTION',
  [TrackingErrorCode.CONSENT_EXPIRED]: 'POLICY_SKIP',
  [TrackingErrorCode.CONSENT_SIGNALS_INCONSISTENT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.CONSENT_CLIENT_LIB_OUTDATED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.CONSENT_CROSS_CHECK_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.CONSENT_GRANTED_BUT_SKIPPED]: 'OPERATOR_ACTION',

  // 950 — reconciliation. A findingek definíció szerint emberi döntést kérnek;
  // a „query failed" ágak viszont átmenetiek.
  [TrackingErrorCode.RECON_VENDOR_FAILURE_RATE]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_COVERAGE_DRIFT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_QUERY_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_CROSS_PLATFORM_DRIFT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_CROSS_QUERY_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.EMQ_BELOW_THRESHOLD]: 'OPERATOR_ACTION',
  [TrackingErrorCode.EMQ_QUERY_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.EMQ_COVERAGE_DROP]: 'OPERATOR_ACTION',
  [TrackingErrorCode.SITE_CONFIG_DRIFT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_CROSS_CHECK_NOT_RUNNING]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.RECON_OFFLINE_ZERO_DELIVERY]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_OFFLINE_COVERAGE_DRIFT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_OFFLINE_VENDOR_FAILURE]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_OFFLINE_BLOCKED]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.RECON_BUSINESS_SOURCE_DRIFT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_BUSINESS_SOURCE_MISSING]: 'OPERATOR_ACTION',
  [TrackingErrorCode.RECON_CONFIG_ENUMERATION_INCOMPLETE]: 'RETRYABLE',
  [TrackingErrorCode.ALERT_EMAIL_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.ALERT_SMS_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.SMOKE_LEAD_CHECK_FAILED]: 'OPERATOR_ACTION',
  // A GTM-elteresek MIND emberi beavatkozast kernek: a kontener kezzel
  // szerkesztheto, retry nem javitja.
  [TrackingErrorCode.GTM_TAG_MISSING]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_TAG_PAUSED]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_TRIGGER_MISSING]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_EVENT_NAME_MISMATCH]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_CONVERSION_LABEL_MISMATCH]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_EC_USER_DATA_VARIABLE_MISSING]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_UNKNOWN_CONVERSION_TAG]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_LEGACY_TRIGGER_ACTIVE]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_UNSUPPORTED_CUSTOM_HTML]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_CONTAINER_MISMATCH]: 'OPERATOR_ACTION',
  [TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE]: 'RETRYABLE',

  // 960 — retention.
  [TrackingErrorCode.RETENTION_QUERY_FAILED]: 'RETRYABLE',
  [TrackingErrorCode.RETENTION_R2_FAILED]: 'RETRYABLE',

  // Build-time / kontraktus-őrök. Ezek NEM futásidejű kézbesítési hibák: a CI
  // bukik el tőlük, tehát a „teendő" mindig emberi.
  [TrackingErrorCode.UNKNOWN_EVENT_NAME]: 'TERMINAL',
  [TrackingErrorCode.RESERVED_EVENT_NAME]: 'TERMINAL',
  [TrackingErrorCode.GA4_ONSITE_FANOUT]: 'OPERATOR_ACTION',
  [TrackingErrorCode.BROWSER_SERVER_META_MISMATCH]: 'OPERATOR_ACTION',
  [TrackingErrorCode.INVALID_LEAD_PROVENANCE]: 'TERMINAL',
  [TrackingErrorCode.INVALID_SITE_CONFIG_SCHEMA]: 'CONFIG_BLOCKED',
  [TrackingErrorCode.MISSING_CONVERSION_ACTIONS_CONFIG]: 'CONFIG_BLOCKED'
};

/**
 * Névtér → komponens. A kód ELEJE mondja meg, melyik rétegben keletkezett;
 * ezt a fleet-nézet és a riasztás-útválasztás használja.
 */
export const ERROR_COMPONENTS: Record<string, string> = {
  'TRK-000': 'worker-infra',
  'TRK-400': 'ingress',
  'TRK-500': 'site-config',
  'TRK-600': 'meta-capi',
  'TRK-700': 'ga4-mp-legacy',
  'TRK-800': 'google-ads-oauth',
  'TRK-810': 'microsoft-ads',
  'TRK-820': 'tiktok',
  'TRK-830': 'linkedin',
  'TRK-840': 'google-data-manager',
  'TRK-900': 'dlq-retry',
  'TRK-910': 'consent',
  'TRK-850': 'gtm-conformance',
  'TRK-950': 'reconciliation',
  'TRK-960': 'retention',
  'TRK-EVT': 'event-contract',
  'TRK-GA4': 'event-contract',
  'TRK-META': 'event-contract',
  'TRK-PROV': 'lead-provenance',
  'TRK-CFG': 'site-config'
};

export function componentForCode(code: string): string {
  const prefix = code.split('-').slice(0, 2).join('-');
  return ERROR_COMPONENTS[prefix] ?? 'unknown';
}

/**
 * Riasztási politika a súlyból. Egyetlen helyen, hogy a napi digest, az SMS-
 * kapu és a fleet-nézet ne fejthesse meg külön-külön.
 */
export function alertPolicyForCode(code: TrackingErrorCode): string {
  switch (ERROR_SEVERITY[code]) {
    case 'critical':
      return 'immediate: critical alert + daily digest';
    case 'warning':
      return 'daily digest';
    default:
      return 'log only';
  }
}

/**
 * Egy kód TELJES rekordja (§15). A generált katalógus és a fleet-nézet ebből
 * dolgozik — nincs második, kézzel karbantartott igazságforrás.
 */
export interface ErrorCodeRecord {
  code: TrackingErrorCode;
  symbolic_name: string;
  severity: ErrorSeverity;
  component: string;
  retryability: Retryability;
  /** A végfelhasználónak SOHA nem mutatunk belső kódot vagy vendor-üzenetet. */
  user_safe_message: string;
  operator_message: string;
  alert_policy: string;
}

const SYMBOL_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(TrackingErrorCode).map(([symbol, code]) => [code as string, symbol])
);

/** Minden kód, a deklarálás sorrendjében. */
export function allErrorCodes(): TrackingErrorCode[] {
  return Object.values(TrackingErrorCode) as TrackingErrorCode[];
}

export function errorCodeRecord(code: TrackingErrorCode): ErrorCodeRecord {
  return {
    code,
    symbolic_name: SYMBOL_BY_CODE[code] ?? 'UNKNOWN_SYMBOL',
    severity: ERROR_SEVERITY[code],
    component: componentForCode(code),
    retryability: ERROR_RETRYABILITY[code],
    // Egyetlen, szándékosan tartalmatlan felhasználói üzenet: a tracking-hiba
    // nem a látogató ügye, és a belső kód kiszivárogtatása információt adna.
    user_safe_message: 'Something went wrong on our side. Your request was not affected.',
    operator_message: ERROR_DESCRIPTIONS[code],
    alert_policy: alertPolicyForCode(code)
  };
}
