import type { Env } from '../env';
import { logStructured } from '../types';
import { corsHeaders } from '../worker';

export async function handleConversion(
  request: Request,
  _env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;

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
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  logStructured({
    level: 'info',
    message: 'Conversion event received (Sprint 1 — placeholder)',
    hostname,
    event_name:
      typeof payload === 'object' && payload !== null && 'event_name' in payload
        ? String((payload as Record<string, unknown>).event_name)
        : 'unknown',
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
