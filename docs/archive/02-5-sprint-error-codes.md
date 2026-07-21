> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: README.md + CLAUDE.md + docs/HANDOVER-run6.md (a kanonikus élő állapot)
>
> Ez egy TERVEZÉSI/SPRINT-dokumentum a Run 1–6 építési fázisból. A benne leírt
> premisszák egy része AZÓTA MEGDŐLT (pl. Turnstile-before-everything, quote-state
> Durable Object, offline GA4 — mind törölve; lásd CLAUDE.md Rule 10/17). NE
> implementálj ez alapján; a jelenlegi valóság a fenti kanonikus fájlokban van.
> ---

# Sprint 2.5 — Error code taxonómia

**Cél:** Strukturált error code rendszer minden Worker hibára. Minden log, alert, és customer-facing hibajelzés egységes kódot használ.

**Idő Claude Code-dal:** 2 óra. **Cross-cutting**: minden későbbi sprint (3-10) használja ezeket az error code-okat.

## Új fájl: `src/lib/error-codes.ts`

```typescript
/**
 * Tracking Worker error code taxonomy.
 * Format: TRK-{category}-{number}
 * Categories:
 * - 000: Internal errors
 * - 400: Client validation errors
 * - 500: Configuration errors
 * - 600: Meta CAPI specific
 * - 700: GA4 MP specific
 * - 800: Google Ads specific
 * - 900: DLQ + Cron specific
 */

export enum TrackingErrorCode {
  // Internal (000-099)
  UNHANDLED_EXCEPTION = 'TRK-000-001',
  KV_READ_FAILED = 'TRK-000-002',
  KV_WRITE_FAILED = 'TRK-000-003',
  R2_READ_FAILED = 'TRK-000-004',
  R2_WRITE_FAILED = 'TRK-000-005',
  DURABLE_OBJECT_FAILED = 'TRK-000-006',

  // Client validation (400-499)
  INVALID_JSON = 'TRK-400-001',
  INVALID_PAYLOAD_STRUCTURE = 'TRK-400-002',
  MISSING_TURNSTILE_TOKEN = 'TRK-400-003',
  INVALID_TURNSTILE_TOKEN = 'TRK-400-004',
  TURNSTILE_API_UNAVAILABLE = 'TRK-400-005',

  // Configuration (500-599)
  NO_SITE_CONFIG = 'TRK-500-001',
  MISSING_PIXEL_ID = 'TRK-500-002',
  MISSING_META_TOKEN = 'TRK-500-003',
  MISSING_GA4_CONFIG = 'TRK-500-004',
  MISSING_GADS_CONFIG = 'TRK-500-005',
  MISSING_CONVERSION_ACTION = 'TRK-500-006',
  INVALID_SITE_CONFIG_JSON = 'TRK-500-007',

  // Meta CAPI (600-699)
  META_API_REJECTED = 'TRK-600-001',
  META_API_TIMEOUT = 'TRK-600-002',
  META_API_NETWORK_ERROR = 'TRK-600-003',
  META_INVALID_ACCESS_TOKEN = 'TRK-600-004',
  META_PIXEL_NOT_FOUND = 'TRK-600-005',
  META_RATE_LIMITED = 'TRK-600-006',
  META_INVALID_USER_DATA = 'TRK-600-007',
  META_EVENTS_RECEIVED_ZERO = 'TRK-600-008',

  // GA4 MP (700-799)
  GA4_API_TIMEOUT = 'TRK-700-001',
  GA4_API_NETWORK_ERROR = 'TRK-700-002',
  GA4_VALIDATION_FAILURE = 'TRK-700-003',
  GA4_INVALID_MEASUREMENT_ID = 'TRK-700-004',
  GA4_INVALID_API_SECRET = 'TRK-700-005',

  // Google Ads (800-899)
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

  // DLQ + Cron (900-999)
  DLQ_WRITE_FAILED = 'TRK-900-001',
  DLQ_LIST_FAILED = 'TRK-900-002',
  DLQ_DELETE_FAILED = 'TRK-900-003',
  CRON_RETRY_FAILED = 'TRK-900-004',
  MAX_RETRIES_EXCEEDED = 'TRK-900-005',
  DLQ_CORRUPT_RECORD = 'TRK-900-006'
}

export const ERROR_DESCRIPTIONS: Record<TrackingErrorCode, string> = {
  [TrackingErrorCode.UNHANDLED_EXCEPTION]: 'Unhandled exception in Worker fetch handler',
  [TrackingErrorCode.KV_READ_FAILED]: 'KV namespace read operation failed',
  [TrackingErrorCode.KV_WRITE_FAILED]: 'KV namespace write operation failed',
  [TrackingErrorCode.R2_READ_FAILED]: 'R2 bucket read operation failed',
  [TrackingErrorCode.R2_WRITE_FAILED]: 'R2 bucket write operation failed',
  [TrackingErrorCode.DURABLE_OBJECT_FAILED]: 'Durable Object operation failed',
  [TrackingErrorCode.INVALID_JSON]: 'Request body is not valid JSON',
  [TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE]: 'Payload missing required fields',
  [TrackingErrorCode.MISSING_TURNSTILE_TOKEN]: 'Turnstile token absent from payload',
  [TrackingErrorCode.INVALID_TURNSTILE_TOKEN]: 'Turnstile validation API rejected token',
  [TrackingErrorCode.TURNSTILE_API_UNAVAILABLE]: 'Turnstile validation API returned non-2xx',
  [TrackingErrorCode.NO_SITE_CONFIG]: 'No KV config exists for the request hostname',
  [TrackingErrorCode.MISSING_PIXEL_ID]: 'Site config has no Meta pixel_id',
  [TrackingErrorCode.MISSING_META_TOKEN]: 'Site config has no Meta access_token',
  [TrackingErrorCode.MISSING_GA4_CONFIG]: 'Site config has no GA4 measurement_id or api_secret',
  [TrackingErrorCode.MISSING_GADS_CONFIG]: 'Site config has no Google Ads customer_id',
  [TrackingErrorCode.MISSING_CONVERSION_ACTION]: 'Site config missing conversion_action for this event_name',
  [TrackingErrorCode.INVALID_SITE_CONFIG_JSON]: 'Site config in KV is not valid JSON',
  [TrackingErrorCode.META_API_REJECTED]: 'Meta Graph API returned non-200 with error response',
  [TrackingErrorCode.META_API_TIMEOUT]: 'Meta Graph API call exceeded 5s timeout',
  [TrackingErrorCode.META_API_NETWORK_ERROR]: 'Network error reaching Meta Graph API',
  [TrackingErrorCode.META_INVALID_ACCESS_TOKEN]: 'Meta access token rejected (expired or revoked)',
  [TrackingErrorCode.META_PIXEL_NOT_FOUND]: 'Meta pixel_id does not exist or no access',
  [TrackingErrorCode.META_RATE_LIMITED]: 'Meta API rate limit exceeded',
  [TrackingErrorCode.META_INVALID_USER_DATA]: 'Meta rejected user_data format (hash or normalization)',
  [TrackingErrorCode.META_EVENTS_RECEIVED_ZERO]: 'Meta returned 200 OK but events_received: 0',
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
  [TrackingErrorCode.DLQ_WRITE_FAILED]: 'Failed to write event to R2 dead letter queue',
  [TrackingErrorCode.DLQ_LIST_FAILED]: 'Failed to list pending DLQ records',
  [TrackingErrorCode.DLQ_DELETE_FAILED]: 'Failed to delete DLQ record after successful retry',
  [TrackingErrorCode.CRON_RETRY_FAILED]: 'Cron retry handler encountered unhandled error',
  [TrackingErrorCode.MAX_RETRIES_EXCEEDED]: 'DLQ record reached max retry count',
  [TrackingErrorCode.DLQ_CORRUPT_RECORD]: 'DLQ record JSON is malformed'
};

export const ERROR_SEVERITY: Record<TrackingErrorCode, 'critical' | 'warning' | 'info'> = {
  [TrackingErrorCode.UNHANDLED_EXCEPTION]: 'critical',
  [TrackingErrorCode.META_INVALID_ACCESS_TOKEN]: 'critical',
  [TrackingErrorCode.GADS_AUTH_REJECTED]: 'critical',
  [TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED]: 'critical',
  [TrackingErrorCode.GADS_NO_REFRESH_TOKEN]: 'critical',
  [TrackingErrorCode.DLQ_WRITE_FAILED]: 'critical',
  [TrackingErrorCode.GADS_DEVELOPER_TOKEN_INVALID]: 'critical',

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
  [TrackingErrorCode.MAX_RETRIES_EXCEEDED]: 'warning',
  [TrackingErrorCode.NO_SITE_CONFIG]: 'warning',
  [TrackingErrorCode.MISSING_CONVERSION_ACTION]: 'warning',
  [TrackingErrorCode.META_EVENTS_RECEIVED_ZERO]: 'warning',
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

  [TrackingErrorCode.INVALID_JSON]: 'info',
  [TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE]: 'info',
  [TrackingErrorCode.MISSING_TURNSTILE_TOKEN]: 'info',
  [TrackingErrorCode.INVALID_TURNSTILE_TOKEN]: 'info',
  [TrackingErrorCode.TURNSTILE_API_UNAVAILABLE]: 'info'
};
```

