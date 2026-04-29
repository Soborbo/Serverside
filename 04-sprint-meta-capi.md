# Sprint 4 — Meta CAPI integration

**Cél:** A Worker tényleges Meta `Lead` és `Contact` event-eket küld a Meta Graph API-nak, dedup-olhatóan a kliensoldali Pixel-lel.

**Idő Claude Code-dal:** 4-6 óra. **Az első sprint, ami valós API-t hív.**

## Mielőtt nekiállsz

### 1. Painless Pixel ID + System User Access Token

Meta Business Manager → Events Manager → Painless Pixel:
- **Pixel ID** (16-jegyű szám a bal felső sarokban)
- **CAPI Access Token**: KÖTELEZŐEN System User token, NEM személyes user token

System User létrehozása:
1. Business Manager → Business Settings → Users → System Users → Add
2. Név: `Soborbo Tracking System User`, Role: `Admin`
3. System User → Add Assets → Pixels → Painless Pixel → Full Control
4. System User → Generate New Token → Pixel ID kiválaszt → Permissions: `ads_management`, `business_management` → Generate

Mentsd a token-t.

### 2. Painless KV config frissítése

```bash
wrangler kv:key put --binding=SITE_CONFIG "painlessremovals.com" '{
  "site_id": "painless",
  "country_code": "GB",
  "currency": "GBP",
  "meta": {
    "pixel_id": "1234567890123456",
    "access_token": "EAAxxxxxx_VALOS_TOKEN_xxxxxxx",
    "test_event_code": "TEST_PAINLESS"
  },
  "ga4": {
    "measurement_id": "PLACEHOLDER",
    "api_secret": "PLACEHOLDER"
  },
  "gads": {
    "customer_id": "PLACEHOLDER",
    "login_customer_id": null,
    "conversion_actions": {}
  }
}'
```

A `test_event_code: "TEST_PAINLESS"` biztosítja, hogy a test event-ek NE kerüljenek a fő Meta stream-be a Sprint 4 alatt.

## Új fájl: `src/lib/meta.ts`

