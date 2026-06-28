import type { Env } from '../env';
import { logStructured } from '../types';
import { getSiteConfig } from '../lib/config';
import { authenticateLeadStatus } from '../lib/admin-auth';
import { hashUserDataForGoogle, sha256Hex, type CountryCode, type PlainUserData } from '../lib/hash';
import { type GAdsPayload } from '../lib/gads';
import { sendToDataManager } from '../lib/datamanager';
import { sendToGA4MP } from '../lib/ga4';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import {
  isValidLeadId,
  isOfflineUploadBlocked,
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
  // user_data: objektum, de NEM tömb (typeof [] === 'object') — a tömb junk
  // kulcsokkal jutna a hash-előhöz.
  if (
    p.user_data !== undefined &&
    (typeof p.user_data !== 'object' || p.user_data === null || Array.isArray(p.user_data))
  ) {
    return null;
  }

  return {
    lead_id: p.lead_id as string,
    status: p.status,
    // UTC ISO-ra normalizálva → konzisztens lexikális rendezés a ledgerben.
    occurred_at:
      typeof p.occurred_at === 'string' ? new Date(p.occurred_at).toISOString() : undefined,
    value: p.value as number | undefined,
    // 3-betűs ISO uppercase (a Google Ads/Meta nagybetűt vár).
    currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : undefined,
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

  // Site-feloldás ELŐSZÖR (hostname-alapú, CLAUDE.md 14.) — a per-site CRM-token
  // auth EHHEZ a site-hoz kötött. Ismeretlen host → 404, fallback nélkül.
  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    return json({ error: 'not_configured' }, 404);
  }

  // Per-site token: a globális ADMIN_API_TOKEN NEM ad hozzáférést egy saját tokennel
  // rendelkező site-hoz. Rossz site tokenjével (cross-tenant kísérlet) → 401.
  if (!(await authenticateLeadStatus(request, env, siteConfig))) {
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

  const eventName = mapLeadStatusToEventName(body.status);
  if (!eventName) {
    return json({ error: 'unknown_status' }, 400);
  }

  const occurredAtIso = body.occurred_at ?? new Date().toISOString();
  const eventTimeSec = Math.floor(Date.parse(occurredAtIso) / 1000);

  // GDPR-kapu: explicit ad_allowed=false → tiltott. Fail-closed: ha a site
  // require_consent ÉS nincs (vagy D1-hiba miatt nem olvasható) consent-rekord,
  // szintén tiltott (egy D1-kiesés ne fordítsa „ismeretlen"→„megadott"-ra).
  const leadConsent = await getLatestConsentForLead(env, siteConfig.site_id, body.lead_id);
  const consentBlocked = isOfflineUploadBlocked(leadConsent, siteConfig.require_consent === true);

  // Ütközésbiztos, determinisztikus orderId: a (lead_id, status) SHA-256-ja —
  // MEGOSZTVA a Google Ads offline upload és az offline GA4 MP között (event_id).
  // A naiv `${lead_id}_${status}`.slice(0,64) hosszú lead_id-knál csonkolt és
  // ütközhetett (két különböző lead → egy orderId → a platform összevonja őket).
  const orderId = (await sha256Hex(`${body.lead_id}_${body.status}`)).slice(0, 32);

  let uploadedToGads = false;
  let gadsErrorCode: string | undefined;

  if (consentBlocked) {
    logStructured({
      level: 'info',
      message: 'Offline conversion skipped — consent not satisfied',
      site_id: siteConfig.site_id,
      event_name: eventName,
      require_consent: siteConfig.require_consent === true,
      has_consent_record: leadConsent !== null
    });
  } else if (siteConfig.gads.customer_id) {
    // Model 2: the server is Google-Ads-offline-only (Enhanced Conversions for
    // Leads), delivered via the Data Manager API. The email hash MUST use the
    // Google normalization (Gmail dot/plus strip), NOT the Meta rule.
    const hashed = await hashUserDataForGoogle(
      body.user_data ?? {},
      siteConfig.country_code as CountryCode
    );
    const gadsPayload: GAdsPayload = {
      event_name: eventName,
      event_id: orderId,
      event_time: eventTimeSec,
      value: body.value,
      currency: body.currency ?? siteConfig.currency,
      // city is dropped by the Data Manager (no AddressInfo.city field); only
      // postal_code/country (plain) are carried into the address identifier.
      postal_code: body.user_data?.postal_code ?? undefined,
      country: body.user_data?.country ?? undefined
    };
    const result = await sendToDataManager(siteConfig, env, gadsPayload, hashed);
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

  // Offline GA4 MP (§4.4) — a szerver legitim „augment" GA4 szerepe a CRM-fázis
  // eventekre, UGYANAZZAL a determinisztikus orderId-vel (event_id). NEM ad-platform
  // (analytics, nincs PII) → nem a consentBlocked ad-kapu gat-eli; a site `ga4` blokkja
  // nélkül no-op skip. A böngésző itt nincs jelen (CRM-webhook) → nincs on-site dupla.
  let uploadedToGa4 = false;
  if (siteConfig.ga4) {
    const ga4Result = await sendToGA4MP(siteConfig, {
      event_name: eventName,
      event_id: orderId,
      client_id: undefined,
      value: body.value,
      currency: body.currency ?? siteConfig.currency
    });
    uploadedToGa4 = ga4Result.success;
    ctx.waitUntil(
      recordDeliveries(env, {
        event_id: orderId,
        lead_id: body.lead_id,
        site_id: siteConfig.site_id,
        event_name: eventName,
        origin: 'offline',
        records: [normalizeDelivery('ga4', { status: 'fulfilled', value: ga4Result })]
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
    uploaded_to_ga4: uploadedToGa4,
    consent_blocked: consentBlocked,
    duration_ms: Date.now() - startedAt
  });

  return json(
    {
      ok: true,
      uploaded_to_gads: uploadedToGads,
      uploaded_to_ga4: uploadedToGa4,
      consent_blocked: consentBlocked
    },
    200
  );
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
