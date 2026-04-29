import type { Env } from '../env';
import { logStructured, isValidConversionPayload } from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig } from '../lib/config';
import { validateTurnstile } from '../lib/turnstile';

export async function handleConversion(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
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
      level: 'warn',
      message: 'Invalid JSON in conversion request',
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  if (!isValidConversionPayload(payload)) {
    logStructured({
      level: 'warn',
      message: 'Invalid conversion payload structure',
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 204, headers: cors });
  }

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    logStructured({
      level: 'warn',
      message: 'No site config found for hostname',
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    return new Response('Not configured', { status: 404, headers: cors });
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;
  const turnstileResult = await validateTurnstile(payload.turnstile_token, remoteIp, env);

  if (!turnstileResult.valid) {
    logStructured({
      level: 'warn',
      message: 'Turnstile validation failed',
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: turnstileResult.errorCodes?.join(',') || 'unknown',
      duration_ms: Date.now() - startedAt
    });
    return new Response('Invalid token', { status: 403, headers: cors });
  }

  logStructured({
    level: 'info',
    message: 'Conversion event validated (Sprint 2 — placeholder)',
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    turnstile_warnings:
      turnstileResult.errorCodes && turnstileResult.errorCodes.length > 0
        ? turnstileResult.errorCodes.join(',')
        : undefined,
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: cors });
}
