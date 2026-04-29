# Sprint 2 — Site config + Turnstile validation

**Cél:** A Worker felismeri, melyik site-ról jött a request, betölti annak konfigurációját KV-ből, és validálja a Turnstile token-t.

**Idő Claude Code-dal:** 3-4 óra.

## Mielőtt nekiállsz

### 1. Wrangler secret feltöltés

```bash
wrangler secret put TURNSTILE_SECRET_KEY
# Bemásolod a Turnstile widget Secret Key-t
```

### 2. Painless KV config feltöltés (placeholder)

```bash
wrangler kv:key put --binding=SITE_CONFIG "painlessremovals.com" '{
  "site_id": "painless",
  "country_code": "GB",
  "currency": "GBP",
  "meta": {
    "pixel_id": "PLACEHOLDER_REPLACE_IN_SPRINT_4",
    "access_token": "PLACEHOLDER_REPLACE_IN_SPRINT_4"
  },
  "ga4": {
    "measurement_id": "PLACEHOLDER_REPLACE_IN_SPRINT_5",
    "api_secret": "PLACEHOLDER_REPLACE_IN_SPRINT_5"
  },
  "gads": {
    "customer_id": "PLACEHOLDER_REPLACE_IN_SPRINT_6",
    "login_customer_id": null,
    "conversions": {}
  }
}'
```

## Új fájlok

### `src/lib/config.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';

export interface SiteConfig {
  site_id: string;
  country_code: 'GB' | 'HU' | 'EU' | 'US';
  currency: string;
  meta: {
    pixel_id: string;
    access_token: string;
    test_event_code?: string | null;
  };
  ga4: {
    measurement_id: string;
    api_secret: string;
  };
  gads: {
    customer_id: string;
    login_customer_id: string | null;
    conversion_actions?: Record<string, string>;
  };
}

const negativeCache = new Set<string>();
const NEGATIVE_CACHE_MAX_SIZE = 1000;

export async function getSiteConfig(
  hostname: string,
  env: Env
): Promise<SiteConfig | null> {
  if (negativeCache.has(hostname)) {
    return null;
  }

  try {
    const raw = await env.SITE_CONFIG.get(hostname, 'json');
    if (!raw) {
      if (negativeCache.size >= NEGATIVE_CACHE_MAX_SIZE) {
        negativeCache.clear();
      }
      negativeCache.add(hostname);
      return null;
    }
    return raw as SiteConfig;
  } catch (err) {
    logStructured({
      level: 'error',
      message: 'KV read failed in getSiteConfig',
      hostname,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
```

### `src/lib/turnstile.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  valid: boolean;
  errorCodes?: string[];
}

export async function validateTurnstile(
  token: string | undefined,
  remoteIp: string | undefined,
  env: Env
): Promise<TurnstileResult> {
  if (!token) {
    return { valid: false, errorCodes: ['missing_token'] };
  }

  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  if (remoteIp) {
    formData.append('remoteip', remoteIp);
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      logStructured({
        level: 'warn',
        message: 'Turnstile verify API returned non-2xx',
        status: response.status
      });
      return { valid: true, errorCodes: ['service_unavailable'] };
    }

    const result = await response.json() as { success: boolean; 'error-codes'?: string[] };
    return {
      valid: result.success === true,
      errorCodes: result['error-codes'] || []
    };
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Turnstile verify network error',
      error: err instanceof Error ? err.message : String(err)
    });
    return { valid: true, errorCodes: ['service_unavailable'] };
  }
}
```

## Módosítandó fájlok

### `src/env.ts`

```typescript
export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;
  DEAD_LETTER: R2Bucket;

  TURNSTILE_SECRET_KEY: string;
}
```

### `src/types.ts`

Add hozzá a `ConversionRequestPayload` típust:

```typescript
export type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  message: string;
  hostname?: string;
  event_name?: string;
  site_id?: string;
  duration_ms?: number;
  error?: string;
  status?: number;
  [key: string]: unknown;
};

export function logStructured(log: StructuredLog): void {
  const fn = log.level === 'error' ? console.error : log.level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(log));
}

export interface ConversionRequestPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  turnstile_token: string;
  [key: string]: unknown;
}

