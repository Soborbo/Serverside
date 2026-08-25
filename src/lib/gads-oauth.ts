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

/**
 * Az OAuth-bukás OKA, nem csak a ténye.
 *
 * Korábban minden ág — hiányzó secret, visszavont hozzájárulás, Google-outage,
 * időtúllépés, értelmezhetetlen válasz — ugyanabba a `GADS_NO_ACCESS_TOKEN`
 * gyűjtőbe esett. Az operátornak ez annyit mondott: „nincs token". A hat ok
 * viszont hat különböző teendő, és három közülük csak emberi beavatkozással
 * oldható meg (secret beírása, újra-engedélyezés) — pont ezért nem szabad
 * összemosni a magától elmúló hálózati hibával.
 */
export type OAuthFailure = { error_code: TrackingErrorCode; error: string };

function isOAuthFailure(v: unknown): v is OAuthFailure {
  return typeof v === 'object' && v !== null && 'error_code' in v;
}

async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<{ accessToken: string; expiresIn: number } | OAuthFailure> {
  // A secretek hiányát ELŐBB fogjuk meg, mint hogy üres mezőkkel elküldenénk a
  // kérést: a Google `invalid_client`-et adna, ami megkülönböztethetetlen egy
  // valóban rossz kulcstól, holott itt egyszerűen nincs beírva a secret.
  if (!env.GADS_OAUTH_CLIENT_ID) {
    const code = TrackingErrorCode.GADS_OAUTH_CLIENT_ID_MISSING;
    logStructured({ level: 'error', error_code: code, message: ERROR_DESCRIPTIONS[code] });
    return { error_code: code, error: 'GADS_OAUTH_CLIENT_ID not set' };
  }
  if (!env.GADS_OAUTH_CLIENT_SECRET) {
    const code = TrackingErrorCode.GADS_OAUTH_CLIENT_SECRET_MISSING;
    logStructured({ level: 'error', error_code: code, message: ERROR_DESCRIPTIONS[code] });
    return { error_code: code, error: 'GADS_OAUTH_CLIENT_SECRET not set' };
  }

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

    // ŐRZÖTT parse. Egy nem-JSON válasz (proxy-hibaoldal, csonka törzs) eddig
    // ide dobott, és a külső catch egy jellegtelen szöveges hibaként adta
    // tovább — így egy Google-oldali sérülés hálózati hibának látszott.
    let data: RefreshTokenResponse | null = null;
    try {
      data = (await response.json()) as RefreshTokenResponse;
    } catch {
      data = null;
    }

    if (!data || typeof data !== 'object') {
      const code = TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE;
      logStructured({
        level: 'error', error_code: code, message: ERROR_DESCRIPTIONS[code], status: response.status
      });
      return { error_code: code, error: 'unparseable OAuth response' };
    }

    if (!response.ok || data.error || !data.access_token) {
      // `invalid_grant` = a refresh token lejárt vagy VISSZAVONTÁK. Ez az
      // egyetlen ág, ami emberi újra-engedélyezést kíván; a többi vagy magától
      // elmúlik, vagy Google-oldali. Ezért kap saját, critical kódot.
      const revoked = data.error === 'invalid_grant';
      const code = revoked
        ? TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED
        : !response.ok
          ? TrackingErrorCode.GADS_OAUTH_HTTP_ERROR
          : TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE;
      logStructured({
        level: 'error',
        error_code: code,
        message: ERROR_DESCRIPTIONS[code],
        error: data.error || 'unknown',
        error_description: data.error_description,
        status: response.status
      });
      return { error_code: code, error: data.error_description || data.error || 'unknown' };
    }
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const code = isTimeout
      ? TrackingErrorCode.GADS_OAUTH_TIMEOUT
      : TrackingErrorCode.GADS_API_NETWORK_ERROR;
    const msg = err instanceof Error ? err.message : String(err);
    logStructured({ level: 'error', error_code: code, message: ERROR_DESCRIPTIONS[code], error: msg });
    return { error_code: code, error: isTimeout ? 'timeout' : msg };
  }
}

/**
 * Access token BESZERZÉSE az OK megtartásával. A hívó (Data Manager) ezt az
 * `error_code`-ot írja a ledgerbe, tehát utólag látszik, MIÉRT nem ment fel a
 * konverzió — nem csak az, hogy nem ment.
 */
export async function getAccessTokenDetailed(
  customerId: string,
  env: Env
): Promise<{ accessToken: string } | OAuthFailure> {
  const accessKey = `gads:${customerId}:access_token`;
  const refreshKey = `gads:${customerId}:refresh_token`;

  const cached = await env.OAUTH_TOKENS.get(accessKey);
  if (cached) return { accessToken: cached };

  const refreshToken = await env.OAUTH_TOKENS.get(refreshKey);
  if (!refreshToken) {
    const code = TrackingErrorCode.GADS_NO_REFRESH_TOKEN;
    logStructured({
      level: 'error',
      error_code: code,
      message: ERROR_DESCRIPTIONS[code],
      customer_id: customerId
    });
    return { error_code: code, error: 'no refresh token in KV' };
  }

  const result = await refreshAccessToken(refreshToken, env);
  if (isOAuthFailure(result)) {
    // A konkrét okot a refreshAccessToken MÁR logolta a saját kódjával; itt
    // csak a customer-kontextust tesszük mellé. A régi, mindent elnyelő
    // GADS_NO_ACCESS_TOKEN log helyett az OK utazik tovább.
    logStructured({
      level: 'error',
      error_code: result.error_code,
      message: ERROR_DESCRIPTIONS[result.error_code],
      customer_id: customerId,
      error: result.error
    });
    return result;
  }

  const ttl = Math.max(60, Math.min(result.expiresIn - 300, ACCESS_TOKEN_TTL_SECONDS));
  await env.OAUTH_TOKENS.put(accessKey, result.accessToken, { expirationTtl: ttl });

  logStructured({
    level: 'info',
    message: 'Refreshed Google Ads access token',
    customer_id: customerId,
    ttl_seconds: ttl
  });

  return { accessToken: result.accessToken };
}

/**
 * Kompatibilitási burkoló azoknak a hívóknak (admin health-check, oauth-debug,
 * cross-check), akiknek elég a „van token / nincs token" bit. Új money-path
 * kódban a `getAccessTokenDetailed` a helyes belépő.
 */
export async function getAccessToken(customerId: string, env: Env): Promise<string | null> {
  const r = await getAccessTokenDetailed(customerId, env);
  return isOAuthFailure(r) ? null : r.accessToken;
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
