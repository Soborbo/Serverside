import type { TrackingErrorCode } from './lib/error-codes';

export type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  message: string;
  error_code?: TrackingErrorCode | string;
  hostname?: string;
  event_name?: string;
  site_id?: string;
  duration_ms?: number;
  error?: string;
  status?: number;
  [key: string]: unknown;
};

export function logStructured(log: StructuredLog): void {
  const fn =
    log.level === 'error' ? console.error : log.level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(log));
}

export interface PlainUserDataPayload {
  email?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  // Stabil, alkalmazás/CRM/cookie-szintű azonosító. Meta CAPI external_id-ként
  // megy (hash-elve) → javítja az Event Match Quality-t és dedup-fallback.
  external_id?: string;
}

export interface ConversionRequestPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  turnstile_token: string;

  value?: number;
  currency?: string;
  source?: string;
  service?: string;
  event_source_url?: string;
  user_data?: PlainUserDataPayload;
  fbp?: string;
  fbc?: string;
  client_id?: string;
  // Stabil lead-azonosító (UUID, NEM PII). A kliens generálja és ezzel köti
  // össze a konverziót a későbbi CRM offline-loop státuszokkal (lead_qualified,
  // booking_confirmed, revenue_confirmed). Opcionális; hiányában a ledger
  // rögzíti az eventet, de a CRM-loop nem tud rákötni.
  lead_id?: string;
  // GA4 session azonosító a `_ga_<container>` cookie-ból (GS1.1.<session_id>...).
  // Nélküle az MP-event elfogadódik, de nem jelenik meg rendesen a riportokban.
  session_id?: string;
  // Google Consent Mode v2 jelek (ad_user_data, ad_personalization, ad_storage,
  // analytics_storage). Lásd lib/consent.ts.
  consent?: unknown;
  // Univerzális attribúció: click ID-k (gclid/gbraid/wbraid/fbclid/...) + UTM-ek
  // + kontextus. Lásd lib/attribution.ts.
  attribution?: unknown;

  [key: string]: unknown;
}

// Allowlist of internal event names accepted by /api/event/conversion.
// New events MUST be added here AND to lib/meta.ts EVENT_NAME_MAP.
// Rejecting unknown event_names prevents Analytics Engine cardinality
// explosion via attacker-controlled strings.
export const ALLOWED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'quote_calculator_conversion',
  'callback_conversion',
  'contact_form_submit',
  'phone_conversion',
  'email_conversion',
  'whatsapp_conversion',
  'quote_calculator_first_view',
  'video_play'
]);

const MAX_EVENT_ID_LENGTH = 60;
const MIN_EVENT_TIME = 1_500_000_000; // 2017-07-14
const MAX_VALUE = 1_000_000_000;

export function isValidConversionPayload(payload: unknown): payload is ConversionRequestPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.event_name !== 'string' || !ALLOWED_EVENT_NAMES.has(p.event_name)) return false;
  if (
    typeof p.event_id !== 'string' ||
    p.event_id.length === 0 ||
    p.event_id.length > MAX_EVENT_ID_LENGTH ||
    !/^[a-zA-Z0-9_-]+$/.test(p.event_id)
  ) {
    return false;
  }
  if (
    typeof p.event_time !== 'number' ||
    !Number.isFinite(p.event_time) ||
    p.event_time < MIN_EVENT_TIME ||
    p.event_time > Math.floor(Date.now() / 1000) + 600
  ) {
    return false;
  }
  if (typeof p.turnstile_token !== 'string') return false;
  if (
    p.value !== undefined &&
    (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0 || p.value > MAX_VALUE)
  ) {
    return false;
  }
  // lead_id opcionális; ha jelen van, korlátozott charset+hossz (NEM PII).
  if (
    p.lead_id !== undefined &&
    (typeof p.lead_id !== 'string' ||
      p.lead_id.length < 8 ||
      p.lead_id.length > 64 ||
      !/^[a-zA-Z0-9_-]+$/.test(p.lead_id))
  ) {
    return false;
  }
  return true;
}
