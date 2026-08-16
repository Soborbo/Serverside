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
  [TrackingErrorCode.DATAMANAGER_API_TIMEOUT]: 'Data Manager API call exceeded 5s timeout',
  [TrackingErrorCode.DATAMANAGER_API_NETWORK_ERROR]: 'Network error reaching Data Manager API',
  [TrackingErrorCode.DATAMANAGER_API_REJECTED]: 'Data Manager API returned non-2xx with error response',
  [TrackingErrorCode.DATAMANAGER_AUTH_REJECTED]: 'Data Manager API rejected authentication (401)',
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
  [TrackingErrorCode.FANOUT_SETUP_FAILED]: 'critical',

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

  [TrackingErrorCode.INVALID_JSON]: 'info',
  [TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD]: 'info',
  [TrackingErrorCode.DEGRADED_TOKENLESS_ACCEPTED]: 'info',
  [TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED]: 'warning',
  [TrackingErrorCode.SERVER_INGRESS_ACCEPTED]: 'info',
  [TrackingErrorCode.ORIGIN_MISSING]: 'info',
  [TrackingErrorCode.ORIGIN_NOT_ALLOWED]: 'warning',
  [TrackingErrorCode.BODY_TOO_LARGE]: 'info',
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
