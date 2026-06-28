import type { Env } from '../env';
import type { SiteConfig } from './config';
import { type HashedUserData, normalizePostalCode, normalizeCountry } from './hash';
import type { ConsentState } from './consent';
import { getAccessToken } from './gads-oauth';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';
import type { GAdsPayload, GAdsResult } from './gads';

/**
 * Google Data Manager API transport — the migration target for the legacy
 * Google Ads `uploadClickConversions` leg (see lib/gads.ts).
 *
 * Why: as of 2026-06-15 the Google Ads API blocks NEW adopters of
 * uploadClickConversions (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE). The Data
 * Manager API is the self-serve replacement — NO developer token, OAuth
 * `datamanager` scope only. Under Model 2 the server is Google-Ads-offline-only
 * (Enhanced Conversions for Leads), so this is the single Google Ads path.
 *
 * Drop-in: same (payload, hashedUserData) → GAdsResult shape as
 * sendToGoogleAdsCAPI, so the lead-status.ts wiring + ledger normalizeDelivery
 * ('gads') stay unchanged.
 *
 * CRITICAL platform differences vs uploadClickConversions:
 *  - eventTimestamp is RFC3339 (`...T...Z`), NOT the CLAUDE.md Rule 6
 *    "YYYY-MM-DD HH:MM:SS+00:00" format.
 *  - the hashed email MUST be Google-normalized (Gmail dot/plus stripped) —
 *    the caller passes hashUserDataForGoogle, NOT hashUserData (Meta's rule).
 *  - consent enum is CONSENT_GRANTED / CONSENT_DENIED, not GRANTED / DENIED.
 *  - no `developer-token` header; login_customer_id goes in loginAccount, not a header.
 *  - address: givenName/familyName HASHED; regionCode/postalCode PLAIN (Rule 7 holds).
 */

const DATAMANAGER_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';
const DATAMANAGER_API_TIMEOUT_MS = 5000;
const DATAMANAGER_ACCOUNT_TYPE = 'GOOGLE_ADS';

function classifyError(
  status: number,
  apiMessage: string | undefined
): TrackingErrorCode {
  if (status === 401 || status === 403) return TrackingErrorCode.DATAMANAGER_AUTH_REJECTED;
  if (status === 429) return TrackingErrorCode.DATAMANAGER_RATE_LIMITED;
  if (apiMessage && /not.allowlisted|NOT_ALLOWLISTED/i.test(apiMessage))
    return TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED;
  return TrackingErrorCode.DATAMANAGER_API_REJECTED;
}

// Google Consent Mode signal → Data Manager Consent enum. Anything that is not
// an explicit GRANTED/DENIED is omitted (the field defaults to unspecified).
function mapConsentSignal(signal: ConsentState['ad_user_data']): string | undefined {
  if (signal === 'GRANTED') return 'CONSENT_GRANTED';
  if (signal === 'DENIED') return 'CONSENT_DENIED';
  return undefined;
}

