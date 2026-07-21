> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: README.md + CLAUDE.md + docs/HANDOVER-run6.md (a kanonikus élő állapot)
>
> Ez egy TERVEZÉSI/SPRINT-dokumentum a Run 1–6 építési fázisból. A benne leírt
> premisszák egy része AZÓTA MEGDŐLT (pl. Turnstile-before-everything, quote-state
> Durable Object, offline GA4 — mind törölve; lásd CLAUDE.md Rule 10/17). NE
> implementálj ez alapján; a jelenlegi valóság a fenti kanonikus fájlokban van.
> ---

# Sprint 6 — Google Ads OAuth2 token management

**Cél:** A Worker képes Google Ads API access token-t szerezni és cache-elni KV-ben. **Ez a sprint még nem küld konverziókat — csak a token-management infrastruktúrát építi.**

**Idő Claude Code-dal:** 4-6 óra.

## Mielőtt nekiállsz

### 1. Google Ads developer token státusz

Ha még nincs jóváhagyott developer token (pending vagy nem indítottad el), **Sprint 7 blokkolva** lesz, **de** Sprint 6 OAuth infrastruktúrát is **érdemes** előre felépíteni. Sprint 8-ra ugorhatsz Sprint 7 nélkül.

### 2. Wrangler secret-ek

```bash
wrangler secret put GADS_OAUTH_CLIENT_ID
# Bemásolod a Google Cloud Console Client ID-t

wrangler secret put GADS_OAUTH_CLIENT_SECRET
# Bemásolod a Google Cloud Console Client Secret-et
```

## Új fájl: `src/lib/gads-oauth.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_OAUTH_TIMEOUT_MS = 5000;
const ACCESS_TOKEN_TTL_SECONDS = 55 * 60;

interface RefreshTokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

