import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import { sha256Hex } from '../src/lib/hash';

/**
 * 2026-10-18 review — a capture-kori kapu saját CMP (sbo) alatt UGYANAZT a
 * szabályt követi, mint a kézbesítési utak (decideAdConsent): bizonyított döntés
 * nélkül nincs hirdetési kézbesítés, és CookieYes-forrású jel nem evidencia.
 */

const HOST = 'consent-strict.example.com';
const SITE_TOKEN = 'consent-strict-token';

async function config(_strict: boolean): Promise<Record<string, unknown>> {
  return {
    site_id: 'consent-strict',
    country_code: 'HU',
    currency: 'HUF',
    // SZÁNDÉKOSAN false: a saját CMP fail-closed szabálya nem a config jóindulatán múlik.
    require_consent: false,
    consent: { provider: 'sbo', mode: 'basic' },
    meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
    expected_platforms: { smoke: ['meta'] },
    gads: { customer_id: null, login_customer_id: null },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
}

interface DeliveryRow {
  platform: string;
  status: string;
  http_status: number | null;
  error_code: string | null;
  skip_reason: string | null;
}

function makeLedger() {
  const deliveries: DeliveryRow[] = [];
  const receipts: unknown[][] = [];
  const debugRows: unknown[][] = [];
  const dispatched: string[] = [];
  const ledger = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async first() {
              if (sql.includes('INSERT INTO idempotency')) {
                return {
                  seen_count: 1,
                  dispatched: 0,
                  do_not_replay: 0,
                  first_seen_at: new Date().toISOString()
                };
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO consent_receipts')) receipts.push(args);
              if (sql.includes('INSERT INTO consent_debug')) debugRows.push(args);
              if (sql.includes('UPDATE idempotency SET dispatched')) dispatched.push(sql);
              return {};
            }
          };
        }
      };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      for (const s of stmts) {
        if (!s.sql.includes('INSERT INTO deliveries')) continue;
        deliveries.push({
          platform: String(s.args[5]),
          status: String(s.args[6]),
          http_status: (s.args[7] as number | null) ?? null,
          error_code: (s.args[8] as string | null) ?? null,
          skip_reason: (s.args[14] as string | null) ?? null
        });
      }
      return [];
    }
  };
  return { ledger, deliveries, receipts, debugRows, dispatched };
}

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

/** GRANTED consent — a mai szabály szerint az ad-platform MEHET. */
const GRANTED = {
  ad_user_data: 'GRANTED',
  ad_personalization: 'GRANTED',
  ad_storage: 'GRANTED',
  analytics_storage: 'GRANTED'
};

/** Ellentmondó források: a süti GRANTED-et mond, a JS API marketing:false-t. */
const MISMATCHED_SOURCES = {
  cookie: { analytics: true, marketing: true },
  api: { analytics: true, marketing: false },
  source_used: 'cookieyes_cookie',
  client_lib_version: '6.1.0',
  raw_cookie: 'consent:yes,analytics:yes,advertisement:yes',
  raw_api: '{"analytics":true,"advertisement":false}'
};

function leadRequest(body: Record<string, unknown>): Request {
  return new Request(`https://${HOST}/api/event/conversion-server`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': SITE_TOKEN,
      'CF-Connecting-IP': '10.0.0.1'
    },
    body: JSON.stringify({
      event_name: 'callback_request_submitted',
      event_id: 'evt-consent-strict',
      event_time: Math.floor(Date.now() / 1000),
      lead_id: 'lead-consent-strict-1',
      event_source_url: `https://${HOST}/kapcsolat`,
      user_data: { email: 'x@example.com' },
      ...body
    })
  });
}

async function run(opts: {
  strict: boolean;
  payload: Record<string, unknown>;
}): Promise<{
  status: number;
  deliveries: DeliveryRow[];
  metaCalls: number;
  receipts: unknown[][];
  debugRows: unknown[][];
  dispatched: number;
}> {
  const metaCalls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('facebook.com')) {
        metaCalls.push(url);
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );

  const { ledger, deliveries, receipts, debugRows, dispatched } = makeLedger();
  const env = {
    SITE_CONFIG: { get: async () => await config(opts.strict) },
    LEDGER: ledger,
    DEAD_LETTER: { put: async () => {} }
  } as never;
  const { ctx, tasks } = collectingCtx();
  const res = await handleConversion(leadRequest(opts.payload), env, ctx, { serverOnly: true });
  await Promise.allSettled(tasks);
  return {
    status: res.status,
    deliveries,
    metaCalls: metaCalls.length,
    receipts,
    debugRows,
    dispatched: dispatched.length
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SBO_SOURCES = { cookie: { analytics: null, marketing: null }, api: { analytics: null, marketing: null }, source_used: 'sbo_cookie', client_lib_version: '6.13.0' };
const CKY_SOURCES = { ...SBO_SOURCES, source_used: 'cookieyes_cookie' };

describe('capture-kapu sbo-site-on (require_consent=false config mellett is)', () => {
  it('consent nélkül → NINCS Meta-hívás (nem fail-open)', async () => {
    const r = await run({ strict: false, payload: {} });
    expect(r.metaCalls).toBe(0);
  });

  it('CookieYes-forrású GRANTED jel → NINCS Meta-hívás (nincs visszaesés régi CookieYes-engedélyre)', async () => {
    const r = await run({ strict: false, payload: { consent: GRANTED, consent_sources: CKY_SOURCES } });
    expect(r.metaCalls).toBe(0);
  });

  it('a saját sütiből jövő GRANTED → megy', async () => {
    const r = await run({ strict: false, payload: { consent: GRANTED, consent_sources: SBO_SOURCES } });
    expect(r.metaCalls).toBe(1);
  });
});
