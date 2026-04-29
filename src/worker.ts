import type { Env } from './env';
import { handleConversion } from './routes/conversion';
import { handleHealth } from './routes/health';
import { handleDebugGA4 } from './routes/debug-ga4';
import { handleOAuthCallback } from './routes/oauth-callback';
import { handleOAuthDebug } from './routes/oauth-debug';
import { logStructured } from './types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './lib/error-codes';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/api/track/health') {
        return handleHealth(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/track/debug-ga4') {
        return handleDebugGA4(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/track/oauth-callback') {
        return handleOAuthCallback(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/track/oauth-debug') {
        return handleOAuthDebug(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/track/conversion') {
        return handleConversion(request, env, ctx);
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request)
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.UNHANDLED_EXCEPTION,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.UNHANDLED_EXCEPTION],
        hostname: url.hostname,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt
      });
      return new Response(null, { status: 204 });
    }
  }
};

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
