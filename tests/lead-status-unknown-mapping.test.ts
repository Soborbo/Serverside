import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

/**
 * §13 — az offline út UTOLSÓ néma elutasítási ága.
 *
 * A `lead-status.ts` `unknown_status` ága volt az egyetlen hibaválasz a
 * money-path-on error code, strukturált log és bármilyen nyom nélkül: a CRM
 * 400-at kapott, a gateway-oldalon viszont SEMMI nem jelezte, hogy egy
 * konverzió elveszett. Egy CRM-oldali státusz-átnevezés így némán, hetekig
 * üríthette volna az offline lábat.
 *
 * KÉT VÉDELEM, két teszttel:
 *   1. a kontraktus-teszt bizonyítja, hogy az ág MA elérhetetlen (a két lista
 *      származtatott, nem sodródhat szét);
 *   2. a mockolt teszt bizonyítja, hogy HA valaki szétválasztja őket, az ág
 *      nem néma: kódot ad, logol, és a hívó megkapja a kódot.
 */

// A `mapLeadStatusToEventName`-t null-ra kényszerítjük — így elérhető lesz az
// egyébként (szándékosan) elérhetetlen ág.
vi.mock('../src/lib/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ledger')>();
  return { ...actual, mapLeadStatusToEventName: () => null };
});

import { handleLeadStatus } from '../src/routes/lead-status';
import { mapLeadStatusToEventName, VALID_LEAD_STATUSES } from '../src/lib/ledger';
import { TrackingErrorCode } from '../src/lib/error-codes';
import { sha256Hex } from '../src/lib/hash';

const HOST = 'painlessremovals.com';
const SITE_TOKEN = 'unknown-mapping-site-token';

let siteConfigCache: Record<string, unknown>;

function makeEnv(): any {
  return {
    ADMIN_API_TOKEN: 'global-token',
    SITE_CONFIG: { get: async () => structuredClone(siteConfigCache) },
    OAUTH_TOKENS: { get: async () => null, put: async () => undefined },
    LEDGER: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
    DEAD_LETTER: { put: async () => undefined }
  };
}

function ctx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

function request(status: string): Request {
  return new Request(`https://${HOST}/api/event/lead-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': SITE_TOKEN },
    body: JSON.stringify({ lead_id: 'lead-unknown-map-1', status })
  });
}

let logs: Record<string, unknown>[] = [];

beforeEach(async () => {
  logs = [];
  siteConfigCache = {
    site_id: 'painless',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: '1', access_token: 'T' },
    gads: { customer_id: '1234567890', login_customer_id: null, conversion_actions: {} },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
  const capture = (line: string) => {
    try { logs.push(JSON.parse(line)); } catch { /* nem strukturált sor */ }
  };
  vi.spyOn(console, 'log').mockImplementation(capture as never);
  vi.spyOn(console, 'warn').mockImplementation(capture as never);
  vi.spyOn(console, 'error').mockImplementation(capture as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('leképezés nélküli lead-státusz — nem néma többé', () => {
  it('400-at ad, de MOST MÁR error_code-dal a törzsben', async () => {
    const res = await handleLeadStatus(request('lead_qualified'), makeEnv(), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; error_code?: string };
    expect(body.error).toBe('unknown_status');
    expect(body.error_code).toBe(TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING);
  });

  it('strukturált WARN logot ír a kóddal — eddig SEMMI nem került a logba', async () => {
    await handleLeadStatus(request('lead_qualified'), makeEnv(), ctx());
    const hit = logs.find(
      (l) => l.error_code === TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING
    );
    expect(hit, 'nincs strukturált log a leképezés-hiányról').toBeTruthy();
    expect(hit!.level).toBe('warn');
    expect(hit!.lead_status).toBe('lead_qualified');
  });

  it('a log NEM tartalmaz PII-t (a lead_id opaque, user_data nincs)', async () => {
    await handleLeadStatus(request('lead_qualified'), makeEnv(), ctx());
    const hit = logs.find((l) => l.error_code === TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING)!;
    const serialized = JSON.stringify(hit);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('user_data');
  });
});

describe('kontraktus — az ág MA elérhetetlen, és ez így is maradjon', () => {
  it('a mockolatlan leképezés MINDEN engedélyezett státuszra ad eventet', async () => {
    // Ugyanazt a modult importáljuk mockolatlanul: ha valaki a jövőben
    // szétválasztja a két listát, ez a teszt bukik ELŐBB, mint hogy egy éles
    // CRM-hívás némán elvesszen.
    const actual = await vi.importActual<typeof import('../src/lib/ledger')>('../src/lib/ledger');
    for (const status of actual.VALID_LEAD_STATUSES) {
      expect(actual.mapLeadStatusToEventName(status), `nincs leképezés: ${status}`).toBeTruthy();
    }
    expect(actual.VALID_LEAD_STATUSES.length).toBeGreaterThan(0);
  });

  it('a mock tényleg hat (különben az első blokk hamis zöldet adna)', () => {
    expect(mapLeadStatusToEventName('lead_qualified')).toBeNull();
    expect(VALID_LEAD_STATUSES.length).toBeGreaterThan(0);
  });
});
