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

  [key: string]: unknown;
}

export function isValidConversionPayload(payload: unknown): payload is ConversionRequestPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.event_name === 'string' &&
    p.event_name.length > 0 &&
    typeof p.event_id === 'string' &&
    p.event_id.length > 0 &&
    typeof p.event_time === 'number' &&
    typeof p.turnstile_token === 'string'
  );
}
