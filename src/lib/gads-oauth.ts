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

  try {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

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