// Unix seconds → RFC3339 with second precision (e.g. "2026-06-10T20:07:01Z").
// Drops the milliseconds toISOString() always appends, to match the documented
// Data Manager sample exactly.
function toRfc3339Seconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function sendToDataManager(
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

  // --- userData.userIdentifiers -------------------------------------------
  const userIdentifiers: Record<string, unknown>[] = [];
  if (hashedUserData.em) userIdentifiers.push({ emailAddress: hashedUserData.em });
  if (hashedUserData.ph) userIdentifiers.push({ phoneNumber: hashedUserData.ph });

  // address is matched "all at once" — only worth sending when we have the
  // hashed name parts (parity with the legacy addressInfo behaviour). region/
  // postal are PLAIN (CLAUDE.md Rule 7 holds for the Data Manager too).
  if (hashedUserData.fn || hashedUserData.ln) {
    const address: Record<string, unknown> = {};
    if (hashedUserData.fn) address.givenName = hashedUserData.fn;
    if (hashedUserData.ln) address.familyName = hashedUserData.ln;
    const region = normalizeCountry(payload.country) || normalizeCountry(siteConfig.country_code);
    if (region) address.regionCode = region.toUpperCase();
    const zp = normalizePostalCode(payload.postal_code);
    if (zp) address.postalCode = zp;
    userIdentifiers.push({ address });
  }

  // --- event ---------------------------------------------------------------
  const event: Record<string, unknown> = {
    transactionId: payload.event_id,
    eventTimestamp: toRfc3339Seconds(payload.event_time),
    eventSource: 'WEB'
  };

  // Click ID — exactly one, by priority. At CRM/offline time it's usually
  // absent (ECL matches via hashed PII), but forward it if present.
  if (payload.gclid) event.adIdentifiers = { gclid: payload.gclid };
  else if (payload.gbraid) event.adIdentifiers = { gbraid: payload.gbraid };
  else if (payload.wbraid) event.adIdentifiers = { wbraid: payload.wbraid };

  // CLAUDE.md Rule 3: never send value:0 — omit the field entirely.
  if (typeof payload.value === 'number' && payload.value > 0) {
    event.conversionValue = payload.value;
  }
  if (payload.currency) event.currency = payload.currency;

  if (userIdentifiers.length > 0) event.userData = { userIdentifiers };

  if (payload.consent) {
    const consent: Record<string, string> = {};
    const adUserData = mapConsentSignal(payload.consent.ad_user_data);
    if (adUserData) consent.adUserData = adUserData;
    const adPersonalization = mapConsentSignal(payload.consent.ad_personalization);
    if (adPersonalization) consent.adPersonalization = adPersonalization;
    if (Object.keys(consent).length > 0) event.consent = consent;
  }

  // --- destination ---------------------------------------------------------
  const destination: Record<string, unknown> = {
    operatingAccount: {
      accountType: DATAMANAGER_ACCOUNT_TYPE,
      accountId: siteConfig.gads.customer_id
    },
    productDestinationId: conversionActionId
  };
  if (siteConfig.gads.login_customer_id) {
    destination.loginAccount = {
      accountType: DATAMANAGER_ACCOUNT_TYPE,
      accountId: siteConfig.gads.login_customer_id
    };
  }

  const validateOnly = env.DATAMANAGER_VALIDATE_ONLY === '1';
  const body = {
    destinations: [destination],
    events: [event],
    encoding: 'HEX',
    validateOnly
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DATAMANAGER_API_TIMEOUT_MS);

  try {
    const response = await fetch(DATAMANAGER_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const responseBody = (await response.json().catch(() => ({}))) as {
      requestId?: string;
      error?: { code?: number; message?: string; status?: string; details?: unknown[] };
    };

    if (!response.ok || responseBody.error) {
      const errorCode = classifyError(response.status, responseBody.error?.message);
      const sanitizedError = sanitizeErrorMessage(responseBody.error?.message);
      // The top-level message is generic ("There was a problem with the request.").
      // The actionable per-field validation errors live in error.details[] — log a
      // capped, sanitized snapshot so a 400 is diagnosable without guessing.
      const detailSnippet = responseBody.error?.details
        ? sanitizeErrorMessage(JSON.stringify(responseBody.error.details))?.slice(0, 5000)
        : undefined;
      logStructured({
        level:
          errorCode === TrackingErrorCode.DATAMANAGER_AUTH_REJECTED ||
          errorCode === TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED
            ? 'error'
            : 'warn',
        error_code: errorCode,
        message: ERROR_DESCRIPTIONS[errorCode],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        dm_error: sanitizedError,
        dm_error_status: responseBody.error?.status,
        dm_error_details: detailSnippet,
        validate_only: validateOnly,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error_code: errorCode,
        error: detailSnippet ? `${sanitizedError} | ${detailSnippet}` : sanitizedError,
        status: response.status
      };
    }

    logStructured({
      level: 'info',
      message: 'Data Manager event ingested',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      request_id: responseBody.requestId,
      ec_identifiers_provided: userIdentifiers.length,
      validate_only: validateOnly,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: true,
      conversions_processed: 1,
      status: response.status
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.DATAMANAGER_API_TIMEOUT
      : TrackingErrorCode.DATAMANAGER_API_NETWORK_ERROR;
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