export function isValidConversionPayload(payload: unknown): payload is ConversionRequestPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.event_name === 'string' && p.event_name.length > 0 &&
    typeof p.event_id === 'string' && p.event_id.length > 0 &&
    typeof p.event_time === 'number' &&
    typeof p.turnstile_token === 'string'
  );
}
```

### `src/routes/conversion.ts`

```typescript
import type { Env } from '../env';
import { logStructured, isValidConversionPayload } from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';

export async function handleConversion(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;
  const cors = corsHeaders(request);

  // 1. Parse body
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    logStructured({
      level: 'warn',
      message: 'Invalid JSON in conversion request',
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  // 2. Validate payload structure
  if (!isValidConversionPayload(payload)) {
    logStructured({
      level: 'warn',
      message: 'Invalid conversion payload structure',
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  // 3. Lookup site config
  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    logStructured({
      level: 'warn',
      message: 'No site config found for hostname',
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    return new Response('Not configured', { status: 404, headers: cors });
  }

  // 4. Validate Turnstile token
  const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;
  const turnstileResult = await validateTurnstile(payload.turnstile_token, remoteIp, env);

  if (!turnstileResult.valid) {
    logStructured({
      level: 'warn',
      message: 'Turnstile validation failed',
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: turnstileResult.errorCodes?.join(',') || 'unknown',
      duration_ms: Date.now() - startedAt
    });
    return new Response('Invalid token', { status: 403, headers: cors });
  }

  // 5. Sprint 2: success path — log and return 204
  logStructured({
    level: 'info',
    message: 'Conversion event validated (Sprint 2 — placeholder)',
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    turnstile_warnings: turnstileResult.errorCodes && turnstileResult.errorCodes.length > 0
      ? turnstileResult.errorCodes.join(',')
      : undefined,
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: cors });
}
```

## Manuális tesztelés

### Local dev

```bash
npm run dev
```

**A. Health check (változatlan)**
```bash
curl http://localhost:8787/api/event/health
```
→ `200 OK`

**B. Hiányzó site config**
```bash
curl -X POST http://localhost:8787/api/event/conversion \
  -H "Content-Type: application/json" \
  -H "Host: nonexistent.example.com" \
  -d '{"event_name":"test","event_id":"abc-123","event_time":1714400000,"turnstile_token":"fake"}'
```
→ `404 Not configured`

**C. Hiányzó Turnstile token**
```bash
curl -X POST http://localhost:8787/api/event/conversion \
  -H "Content-Type: application/json" \
  -H "Host: painlessremovals.com" \
  -d '{"event_name":"test","event_id":"abc-123","event_time":1714400000,"turnstile_token":""}'
```
→ `403 Invalid token`

**D. Érvénytelen JSON**
```bash
curl -X POST http://localhost:8787/api/event/conversion \
  -H "Content-Type: application/json" \
  -d 'not-json'
```
→ `204 No Content`

**E. Érvénytelen payload struktúra**
```bash
curl -X POST http://localhost:8787/api/event/conversion \
  -H "Content-Type: application/json" \
  -d '{"foo":"bar"}'
```
→ `204 No Content`

### Production tesztelés

```bash
npm run deploy
```

```bash
curl https://painlessremovals.com/api/event/health
```
→ `200 OK`

```bash
curl -X POST https://painlessremovals.com/api/event/conversion \
  -H "Content-Type: application/json" \
  -d '{"event_name":"test","event_id":"abc-123","event_time":1714400000,"turnstile_token":""}'
```
→ `403 Invalid token`

## Sprint 2 utáni státusz

- ✅ Site config lookup KV-ből
- ✅ Turnstile validation
- ✅ Strukturált logok minden döntési pontnál
- ✅ Negative cache a hostname lookup-ra
- ✅ Graceful degradation Turnstile API outage esetén
- ❌ Tényleges Meta/GA4/GAds POST-ok: Sprint 4-7
- ❌ User data hash: Sprint 3
- ❌ Fan-out: Sprint 8

## Mit KÉRDEZZ a usertől

1. Megerősítés, hogy a `wrangler secret put TURNSTILE_SECRET_KEY` lefutott sikeresen
2. Megerősítés, hogy a Painless KV config feltöltve a placeholder JSON-nel
3. `wrangler kv:key list --binding=SITE_CONFIG` output: `painlessremovals.com` key megjelenik?
