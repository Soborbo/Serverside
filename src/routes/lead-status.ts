import type { Env } from '../env';
import { logStructured } from '../types';
import { getSiteConfig } from '../lib/config';
import { authenticateLeadStatus } from '../lib/admin-auth';
import {
  hashUserDataForGoogle,
  mapPrehashedUserData,
  sha256Hex,
  type CountryCode,
  type HashedUserData,
  type PlainUserData
} from '../lib/hash';
import { type GAdsPayload } from '../lib/gads';
import { sendToDataManager } from '../lib/datamanager';
import { enqueueFailure } from '../lib/deadletter';
import { sendAlert } from '../lib/notify';
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
  // F3-D · Prehashed PII contract a lifecycle-lábhoz. A CRM outbox CSAK SHA-256
  // hash-eket tárol (nyers email/telefon soha), és a Google-normalizált hash-eket
  // (`email_sha256_google` = Gmail dot/plus strip) ITT küldi, hogy a gateway NE
  // hash-eljen újra (dupla hash → néma Google EC match-rate esés). Kölcsönösen
  // kizáró a `user_data` NYERS identity-mezőivel (email/telefon/név) — a plain CÍM
  // (postal_code/country) viszont a `user_data`-ban marad (a Data Manager plain-t
  // vár rájuk). Az endpoint teljes egészében admin-auth (szerver-szerver), ezért —
  // a /conversion-server böngésző-ágával ellentétben — nincs külön serverIngress-kapu.
  user_data_hashed?: Record<string, unknown>;
  // A CRM ad-consent jele a leadre (a CRM marketingConsent-jéből). FALLBACK:
  // a Worker saját consent-receiptje (explicit GRANTED/DENIED capture-kori jel)
  // MEGELŐZI — a CRM marketingConsent-je newsletter-optin szemantikájú, és a
  // 2026-07-17-es consent-audit szerint a site-ok soha nem töltik a CookieYes
  // ad-consentből, így önmagában minden uploadot némán blokkolna.
  ad_allowed?: boolean;
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
  // ad_allowed: ha jelen van, csak boolean lehet (a CRM autoritatív consentje).
  if (p.ad_allowed !== undefined && typeof p.ad_allowed !== 'boolean') return null;

  // user_data_hashed: objektum, de NEM tömb (a mező-tartalmi hash-validáció a
  // handlerben, mapPrehashedUserData-val — az fail-loud hibás mezőnévvel).
  if (
    p.user_data_hashed !== undefined &&
    (typeof p.user_data_hashed !== 'object' ||
      p.user_data_hashed === null ||
      Array.isArray(p.user_data_hashed))
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
    user_data: p.user_data as PlainUserData | undefined,
    user_data_hashed: p.user_data_hashed as Record<string, unknown> | undefined,
    ad_allowed: p.ad_allowed as boolean | undefined
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

  // ── F3-D · Prehashed PII contract ────────────────────────────────────────
  // A CRM lifecycle-outbox a Google-normalizált hash-eket küldi (`user_data_hashed`),
  // hogy a gateway NE hash-eljen újra. Fail-loud: hibás hash / kettős identity-forrás
  // → 400 (a néma pass-through Google EC match-et rontana jel nélkül). Az identity
  // (email/telefon/név) prehashed; a plain CÍM (postal_code/country) a user_data-ban
  // marad — a kettő diszjunkt, ezért együtt élhet.
  let prehashedUserData: HashedUserData | null = null;
  if (body.user_data_hashed) {
    const ud = body.user_data ?? {};
    const rawIdentityPresent = !!(ud.email || ud.phone_number || ud.first_name || ud.last_name);
    if (rawIdentityPresent) {
      logStructured({
        level: 'info',
        error_code: TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA],
        hostname,
        site_id: siteConfig.site_id,
        event_name: eventName,
        duration_ms: Date.now() - startedAt
      });
      return json({ error: 'user_data and user_data_hashed are mutually exclusive' }, 400);
    }
    const mapped = mapPrehashedUserData(body.user_data_hashed);
    if ('invalidField' in mapped) {
      logStructured({
        level: 'info',
        error_code: TrackingErrorCode.INVALID_PREHASHED_USER_DATA,
        // A mezőNÉV nem PII (a hash-érték sem az) — a konkrét mező kell a CRM-nek.
        message: `${ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_PREHASHED_USER_DATA]} (${mapped.invalidField})`,
        hostname,
        site_id: siteConfig.site_id,
        event_name: eventName,
        duration_ms: Date.now() - startedAt
      });
      return json({ error: `invalid_user_data_hashed`, field: mapped.invalidField }, 400);
    }
    prehashedUserData = mapped.data;
  }

  const occurredAtIso = body.occurred_at ?? new Date().toISOString();
  const eventTimeSec = Math.floor(Date.parse(occurredAtIso) / 1000);

  // GDPR-kapu, precedencia szerint (2026-07-17 consent-audit):
  //  1. A Worker SAJÁT consent-receiptje, ha EXPLICIT capture-kori jelet hordoz
  //     (ad_user_data GRANTED/DENIED). Ez az időbélyeges, bizonyítható consent —
  //     a szerver-ingress dispatch óta a receipt hordozza a CRM lead_id-t.
  //     (A korábbi „a receipt lead_id=NULL-lal íródik" premissza HAMIS volt, és a
  //     CRM newsletter-szemantikájú marketingConsent-je — amit a site-ok soha nem
  //     töltenek a CookieYes ad-consentből — némán blokkolt minden uploadot.)
  //  2. A CRM ad_allowed jele — fallback, ha nincs explicit receipt (telefonos/
  //     manuális lead, vagy fail-open site consent-objektum nélküli receipttel).
  //  3. require_consent fail-closed: kötelező consent + semmilyen jel → tiltott.
  // A jel nélküli receipt ad_allowed=1-e NEM evidencia (fail-open default is adhatja).
  const leadConsent = await getLatestConsentForLead(env, siteConfig.site_id, body.lead_id);
  const receiptSignal =
    leadConsent?.ad_user_data === 'GRANTED' || leadConsent?.ad_user_data === 'DENIED'
      ? leadConsent.ad_user_data
      : null;
  let consentBlocked: boolean;
  let consentSource: 'receipt' | 'crm' | 'fallback';
  if (receiptSignal !== null) {
    consentBlocked = receiptSignal === 'DENIED';
    consentSource = 'receipt';
  } else if (body.ad_allowed !== undefined) {
    consentBlocked = body.ad_allowed === false;
    consentSource = 'crm';
  } else {
    consentBlocked = isOfflineUploadBlocked(leadConsent, siteConfig.require_consent === true);
    consentSource = 'fallback';
  }

  // Ütközésbiztos, determinisztikus orderId: a (lead_id, status) SHA-256-ja —
  // ez megy a Google Ads offline uploadnak event_id-ként (transactionId).
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
      has_consent_record: leadConsent !== null,
      consent_source: consentSource
    });
  } else if (siteConfig.gads.customer_id) {
    // Model 2: the server is Google-Ads-offline-only (Enhanced Conversions for
    // Leads), delivered via the Data Manager API. The email hash MUST use the
    // Google normalization (Gmail dot/plus strip), NOT the Meta rule.
    // F3-D: a CRM lifecycle-outbox már Google-normalizált hash-eket küld
    // (`user_data_hashed`) → ilyenkor NEM hash-elünk újra (nincs dupla-hash). Plain
    // user_data esetén (pl. telefonos/manuális lead) a gateway hash-el, mint eddig.
    const hashed =
      prehashedUserData ??
      (await hashUserDataForGoogle(body.user_data ?? {}, siteConfig.country_code as CountryCode));
    // Consent Mode jelek a Data Manager eventre. EEA/DMA alatt a jelöletlen
    // (unspecified) consentű eventet a Google csendben kizárhatja az ads-
    // mérésből — ha van POZITÍV consent-evidenciánk (explicit GRANTED receipt a
    // capture-ből, vagy a CRM ad_allowed=true jele), azt explicit
    // CONSENT_GRANTED-ként továbbítjuk. Evidencia nélkül (fail-open site jel
    // nélküli receipttel) a mező kimarad — consentet nem találunk ki.
    const consentEvidence = receiptSignal === 'GRANTED' || body.ad_allowed === true;
    const gadsPayload: GAdsPayload = {
      event_name: eventName,
      event_id: orderId,
      event_time: eventTimeSec,
      value: body.value,
      currency: body.currency ?? siteConfig.currency,
      // city is dropped by the Data Manager (no AddressInfo.city field); only
      // postal_code/country (plain) are carried into the address identifier.
      postal_code: body.user_data?.postal_code ?? undefined,
      country: body.user_data?.country ?? undefined,
      consent: consentEvidence
        ? { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' }
        : undefined
    };
    const result = await sendToDataManager(siteConfig, env, gadsPayload, hashed);
    // `skipped` (nincs conversion action / nincs identifier) NEM upload — ha
    // success-ként könyvelnénk, a válasz `uploaded_to_gads: true`-t hazudna egy
    // soha el nem indult hívásról, és a CRM/ledger sosem jelezné a hiányt.
    uploadedToGads = result.success && result.skipped !== true;
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

    // A sikertelen offline Data Manager upload (tranziens 5xx/timeout) → DLQ, hogy a
    // retry (worker.ts queue() / scheduled retry → retrySingle, sendToDataManager)
    // visszanyerje. Enélkül egy átmeneti hiba VÉGLEG elveszítené az Enhanced
    // Conversion-t (P0: „melyik leadből lett valódi pénz"). event_id-vel dedup-ol.
    if (!result.success) {
      const nowIso = new Date().toISOString();
      const leadIdForDlq = body.lead_id;
      const statusForLog = body.status;
      ctx.waitUntil(
        enqueueFailure(env, {
          platform: 'gads',
          site_id: siteConfig.site_id,
          hostname,
          lead_id: leadIdForDlq,
          event_payload: gadsPayload as unknown as Record<string, unknown>,
          hashed_user_data: hashed as unknown as Record<string, unknown>,
          failure_reason: result.error || gadsErrorCode || 'unknown',
          retry_count: 0,
          first_failed_at: nowIso,
          last_attempted_at: nowIso
        }).then((stored): Promise<void> | void => {
          // Hármas kiesés (Data Manager fail + Queue fail + R2 fail): a retry-
          // példány SEHOL sincs, és a CRM már 200-at kapott (uploaded_to_gads:
          // false), tehát nem fog retry-olni → a visszanyerés útja a CRITICAL
          // riasztás nyomán kézi újraküldés a CRM-ből. Ugyanaz a védelem, mint a
          // fan-out RETRY_PERSIST_FAILED őre (conversion.ts).
          if (!stored) {
            logStructured({
              level: 'error',
              error_code: TrackingErrorCode.RETRY_PERSIST_FAILED,
              message: ERROR_DESCRIPTIONS[TrackingErrorCode.RETRY_PERSIST_FAILED],
              site_id: siteConfig.site_id,
              hostname,
              event_name: eventName,
              lead_status: statusForLog
            });
            return sendAlert(env, TrackingErrorCode.RETRY_PERSIST_FAILED, {
              site_id: siteConfig.site_id,
              hostname,
              platform: 'gads',
              event_name: eventName,
              lead_status: statusForLog
            }).catch(() => {});
          }
        })
      );
    }
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
    // Az offline GA4 láb kikapcsolt (Run 6): client_id nélkül minden státusz új
    // szintetikus GA4-clientbe esett volna. A mező a válasz-séma stabilitásáért
    // marad, értéke definíció szerint false.
    uploaded_to_ga4: false,
    consent_blocked: consentBlocked,
    consent_source: consentSource,
    duration_ms: Date.now() - startedAt
  });

  return json(
    {
      ok: true,
      uploaded_to_gads: uploadedToGads,
      uploaded_to_ga4: false,
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
