> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: README.md + CLAUDE.md + docs/HANDOVER-run6.md (a kanonikus élő állapot)
>
> Ez egy TERVEZÉSI/SPRINT-dokumentum a Run 1–6 építési fázisból. A benne leírt
> premisszák egy része AZÓTA MEGDŐLT (pl. Turnstile-before-everything, quote-state
> Durable Object, offline GA4 — mind törölve; lásd CLAUDE.md Rule 10/17). NE
> implementálj ez alapján; a jelenlegi valóság a fenti kanonikus fájlokban van.
> ---

# Sprint 7 — Google Ads Conversion Upload

**Cél:** A Worker enhanced conversions-t küld a Google Ads Conversion Upload Service-nek, hashed user data-val.

**Idő Claude Code-dal:** 3-4 óra. **Feltétel: jóváhagyott Google Ads developer token.**

## Mielőtt nekiállsz

### 1. Developer token wrangler secret-be

```bash
wrangler secret put GADS_DEVELOPER_TOKEN
```

### 2. Painless 6 conversion action ID

Painless Google Ads → Goals → Conversions → minden action → "Tag setup" fülön a `send_to: AW-XXX/<ACTION_ID>` második része.

### 3. KV config frissítés

```bash
wrangler kv:key put --binding=SITE_CONFIG "painlessremovals.com" '{
  "site_id": "painless",
  "country_code": "GB",
  "currency": "GBP",
  "meta": { "pixel_id": "...", "access_token": "...", "test_event_code": "TEST_PAINLESS" },
  "ga4": { "measurement_id": "...", "api_secret": "..." },
  "gads": {
    "customer_id": "1234567890",
    "login_customer_id": null,
    "conversion_actions": {
      "quote_calculator_conversion": "AbCdEf123456",
      "callback_conversion": "GhIjKl789012",
      "contact_form_submit": "MnOpQr345678",
      "phone_conversion": "StUvWx901234",
      "email_conversion": "YzAbCd567890",
      "whatsapp_conversion": "EfGhIj123456"
    }
  }
}'
```

Ha Painless **MCC alatt van**: `login_customer_id` legyen az MCC ID. Ha közvetlen account: hagyd `null`-on.

## Google Ads API specifikációk

- Endpoint: `POST https://googleads.googleapis.com/v24/customers/{customer_id}:uploadClickConversions`
- Headers: `Authorization: Bearer <token>`, `developer-token: <token>`, `login-customer-id: <mcc_id>` (csak ha MCC), `Content-Type: application/json`
- `conversionDateTime`: `YYYY-MM-DD HH:MM:SS+00:00` (NEM ISO 8601 T separator)
- `orderId` = mi `event_id`-nk, max 64 char
- `userIdentifiers`: `hashedEmail`, `hashedPhoneNumber`, `addressInfo`
- `addressInfo`: `hashedFirstName`, `hashedLastName` HASHED; `city`, `state`, `postalCode`, `countryCode` PLAIN
- Customer ID dashe nélkül

## Új fájl: `src/lib/gads.ts`

