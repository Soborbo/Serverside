import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cloudflare:email runtime-import elkerülése (a conversion/lead-status a sendAlert-en
// keresztül húzná be a notify.ts-t — lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import { handleLeadStatus } from '../src/routes/lead-status';
import { sha256Hex } from '../src/lib/hash';

/**
 * FÁZIS 5 · Kritikus cross-endpoint E2E — a gateway PÉNZ-útja egyben.
 *
 * A rendszer legveszélyesebb hibamódjai piecemeal le vannak fedve (server-ingress,
 * skip-osztályozás, lead-status-consent, idempotencia). Ez a suite a **teljes
 * happy-path láncot** köti össze egy STATEFUL ledgeren, mert a legdrágább néma
 * hibák pont a VARRATOKON élnek (a 2026-07-17 consent-propagáció incidens):
 *
 *   böngésző/szerver konverzió (GRANTED consent) → `consent_receipts` perzisztálva
 *     → UGYANARRA a lead_id-ra offline lifecycle (/lead-status) → a receipt-first
 *     precedencia a TÁROLT consentet olvassa (nem a CRM ad_allowedját) → Data
 *     Manager upload CONSENT_GRANTED-del.
 *
 * Ha bármelyik varrat elszakad (a receipt nem íródik, a lead_id-join téves, vagy a
 * lead-status nem esik vissza a receiptre), a Google EEA/DMA alatt CSENDBEN kizárja
 * az offline konverziót az ads-mérésből — zöld pipeline, romló match rate.
 */

const HOST = 'painlessremovals.com';
const SITE_TOKEN = 'e2e-site-token'; // konverzió (per-site crm_token)
const ADMIN_TOKEN = 'e2e-admin-token'; // lead-status (globális ADMIN_API_TOKEN)
const LEAD_ID = 'lead-e2e-12345678';
const EVENT_ID = 'evt-e2e-happy-path';

async function siteConfig(): Promise<Record<string, unknown>> {
  return {
    site_id: 'painless',
    country_code: 'GB',
    currency: 'GBP',
    require_consent: true,
    meta: { pixel_id: '111222333', access_token: 'META-TOKEN' },
    gads: {
      customer_id: '1234567890',
      login_customer_id: null,
      conversion_actions: { lead_qualified: '99887766' }
    },
    expected_platforms: { smoke: ['meta'], offline: ['gads'] },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
}

interface Receipt {
  site_id: string;
  lead_id: string | null;
  ad_user_data: string | null;
  ad_personalization: string | null;
  ad_allowed: number;
  received_at: string;
}

/**
 * Stateful fake D1: a conversion `recordConsentReceipt` INSERT-jét eltárolja, és a
 * lead-status `getLatestConsentForLead` SELECT-jére visszaadja — így a lead_id-join
 * VALÓDIAN teszteltté válik (nem előre bedrótozott receipt-sorral).
 */
function makeStatefulLedger() {
  const receipts: Receipt[] = [];
  const deliveries: Array<{ platform: string; status: string; origin?: string }> = [];
  const dispatched: string[] = [];

  const ledger = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            // A D1 batch() a bind-olt statementet kapja — a sql/args-t exponálni kell,
            // hogy a batch-handler (deliveries-capture) olvashassa.
            sql,
            args,
            async first() {
              if (sql.includes('INSERT INTO idempotency')) {
                return { seen_count: 1, dispatched: 0, do_not_replay: 0, first_seen_at: new Date().toISOString() };
              }
              if (/FROM consent_receipts/.test(sql)) {
                // getLatestConsentForLead: WHERE site_id=? AND lead_id=? ORDER BY received_at DESC LIMIT 1
                const [siteId, leadId] = args as [string, string];
                const match = receipts
                  .filter((r) => r.site_id === siteId && r.lead_id === leadId)
                  .sort((a, b) => b.received_at.localeCompare(a.received_at))[0];
                return match
                  ? { ad_allowed: match.ad_allowed, ad_user_data: match.ad_user_data, ad_personalization: match.ad_personalization }
                  : null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO consent_receipts')) {
                // Bind-sorrend (ledger.ts recordConsentReceipt): id, event_id, lead_id,
                // site_id, ad_user_data, ad_personalization, ad_storage,
                // analytics_storage, require_consent, ad_allowed, received_at.
                receipts.push({
                  lead_id: (args[2] as string | null) ?? null,
                  site_id: String(args[3]),
                  ad_user_data: (args[4] as string | null) ?? null,
                  ad_personalization: (args[5] as string | null) ?? null,
                  ad_allowed: Number(args[9]),
                  received_at: String(args[10])
                });
              }
              if (sql.includes('UPDATE idempotency SET dispatched')) dispatched.push(sql);
              return {};
            },
            async all() {
              return { results: [] };
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
            origin: s.args[11] as string | undefined
          });
        }
      }
      return [];
    }
  };
  return { ledger, receipts, deliveries, dispatched };
}

function makeEnv(ledger: unknown): any {
  return {
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    SITE_CONFIG: { get: async () => structuredClone(SITE_CONFIG_CACHE) },
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    },
    LEDGER: ledger,
    DEAD_LETTER: { put: async () => undefined }
  };
}

let SITE_CONFIG_CACHE: Record<string, unknown>;

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

