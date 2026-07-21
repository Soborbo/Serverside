> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: README.md + CLAUDE.md + docs/HANDOVER-run6.md (a kanonikus élő állapot)
>
> Ez egy TERVEZÉSI/SPRINT-dokumentum a Run 1–6 építési fázisból. A benne leírt
> premisszák egy része AZÓTA MEGDŐLT (pl. Turnstile-before-everything, quote-state
> Durable Object, offline GA4 — mind törölve; lásd CLAUDE.md Rule 10/17). NE
> implementálj ez alapján; a jelenlegi valóság a fenti kanonikus fájlokban van.
> ---

# Sprint 5 — GA4 Measurement Protocol

**Cél:** A Worker server-side GA4 event-eket küld a Measurement Protocol-on, párhuzamosan a kliensoldali GA4-vel.

**Idő Claude Code-dal:** 2-3 óra.

## Mielőtt nekiállsz

### 1. Painless GA4 Measurement ID + API Secret

GA4 Admin → Data Streams → Web → Painless stream → Measurement ID (`G-XXXXXXXXXX`).
GA4 Admin → Data Streams → Web → Painless stream → Measurement Protocol API secrets → Create.

### 2. Painless KV config frissítése

```bash
wrangler kv:key put --binding=SITE_CONFIG "painlessremovals.com" '{
  "site_id": "painless",
  "country_code": "GB",
  "currency": "GBP",
  "meta": { "pixel_id": "...", "access_token": "...", "test_event_code": "TEST_PAINLESS" },
  "ga4": {
    "measurement_id": "G-XXXXXXXXXX",
    "api_secret": "abcd1234EFGH-xyz"
  },
  "gads": { "customer_id": "PLACEHOLDER", "login_customer_id": null, "conversion_actions": {} }
}'
```

## GA4 fontos szabályok

1. `client_id` KÖTELEZŐ. `_ga` cookie-ból: `GA1.1.1234567890.0987654321` → `1234567890.0987654321`
2. `engagement_time_msec` ajánlott (100ms minimum)
3. PII tilos GA4-ben (Meta-tól eltérő rule)
4. Event név snake_case
5. GA4 NEM dedup-ál `event_id` alapján — ezért Sprint 9-ben a konverziók CSAK server-side mennek, kliensoldali GA4 csak page_view-t és engagement-et küld

## Új fájl: `src/lib/ga4.ts`

```typescript
import type { SiteConfig } from './config';
import { logStructured } from '../types';

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';
const GA4_TIMEOUT_MS = 5000;

export interface GA4Payload {
  event_name: string;
  event_id: string;
  client_id: string | undefined;
  value?: number;
  currency?: string;
  source?: string;
  service?: string;
  page_location?: string;
  user_agent?: string;
}

export interface GA4Result {
  success: boolean;
  status?: number;
  error?: string;
  validation_messages?: unknown[];
}

export async function sendToGA4MP(
  siteConfig: SiteConfig,
  payload: GA4Payload,
  options: { debug?: boolean } = {}
): Promise<GA4Result> {
  const startedAt = Date.now();
  const endpoint = options.debug ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT;
  const url = `${endpoint}?measurement_id=${siteConfig.ga4.measurement_id}&api_secret=${siteConfig.ga4.api_secret}`;

  const clientId = payload.client_id || generateFallbackClientId();

  const params: Record<string, unknown> = {
    engagement_time_msec: 100,
    event_id: payload.event_id
  };
  if (typeof payload.value === 'number') params.value = payload.value;
  if (payload.currency) params.currency = payload.currency;
  if (payload.source) params.source = payload.source;
  if (payload.service) params.service = payload.service;
  if (payload.page_location) params.page_location = payload.page_location;

  const body = {
    client_id: clientId,
    events: [{ name: payload.event_name, params }]
  };

  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (payload.user_agent) {
    headers['User-Agent'] = payload.user_agent;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GA4_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (options.debug) {
      const debugBody = await response.json() as { validationMessages?: unknown[] };
      const hasErrors = (debugBody.validationMessages?.length ?? 0) > 0;
      logStructured({
        level: hasErrors ? 'warn' : 'info',
        message: hasErrors ? 'GA4 MP debug validation issues' : 'GA4 MP debug OK',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        validation_messages: debugBody.validationMessages,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: !hasErrors,
        status: response.status,
        validation_messages: debugBody.validationMessages
      };
    }

    if (response.status === 204) {
      logStructured({
        level: 'info',
        message: 'GA4 MP event sent',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        client_id_provided: !!payload.client_id,
        duration_ms: Date.now() - startedAt
      });
      return { success: true, status: 204 };
    }

    logStructured({
      level: 'error',
      message: 'GA4 MP unexpected status',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      status: response.status,
      duration_ms: Date.now() - startedAt
    });
    return { success: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logStructured({
      level: 'error',
      message: isTimeout ? 'GA4 MP timeout' : 'GA4 MP network error',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: errMsg,
      duration_ms: Date.now() - startedAt
    });
    return { success: false, error: isTimeout ? 'timeout' : errMsg };
  }
}

function generateFallbackClientId(): string {
  const random = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;
  const seconds = Math.floor(Date.now() / 1000);
  return `${random}.${seconds}`;
}
```

