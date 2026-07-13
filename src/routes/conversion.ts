import type { Env } from '../env';
import {
  logStructured,
  isValidConversionPayload,
  canonicalizeEventName,
  ALLOWED_EVENT_NAMES,
  type ConversionRequestPayload
} from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig, type SiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';
import { hashUserData, type CountryCode, type HashedUserData } from '../lib/hash';
import { sendToMetaCAPI, type MetaCAPIPayload, type MetaCAPIResult } from '../lib/meta';
// Modell 2 (§0/§4.3): az on-site fan-outból a GA4 ÉS a Google Ads láb kikerült.
// On-site GA4 = csak böngésző (GA4 nem dedup-ol event_id-re → dupla lenne).
// On-site Google Ads = csak böngésző (AWCT + Enhanced Conversions). A szerver a
// Google Adset KIZÁRÓLAG offline-ként küldi (routes/lead-status.ts). Meta CAPI +
// a click-ID forwarderek (TikTok/LinkedIn/MsAds) maradnak (event_id-dedup, mint a Meta).
import { sendToTikTok, type TikTokPayload, type TikTokResult } from '../lib/tiktok';
import { sendToLinkedIn, type LinkedInPayload, type LinkedInResult } from '../lib/linkedin';
import { sendToMsAds, type MsAdsPayload, type MsAdsResult } from '../lib/msads';
import { parseConsent, resolveConsent, type ConsentDecision } from '../lib/consent';
import { parseAttribution, buildFbcFromFbclid, type AttributionParams } from '../lib/attribution';
import { isValidProvenance } from '../lib/provenance';
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

