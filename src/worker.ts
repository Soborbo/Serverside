import type { Env } from './env';
import { handleConversion } from './routes/conversion';
import { handleLeadStatus } from './routes/lead-status';
import { handleAdmin } from './routes/admin';
import { handleAdminUI } from './routes/admin-ui';
import { handleHealth } from './routes/health';
import { handleDebugGA4 } from './routes/debug-ga4';
import { handleOAuthCallback } from './routes/oauth-callback';
import { handleOAuthDebug } from './routes/oauth-debug';
import { handleOAuthInit } from './routes/oauth-init';
import { logStructured } from './types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './lib/error-codes';
import { QuoteStateObject } from './durable-objects/quote-state';
import { handleScheduledRetry, retrySingle } from './scheduled/retry';
import { handleDailyDigest } from './scheduled/daily-digest';
import { handleSloCheck } from './scheduled/slo-check';
import { handleReconciliation } from './scheduled/reconciliation';
import {
  writeDeadLetter,
  backoffSeconds,
  MAX_RETRIES,
  type DeadLetterRecord
} from './lib/deadletter';

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

      if (request.method === 'GET' && url.pathname === '/api/event/oauth-init') {
        return handleOAuthInit(request, env);
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

      // CRM offline-loop — lead lifecycle státuszok → Enhanced Conversions for
      // Leads (admin-auth, server-to-server). Lásd routes/lead-status.ts.
      if (request.method === 'POST' && url.pathname === '/api/event/lead-status') {
        return handleLeadStatus(request, env, ctx);
      }

      // Admin UI — önálló dashboard-váz (nincs benne secret), a 4 admin-endpointot
      // fogyasztja böngészőből. NEM az /api/event/admin/ prefix alatt, hogy ne
      // legyen auth-gated (a token a fetch-headerben megy). Lásd routes/admin-ui.ts.
      if (request.method === 'GET' && url.pathname === '/api/event/admin-ui') {
        return handleAdminUI();
      }

      // Admin read/ops API (reconciliation, lead-trail, DLQ replay, health-check).
      // Mind X-Admin-Token mögött. Lásd routes/admin.ts.
      if (url.pathname.startsWith('/api/event/admin/')) {
        return handleAdmin(request, env, ctx);
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, env)
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
    } else if (event.cron === '15 8 * * *') {
      // Napi reconciliation (drift-detektálás a D1 ledger fölött), a digest után.
      ctx.waitUntil(handleReconciliation(env));
    } else if (event.cron === '*/30 * * * *') {
      ctx.waitUntil(handleSloCheck(env));
    } else if (event.cron === '0 * * * *') {
      // Csak akkor releváns, ha NINCS Queues binding (R2-fallback üzemmód).
      // Queues-módban a consumer (queue handler) végzi az újrapróbálkozást.
      ctx.waitUntil(handleScheduledRetry(event, env));
    }
  },

  /**
   * Cloudflare Queues consumer (H1) — sikertelen platform-hívások
   * újrapróbálkozása natív retry + backoff segítségével. Csak akkor fut, ha a
   * `DLQ` queue consumer be van kötve (lásd wrangler.toml).
   *
   * Idempotencia: az újraküldés event_id/orderId alapján dedup-ol downstream
   * (Meta 48h ablak, Google Ads orderId), így a Queues at-least-once kézbesítése
   * nem okoz dupla konverziót.
   *
   * Exhaustion ownership: a WORKER kezeli a kimerülést. `msg.attempts` 1-alapú,
   * ezért `> MAX_RETRIES` (=3) → a 4. kézbesítés után (3 retry) R2 'dead'
   * archívumba írunk + ack. Hogy a platform ne előzze meg ezt, a wrangler
   * `max_retries`-t MAGASABBRA kell állítani (lásd wrangler.toml), és a
   * `dead_letter_queue` opcionális (a worker R2-archívuma a kanonikus dead store).
   */
  async queue(batch: MessageBatch<DeadLetterRecord>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const record = msg.body;
      try {
        const ok = await retrySingle(env, record);
        if (ok) {
          msg.ack();
          continue;
        }
        // attempts a Queues által számolt kézbesítési kísérlet (1-től).
        if (msg.attempts > MAX_RETRIES) {
          // Kimerült retry → R2 'dead' archívum (SLO-check / daily-digest látja).
          await writeDeadLetter(env, {
            ...record,
            retry_count: MAX_RETRIES,
            last_attempted_at: new Date().toISOString()
          });
          msg.ack();
        } else {
          msg.retry({ delaySeconds: backoffSeconds(msg.attempts - 1) });
        }
      } catch (err) {
        logStructured({
          level: 'warn',
          error_code: TrackingErrorCode.CRON_RETRY_FAILED,
          message: 'Queue consumer retry threw',
          platform: record?.platform,
          site_id: record?.site_id,
          error: err instanceof Error ? err.message : String(err)
        });
        if (msg.attempts > MAX_RETRIES) {
          msg.ack();
        } else {
          msg.retry({ delaySeconds: backoffSeconds(msg.attempts - 1) });
        }
      }
    }
  }
};

export function corsHeaders(request: Request, env?: Env): HeadersInit {
  const origin = request.headers.get('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, request, env);
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function resolveAllowedOrigin(
  origin: string | null,
  request: Request,
  env?: Env
): string {
  const requestHost = new URL(request.url).hostname;
  // Test/dev mode: workers.dev hostname → allow any origin (for curl testing)
  if (requestHost.endsWith('.workers.dev')) {
    return origin || '*';
  }
  if (!origin || origin === 'null') {
    return 'https://' + requestHost;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return 'https://' + requestHost;
  }
  // Same-origin or matching configured site: allow
  if (originHost === requestHost) return origin;
  if (env?.ALLOWED_ORIGINS) {
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    if (allowed.includes(originHost)) return origin;
  }
  return 'https://' + requestHost;
}
