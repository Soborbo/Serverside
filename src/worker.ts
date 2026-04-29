import type { Env } from './env';
import { handleConversion } from './routes/conversion';
import { handleHealth } from './routes/health';
import { handleDebugGA4 } from './routes/debug-ga4';
import { handleOAuthCallback } from './routes/oauth-callback';
import { handleOAuthDebug } from './routes/oauth-debug';
import { logStructured } from './types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './lib/error-codes';
import { QuoteStateObject } from './durable-objects/quote-state';
import { handleScheduledRetry } from './scheduled/retry';
import { handleDailyDigest } from './scheduled/daily-digest';
import { handleSloCheck } from './scheduled/slo-check';

export { QuoteStateObject };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/api/event/health') {
        return handleHealth(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/event/debug-ga4') {
        return handleDebugGA4(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/event/oauth-callback') {
        return handleOAuthCallback(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/event/oauth-debug') {
        return handleOAuthDebug(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/event/conversion') {
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
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 8 * * *') {
      ctx.waitUntil(handleDailyDigest(env));
    } else if (event.cron === '*/30 * * * *') {
      ctx.waitUntil(handleSloCheck(env));
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(handleScheduledRetry(event, env));
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
