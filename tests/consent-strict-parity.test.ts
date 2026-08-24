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
 * Fázis D · S2.4 — a `consent_strict` kapcsoló ELFOGADÁSI KRITÉRIUMA.
 *
 * „`consent_strict=false` mellett a delivery-viselkedés BITRE azonos a maival.
 *  Ezt teszt bizonyítsa, ne érvelés."
 *
 * Ezért ez a fájl nem a telemetriát ellenőrzi (azt a consent-sources.test.ts
 * teszi), hanem azt, hogy a MÉRŐMŰSZER nem nyúl a méréshez: ugyanaz a konverzió,
 * ellentmondó consent-forrásokkal, pontosan ugyanazokat a vendor-hívásokat és
 * ledger-sorokat termeli, mint a telemetria BEVEZETÉSE ELŐTTI payload.
 *
 * A második fele a kapcsoló bekapcsolt állapotát írja le — hogy a napokon belüli
 * élesítés ne vak ugrás legyen.
 */

const HOST = 'consent-strict.example.com';
const SITE_TOKEN = 'consent-strict-token';

async function config(consentStrict: boolean): Promise<Record<string, unknown>> {
  return {
    site_id: 'consent-strict',
    country_code: 'HU',
    currency: 'HUF',
    require_consent: true,
    ...(consentStrict ? { consent_strict: true } : {}),
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

describe('consent_strict = false (default) — bitre a mai viselkedés', () => {
  it('a telemetria-blokk NÉLKÜLI és a MISMATCH-elő payload azonos deliveryt termel', async () => {
    // (a) a Fázis D ELŐTTI payload — nincs consent_sources blokk
    const before = await run({ strict: false, payload: { consent: GRANTED } });
    // (b) ugyanaz az event, ellentmondó forrás-telemetriával
    const after = await run({
      strict: false,
      payload: { consent: GRANTED, consent_sources: MISMATCHED_SOURCES }
    });

    expect(after.status).toBe(before.status);
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.metaCalls).toBe(before.metaCalls);
    expect(after.dispatched).toBe(before.dispatched);
    // …és a hívás tényleg megtörtént (a teszt nem két üres halmazt hasonlít).
    expect(after.metaCalls).toBe(1);
    expect(after.deliveries).toEqual([
      { platform: 'meta', status: 'accepted', http_status: 200, error_code: null, skip_reason: null }
    ]);
  });

  it('a mismatch attól még RÖGZÜL: consent_debug sor + source_consistent=0 a receipten', async () => {
    const r = await run({
      strict: false,
      payload: { consent: GRANTED, consent_sources: MISMATCHED_SOURCES }
    });
    expect(r.debugRows).toHaveLength(1);
    expect(String(r.debugRows[0][3])).toBe('TRK-910-003');
    // A nyers süti CSAK ide kerül — a receipt bindjei közt nem szerepelhet.
    expect(r.receipts[0].some((a) => String(a).includes('advertisement:yes'))).toBe(false);
    // source_consistent a receipt 19. bindje (lásd recordConsentReceipt).
    expect(r.receipts[0][18]).toBe(0);
    expect(r.receipts[0][19]).toBe('server');
    expect(r.receipts[0][20]).toBe('6.1.0');
    // consent_age_s CookieYes alatt NULL marad.
    expect(r.receipts[0][21]).toBeNull();
  });

  it('konzisztens forrásoknál nincs consent_debug sor', async () => {
    const r = await run({
      strict: false,
      payload: {
        consent: GRANTED,
        consent_sources: {
          ...MISMATCHED_SOURCES,
          api: { analytics: true, marketing: true }
        }
      }
    });
    expect(r.debugRows).toHaveLength(0);
    expect(r.receipts[0][18]).toBe(1);
  });
});

describe('consent_strict = true — élesített fail-closed', () => {
  it('bizonytalan consent → nincs vendor-hívás, megnevezett skip', async () => {
    const r = await run({
      strict: true,
      payload: { consent: GRANTED, consent_sources: MISMATCHED_SOURCES }
    });
    expect(r.metaCalls).toBe(0);
    // Consent-tiltásnál MINDEN ad-platform ugyanazt a skipet kapja (a hívás el
    // sem indul) — a Meta a site egyetlen ELVÁRT lába, azt nézzük.
    expect(r.deliveries.find((d) => d.platform === 'meta')).toEqual({
      platform: 'meta',
      status: 'skipped',
      http_status: null,
      error_code: null,
      skip_reason: 'consent_uncertain_failclosed'
    });
    expect(r.deliveries.every((d) => d.skip_reason === 'consent_uncertain_failclosed')).toBe(true);
    // Terminális skip: az event kézbesítettnek jelölhető, nem kering a DLQ-ban.
    expect(r.dispatched).toBe(1);
  });

  it('egyértelmű consent mellett strict=true sem változtat semmit', async () => {
    const r = await run({
      strict: true,
      payload: {
        consent: GRANTED,
        consent_sources: { ...MISMATCHED_SOURCES, api: { analytics: true, marketing: true } }
      }
    });
    expect(r.metaCalls).toBe(1);
    expect(r.deliveries[0].status).toBe('accepted');
  });
});

describe('a consent-skip megnevezi magát (S2.1 a consent-ágon)', () => {
  it('hiányzó consent fail-closed site-on → consent_missing_failclosed, NEM consent_denied', async () => {
    const r = await run({ strict: false, payload: {} });
    expect(r.deliveries.find((d) => d.platform === 'meta')).toEqual({
      platform: 'meta',
      status: 'skipped',
      http_status: null,
      error_code: null,
      skip_reason: 'consent_missing_failclosed'
    });
  });

  it('kimondott elutasítás → consent_denied', async () => {
    const r = await run({
      strict: false,
      payload: { consent: { ad_user_data: 'DENIED', ad_storage: 'DENIED', ad_personalization: 'DENIED' } }
    });
    expect(r.deliveries.find((d) => d.platform === 'meta')?.skip_reason).toBe('consent_denied');
  });
});
