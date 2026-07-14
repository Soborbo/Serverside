import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import { sendAlert } from '../src/lib/notify';
import { sha256Hex } from '../src/lib/hash';
import { TrackingErrorCode } from '../src/lib/error-codes';

/**
 * Fix 1 + Fix 3 integrációs tesztek (Run 6, post-audit).
 *
 * Fix 1 — hamis siker a kihagyott platform-küldésen: a lomtalan 2026-07-14-i
 * VALÓS lead-jén a ledger `meta | accepted | http_status=NULL` sort írt, miközben
 * HTTP-hívás nem történt (nincs meta config). Az elvárt állapot: `skipped`.
 *
 * Fix 3 — hármas kiesés: Meta-hiba + Queue-hiba + R2-hiba esetén az event minden
 * tárból kiesik; ilyenkor a dispatched flag NEM állhat 1-re, különben az
 * idempotencia a kliens-retry-t is elnyelné és az event végleg elveszne.
 */

const HOST = 'lomtalan-shape.example.com';
const SITE_TOKEN = 'lomtalan-server-token-xyz';

// lomtalan-alak: NINCS meta blokk (a CAPI access token még nem létezik), nincs gads.
async function lomtalanShapeConfig(withMeta = false) {
  return {
    site_id: 'lomtalan-shape',
    country_code: 'HU',
    currency: 'HUF',
    ...(withMeta ? { meta: { pixel_id: '123', access_token: 'TOKEN' } } : {}),
    gads: { customer_id: null, login_customer_id: null },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
}

interface DeliveryRow {
  platform: string;
  status: string;
  http_status: number | null;
}

/**
 * Fake D1 ledger: az idempotency upsert first-sight sort ad vissza, a deliveries
 * batch-insertek bind-argumentumait és a `dispatched=1` UPDATE-eket rögzíti.
 * Bind-sorrend (lib/ledger.ts recordDeliveries): (id, event_id, lead_id, site_id,
 * event_name, platform[5], status[6], http_status[7], ...).
 */
function makeLedger() {
  const deliveries: DeliveryRow[] = [];
  const dispatchedUpdates: string[] = [];
  const leadIds: (string | null)[] = [];
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
              if (sql.includes('UPDATE idempotency SET dispatched')) {
                dispatchedUpdates.push(sql);
              }
              return {};
            }
          };
        }
      };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      for (const s of stmts) {
        if (s.sql.includes('INSERT INTO deliveries')) {
          deliveries.push({
            platform: String(s.args[5]),
            status: String(s.args[6]),
            http_status: s.args[7] as number | null
          });
          leadIds.push(s.args[2] as string | null);
        }
      }
      return [];
    }
  };
  return { ledger, deliveries, dispatchedUpdates, leadIds };
}

function makeEnv(opts: {
  siteConfig: unknown;
  ledger: unknown;
  queueSendThrows?: boolean;
  r2PutThrows?: boolean;
  withQueue?: boolean;
}): { env: any; deadKeys: string[] } {
  const deadKeys: string[] = [];
  const env: any = {
    SITE_CONFIG: { get: async () => opts.siteConfig },
    LEDGER: opts.ledger,
    DEAD_LETTER: {
      put: async (key: string) => {
        if (opts.r2PutThrows) throw new Error('R2 down');
        deadKeys.push(key);
      }
    }
  };
  if (opts.withQueue) {
    env.DLQ = {
      send: async () => {
        if (opts.queueSendThrows) throw new Error('Queue down');
      }
    };
  }
  return { env, deadKeys };
}

/** Hitelesített szerver-ingress kérés — a lomtalan valós dispatch-formája. */
function serverLeadRequest(): Request {
  return new Request(`https://${HOST}/api/event/conversion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': SITE_TOKEN,
      'CF-Connecting-IP': '10.0.0.1'
    },
    body: JSON.stringify({
      event_name: 'quote_calculator_submitted',
      event_id: 'evt-05aa8ce5-shape',
      event_time: Math.floor(Date.now() / 1000),
      value: 300000,
      currency: 'HUF',
      service: 'lomtalanitas',
      lead_id: 'lead-cb-12345678',
      event_source_url: `https://${HOST}/arajanlat`,
      user_data: { email: 'x@example.com', phone_number: '+36301234567' }
    })
  });
}

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

function installFetch(metaStatus: number): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.includes('facebook.com')) {
        return new Response(JSON.stringify({ events_received: 1 }), { status: metaStatus });
      }
      return new Response('{}', { status: 200 });
    })
  );
  return calls;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(sendAlert).mockClear();
});

