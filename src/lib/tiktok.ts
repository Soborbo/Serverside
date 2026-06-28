import type { SiteConfig } from './config';
import type { HashedUserData } from './hash';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';

/**
 * TikTok Events API 2.0 forwarder (TASK 3) — ttclid alapú server-side konverzió.
 *
 * Endpoint: POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 * Header: Access-Token. Body: { event_source:'web', event_source_id:<pixel_code>,
 * data:[{ event, event_time(sec), event_id, user:{ ttclid, email(sha256),
 * phone(sha256), ip, user_agent }, page:{url}, properties:{value,currency} }] }.
 *
 * Consent: a hívó CSAK adAllowed esetén hívja (mint Meta/GAds). PII: az em/ph a
 * már SHA-256-olt HashedUserData-ból jön (nincs nyers PII). Config nélkül no-op.
 *
 * TODO(live): a payload a TikTok Events API v1.3 doksi szerint épül, de élesben
 * NEM tesztelt (nincs sandbox access token). Élesítés előtt verifikáld a TikTok
 * Events Manager Test Events nézetében.
 */

const TIKTOK_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const TIKTOK_TIMEOUT_MS = 5000;

// internal (kanonikus) event_name → TikTok standard event (config.event_names
// felülírhatja). A forwarder az ingress-normalizálás után kanonikus nevet kap.
const DEFAULT_EVENT_MAP: Record<string, string> = {
  quote_calculator_submitted: 'SubmitForm',
  callback_request_submitted: 'Contact',
  contact_form_submitted: 'SubmitForm',
  phone_number_clicked: 'Contact',
  email_address_clicked: 'Contact',
  whatsapp_button_clicked: 'Contact',
  quote_calculator_opened: 'ViewContent',
  video_play: 'ViewContent',
  view_item: 'ViewContent',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  order_request_submitted: 'SubmitForm',
  purchase: 'CompletePayment'
};

export interface TikTokPayload {
  event_name: string;
  event_id: string;
  event_time: number; // unix seconds
  value?: number;
  currency?: string;
  event_source_url?: string;
  ttclid?: string;
  client_ip?: string;
  client_user_agent?: string;
}

export interface TikTokResult {
  success: boolean;
  error?: string;
  error_code?: TrackingErrorCode;
  status?: number;
  skipped?: boolean;
}

export async function sendToTikTok(
  siteConfig: SiteConfig,
  payload: TikTokPayload,
  hashedUserData: HashedUserData
): Promise<TikTokResult> {
  const cfg = siteConfig.tiktok;
  if (!cfg || !cfg.pixel_code || !cfg.access_token) {
    return { success: true, skipped: true }; // nem konfigurált → no-op skip
  }

  const event = cfg.event_names?.[payload.event_name] || DEFAULT_EVENT_MAP[payload.event_name] || payload.event_name;

  const user: Record<string, unknown> = {};
  if (payload.ttclid) user.ttclid = payload.ttclid;
  if (hashedUserData.em) user.email = hashedUserData.em;
  if (hashedUserData.ph) user.phone = hashedUserData.ph;
  if (payload.client_ip) user.ip = payload.client_ip;
  if (payload.client_user_agent) user.user_agent = payload.client_user_agent;

  const properties: Record<string, unknown> = {};
  if (typeof payload.value === 'number' && payload.value > 0) properties.value = payload.value;
  if (payload.currency) properties.currency = payload.currency;

  const body = {
    event_source: 'web',
    event_source_id: cfg.pixel_code,
    data: [
      {
        event,
        event_time: payload.event_time,
        event_id: payload.event_id,
        user,
        page: payload.event_source_url ? { url: payload.event_source_url } : undefined,
        properties
      }
    ]
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIKTOK_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    // TODO(live): UNVERIFIED against the live TikTok API (no sandbox creds).
    const response = await fetch(TIKTOK_URL, {
      method: 'POST',
      headers: { 'Access-Token': cfg.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const json = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
    // TikTok: code === 0 → success.
    if (!response.ok || (json.code !== undefined && json.code !== 0)) {
      const msg = sanitizeErrorMessage(json.message);
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.TIKTOK_DISPATCH_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.TIKTOK_DISPATCH_FAILED],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        tiktok_code: json.code,
        tiktok_error: msg,
        duration_ms: Date.now() - startedAt
      });
      return { success: false, error_code: TrackingErrorCode.TIKTOK_DISPATCH_FAILED, error: msg, status: response.status };
    }

    logStructured({
      level: 'info',
      message: 'TikTok event forwarded',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    return { success: true, status: response.status };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.TIKTOK_API_TIMEOUT
      : TrackingErrorCode.TIKTOK_DISPATCH_FAILED;
    logStructured({
      level: 'warn',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
      duration_ms: Date.now() - startedAt
    });
    return { success: false, error_code: errorCode, error: isTimeout ? 'timeout' : String(err) };
  }
}

export { DEFAULT_EVENT_MAP as TIKTOK_DEFAULT_EVENT_MAP };
