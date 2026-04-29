import type { Env } from '../env';
import type { SiteConfig } from './config';
import type { HashedUserData } from './hash';
import { getAccessToken } from './gads-oauth';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';

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
  error_code?: TrackingErrorCode;
  status?: number;
}

function classifyGAdsError(
  status: number,
  apiCode: number | undefined,
  apiMessage: string | undefined
): TrackingErrorCode {
  if (status === 401) return TrackingErrorCode.GADS_AUTH_REJECTED;
  if (status === 429) return TrackingErrorCode.GADS_RATE_LIMITED;
  if (apiMessage && /developer.token/i.test(apiMessage))
    return TrackingErrorCode.GADS_DEVELOPER_TOKEN_INVALID;
  if (apiMessage && /conversion.action/i.test(apiMessage))
    return TrackingErrorCode.GADS_INVALID_CONVERSION_ACTION;
  if (apiCode === 16) return TrackingErrorCode.GADS_AUTH_REJECTED;
  return TrackingErrorCode.GADS_PARTIAL_FAILURE;
}

export async function sendToGoogleAdsCAPI(
  siteConfig: SiteConfig,
  env: Env,
  payload: GAdsPayload,
  hashedUserData: HashedUserData
): Promise<GAdsResult> {
  const startedAt = Date.now();

  if (!siteConfig.gads.customer_id) {
    return { success: true };
  }

  const conversionActionId = siteConfig.gads.conversion_actions?.[payload.event_name];
  if (!conversionActionId) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.MISSING_CONVERSION_ACTION,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.MISSING_CONVERSION_ACTION],
      site_id: siteConfig.site_id,
      event_name: payload.event_name
    });
    return { success: true };
  }

  const accessToken = await getAccessToken(siteConfig.gads.customer_id, env);
  if (!accessToken) {
    return {
      success: false,
      error_code: TrackingErrorCode.GADS_NO_ACCESS_TOKEN,
      error: 'No access token available'
    };
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
  if (typeof payload.value === 'number' && payload.value > 0) {
    conversion.conversionValue = payload.value;
  }
  if (payload.currency) conversion.currencyCode = payload.currency;
  if (userIdentifiers.length > 0) conversion.userIdentifiers = userIdentifiers;

  const body = {
    conversions: [conversion],
    partialFailure: true
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
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

    const responseBody = (await response.json()) as {
      results?: unknown[];
      partialFailureError?: { code?: number; message?: string };
      error?: { code?: number; message?: string; details?: unknown[] };
    };

    if (!response.ok || responseBody.error) {
      const errorCode = classifyGAdsError(
        response.status,
        responseBody.error?.code,
        responseBody.error?.message
      );
      const sanitizedError = sanitizeErrorMessage(responseBody.error?.message);
      logStructured({
        level:
          errorCode === TrackingErrorCode.GADS_AUTH_REJECTED ||
          errorCode === TrackingErrorCode.GADS_DEVELOPER_TOKEN_INVALID
            ? 'error'
            : 'warn',
        error_code: errorCode,
        message: ERROR_DESCRIPTIONS[errorCode],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        gads_error: sanitizedError,
        gads_error_code: responseBody.error?.code,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error_code: errorCode,
        error: sanitizedError,
        status: response.status
      };
    }

    if (responseBody.partialFailureError) {
      const sanitizedPartial = sanitizeErrorMessage(responseBody.partialFailureError.message);
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.GADS_PARTIAL_FAILURE,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.GADS_PARTIAL_FAILURE],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        partial_error: sanitizedPartial,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error_code: TrackingErrorCode.GADS_PARTIAL_FAILURE,
        partial_failure_error: sanitizedPartial,
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
    const errorCode = isTimeout
      ? TrackingErrorCode.GADS_API_TIMEOUT
      : TrackingErrorCode.GADS_API_NETWORK_ERROR;
    logStructured({
      level: 'warn',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: errMsg,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      error_code: errorCode,
      error: isTimeout ? 'timeout' : errMsg
    };
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