```typescript
import type { Env } from '../env';
import type { SiteConfig } from './config';
import type { HashedUserData } from './hash';
import { getAccessToken } from './gads-oauth';
import { logStructured } from '../types';

const GADS_API_VERSION = 'v24';
const GADS_API_TIMEOUT_MS = 5000;

export interface GAdsPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  value?: number;
  currency?: string;
  city?: string;
  postal_code?: string;
}

export interface GAdsResult {
  success: boolean;
  conversions_processed?: number;
  partial_failure_error?: string;
  error?: string;
  status?: number;
}

export async function sendToGoogleAdsCAPI(
  siteConfig: SiteConfig,
  env: Env,
  payload: GAdsPayload,
  hashedUserData: HashedUserData
): Promise<GAdsResult> {
  const startedAt = Date.now();

  const conversionActionId = siteConfig.gads.conversion_actions?.[payload.event_name];
  if (!conversionActionId) {
    logStructured({
      level: 'warn',
      message: 'No Google Ads conversion action configured for event',
      site_id: siteConfig.site_id,
      event_name: payload.event_name
    });
    return { success: false, error: 'No conversion action configured' };
  }

  const accessToken = await getAccessToken(siteConfig.gads.customer_id, env);
  if (!accessToken) {
    return { success: false, error: 'No access token available' };
  }

  const dt = new Date(payload.event_time * 1000);
  const conversionDateTime = formatGAdsDateTime(dt);

  const userIdentifiers: Record<string, unknown>[] = [];
  if (hashedUserData.em) userIdentifiers.push({ hashedEmail: hashedUserData.em });
  if (hashedUserData.ph) userIdentifiers.push({ hashedPhoneNumber: hashedUserData.ph });

  if (hashedUserData.fn || hashedUserData.ln) {
    const addressInfo: Record<string, unknown> = {};
    if (hashedUserData.fn) addressInfo.hashedFirstName = hashedUserData.fn;
    if (hashedUserData.ln) addressInfo.hashedLastName = hashedUserData.ln;
    if (payload.city) addressInfo.city = payload.city;
    if (payload.postal_code) addressInfo.postalCode = payload.postal_code;
    addressInfo.countryCode = siteConfig.country_code;
    userIdentifiers.push({ addressInfo });
  }

  const conversion: Record<string, unknown> = {
    conversionAction: `customers/${siteConfig.gads.customer_id}/conversionActions/${conversionActionId}`,
    conversionDateTime,
    orderId: payload.event_id.slice(0, 64)
  };
  if (typeof payload.value === 'number') conversion.conversionValue = payload.value;
  if (payload.currency) conversion.currencyCode = payload.currency;
  if (userIdentifiers.length > 0) conversion.userIdentifiers = userIdentifiers;

  const body = {
    conversions: [conversion],
    partialFailure: true
  };

  const headers: HeadersInit = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': env.GADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json'
  };
  if (siteConfig.gads.login_customer_id) {
    headers['login-customer-id'] = siteConfig.gads.login_customer_id;
  }

  const url = `https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${siteConfig.gads.customer_id}:uploadClickConversions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GADS_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const responseBody = await response.json() as {
      results?: unknown[];
      partialFailureError?: { code?: number; message?: string };
      error?: { code?: number; message?: string; details?: unknown[] };
    };

    if (!response.ok || responseBody.error) {
      logStructured({
        level: 'error',
        message: 'Google Ads API rejected request',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        gads_error: responseBody.error?.message || `HTTP ${response.status}`,
        gads_error_code: responseBody.error?.code,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error: responseBody.error?.message || `HTTP ${response.status}`,
        status: response.status
      };
    }

    if (responseBody.partialFailureError) {
      logStructured({
        level: 'warn',
        message: 'Google Ads partial failure',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        partial_error: responseBody.partialFailureError.message,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        partial_failure_error: responseBody.partialFailureError.message,
        status: response.status
      };
    }

    logStructured({
      level: 'info',
      message: 'Google Ads conversion uploaded',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      conversions_processed: responseBody.results?.length || 0,
      ec_identifiers_provided: userIdentifiers.length,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: true,
      conversions_processed: responseBody.results?.length || 0,
      status: response.status
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logStructured({
      level: 'error',
      message: isTimeout ? 'Google Ads timeout' : 'Google Ads network error',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: errMsg,
      duration_ms: Date.now() - startedAt
    });
    return { success: false, error: isTimeout ? 'timeout' : errMsg };
  }
}

function formatGAdsDateTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}+00:00`;
}
```

## Módosítandó fájl: `src/env.ts`

```typescript
export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;
  DEAD_LETTER: R2Bucket;

  TURNSTILE_SECRET_KEY: string;
  GADS_OAUTH_CLIENT_ID: string;
  GADS_OAUTH_CLIENT_SECRET: string;
  GADS_DEVELOPER_TOKEN: string;
}
```

## Módosítandó fájl: `src/routes/conversion.ts` — 3-way fan-out

```typescript
import { sendToGoogleAdsCAPI } from '../lib/gads';

// A Sprint 5 fan-out helyett:

const fanout = Promise.allSettled([
  sendToMetaCAPI(siteConfig, { /* ... */ }, hashedUserData),
  sendToGA4MP(siteConfig, { /* ... */ }),
  sendToGoogleAdsCAPI(
    siteConfig,
    env,
    {
      event_name: payload.event_name,
      event_id: payload.event_id,
      event_time: payload.event_time,
      value: payload.value,
      currency: payload.currency,
      city: payload.user_data?.city,
      postal_code: payload.user_data?.postal_code
    },
    hashedUserData
  )
]).then(results => {
  const [metaResult, ga4Result, gadsResult] = results;
  logStructured({
    level: 'info',
    message: 'Fan-out completed',
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
    ga4_success: ga4Result.status === 'fulfilled' && ga4Result.value.success,
    gads_success: gadsResult.status === 'fulfilled' && gadsResult.value.success
  });
});

ctx.waitUntil(fanout);
```

## Manuális tesztelés

```bash
curl -X POST https://painlessremovals.com/api/event/conversion \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "callback_conversion",
    "event_id": "gads-test-001",
    "event_time": '$(date +%s)',
    "turnstile_token": "VALID_TOKEN",
    "client_id": "1234567890.1714400000",
    "value": 380, "currency": "GBP", "service": "removal",
    "user_data": {
      "email": "test@example.com", "phone_number": "07123456789",
      "first_name": "Test", "last_name": "User",
      "city": "Bristol", "postal_code": "BS1 1AA", "country": "GB"
    },
    "fbp": "fb.1.1714400000.123456789",
    "event_source_url": "https://painlessremovals.com/quote"
  }'
```

Várt logok:
- `"Meta CAPI event sent" events_received: 1`
- `"GA4 MP event sent"`
- `"Google Ads conversion uploaded" conversions_processed: 1, ec_identifiers_provided: 3`

24-48 óra múlva Google Ads → Goals → Conversions → "Callback Request" → Diagnostics: "Recording" státusz.

## Sprint 7 utáni státusz

- ✅ Google Ads Conversion Upload működik
- ✅ Hashed user data EC match-hez
- ✅ City/postal plain átadás
- ✅ OAuth token cache + auto-refresh
- ✅ Partial failure handling
- ✅ 3-way fan-out
- ❌ Dead letter queue: Sprint 8

## Mit KÉRDEZZ a usertől

1. Painless 6 conversion action ID feltöltve KV-be?
2. Test conversion megérkezett Google Ads Diagnostics-ban (24-48 óra)?
3. Workers logs: `gads_success: true`?