interface RefreshTokenExchangeResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  env: Env
): Promise<{ accessToken: string; refreshToken: string; error?: string }> {
  const formData = new URLSearchParams();
  formData.set('code', code);
  formData.set('client_id', env.GADS_OAUTH_CLIENT_ID);
  formData.set('client_secret', env.GADS_OAUTH_CLIENT_SECRET);
  formData.set('redirect_uri', redirectUri);
  formData.set('grant_type', 'authorization_code');

  try {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    const data = await response.json() as RefreshTokenExchangeResponse;
    if (!response.ok || data.error) {
      logStructured({
        level: 'error',
        message: 'OAuth code exchange failed',
        error: data.error || 'unknown',
        error_description: data.error_description
      });
      return { accessToken: '', refreshToken: '', error: data.error_description || data.error || 'unknown' };
    }

    if (!data.refresh_token) {
      logStructured({
        level: 'error',
        message: 'OAuth code exchange did not return refresh_token. access_type=offline + prompt=consent kötelező.'
      });
      return { accessToken: '', refreshToken: '', error: 'No refresh_token returned' };
    }

    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  } catch (err) {
    return { accessToken: '', refreshToken: '', error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  const formData = new URLSearchParams();
  formData.set('refresh_token', refreshToken);
  formData.set('client_id', env.GADS_OAUTH_CLIENT_ID);
  formData.set('client_secret', env.GADS_OAUTH_CLIENT_SECRET);
  formData.set('grant_type', 'refresh_token');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GOOGLE_OAUTH_TIMEOUT_MS);

  try {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await response.json() as RefreshTokenResponse;
    if (!response.ok || data.error || !data.access_token) {
      logStructured({
        level: 'error',
        message: 'OAuth refresh failed',
        error: data.error || 'unknown',
        error_description: data.error_description,
        status: response.status
      });
      return { error: data.error_description || data.error || 'unknown' };
    }
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  } catch (err) {
    clearTimeout(timeoutId);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getAccessToken(
  customerId: string,
  env: Env
): Promise<string | null> {
  const accessKey = `gads:${customerId}:access_token`;
  const refreshKey = `gads:${customerId}:refresh_token`;

  const cached = await env.OAUTH_TOKENS.get(accessKey);
  if (cached) return cached;

  const refreshToken = await env.OAUTH_TOKENS.get(refreshKey);
  if (!refreshToken) {
    logStructured({
      level: 'error',
      message: 'No refresh token in KV. Run OAuth flow first.',
      customer_id: customerId
    });
    return null;
  }

  const result = await refreshAccessToken(refreshToken, env);
  if ('error' in result) {
    logStructured({
      level: 'error',
      message: 'Failed to refresh Google Ads access token',
      customer_id: customerId,
      error: result.error
    });
    return null;
  }

  const ttl = Math.min(result.expiresIn - 300, ACCESS_TOKEN_TTL_SECONDS);
  await env.OAUTH_TOKENS.put(accessKey, result.accessToken, { expirationTtl: ttl });

  logStructured({
    level: 'info',
    message: 'Refreshed Google Ads access token',
    customer_id: customerId,
    ttl_seconds: ttl
  });

  return result.accessToken;
}

export async function storeRefreshToken(
  customerId: string,
  refreshToken: string,
  env: Env
): Promise<void> {
  const refreshKey = `gads:${customerId}:refresh_token`;
  await env.OAUTH_TOKENS.put(refreshKey, refreshToken);
  logStructured({
    level: 'info',
    message: 'Stored Google Ads refresh token',
    customer_id: customerId
  });
}
```

## Új fájl: `src/routes/oauth-callback.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';
import { exchangeCodeForTokens, storeRefreshToken } from '../lib/gads-oauth';

export async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing code or state parameter', { status: 400 });
  }

  const customerId = state;
  const redirectUri = `${url.origin}/api/event/oauth-callback`;

  const result = await exchangeCodeForTokens(code, redirectUri, env);
  if (result.error) {
    return new Response(`OAuth exchange failed: ${result.error}`, { status: 500 });
  }

  await storeRefreshToken(customerId, result.refreshToken, env);

  logStructured({
    level: 'info',
    message: 'OAuth flow completed successfully',
    customer_id: customerId
  });

  return new Response(
    `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 2rem;">
    <h1>OAuth Setup Complete</h1>
    <p>Refresh token stored for customer ID: <code>${customerId}</code></p>
    <p><strong>Important:</strong> Delete or protect this endpoint now to prevent unauthorized access.</p>
    </body></html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    }
  );
}
```

## Új fájl: `src/routes/oauth-debug.ts`

```typescript
import type { Env } from '../env';
import { getAccessToken } from '../lib/gads-oauth';

export async function handleOAuthDebug(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  if (!customerId) {
    return new Response('Missing customer_id query param', { status: 400 });
  }

  const token = await getAccessToken(customerId, env);
  return new Response(
    JSON.stringify({
      customer_id: customerId,
      access_token_received: !!token,
      access_token_preview: token ? token.slice(0, 20) + '...' : null
    }, null, 2),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
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
}
```

## Módosítandó fájl: `src/worker.ts`

```typescript
if (request.method === 'GET' && url.pathname === '/api/event/oauth-callback') {
  const { handleOAuthCallback } = await import('./routes/oauth-callback');
  return handleOAuthCallback(request, env);
}

if (request.method === 'GET' && url.pathname === '/api/event/oauth-debug') {
  const { handleOAuthDebug } = await import('./routes/oauth-debug');
  return handleOAuthDebug(request, env);
}
```

## Manuális OAuth flow

1. **Painless customer_id KV-ben:**
   ```bash
   wrangler kv:key put --binding=SITE_CONFIG "painlessremovals.com" '{...,"gads":{"customer_id":"1234567890",...},...}'
   ```

2. **Browser-ben:**
   ```
   https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=https%3A%2F%2Fpainlessremovals.com%2Fapi%2Ftrack%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadwords&access_type=offline&prompt=consent&state=1234567890
   ```

3. **Google sign-in → engedélyez** → redirect.

4. **Browser response**: `OAuth Setup Complete`.

5. **Verify:**
   ```bash
   curl 'https://painlessremovals.com/api/event/oauth-debug?customer_id=1234567890'
   ```
   → `{"access_token_received":true, "access_token_preview":"ya29.A0..."}`

6. **Cache test**: ugyanazt a curl-t újra → token a KV cache-ből, nincs új refresh log.

7. **Refresh test**: töröld a KV-ből az access token-t, és curl-d újra → log `"Refreshed Google Ads access token"`.

## Sprint 6 utáni státusz

- ✅ One-time OAuth flow működik
- ✅ Refresh token KV-ben tárolva
- ✅ Access token cache 55 perces TTL-lel
- ✅ Refresh on cache miss
- ❌ Tényleges Google Ads conversion upload: Sprint 7

## Mit KÉRDEZZ a usertől

1. Painless Google Ads developer token: jóváhagyott?
2. Google Cloud OAuth Client ID + Secret létrehozva?
3. Wrangler secret-ek feltöltve?
4. Browser OAuth flow lefutott?
5. `oauth-debug` `access_token_received:true`-t ad?