// Kanonikus nevek (ingress-normalizálás után). Ezek az events a 60 perces quote-
// alarmot „felülírják": ha aktív quote van, az event a quote event_id-jét/értékét örökli.
const QUOTE_UPGRADE_EVENTS = new Set([
  'callback_request_submitted',
  'phone_number_clicked',
  'email_address_clicked',
  'whatsapp_button_clicked'
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
      recordConversionMetric(env, {
        hostname,
        site_id: 'unknown',
        event_name: 'unknown',
        accepted: false,
        error_code: 'rate_limited',
        total_duration_ms: Date.now() - startedAt
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
    // TRK-EVT-001 ha specifikusan az event_name ismeretlen (nincs az ALLOWED-ban);
    // egyébként strukturális hiba. Mindkettő 204 (a kliens felé nem szivárog hiba).
    const rawName = (payload as { event_name?: unknown } | null)?.event_name;
    const unknownEvent = typeof rawName === 'string' && !ALLOWED_EVENT_NAMES.has(rawName);
    const errorCode = unknownEvent
      ? TrackingErrorCode.UNKNOWN_EVENT_NAME
      : TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE;
    logStructured({
      level: 'info',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    recordConversionMetric(env, {
      hostname,
      site_id: 'unknown',
      // Ismert-formájú de nem engedélyezett event_name mehet blobba (bounded
      // cardinality nem sérül: az AE-riport error_code+hostname szerint aggregál).
      event_name: unknownEvent && typeof rawName === 'string' ? rawName.slice(0, 64) : 'unknown',
      accepted: false,
      error_code: errorCode,
      total_duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  // Ingress-normalizálás (§1 migráció): legacy GA4 alias → kanonikus név, hogy MINDEN
  // downstream (special-case logika, forwarderek, Meta-map, ledger) egységesen a
  // kanonikus nevet lássa. A régi kliensek/tesztek így sem törnek.
  payload.event_name = canonicalizeEventName(payload.event_name);

  // §3 lead_provenance — csak a három engedélyezett érték mehet tovább; bármi más
  // → drop (TRK-PROV-001 warn), de az event maga megy.
  if (payload.lead_provenance !== undefined && !isValidProvenance(payload.lead_provenance)) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.INVALID_LEAD_PROVENANCE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_LEAD_PROVENANCE],
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    payload.lead_provenance = undefined;
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
    recordConversionMetric(env, {
      hostname,
      site_id: 'unknown',
      event_name: payload.event_name,
      accepted: false,
      error_code: TrackingErrorCode.NO_SITE_CONFIG,
      total_duration_ms: Date.now() - startedAt
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
        recordConversionMetric(env, {
          hostname,
          site_id: siteConfig.site_id,
          event_name: payload.event_name,
          accepted: false,
          error_code: TrackingErrorCode.DEGRADED_RATE_LIMITED,
          total_duration_ms: Date.now() - startedAt
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
      recordConversionMetric(env, {
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        accepted: false,
        error_code: errorCode,
        total_duration_ms: Date.now() - startedAt
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

  // Quote-state DO kulcs: client_id (_ga cookie) az elsődleges; ha a GA cookie
  // blokkolt/kései, az fbp a fallback — így a 60 perces halasztott-Lead flow nem
  // esik némán vissza azonnali fan-outra egy third-party cookie-race miatt.
  // A kliens mindkét oldalon (submit + upgrade klikk) ugyanígy küldi őket, így a
  // kulcs konzisztens.
  const quoteKey =
    typeof payload.client_id === 'string'
      ? payload.client_id
      : typeof payload.fbp === 'string'
        ? payload.fbp
        : undefined;

  if (
    payload.event_name === 'quote_calculator_submitted' &&
    typeof payload.value === 'number' &&
    typeof payload.currency === 'string' &&
    typeof payload.service === 'string'
  ) {
    if (quoteKey) {
      return await handleQuoteCompletion(
        {
          ...payload,
          value: payload.value,
          currency: payload.currency,
          service: payload.service
        },
        quoteKey,
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
    // Se client_id, se fbp → nincs stabil DO-kulcs; az event a normál fan-outra
    // esik (azonnali Lead, event_id-dedup a böngésző-pixellel). Logoljuk, hogy a
    // szemantika-váltás látható legyen, ne néma degradáció.
    logStructured({
      level: 'warn',
      message: 'quote_calculator_submitted without client_id/fbp — immediate fan-out (no 60min deferral)',
      hostname,
      site_id: siteConfig.site_id
    });
  }

  const leadId = typeof payload.lead_id === 'string' ? payload.lead_id : undefined;

  let effectivePayload: ConversionRequestPayload = payload;
  if (QUOTE_UPGRADE_EVENTS.has(payload.event_name) && quoteKey) {
    const activeQuote = await getQuoteState(env, quoteKey);
    if (activeQuote) {
      await markQuoteUpgraded(env, quoteKey);
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
    attribution,
    leadId,
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
    degraded,
    duration_ms: totalDuration
  });

  return new Response(null, { status: 204, headers: cors });
}

async function handleQuoteCompletion(
  payload: ConversionRequestPayload & {
    value: number;
    currency: string;
    service: string;
  },
  quoteKey: string,
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
  const previousState = await getQuoteState(env, quoteKey);

  // Az fbc-t már ingest-időben feloldjuk (cookie > fbclid-ből épített) és a
  // state-ben tároljuk az fbp-vel együtt — a +60 perces DO-alarm tüzelésekor a
  // request-kontextus (cookie-k) már nem elérhető, e nélkül a halasztott Lead
  // match-minősége (EMQ) csendben gyengülne.
  const resolvedFbc = payload.fbc || buildFbcFromFbclid(attribution?.fbclid, payload.event_time);

  await setQuoteState(env, quoteKey, {
    client_id: quoteKey,
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
    attribution,
    fbp: payload.fbp,
    fbc: resolvedFbc,
    lead_provenance: payload.lead_provenance
  });

  // ViewContent csak akkor, ha az ad-platform engedett (Meta-only event).
  if (consentDecision.adAllowed && !previousState?.view_content_fired) {
    const viewContentPromise = sendToMetaCAPI(
      siteConfig,
      {
        event_name: 'quote_calculator_opened',
        // UGYANAZ az event_id, mint a quote-é: a böngésző-pixel ViewContent-je is
        // a quote eventId-jével tüzel (spec), és a Meta (event_name, event_id)
        // PÁRON dedup-ol — a korábbi `_vc` suffix miatt a kettő nem dedup-olt,
        // dupla ViewContent-et számolva.
        event_id: payload.event_id,
        event_time: payload.event_time,
        value: payload.value,
        currency: payload.currency,
        source: payload.source,
        event_source_url: payload.event_source_url,
        fbp: payload.fbp,
        fbc: resolvedFbc,
        client_ip: remoteIp,
        client_user_agent: userAgent,
        lead_provenance: payload.lead_provenance
      },
      hashedUserData
    ).then(async (result) => {
      if (result.success) {
        await markViewContentFired(env, quoteKey);
      } else {
        logStructured({
          level: 'warn',
          message: 'ViewContent Meta call failed; not marking view_content_fired (will retry on next quote)',
          site_id: siteConfig.site_id,
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
    quote_key_source: typeof payload.client_id === 'string' ? 'client_id' : 'fbp',
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
  attribution: AttributionParams | undefined,
  leadId: string | undefined,
  env: Env,
  ctx: ExecutionContext
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
    client_user_agent: userAgent,
    lead_provenance: payload.lead_provenance
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
    event_id: payload.event_id,
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
  // Modell 2: NINCS GA4 és NINCS Google Ads on-site láb (a böngésző birtokolja).
  // A szerver a Google Adset kizárólag offline-ként küldi (routes/lead-status.ts).
  const metaStart = Date.now();
  const metaPromise: Promise<MetaCAPIResult> = adAllowed
    ? sendToMetaCAPI(siteConfig, metaPayload, hashedUserData)
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
    tiktokPromise,
    linkedinPromise,
    msadsPromise
  ]).then(
    async (results) => {
      const [metaResult, tiktokResult, linkedinResult, msadsResult] = results;
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
