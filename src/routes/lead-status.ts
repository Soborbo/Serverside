import type { Env } from '../env';
import { logStructured } from '../types';
import { getSiteConfig } from '../lib/config';
import { authenticateAdmin } from '../lib/admin-auth';
import { hashUserData, type CountryCode, type PlainUserData } from '../lib/hash';
import { sendToGoogleAdsCAPI, type GAdsPayload } from '../lib/gads';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import {
  isValidLeadId,
  mapLeadStatusToEventName,
  VALID_LEAD_STATUSES,
  getLatestConsentForLead,
  recordLeadStatus,
  recordDeliveries,
  normalizeDelivery
} from '../lib/ledger';

/**
 * CRM offline-loop endpoint (P0 üzleti érték). A CRM ide POST-olja a lead
 * lifecycle-státuszait (lead_qualified, booking_confirmed, revenue_confirmed,
 * stb.), amiket Enhanced Conversions for Leads-ként visszaküldünk a Google Ads
 * felé — így a bidding tudja, MELYIK leadből lett valódi pénz.
 *
 * - Admin-auth (X-Admin-Token) — server-to-server, megbízható hívó.
 * - Hostname-alapú site routing (CLAUDE.md 14.) — a CRM a site gateway-hostjára hív.
 * - PII (user_data) menet közben hash-elődik és továbbítódik, SOHA nem tárolódik.
 * - GDPR: ha a lead capture-kor visszavonta az ad-consentet, az upload kimarad.
 */

interface LeadStatusBody {
  lead_id: string;
  status: string;
  occurred_at?: string;
  value?: number;
  currency?: string;
  user_data?: PlainUserData;
}

export function validateLeadStatusBody(payload: unknown): LeadStatusBody | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (!isValidLeadId(p.lead_id)) return null;
  if (typeof p.status !== 'string' || !VALID_LEAD_STATUSES.includes(p.status)) return null;

  if (p.occurred_at !== undefined) {
    if (typeof p.occurred_at !== 'string' || Number.isNaN(Date.parse(p.occurred_at))) return null;
  }
  if (
    p.value !== undefined &&
    (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0 || p.value > 1_000_000_000)
  ) {
    return null;
  }
  if (p.currency !== undefined && (typeof p.currency !== 'string' || !/^[A-Za-z]{3}$/.test(p.currency))) {
    return null;
  }
  if (p.user_data !== undefined && (typeof p.user_data !== 'object' || p.user_data === null)) {
    return null;
  }

  return {
    lead_id: p.lead_id as string,
    status: p.status,
    occurred_at: p.occurred_at as string | undefined,
    value: p.value as number | undefined,
    currency: p.currency as string | undefined,
    user_data: p.user_data as PlainUserData | undefined
  };
}

export async function handleLeadStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const hostname = new URL(request.url).hostname;

  if (!authenticateAdmin(request, env)) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return json({ error: 'unauthorized' }, 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const body = validateLeadStatusBody(raw);
  if (!body) {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return json({ error: 'invalid_payload', valid_statuses: VALID_LEAD_STATUSES }, 400);
  }

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    return json({ error: 'not_configured' }, 404);
  }

  const eventName = mapLeadStatusToEventName(body.status);
  if (!eventName) {
    return json({ error: 'unknown_status' }, 400);
  }

  const occurredAtIso = body.occurred_at ?? new Date().toISOString();
  const eventTimeSec = Math.floor(Date.parse(occurredAtIso) / 1000);

  // GDPR-kapu: ha a lead capture-kor visszavonta az ad-consentet, NEM töltünk fel.
  // null (nincs rekord / D1 nélkül) → engedjük (a CRM megbízható, a consent a
  // business felelőssége — Enhanced Conversions for Leads követelmény).
  const leadConsent = await getLatestConsentForLead(env, siteConfig.site_id, body.lead_id);
  const consentBlocked = leadConsent !== null && leadConsent.ad_allowed === false;

  let uploadedToGads = false;
  let gadsErrorCode: string | undefined;

  if (consentBlocked) {
    logStructured({
      level: 'info',
      message: 'Offline conversion skipped — lead revoked ad consent at capture',
      site_id: siteConfig.site_id,
      event_name: eventName,
      lead_id_present: true
    });
  } else if (siteConfig.gads.customer_id) {
    const hashed = await hashUserData(
      body.user_data ?? {},
      siteConfig.country_code as CountryCode
    );
    const gadsPayload: GAdsPayload = {
      event_name: eventName,
      // Stabil orderId az offline-konverzióhoz (lead+status) → Google Ads dedup.
      event_id: `${body.lead_id}_${body.status}`.slice(0, 64),
      event_time: eventTimeSec,
      value: body.value,
      currency: body.currency ?? siteConfig.currency,
      city: body.user_data?.city ?? undefined,
      postal_code: body.user_data?.postal_code ?? undefined
    };
    const result = await sendToGoogleAdsCAPI(siteConfig, env, gadsPayload, hashed);
    uploadedToGads = result.success;
    gadsErrorCode = result.error_code;

    ctx.waitUntil(
      recordDeliveries(env, {
        event_id: gadsPayload.event_id,
        lead_id: body.lead_id,
        site_id: siteConfig.site_id,
        event_name: eventName,
        origin: 'offline',
        records: [normalizeDelivery('gads', { status: 'fulfilled', value: result })]
      })
    );
  }

  ctx.waitUntil(
    recordLeadStatus(env, {
      lead_id: body.lead_id,
      site_id: siteConfig.site_id,
      status: body.status,
      value: body.value,
      currency: body.currency,
      occurred_at: occurredAtIso,
      uploaded_to_gads: uploadedToGads,
      gads_error_code: gadsErrorCode
    })
  );

  logStructured({
    level: 'info',
    message: 'Lead status recorded',
    site_id: siteConfig.site_id,
    event_name: eventName,
    uploaded_to_gads: uploadedToGads,
    consent_blocked: consentBlocked,
    duration_ms: Date.now() - startedAt
  });

  return json({ ok: true, uploaded_to_gads: uploadedToGads, consent_blocked: consentBlocked }, 200);
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