describe('Fix 1 — a kihagyott platform-küldés SOHA nem accepted', () => {
  it('lomtalan-alak (nincs meta config): a Meta-láb "skipped"-ként könyvelődik, NEM "accepted"-ként', async () => {
    const calls = installFetch(200);
    const { ledger, deliveries, dispatchedUpdates, leadIds } = makeLedger();
    const { env } = makeEnv({ siteConfig: await lomtalanShapeConfig(false), ledger });
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(serverLeadRequest(), env, ctx);
    await Promise.allSettled(tasks);

    expect(res.status).toBe(204);
    // HTTP-hívás a Meta felé NEM történt.
    expect(calls.some((u) => u.includes('facebook.com'))).toBe(false);

    // A pontos 2026-07-14-i hibaalak: meta|accepted|http_status=NULL. Most: skipped.
    const meta = deliveries.find((d) => d.platform === 'meta');
    expect(meta).toBeDefined();
    expect(meta!.status).toBe('skipped');
    expect(meta!.http_status).toBeNull();

    // Az invariáns a TELJES delivery-halmazra: accepted CSAK vendor-státusszal.
    for (const d of deliveries) {
      if (d.status === 'accepted') expect(typeof d.http_status).toBe('number');
    }

    // A lead_id végig utazik a delivery-sorokig (CRM-join képesség).
    expect(leadIds.every((l) => l === 'lead-cb-12345678')).toBe(true);

    // Skip nem hiba → az event dispatched-nek jelölhető.
    expect(dispatchedUpdates).toHaveLength(1);
  });

  it('meta configgal a valós 200-as hívás "accepted"-ként, a vendor HTTP-státusszal könyvelődik', async () => {
    const calls = installFetch(200);
    const { ledger, deliveries } = makeLedger();
    const { env } = makeEnv({ siteConfig: await lomtalanShapeConfig(true), ledger });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(serverLeadRequest(), env, ctx);
    await Promise.allSettled(tasks);

    expect(calls.some((u) => u.includes('facebook.com'))).toBe(true);
    const meta = deliveries.find((d) => d.platform === 'meta');
    expect(meta!.status).toBe('accepted');
    expect(meta!.http_status).toBe(200);
  });
});

describe('Fix 3 — hármas kiesés (Meta + Queue + R2) esetén dispatched marad 0', () => {
  it('Meta fail + Queue fail + R2 fail → NINCS markDispatched, CRITICAL alert megy', async () => {
    installFetch(500); // Meta bukik
    const { ledger, dispatchedUpdates } = makeLedger();
    const { env } = makeEnv({
      siteConfig: await lomtalanShapeConfig(true),
      ledger,
      withQueue: true,
      queueSendThrows: true,
      r2PutThrows: true
    });
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(serverLeadRequest(), env, ctx);
    await Promise.allSettled(tasks);

    // A kliens felé továbbra sem szivárog hiba (a fan-out háttérben fut).
    expect(res.status).toBe(204);
    // A LÉNYEG: az event nincs dispatched-nek jelölve → egy retry újrakézbesíthet.
    expect(dispatchedUpdates).toHaveLength(0);
    // És kritikus riasztás ment róla.
    expect(vi.mocked(sendAlert).mock.calls.some(
      (c) => c[1] === TrackingErrorCode.RETRY_PERSIST_FAILED
    )).toBe(true);
  });

  it('kontroll: Meta fail, de az R2 DLQ-írás sikerül → markDispatched lefut', async () => {
    installFetch(500);
    const { ledger, dispatchedUpdates } = makeLedger();
    const { env, deadKeys } = makeEnv({
      siteConfig: await lomtalanShapeConfig(true),
      ledger
      // nincs Queue → közvetlen R2 fallback, ami sikerül
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(serverLeadRequest(), env, ctx);
    await Promise.allSettled(tasks);

    expect(deadKeys.length).toBeGreaterThan(0); // a retry-példány tárolva
    expect(dispatchedUpdates).toHaveLength(1); // → jelölhető dispatched-nek
  });

  it('kontroll: minden platform sikeres → markDispatched lefut, nincs alert', async () => {
    installFetch(200);
    const { ledger, dispatchedUpdates } = makeLedger();
    const { env } = makeEnv({ siteConfig: await lomtalanShapeConfig(true), ledger });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(serverLeadRequest(), env, ctx);
    await Promise.allSettled(tasks);

    expect(dispatchedUpdates).toHaveLength(1);
    expect(vi.mocked(sendAlert).mock.calls.some(
      (c) => c[1] === TrackingErrorCode.RETRY_PERSIST_FAILED
    )).toBe(false);
  });
});