/** Szerver-ingress konverzió: per-site X-Admin-Token, GRANTED consent, lead_id. */
function conversionRequest(): Request {
  return new Request(`https://${HOST}/api/event/conversion-server`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': SITE_TOKEN,
      'CF-Connecting-IP': '10.0.0.9'
    },
    body: JSON.stringify({
      event_name: 'quote_calculator_submitted',
      event_id: EVENT_ID,
      event_time: Math.floor(Date.now() / 1000),
      value: 250000,
      currency: 'GBP',
      lead_id: LEAD_ID,
      event_source_url: `https://${HOST}/arajanlat`,
      consent: { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', ad_storage: 'GRANTED' },
      user_data: { email: 'jane@example.com', phone_number: '+447123456789' }
    })
  });
}

/** Offline lifecycle: PER-SITE X-Admin-Token (a config crm_token_sha256-ja miatt a
 *  globális ADMIN_API_TOKEN nem ad hozzáférést — tenant-izoláció, ahogy a CRM hív),
 *  UGYANAZ a lead_id, NINCS ad_allowed (szándékosan → a receipt-first precedencia a
 *  tárolt consentre esik vissza). */
function leadStatusRequest(): Request {
  return new Request(`https://${HOST}/api/event/lead-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': SITE_TOKEN },
    body: JSON.stringify({
      lead_id: LEAD_ID,
      status: 'lead_qualified',
      user_data: { email: 'jane@example.com' }
    })
  });
}

beforeEach(async () => {
  SITE_CONFIG_CACHE = await siteConfig();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E2E #1 · teljes happy-path pénz-lánc (konverzió → receipt → lifecycle → Data Manager)', () => {
  it('a GRANTED böngésző-consent a lead_id-n át CONSENT_GRANTED-ként ér a Data Manager uploadra', async () => {
    let dmBody: any = null;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: any) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push(url);
        if (url.includes('facebook.com')) {
          return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
        }
        // Data Manager events:ingest (a lead-status offline lába).
        dmBody = init?.body ? JSON.parse(init.body) : null;
        return new Response(JSON.stringify({ requestId: 'r-e2e' }), { status: 200 });
      })
    );

    const { ledger, receipts, deliveries, dispatched } = makeStatefulLedger();
    const env = makeEnv(ledger);

    // 1) KONVERZIÓ (szerver-ingress, GRANTED consent). A Meta accepted, a
    //    consent_receipt perzisztál, az esemény dispatched.
    const conv = collectingCtx();
    const convRes = await handleConversion(conversionRequest(), env, conv.ctx, { serverOnly: true });
    await Promise.allSettled(conv.tasks);

    expect(convRes.status).toBe(204);
    expect(calls.some((u) => u.includes('facebook.com'))).toBe(true);
    expect(deliveries.find((d) => d.platform === 'meta')?.status).toBe('accepted');
    // A receipt a lead_id-hoz kötve, GRANTED jellel, ad_allowed=1.
    const r = receipts.find((x) => x.lead_id === LEAD_ID);
    expect(r).toBeTruthy();
    expect(r?.ad_user_data).toBe('GRANTED');
    expect(r?.ad_allowed).toBe(1);
    expect(dispatched.length).toBeGreaterThan(0);

    // 2) OFFLINE LIFECYCLE (/lead-status, ugyanaz a lead_id, ad_allowed NÉLKÜL).
    //    A receipt-first precedencia a TÁROLT GRANTED consentet olvassa vissza.
    const life = collectingCtx();
    const lifeRes = await handleLeadStatus(leadStatusRequest(), env, life.ctx);
    await Promise.allSettled(life.tasks);

    expect(lifeRes.status).toBe(200);
    // A Data Manager ingest tartalmazza a CONSENT_GRANTED jeleket — a böngésző-oldali
    // consent VÉGIGUTAZOTT a lead_id-n a varraton át. Ez a lánc lényege.
    expect(dmBody).not.toBeNull();
    expect(dmBody.events[0].consent).toEqual({
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_GRANTED'
    });
  });

  it('DENIED böngésző-consent → a lifecycle upload consentje NEM GRANTED (fail-closed a varraton)', async () => {
    let dmBody: any = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: any) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('facebook.com')) {
          return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
        }
        dmBody = init?.body ? JSON.parse(init.body) : null;
        return new Response(JSON.stringify({ requestId: 'r-e2e' }), { status: 200 });
      })
    );

    const { ledger, receipts } = makeStatefulLedger();
    const env = makeEnv(ledger);

    // Konverzió DENIED consenttel → a receipt ad_user_data=DENIED, ad_allowed=0.
    const denyReq = new Request(`https://${HOST}/api/event/conversion-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': SITE_TOKEN, 'CF-Connecting-IP': '10.0.0.9' },
      body: JSON.stringify({
        event_name: 'quote_calculator_submitted',
        event_id: EVENT_ID,
        event_time: Math.floor(Date.now() / 1000),
        lead_id: LEAD_ID,
        event_source_url: `https://${HOST}/arajanlat`,
        consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED', ad_storage: 'DENIED' },
        user_data: { email: 'jane@example.com' }
      })
    });
    const conv = collectingCtx();
    await handleConversion(denyReq, env, conv.ctx, { serverOnly: true });
    await Promise.allSettled(conv.tasks);
    expect(receipts.find((x) => x.lead_id === LEAD_ID)?.ad_user_data).toBe('DENIED');

    // Lifecycle: a tárolt DENIED receipt miatt a Data Manager consentje NEM GRANTED.
    const life = collectingCtx();
    await handleLeadStatus(leadStatusRequest(), env, life.ctx);
    await Promise.allSettled(life.tasks);

    if (dmBody) {
      expect(dmBody.events[0].consent).not.toEqual({
        adUserData: 'CONSENT_GRANTED',
        adPersonalization: 'CONSENT_GRANTED'
      });
    }
  });
});
