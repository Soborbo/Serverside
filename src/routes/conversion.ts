import type { Env } from '../env';
import { logStructured, isValidConversionPayload, type ConversionRequestPayload } from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig, type SiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';
import { hashUserData, type CountryCode, type HashedUserData } from '../lib/hash';
import { sendToMetaCAPI, type MetaCAPIPayload, type MetaCAPIResult } from '../lib/meta';
import { sendToGA4MP, type GA4Payload, type GA4Result } from '../lib/ga4';
import { sendToGoogleAdsCAPI, type GAdsPayload, type GAdsResult } from '../lib/gads';
import { sendToTikTok, type TikTokPayload, type TikTokResult } from '../lib/tiktok';
import { sendToLinkedIn, type LinkedInPayload, type LinkedInResult } from '../lib/linkedin';
import { sendToMsAds, type MsAdsPayload, type MsAdsResult } from '../lib/msads';
import { parseConsent, resolveConsent, type ConsentDecision } from '../lib/consent';
import { parseAttribution, buildFbcFromFbclid, type AttributionParams } from '../lib/attribution';
import { enqueueFailure, type Platform } from '../lib/deadletter';
import { isTokenlessLowRiskAcceptable, degradedRateLimit } from '../lib/degraded';
import {
  setQuoteState,
  getQuoteState,
  markQuoteUpgraded,
  markViewContentFired
} from '../lib/quote-state';
import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY } from '../lib/error-codes';
import { recordFanoutMetric, recordConversionMetric } from '../lib/metrics';
import { sendAlert } from '../lib/notify';
import {
  checkIdempotency,
  markDispatched,
  recordEventRaw,
  recordConsentReceipt,
  recordDeliveries,
  normalizeDelivery,
  type DeliveryRecord
} from '../lib/ledger';

const QUOTE_UPGRADE_EVENTS = new Set([
  'callback_conversion',
  'phone_conversion',
  'email_conversion',
  'whatsapp_conversion'
]);