## Módosítandó fájl: `src/types.ts`

```typescript
import type { TrackingErrorCode } from './lib/error-codes';

export type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  message: string;
  error_code?: TrackingErrorCode | string;
  hostname?: string;
  event_name?: string;
  site_id?: string;
  duration_ms?: number;
  error?: string;
  status?: number;
  [key: string]: unknown;
};
```

## Módosítandó fájlok a meglévő sprintekben

Minden meglévő `logStructured` hívást frissíts `error_code`-dal. Példák:

```typescript
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';

// Régi:
logStructured({ level: 'warn', message: 'Invalid JSON', hostname });

// Új:
logStructured({
  level: 'info',
  error_code: TrackingErrorCode.INVALID_JSON,
  message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_JSON],
  hostname
});
```

## Új fájl: `docs/error-codes.md` (runbook)

Minden error code-hoz dokumentáció:

```md
## TRK-600-004 — Meta Invalid Access Token
**Severity**: Critical
**Description**: Meta access token rejected (expired or revoked)
**Action**:
1. Check Meta Business Manager → Painless Pixel → Settings → Conversions API
2. If "Access token revoked", regenerate System User token
3. Update KV: `wrangler kv:key put --binding=SITE_CONFIG ...`
4. No retry needed — DLQ records will succeed on next cron run
**Common causes**: System User permissions changed, MFA reset, password changed

## TRK-800-006 — Google Ads OAuth Refresh Failed
**Severity**: Critical
**Description**: OAuth refresh token exchange failed
**Action**:
1. Test: `curl '/api/event/oauth-debug?customer_id=...'`
2. If `access_token_received: false`, the refresh token is revoked
3. Run OAuth flow again from browser
4. New refresh token will be saved to KV
5. DLQ records will succeed on next cron run
**Common causes**: Customer revoked access, password changed, account closed
```

(Minden error code-ra hasonló dokumentáció, ahogy production-ben találkozol velük.)

## Sprint 2.5 utáni státusz

- ✅ Strukturált error code taxonómia
- ✅ Severity classification
- ✅ Runbook docs/error-codes.md
- ✅ Meglévő logStructured hívások frissítve
- ✅ Minden új sprint (3-10) használja az error code-okat

## Mit KÉRDEZZ a usertől

Semmit. Sprint 2.5 független a user-feedback-től.