## Új fájl: `src/routes/debug-ga4.ts`

```typescript
import type { Env } from '../env';
import { corsHeaders } from '../worker';
import { getSiteConfig } from '../lib/config';
import { sendToGA4MP } from '../lib/ga4';

export async function handleDebugGA4(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.searchParams.get('host') || url.hostname;
  const cors = corsHeaders(request);

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    return new Response(JSON.stringify({ error: 'No site config' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const result = await sendToGA4MP(
    siteConfig,
    {
      event_name: 'debug_test',
      event_id: 'debug-' + Date.now(),
      client_id: '1234567890.1714400000',
      value: 100,
      currency: 'GBP',
      source: 'debug_endpoint'
    },
    { debug: true }
  );

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
```

## Módosítandó fájl: `src/worker.ts`

Add hozzá az új route-ot:

```typescript
if (request.method === 'GET' && url.pathname === '/api/event/debug-ga4') {
  const { handleDebugGA4 } = await import('./routes/debug-ga4');
  return handleDebugGA4(request, env);
}
```

## Módosítandó fájl: `src/routes/conversion.ts`

A Sprint 4 fan-out-ot bővítsd Meta + GA4 párhuzamossal. A `metaPromise` után:

```typescript
import { sendToGA4MP } from '../lib/ga4';

// ... a Sprint 4 kódban a metaPromise létrehozása után:

const fanout = Promise.allSettled([
  metaPromise,
  sendToGA4MP(
    siteConfig,
    {
      event_name: payload.event_name,
      event_id: payload.event_id,
      client_id: payload.client_id,
      value: payload.value,
      currency: payload.currency,
      source: payload.source,
      service: payload.service,
      page_location: payload.event_source_url,
      user_agent: userAgent
    }
  )
]).then(results => {
  const [metaResult, ga4Result] = results;
  logStructured({
    level: 'info',
    message: 'Fan-out completed',
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
    ga4_success: ga4Result.status === 'fulfilled' && ga4Result.value.success
  });
});

ctx.waitUntil(fanout);
```

## Manuális tesztelés

### A. Debug endpoint
```bash
curl 'https://painlessremovals.com/api/event/debug-ga4?host=painlessremovals.com'
```
→ JSON `{ success: true, validation_messages: [] }`

### B. Production GA4 event
GA4 Admin → DebugView megnyitva.

```bash
curl -X POST https://painlessremovals.com/api/event/conversion \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "callback_conversion",
    "event_id": "ga4-test-001",
    "event_time": '$(date +%s)',
    "turnstile_token": "VALID_TOKEN",
    "client_id": "1234567890.1714400000",
    "value": 380, "currency": "GBP", "service": "removal",
    "user_data": {"email": "test@example.com", "phone_number": "07123456789"},
    "fbp": "fb.1.1714400000.123456789",
    "event_source_url": "https://painlessremovals.com/quote"
  }'
```

GA4 DebugView 30-60 másodperc múlva megjeleníti az eventet.

## Sprint 5 utáni státusz

- ✅ GA4 Measurement Protocol POST működik
- ✅ Debug endpoint validációhoz
- ✅ Fallback client_id generálás
- ✅ NINCS PII GA4-be
- ✅ 2-way fan-out (Meta + GA4)
- ❌ Google Ads OAuth: Sprint 6
- ❌ Dead letter queue: Sprint 8

## Mit KÉRDEZZ a usertől

1. Painless GA4 Measurement ID megerősítése
2. Painless API Secret létrehozva és KV-ben
3. Debug endpoint OK választ ad?
4. GA4 DebugView server-side event-eket mutat?
