import type { SiteConfig } from './config';
import type { HashedUserData } from './hash';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';

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
  error_code?: TrackingErrorCode;
  status?: number;
}

function classifyMetaError(
  status: number,
  metaCode: number | undefined,
  metaMessage: string | undefined
): TrackingErrorCode {
  if (metaCode === 190 || status === 401) return TrackingErrorCode.META_INVALID_ACCESS_TOKEN;
  if (metaCode === 4 || metaCode === 17 || status === 429) return TrackingErrorCode.META_RATE_LIMITED;
  if (metaCode === 803 || (status === 400 && metaMessage && /pixel|object/i.test(metaMessage)))
    return TrackingErrorCode.META_PIXEL_NOT_FOUND;
  if (status === 400 && metaMessage && /user_data|hash|normaliz/i.test(metaMessage))
    return TrackingErrorCode.META_INVALID_USER_DATA;
  return TrackingErrorCode.META_API_REJECTED;
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
  if (typeof payload.value === 'number' && payload.value > 0 && payload.currency) {
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

    const responseBody = (await response.json()) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string; code?: number };
    };

    if (response.ok && responseBody.events_received && responseBody.events_received > 0) {
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

    if (response.ok && (!responseBody.events_received || responseBody.events_received === 0)) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.META_EVENTS_RECEIVED_ZERO,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.META_EVENTS_RECEIVED_ZERO],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        fbtrace_id: responseBody.fbtrace_id,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error_code: TrackingErrorCode.META_EVENTS_RECEIVED_ZERO,
        error: 'events_received: 0',
        status: response.status,
        fbtrace_id: responseBody.fbtrace_id
      };
    }

    const errorCode = classifyMetaError(
      response.status,
      responseBody.error?.code,
      responseBody.error?.message
    );

    logStructured({
      level: errorCode === TrackingErrorCode.META_INVALID_ACCESS_TOKEN ? 'error' : 'warn',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      status: response.status,
      meta_error: sanitizeErrorMessage(responseBody.error?.message),
      meta_error_code: responseBody.error?.code,
      fbtrace_id: responseBody.fbtrace_id,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      error_code: errorCode,
      error: responseBody.error?.message || `HTTP ${response.status}`,
      status: response.status,
      fbtrace_id: responseBody.fbtrace_id
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.META_API_TIMEOUT
      : TrackingErrorCode.META_API_NETWORK_ERROR;

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