```typescript
import type { SiteConfig } from './config';
import type { HashedUserData } from './hash';
import { logStructured } from '../types';

const META_API_VERSION = 'v25.0';
const META_API_TIMEOUT_MS = 5000;

export interface MetaCAPIPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  value?: number;
  currency?: string;
  source?: string;
  event_source_url?: string;
  fbp?: string;
  fbc?: string;
  client_ip?: string;
  client_user_agent?: string;
}

const EVENT_NAME_MAP: Record<string, string> = {
  quote_calculator_conversion: 'Lead',
  callback_conversion: 'Lead',
  contact_form_submit: 'Contact',
  phone_conversion: 'Contact',
  email_conversion: 'Contact',
  whatsapp_conversion: 'Contact',
  quote_calculator_first_view: 'ViewContent',
  video_play: 'ViewContent'
};

function mapEventName(internalName: string): string {
  return EVENT_NAME_MAP[internalName] || internalName;
}

export interface MetaCAPIResult {
  success: boolean;
  events_received?: number;
  fbtrace_id?: string;
  error?: string;
  status?: number;
}

export async function sendToMetaCAPI(
  siteConfig: SiteConfig,
  payload: MetaCAPIPayload,
  hashedUserData: HashedUserData
): Promise<MetaCAPIResult> {
  const startedAt = Date.now();
  const url = `https://graph.facebook.com/${META_API_VERSION}/${siteConfig.meta.pixel_id}/events`;

  const user_data: Record<string, unknown> = { ...hashedUserData };
  if (payload.fbp) user_data.fbp = payload.fbp;
  if (payload.fbc) user_data.fbc = payload.fbc;
  if (payload.client_ip) user_data.client_ip_address = payload.client_ip;
  if (payload.client_user_agent) user_data.client_user_agent = payload.client_user_agent;

  const custom_data: Record<string, unknown> = {};
  if (typeof payload.value === 'number' && payload.currency) {
    custom_data.value = payload.value;
    custom_data.currency = payload.currency;
  }

  const event = {
    event_name: mapEventName(payload.event_name),
    event_time: payload.event_time,
    event_id: payload.event_id,
    action_source: 'website',
    event_source_url: payload.event_source_url,
    user_data,
    custom_data
  };

  const body: Record<string, unknown> = {
    data: [event],
    access_token: siteConfig.meta.access_token
  };

  if (siteConfig.meta.test_event_code) {
    body.test_event_code = siteConfig.meta.test_event_code;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), META_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const responseBody = await response.json() as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string; code?: number };
    };

    if (response.ok && responseBody.events_received) {
      logStructured({
        level: 'info',
        message: 'Meta CAPI event sent',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        events_received: responseBody.events_received,
        fbtrace_id: responseBody.fbtrace_id,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: true,
        events_received: responseBody.events_received,
        fbtrace_id: responseBody.fbtrace_id,
        status: response.status
      };
    }

    logStructured({
      level: 'error',
      message: 'Meta CAPI rejected event',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      status: response.status,
      meta_error: responseBody.error?.message || 'unknown',
      meta_error_code: responseBody.error?.code,
      fbtrace_id: responseBody.fbtrace_id,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      error: responseBody.error?.message || `HTTP ${response.status}`,
      status: response.status,
      fbtrace_id: responseBody.fbtrace_id
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';

    logStructured({
      level: 'error',
      message: isTimeout ? 'Meta CAPI timeout' : 'Meta CAPI network error',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: errMsg,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      error: isTimeout ? 'timeout' : errMsg
    };
  }
}
```

## Módosítandó fájl: `src/types.ts`

```typescript
export interface ConversionRequestPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  turnstile_token: string;

  value?: number;
  currency?: string;
  source?: string;
  service?: string;
  event_source_url?: string;
  user_data?: {
    email?: string;
    phone_number?: string;
    first_name?: string;
    last_name?: string;
    city?: string;
    postal_code?: string;
    country?: string;
  };
  fbp?: string;
  fbc?: string;
  client_id?: string;

  [key: string]: unknown;
}
```

## Módosítandó fájl: `src/routes/conversion.ts`

```typescript
import type { Env } from '../env';
import { logStructured, isValidConversionPayload } from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';
import { hashUserData, type CountryCode } from '../lib/hash';
import { sendToMetaCAPI } from '../lib/meta';

export async function handleConversion(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;
  const cors = corsHeaders(request);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    logStructured({ level: 'warn', message: 'Invalid JSON', hostname });
    return new Response(null, { status: 204, headers: cors });
  }

  if (!isValidConversionPayload(payload)) {
    logStructured({ level: 'warn', message: 'Invalid payload', hostname });
    return new Response(null, { status: 204, headers: cors });
  }

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    logStructured({ level: 'warn', message: 'No site config', hostname, event_name: payload.event_name });
    return new Response('Not configured', { status: 404, headers: cors });
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;
  const turnstileResult = await validateTurnstile(payload.turnstile_token, remoteIp, env);
  if (!turnstileResult.valid) {
    logStructured({
      level: 'warn',
      message: 'Turnstile failed',
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: turnstileResult.errorCodes?.join(',') || 'unknown'
    });
    return new Response('Invalid token', { status: 403, headers: cors });
  }

  const hashedUserData = await hashUserData(
    payload.user_data || {},
    siteConfig.country_code as CountryCode
  );

  const userAgent = request.headers.get('User-Agent') || undefined;
  const metaPromise = sendToMetaCAPI(
    siteConfig,
    {
      event_name: payload.event_name,
      event_id: payload.event_id,
      event_time: payload.event_time,
      value: payload.value,
      currency: payload.currency,
      source: payload.source,
      event_source_url: payload.event_source_url,
      fbp: payload.fbp,
      fbc: payload.fbc,
      client_ip: remoteIp,
      client_user_agent: userAgent
    },
    hashedUserData
  );

  ctx.waitUntil(metaPromise);

  logStructured({
    level: 'info',
    message: 'Conversion event accepted',
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: cors });
}
```

## Manuális tesztelés

### A. Test conversion Painless-en (production deploy után)

1. `npm run deploy`
2. Meta Events Manager → Painless Pixel → Test Events → "Test Event Code" mezőbe írd: `TEST_PAINLESS`
3. Curl-lel küldj egy konverziós event-et:

```bash
curl -X POST https://painlessremovals.com/api/event/conversion \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "callback_conversion",
    "event_id": "test-event-001",
    "event_time": '$(date +%s)',
    "turnstile_token": "VALID_TURNSTILE_TOKEN_FROM_DEV_SITE",
    "user_data": {
      "email": "test@example.com",
      "phone_number": "07123456789",
      "first_name": "Test",
      "last_name": "User",
      "city": "Bristol",
      "postal_code": "BS1 1AA",
      "country": "GB"
    },
    "fbp": "fb.1.1714400000.123456789",
    "event_source_url": "https://painlessremovals.com/quote"
  }'
```

4. Meta Events Manager → Test Events tab: 5-30 másodperc múlva megjelenik a `Lead` event "Server" forrással
5. Cloudflare Workers logs: `"Meta CAPI event sent"` `events_received: 1`-gyel

### B. Hibás Meta token tesztelése

1. Ideiglenesen rongáld el a `meta.access_token` értéket KV-ben
2. Curl request → Worker visszaad 204-et (sikerként a kliensnek)
3. Cloudflare Workers logs: `level: error, message: "Meta CAPI rejected event"`
4. Visszaállítod a valós token-t

## Sprint 4 utáni státusz

- ✅ Meta CAPI POST működik production-ben
- ✅ Hash + normalize a Sprint 3-as lib-ből
- ✅ `event_id` dedup-pal kompatibilis
- ✅ Test event code support
- ✅ 5s timeout
- ✅ Strukturált logok
- ❌ GA4 MP: Sprint 5
- ❌ Google Ads: Sprint 6-7
- ❌ Dead letter queue: Sprint 8

## FONTOS Sprint 5 ELŐTT

Mielőtt Sprint 5-re lépsz, **legalább** 1 hét stabil Sprint 4 production:
- Meta Events Manager → Painless Pixel → Match Quality nem csökkent
- Cloudflare Workers logs: nincs unhandled exception
- `events_received: 1` minden POST-nál
- Test events megérkeznek

## Mit KÉRDEZZ a usertől

1. Painless Pixel ID + System User Access Token feltöltve KV-be?
2. Test conversion megérkezett Meta Events Manager Test Events-be?
3. Cloudflare Workers logs tisztaak?