export async function handleConversion(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;
  const cors = corsHeaders(request, env);

  // Natív rate limiting (H2) — Turnstile a botokat fogja, de egy scriptelt
  // forrást nem. IP+hostname kulcs: egy site/IP nem meríti ki a többit.
  // Guarded: ha nincs binding, kimarad.
  if (env.INGEST_LIMITER) {
    const rlIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.INGEST_LIMITER.limit({ key: `${hostname}:${rlIp}` });
    if (!success) {
      logStructured({
        level: 'info',
        message: 'Rate limited',
        hostname,
        duration_ms: Date.now() - startedAt
      });
      return new Response(null, { status: 429, headers: cors });
    }
  }

  // Reject oversized bodies before parsing — guards against DLQ/AE flooding
  // via large user_data payloads.
  const MAX_BODY_BYTES = 16 * 1024;
  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return new Response(null, { status: 204, headers: cors });
    }
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.INVALID_JSON,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_JSON],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  if (!isValidConversionPayload(payload)) {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.NO_SITE_CONFIG,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.NO_SITE_CONFIG],
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    return new Response('Not configured', { status: 404, headers: cors });
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;
  const turnstileResult = await validateTurnstile(payload.turnstile_token, remoteIp, env);
  let degraded = false;
  if (!turnstileResult.valid) {
    // TASK 2 — degradált elfogadás: token-NÉLKÜLI (vagy Turnstile-elérhetetlen)
    // ALACSONY-kockázatú event (tel:/mailto:/whatsapp) → rate-limitelt elfogadás,
    // hogy a money-signal (köztük a phone) ne vesszen el. A token-nélküli
    // form-submit + az ÉRVÉNYTELEN token továbbra is kemény 403.
    if (isTokenlessLowRiskAcceptable(turnstileResult.errorCodes, payload.event_name)) {
      const rlKey = `degraded:${hostname}:${remoteIp || 'unknown'}`;
      if (!(await degradedRateLimit(env, rlKey))) {
        logStructured({
          level: 'info',
          error_code: TrackingErrorCode.DEGRADED_RATE_LIMITED,
          message: ERROR_DESCRIPTIONS[TrackingErrorCode.DEGRADED_RATE_LIMITED],
          hostname,
          site_id: siteConfig.site_id,
          event_name: payload.event_name,
          duration_ms: Date.now() - startedAt
        });
        return new Response(null, { status: 429, headers: cors });
      }
      degraded = true;
      logStructured({
        level: 'info',
        error_code: TrackingErrorCode.DEGRADED_TOKENLESS_ACCEPTED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.DEGRADED_TOKENLESS_ACCEPTED],
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        turnstile_codes: turnstileResult.errorCodes?.join(',') || 'unknown'
      });
      // tovább a normál feldolgozásra (consent + fan-out + Queues/DLQ)
    } else {
      const isMissing = turnstileResult.errorCodes?.includes('missing_token') === true;
      const errorCode = isMissing
        ? TrackingErrorCode.MISSING_TURNSTILE_TOKEN
        : TrackingErrorCode.INVALID_TURNSTILE_TOKEN;
      logStructured({
        level: 'info',
        error_code: errorCode,
        message: ERROR_DESCRIPTIONS[errorCode],
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        error: turnstileResult.errorCodes?.join(',') || 'unknown',
        duration_ms: Date.now() - startedAt
      });
      return new Response('Invalid token', { status: 403, headers: cors });
    }
  }

  const hashedUserData = await hashUserData(
    payload.user_data || {},
    siteConfig.country_code as CountryCode
  );

  const userAgent = request.headers.get('User-Agent') || undefined;

  // Consent feloldása (Consent Mode v2). adAllowed=false → Meta + Google Ads
  // konverzió tiltva (GDPR). GA4 mindig megy, consent-jelekkel.
  const consentState = parseConsent(payload.consent);
  const consentDecision = resolveConsent(consentState, siteConfig.require_consent === true);
  const attribution = parseAttribution(payload.attribution);
  // session_id a GA4 numerikus session timestamp — bound + charset check, hogy
  // ne továbbítsunk korlátlan attacker-stringet a GA4 MP felé.
  const sessionId =
    typeof payload.session_id === 'string' && /^\d{1,20}$/.test(payload.session_id)
      ? payload.session_id
      : undefined;

  if (
    payload.event_name === 'quote_calculator_conversion' &&
    typeof payload.client_id === 'string' &&
    typeof payload.value === 'number' &&
    typeof payload.currency === 'string' &&
    typeof payload.service === 'string'
  ) {
    return await handleQuoteCompletion(
      {
        ...payload,
        client_id: payload.client_id,
        value: payload.value,
        currency: payload.currency,
        service: payload.service
      },
      siteConfig,
      hashedUserData,
      hostname,
      remoteIp,
      userAgent,
      consentDecision,
      attribution,
      env,
      ctx,
      cors,
      startedAt
    );
  }

  const leadId = typeof payload.lead_id === 'string' ? payload.lead_id : undefined;

  let effectivePayload: ConversionRequestPayload = payload;
  if (QUOTE_UPGRADE_EVENTS.has(payload.event_name) && typeof payload.client_id === 'string') {
    const activeQuote = await getQuoteState(env, payload.client_id);
    if (activeQuote) {
      await markQuoteUpgraded(env, payload.client_id);
      effectivePayload = {
        ...payload,
        event_id: activeQuote.event_id,
        value: activeQuote.value,
        currency: activeQuote.currency,
        service: activeQuote.service
      };
      logStructured({
        level: 'info',
        message: 'Quote upgraded by downstream event',
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        upgraded_event_id: activeQuote.event_id
      });
    }
  }

  // Gateway-ingress idempotencia (NEM vendor-dedup): ugyanaz a submit 5× (dupla
  // klikk, retry, hálózati gond) → a fan-out csak egyszer fut. Fail-open: D1-hiba
  // vagy hiányzó binding esetén dispatch-elünk. A kliens felé mindkét esetben 204.
  const idem = await checkIdempotency(
    env,
    siteConfig.site_id,
    effectivePayload.event_name,
    effectivePayload.event_id
  );
  if (!idem.shouldDispatch) {
    const dupDuration = Date.now() - startedAt;
    recordConversionMetric(env, {
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      accepted: true,
      total_duration_ms: dupDuration
    });
    logStructured({
      level: 'info',
      message: 'Duplicate conversion suppressed by idempotency',
      hostname,
      site_id: siteConfig.site_id,
      event_name: effectivePayload.event_name,
      seen_count: idem.seenCount,
      duration_ms: dupDuration
    });
    return new Response(null, { status: 204, headers: cors });
  }

  fanOut(
    effectivePayload,
    siteConfig,
    hashedUserData,
    hostname,
    remoteIp,
    userAgent,
    consentDecision,
    sessionId,
    attribution,
    leadId,
    env,
    ctx,
    idem.suppressGa4
  );

  const totalDuration = Date.now() - startedAt;
  recordConversionMetric(env, {
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    accepted: true,
    total_duration_ms: totalDuration
  });

  logStructured({
    level: 'info',
    message: 'Conversion event accepted',
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    degraded,
    duration_ms: totalDuration
  });

  return new Response(null, { status: 204, headers: cors });
}

