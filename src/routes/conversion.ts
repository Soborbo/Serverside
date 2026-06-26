import type { Env } from '../env';
import { logStructured, isValidConversionPayload, type ConversionRequestPayload } from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig, type SiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';
import { hashUserData, type CountryCode, type HashedUserData } from '../lib/hash';
import { sendToMetaCAPI, type MetaCAPIPayload, type MetaCAPIResult } from '../lib/meta';
import { sendToGA4MP, type GA4Payload } from '../lib/ga4';
import { sendToGoogleAdsCAPI, type GAdsPayload, type GAdsResult } from '../lib/gads';
import { parseConsent, resolveConsent, type ConsentDecision } from '../lib/consent';
import { parseAttribution, buildFbcFromFbclid, type AttributionParams } from '../lib/attribution';
import { enqueueFailure, type Platform } from '../lib/deadletter';
import {
  setQuoteState,
  getQuoteState,
  markQuoteUpgraded,
  markViewContentFired
} from '../lib/quote-state';
import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY } from '../lib/error-codes';
import { recordFanoutMetric, recordConversionMetric } from '../lib/metrics';
import { sendAlert } from '../lib/notify';

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
  if (!turnstileResult.valid) {
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
    env,
    ctx
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
  env: Env,
  ctx: ExecutionContext
): void {
  const adAllowed = consentDecision.adAllowed;

  // Meta fbc: a kliens _fbc cookie-ja elsődleges; ha nincs, fbclid-ből építjük.
  const fbc = payload.fbc || buildFbcFromFbclid(attribution?.fbclid, payload.event_time);

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
    consent: consentDecision.consent,
    gclid: attribution?.gclid,
    gbraid: attribution?.gbraid,
    wbraid: attribution?.wbraid
  };

  // adAllowed=false → Meta + Google Ads no-op success (nincs hívás, nincs DLQ).
  const metaStart = Date.now();
  const metaPromise: Promise<MetaCAPIResult> = adAllowed
    ? sendToMetaCAPI(siteConfig, metaPayload, hashedUserData)
    : Promise.resolve({ success: true });
  const ga4Start = Date.now();
  const ga4Promise = sendToGA4MP(siteConfig, ga4Payload);
  const gadsStart = Date.now();
  const gadsPromise: Promise<GAdsResult> = adAllowed
    ? sendToGoogleAdsCAPI(siteConfig, env, gadsPayload, hashedUserData)
    : Promise.resolve({ success: true });

  const fanout = Promise.allSettled([metaPromise, ga4Promise, gadsPromise]).then(
    async (results) => {
      const [metaResult, ga4Result, gadsResult] = results;
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

      await Promise.allSettled([...dlqWrites, ...alerts]);

      logStructured({
        level: 'info',
        message: 'Fan-out completed',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
        ga4_success: ga4Result.status === 'fulfilled' && ga4Result.value.success,
        gads_success: gadsResult.status === 'fulfilled' && gadsResult.value.success,
        platforms_failed: dlqWrites.length
      });
    }
  );

  ctx.waitUntil(fanout);
}
