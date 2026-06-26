import type { SiteConfig } from './config';
import type { ConsentState } from './consent';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

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
  // GA4 session azonosító — session-attribúcióhoz és a Realtime/standard
  // riportokban való megjelenéshez szükséges (engagement_time_msec mellett).
  session_id?: string;
  // Google Consent Mode v2 jelek; ha analytics_storage DENIED, a GA4
  // cookieless modellezést végez (nem mi gate-eljük ki kliensoldalon).
  consent?: ConsentState;
}

export interface GA4Result {
  success: boolean;
  status?: number;
  error?: string;
  error_code?: TrackingErrorCode;
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
  // session_id kötelező a helyes session-attribúcióhoz / riport-megjelenéshez.
  if (payload.session_id) params.session_id = payload.session_id;
  if (typeof payload.value === 'number') params.value = payload.value;
  if (payload.currency) params.currency = payload.currency;
  if (payload.source) params.source = payload.source;
  if (payload.service) params.service = payload.service;
  if (payload.page_location) params.page_location = payload.page_location;

  const body: Record<string, unknown> = {
    client_id: clientId,
    events: [{ name: payload.event_name, params }]
  };

  // Consent Mode v2 — top-level consent objektum. A GA4 MP CSAK GRANTED/DENIED-et
  // dokumentál; az UNSPECIFIED-et kihagyjuk (a hiányzó mező a default).
  if (payload.consent) {
    const consent: Record<string, string> = {};
    if (payload.consent.ad_user_data === 'GRANTED' || payload.consent.ad_user_data === 'DENIED') {
      consent.ad_user_data = payload.consent.ad_user_data;
    }
    if (
      payload.consent.ad_personalization === 'GRANTED' ||
      payload.consent.ad_personalization === 'DENIED'
    ) {
      consent.ad_personalization = payload.consent.ad_personalization;
    }
    if (Object.keys(consent).length > 0) body.consent = consent;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
      const debugBody = (await response.json()) as { validationMessages?: unknown[] };
      const hasErrors = (debugBody.validationMessages?.length ?? 0) > 0;
      logStructured({
        level: hasErrors ? 'warn' : 'info',
        error_code: hasErrors ? TrackingErrorCode.GA4_VALIDATION_FAILURE : undefined,
        message: hasErrors
          ? ERROR_DESCRIPTIONS[TrackingErrorCode.GA4_VALIDATION_FAILURE]
          : 'GA4 MP debug OK',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        validation_messages: debugBody.validationMessages,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: !hasErrors,
        status: response.status,
        validation_messages: debugBody.validationMessages,
        error_code: hasErrors ? TrackingErrorCode.GA4_VALIDATION_FAILURE : undefined
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
      level: 'warn',
      error_code: TrackingErrorCode.GA4_VALIDATION_FAILURE,
      message: `GA4 MP unexpected status ${response.status}`,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      status: response.status,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      error_code: TrackingErrorCode.GA4_VALIDATION_FAILURE
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.GA4_API_TIMEOUT
      : TrackingErrorCode.GA4_API_NETWORK_ERROR;
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
      error: isTimeout ? 'timeout' : errMsg,
      error_code: errorCode
    };
  }
}

function generateFallbackClientId(): string {
  const random = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;
  const seconds = Math.floor(Date.now() / 1000);
  return `${random}.${seconds}`;
}
