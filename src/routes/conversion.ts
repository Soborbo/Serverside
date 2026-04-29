import type { Env } from '../env';
import { logStructured, isValidConversionPayload } from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';
import { hashUserData, type CountryCode } from '../lib/hash';
import { sendToMetaCAPI } from '../lib/meta';
import { sendToGA4MP } from '../lib/ga4';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';

export async function handleConversion(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;
  const cors = corsHeaders(request);

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
  const metaPromise = sendToMetaCAPI(
    siteConfig,
    {
      event_name: payload.event_name,
      event_id: payload.event_id,
      event_time: payload.event_time,
      value: payload.value,
      currency: payload.currency,
      source: payload.source,
      event_source_url: payload.event_source_url,
      fbp: payload.fbp,
      fbc: payload.fbc,
      client_ip: remoteIp,
      client_user_agent: userAgent
    },
    hashedUserData
  );

  const ga4Promise = sendToGA4MP(siteConfig, {
    event_name: payload.event_name,
    event_id: payload.event_id,
    client_id: payload.client_id,
    value: payload.value,
    currency: payload.currency,
    source: payload.source,
    service: payload.service,
    page_location: payload.event_source_url,
    user_agent: userAgent
  });

  const fanout = Promise.allSettled([metaPromise, ga4Promise]).then((results) => {
    const [metaResult, ga4Result] = results;
    logStructured({
      level: 'info',
      message: 'Fan-out completed',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
      ga4_success: ga4Result.status === 'fulfilled' && ga4Result.value.success
    });
  });

  ctx.waitUntil(fanout);

  logStructured({
    level: 'info',
    message: 'Conversion event accepted',
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: cors });
}