async function handleQuoteCompletion(
  payload: ConversionRequestPayload & {
    client_id: string;
    value: number;
    currency: string;
    service: string;
  },
  siteConfig: SiteConfig,
  hashedUserData: HashedUserData,
  hostname: string,
  remoteIp: string | undefined,
  userAgent: string | undefined,
  consentDecision: ConsentDecision,
  attribution: AttributionParams | undefined,
  env: Env,
  ctx: ExecutionContext,
  cors: HeadersInit,
  startedAt: number
): Promise<Response> {
  const previousState = await getQuoteState(env, payload.client_id);

  await setQuoteState(env, payload.client_id, {
    client_id: payload.client_id,
    value: payload.value,
    currency: payload.currency,
    service: payload.service,
    completed_at: Date.now(),
    event_time: payload.event_time,
    event_id: payload.event_id,
    user_data: hashedUserData,
    hostname,
    consent: consentDecision.consent,
    ad_allowed: consentDecision.adAllowed,
    attribution
  });

  // ViewContent csak akkor, ha az ad-platform engedett (Meta-only event).
  if (consentDecision.adAllowed && !previousState?.view_content_fired) {
    const viewContentPromise = sendToMetaCAPI(
      siteConfig,
      {
        event_name: 'quote_calculator_first_view',
        event_id: `${payload.event_id}_vc`,
        event_time: payload.event_time,
        value: payload.value,
        currency: payload.currency,
        source: payload.source,
        event_source_url: payload.event_source_url,
        fbp: payload.fbp,
        fbc: payload.fbc || buildFbcFromFbclid(attribution?.fbclid, payload.event_time),
        client_ip: remoteIp,
        client_user_agent: userAgent
      },
      hashedUserData
    ).then(async (result) => {
      if (result.success) {
        await markViewContentFired(env, payload.client_id);
      } else {
        logStructured({
          level: 'warn',
          message: 'ViewContent Meta call failed; not marking view_content_fired (will retry on next quote)',
          site_id: siteConfig.site_id,
          client_id: payload.client_id,
          error_code: result.error_code
        });
      }
    });

    ctx.waitUntil(viewContentPromise);
  }

  logStructured({
    level: 'info',
    message: 'Quote state stored, 60min DO alarm set',
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    client_id: payload.client_id,
    fired_view_content: !previousState?.view_content_fired,
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: cors });
}

