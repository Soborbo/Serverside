import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (a worker.ts a daily-digest →
// notify láncon át húzná be).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import worker from '../src/worker';

/**
 * Fix 4 — a globális catch státuszkódja útvonal-függő:
 *  - /api/event/conversion (böngésző-beacon): 204 — a sendBeacon úgysem olvas
 *    választ, és a kliens felé nem szivárogtatunk hibát.
 *  - minden szerver-szerver útvonal (conversion-server, lead-status, admin,
 *    OAuth): 500 — a CRM/backend hívónak TUDNIA kell retry-olni; egy 204-et
 *    sikernek venne, és az event némán veszne el.
 */

// Bármely property-hozzáférésre dobó env → garantált throw a try-blokkon belül.
const explodingEnv = new Proxy(
  {},
  {
    get() {
      throw new Error('env access boom');
    }
  }
) as any;

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://gateway.example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}'
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('global catch — status code by route class (Fix 4)', () => {
  it('browser beacon route (/api/event/conversion) → 204 on unhandled error', async () => {
    const res = await worker.fetch(post('/api/event/conversion'), explodingEnv, ctx);
    expect(res.status).toBe(204);
  });

  it('/api/event/conversion-server → 500 (the caller must be able to retry)', async () => {
    const res = await worker.fetch(post('/api/event/conversion-server'), explodingEnv, ctx);
    expect(res.status).toBe(500);
  });

  it('legacy /api/event/conversion WITH X-Admin-Token → 500 (authenticated backend, not a beacon)', async () => {
    // A path önmagában nem dönt: token-t hozó hívó szerver-ingress a legacy
    // útvonalon is — 204-re sosem retry-olna, az event némán veszne el.
    const res = await worker.fetch(
      post('/api/event/conversion', { 'X-Admin-Token': 'site-token' }),
      explodingEnv,
      ctx
    );
    expect(res.status).toBe(500);
  });

  it('/api/event/lead-status → soha nem hamis-siker 204 (itt: 404, a route saját hibaútja)', async () => {
    // A handleLeadStatus belül fail-safe (a KV/D1 hibát elkapja és 4xx-szel
    // jelzi), így a globális catch csak backstop. A szerződés, ami számít: a CRM
    // hívó SOHA nem kaphat 204-et hibára — different-status, de mindig >= 400.
    const res = await worker.fetch(post('/api/event/lead-status'), explodingEnv, ctx);
    expect(res.status).not.toBe(204);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('admin route → 500', async () => {
    const res = await worker.fetch(post('/api/event/admin/reconciliation'), explodingEnv, ctx);
    expect(res.status).toBe(500);
  });
});
