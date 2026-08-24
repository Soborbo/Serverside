import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

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

  // Timeout, mint a refreshAccessToken-nél: egy beragadt Google oauth2/token
  // endpoint enélkül a Worker globális invocation-limitjéig blokkolná az admin
  // OAuth-complete kérést, timeout-hibakód nélkül.
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

    const data = (await response.json()) as RefreshTokenExchangeResponse;
    if (!response.ok || data.error) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED,
        message: 'OAuth code exchange failed',
        error: data.error || 'unknown',
        error_description: data.error_description
      });
      return {
        accessToken: '',
        refreshToken: '',
        error: data.error_description || data.error || 'unknown'
      };
    }

    if (!data.refresh_token) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED,
        message:
          'OAuth code exchange did not return refresh_token. access_type=offline + prompt=consent kötelező.'
      });
      return { accessToken: '', refreshToken: '', error: 'No refresh_token returned' };
    }

    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  } catch (err) {
    return {
      accessToken: '',
      refreshToken: '',
      error: err instanceof Error ? err.message : String(err)
    };
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

    const data = (await response.json()) as RefreshTokenResponse;
    if (!response.ok || data.error || !data.access_token) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.GADS_OAUTH_REFRESH_FAILED],
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

export async function getAccessToken(customerId: string, env: Env): Promise<string | null> {
  const accessKey = `gads:${customerId}:access_token`;
  const refreshKey = `gads:${customerId}:refresh_token`;

  const cached = await env.OAUTH_TOKENS.get(accessKey);
  if (cached) return cached;

  const refreshToken = await env.OAUTH_TOKENS.get(refreshKey);
  if (!refreshToken) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.GADS_NO_REFRESH_TOKEN,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.GADS_NO_REFRESH_TOKEN],
      customer_id: customerId
    });
    return null;
  }

  const result = await refreshAccessToken(refreshToken, env);
  if ('error' in result) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.GADS_NO_ACCESS_TOKEN,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.GADS_NO_ACCESS_TOKEN],
      customer_id: customerId,
      error: result.error
    });
    return null;
  }

  const ttl = Math.max(60, Math.min(result.expiresIn - 300, ACCESS_TOKEN_TTL_SECONDS));
  await env.OAUTH_TOKENS.put(accessKey, result.accessToken, { expirationTtl: ttl });

  logStructured({
    level: 'info',
    message: 'Refreshed Google Ads access token',
    customer_id: customerId,
    ttl_seconds: ttl
  });

  return result.accessToken;
}

/**
 * Van-e EGYÁLTALÁN refresh token ehhez a customerhez? Olcsó KV-olvasás, hálózati
 * hívás NÉLKÜL — szándékosan nem `getAccessToken`, ami refresh-elne is.
 *
 * A P1.1 offline reconciliation dependency-állapotához kell: ha nincs token, a láb
 * BLOCKED_DEPENDENCY, és NEM szabad drift-findinget generálni rá (a hiba ismert, a
 * health-check jelzi). Egy hálózati refresh itt napi több tucat felesleges
 * Google-hívást jelentene, ráadásul a cron futásidejét is a vendor válaszidejéhez
 * kötné.
 */
export async function hasRefreshToken(customerId: string, env: Env): Promise<boolean> {
  try {
    return (await env.OAUTH_TOKENS.get(`gads:${customerId}:refresh_token`)) !== null;
  } catch {
    // KV-hiba → NEM állítjuk, hogy hiányzik: a „blokkolt" állapot elnémítaná a
    // drift-detektort. Inkább mérjünk (és ha tényleg nincs token, a nulla
    // kézbesítés úgyis kiderül).
    return true;
  }
}

export async function storeRefreshToken(
  customerId: string,
  refreshToken: string,
  env: Env
): Promise<void> {
  const refreshKey = `gads:${customerId}:refresh_token`;
  await env.OAUTH_TOKENS.put(refreshKey, refreshToken);
  // A cache-elt access token a RÉGI consent scope-jával él (akár 55 percig) —
  // re-consent után (pl. az új `datamanager` scope felvételekor) ez 403-akat
  // adna, mintha a re-consent nem sikerült volna. Töröljük: a következő
  // getAccessToken az ÚJ refresh tokennel, az új scope-pal frissít.
  try {
    await env.OAUTH_TOKENS.delete(`gads:${customerId}:access_token`);
  } catch {
    // best-effort: ha a delete elbukik, a stale token legfeljebb a TTL-ig él
  }
  logStructured({
    level: 'info',
    message: 'Stored Google Ads refresh token (stale access-token cache cleared)',
    customer_id: customerId
  });
}