function fanOut(
  payload: ConversionRequestPayload,
  siteConfig: SiteConfig,
  hashedUserData: HashedUserData,
  hostname: string,
  remoteIp: string | undefined,
  userAgent: string | undefined,
  consentDecision: ConsentDecision,
  sessionId: string | undefined,
  attribution: AttributionParams | undefined,
  leadId: string | undefined,
  env: Env,
  ctx: ExecutionContext,
  suppressGa4: boolean
): void {
  try {
  const adAllowed = consentDecision.adAllowed;

  // Meta fbc: a kliens _fbc cookie-ja elsődleges; ha nincs, fbclid-ből építjük.
  const fbc = payload.fbc || buildFbcFromFbclid(attribution?.fbclid, payload.event_time);

  // Ledger: az elfogadott event nyers rekordja + consent receipt (NEM PII;
  // csak az `em/ph` jelenléti flag-ek a match-quality audithoz). Fire-and-forget.
  ctx.waitUntil(
    recordEventRaw(env, {
      event_id: payload.event_id,
      lead_id: leadId,
      site_id: siteConfig.site_id,
      hostname,
      event_name: payload.event_name,
      event_time: payload.event_time,
      value: payload.value,
      currency: payload.currency,
      ad_allowed: adAllowed,
      em_present: Boolean(hashedUserData.em),
      ph_present: Boolean(hashedUserData.ph)
    })
  );
  ctx.waitUntil(
    recordConsentReceipt(env, {
      event_id: payload.event_id,
      lead_id: leadId,
      site_id: siteConfig.site_id,
      consent: consentDecision.consent,
      require_consent: siteConfig.require_consent === true,
      ad_allowed: adAllowed
    })
  );

  const metaPayload: MetaCAPIPayload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    source: payload.source,
    event_source_url: payload.event_source_url,
    fbp: payload.fbp,
    fbc,
    client_ip: remoteIp,
    client_user_agent: userAgent
  };

  const ga4Payload: GA4Payload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    client_id: payload.client_id,
    value: payload.value,
    currency: payload.currency,
    source: payload.source,
    service: payload.service,
    page_location: payload.event_source_url,
    user_agent: userAgent,
    session_id: sessionId,
    consent: consentDecision.consent,
    attribution
  };

  const gadsPayload: GAdsPayload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    city: payload.user_data?.city,
    postal_code: payload.user_data?.postal_code,
    country: payload.user_data?.country,
    consent: consentDecision.consent,
    gclid: attribution?.gclid,
    gbraid: attribution?.gbraid,
    wbraid: attribution?.wbraid
  };

  // TASK 3 — click-ID forwarderek. A click ID-k a validált `attribution`
  // paraméterből jönnek (parseAttribution: charset + hossz-bound). Mind
  // opcionális; a forwarder no-op, ha a site nincs konfigurálva az adott
  // platformra VAGY hiányzik a click ID.
  const tiktokPayload: TikTokPayload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    event_source_url: payload.event_source_url,
    ttclid: attribution?.ttclid,
    client_ip: remoteIp,
    client_user_agent: userAgent
  };
  const linkedinPayload: LinkedInPayload = {
    event_name: payload.event_name,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    li_fat_id: attribution?.li_fat_id
  };
  const msadsPayload: MsAdsPayload = {
    event_name: payload.event_name,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    msclkid: attribution?.msclkid
  };

  // adAllowed=false → minden ad-platform no-op success (nincs hívás, nincs DLQ).
  const metaStart = Date.now();
  const metaPromise: Promise<MetaCAPIResult> = adAllowed
    ? sendToMetaCAPI(siteConfig, metaPayload, hashedUserData)
    : Promise.resolve({ success: true });
  const ga4Start = Date.now();
  // GA4 nem dedup-ol event_id-re (#16) → in-flight dupla-submitnél a GA4-leget
  // kihagyjuk (skipped success), hogy ne duplázódjon a konverzió/revenue.
  const ga4Promise: Promise<GA4Result> = suppressGa4
    ? Promise.resolve({ success: true, skipped: true })
    : sendToGA4MP(siteConfig, ga4Payload);
  const gadsStart = Date.now();
  const gadsPromise: Promise<GAdsResult> = adAllowed
    ? sendToGoogleAdsCAPI(siteConfig, env, gadsPayload, hashedUserData)
    : Promise.resolve({ success: true });
  const tiktokStart = Date.now();
  const tiktokPromise: Promise<TikTokResult> = adAllowed
    ? sendToTikTok(siteConfig, tiktokPayload, hashedUserData)
    : Promise.resolve({ success: true });
  const linkedinStart = Date.now();
  const linkedinPromise: Promise<LinkedInResult> = adAllowed
    ? sendToLinkedIn(siteConfig, linkedinPayload, hashedUserData)
    : Promise.resolve({ success: true });
  const msadsStart = Date.now();
  const msadsPromise: Promise<MsAdsResult> = adAllowed
    ? sendToMsAds(siteConfig, msadsPayload, hashedUserData)
    : Promise.resolve({ success: true });

  const fanout = Promise.allSettled([
    metaPromise,
    ga4Promise,
    gadsPromise,
    tiktokPromise,
    linkedinPromise,
    msadsPromise
  ]).then(
    async (results) => {
      const [metaResult, ga4Result, gadsResult, tiktokResult, linkedinResult, msadsResult] =
        results;
      const completedAt = Date.now();
      const nowIso = new Date(completedAt).toISOString();
      const dlqWrites: Promise<void>[] = [];
      const alerts: Promise<void>[] = [];

      const handleResult = (
        platform: Platform,
        result: (typeof results)[number],
        platformPayload: Record<string, unknown>,
        includeUserData: boolean,
        platformStart: number
      ) => {
        const success =
          result.status === 'fulfilled' && result.value.success;
        const errorCode =
          result.status === 'fulfilled' ? result.value.error_code : undefined;

        recordFanoutMetric(env, {
          site_id: siteConfig.site_id,
          event_name: payload.event_name,
          platform,
          success,
          duration_ms: completedAt - platformStart,
          error_code: errorCode
        });

        if (errorCode && ERROR_SEVERITY[errorCode] === 'critical') {
          alerts.push(
            sendAlert(env, errorCode, {
              site_id: siteConfig.site_id,
              hostname,
              platform,
              event_name: payload.event_name
            })
          );
        }

        if (success) return;
        const reason =
          result.status === 'rejected'
            ? String(result.reason)
            : result.value.error || 'unknown';
        dlqWrites.push(
          enqueueFailure(env, {
            platform,
            site_id: siteConfig.site_id,
            hostname,
            event_payload: platformPayload,
            hashed_user_data: includeUserData
              ? (hashedUserData as unknown as Record<string, unknown>)
              : undefined,
            failure_reason: reason,
            retry_count: 0,
            first_failed_at: nowIso,
            last_attempted_at: nowIso
          })
        );
      };

      handleResult(
        'meta',
        metaResult,
        metaPayload as unknown as Record<string, unknown>,
        true,
        metaStart
      );
      handleResult(
        'ga4',
        ga4Result,
        ga4Payload as unknown as Record<string, unknown>,
        false,
        ga4Start
      );
      handleResult(
        'gads',
        gadsResult,
        gadsPayload as unknown as Record<string, unknown>,
        true,
        gadsStart
      );
      // TASK 3 — extra platformok. TikTok/LinkedIn hashed user_data-t használ a
      // matcheléshez → includeUserData=true (DLQ-retry-hoz). Microsoft csak
      // msclkid → false.
      handleResult('tiktok', tiktokResult, tiktokPayload as unknown as Record<string, unknown>, true, tiktokStart);
      handleResult('linkedin', linkedinResult, linkedinPayload as unknown as Record<string, unknown>, true, linkedinStart);
      handleResult('msads', msadsResult, msadsPayload as unknown as Record<string, unknown>, false, msadsStart);

      // Normalizált vendor-kézbesítés a ledgerbe (#9). adAllowed=false → minden
      // ad-platform 'skipped' (consent-tiltás, nem hiba); a GA4 mindig megy.
      const deliveryRecords: DeliveryRecord[] = [
        normalizeDelivery('meta', metaResult, { skipped: !adAllowed }),
        normalizeDelivery('ga4', ga4Result),
        normalizeDelivery('gads', gadsResult, { skipped: !adAllowed }),
        normalizeDelivery('tiktok', tiktokResult, { skipped: !adAllowed }),
        normalizeDelivery('linkedin', linkedinResult, { skipped: !adAllowed }),
        normalizeDelivery('msads', msadsResult, { skipped: !adAllowed })
      ];

      await Promise.allSettled([
        ...dlqWrites,
        ...alerts,
        recordDeliveries(env, {
          event_id: payload.event_id,
          lead_id: leadId,
          site_id: siteConfig.site_id,
          event_name: payload.event_name,
          origin: 'fanout',
          records: deliveryRecords
        })
      ]);

      // A fan-out lefutott → jelöljük kézbesítettnek (idempotencia). Csak ezután,
      // hogy egy crash-elt, soha-le-nem-kézbesített event újraküldhető maradjon.
      await markDispatched(env, siteConfig.site_id, payload.event_name, payload.event_id);

      logStructured({
        level: 'info',
        message: 'Fan-out completed',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
        ga4_success: ga4Result.status === 'fulfilled' && ga4Result.value.success,
        gads_success: gadsResult.status === 'fulfilled' && gadsResult.value.success,
        tiktok_success: tiktokResult.status === 'fulfilled' && tiktokResult.value.success,
        linkedin_success: linkedinResult.status === 'fulfilled' && linkedinResult.value.success,
        msads_success: msadsResult.status === 'fulfilled' && msadsResult.value.success,
        platforms_failed: dlqWrites.length
      });
    }
  );

  ctx.waitUntil(fanout);
  } catch (setupErr) {
    // A fan-out SZINKRON felépítése dobott (rendkívül ritka — pure payload-építés).
    // A platform-hívások amúgy is Promise.allSettled+DLQ mögött vannak; ide csak egy
    // váratlan setup-hiba juthat. Ne némán: CRITICAL log + alert, hogy az event ne
    // tűnjön el nyom nélkül (a top-level catch különben 204-et adna némán).
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.FANOUT_SETUP_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.FANOUT_SETUP_FAILED],
      site_id: siteConfig.site_id,
      hostname,
      event_name: payload.event_name,
      error: setupErr instanceof Error ? setupErr.message : String(setupErr)
    });
    ctx.waitUntil(
      sendAlert(env, TrackingErrorCode.FANOUT_SETUP_FAILED, {
        site_id: siteConfig.site_id,
        hostname,
        event_name: payload.event_name
      })
    );
  }
}
