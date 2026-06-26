import { describe, it, expect } from 'vitest';
import { handleAdmin } from '../src/routes/admin';

const TOKEN = 'admin-secret-123';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// Egyedi hostname-ek tesztenként: a getSiteConfig modul-szintű negatív cache-e
// (60s TTL) különben átszivárogna a tesztek között.
function req(host: string, method: string, path: string, token?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token) headers['X-Admin-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://${host}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

function makeEnv(over: Record<string, unknown> = {}): any {
  return { ADMIN_API_TOKEN: TOKEN, ...over };
}

describe('handleAdmin — auth gate', () => {
  it('401 without token', async () => {
    const res = await handleAdmin(req('a1.example.com', 'GET', '/api/event/admin/health-check'), makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('401 with wrong token', async () => {
    const res = await handleAdmin(
      req('a2.example.com', 'GET', '/api/event/admin/health-check', 'wrong'),
      makeEnv(),
      ctx
    );
    expect(res.status).toBe(401);
  });

  it('401 when ADMIN_API_TOKEN unset (disabled)', async () => {
    const res = await handleAdmin(
      req('a3.example.com', 'GET', '/api/event/admin/health-check', TOKEN),
      { } as any,
      ctx
    );
    expect(res.status).toBe(401);
  });
});

describe('handleAdmin — dispatch + guards', () => {
  it('404 on unknown admin path', async () => {
    const res = await handleAdmin(
      req('b1.example.com', 'GET', '/api/event/admin/nope', TOKEN),
      makeEnv(),
      ctx
    );
    expect(res.status).toBe(404);
  });

  it('reconciliation → 503 when no LEDGER binding', async () => {
    const res = await handleAdmin(
      req('b2.example.com', 'GET', '/api/event/admin/reconciliation', TOKEN),
      makeEnv(),
      ctx
    );
    expect(res.status).toBe(503);
    const bodyText = await res.text();
    expect(bodyText).toContain('ledger_unavailable');
  });

  it('leads/:id → 400 on invalid lead_id (before any I/O)', async () => {
    const res = await handleAdmin(
      req('b3.example.com', 'GET', '/api/event/admin/leads/short', TOKEN),
      makeEnv(),
      ctx
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid_lead_id');
  });
});

const goodConfig = {
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: 'PX', access_token: 'TOK' },
  ga4: { measurement_id: 'G-1', api_secret: 'S' },
  gads: { customer_id: null, login_customer_id: null },
  require_consent: true
};

function kvReturning(config: unknown) {
  return { SITE_CONFIG: { get: async () => config } };
}

describe('handleAdmin — health-check', () => {
  it('404 + FAIL when no site config', async () => {
    const res = await handleAdmin(
      req('c1.example.com', 'GET', '/api/event/admin/health-check', TOKEN),
      makeEnv(kvReturning(null)),
      ctx
    );
    expect(res.status).toBe(404);
    const body = JSON.parse(await res.text());
    expect(body.overall).toBe('FAIL');
  });

  it('200 + overall WARN for a healthy site without gads/ledger', async () => {
    const res = await handleAdmin(
      req('c2.example.com', 'GET', '/api/event/admin/health-check', TOKEN),
      makeEnv(kvReturning(goodConfig)),
      ctx
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.site_id).toBe('painless');
    // gads_customer_id WARN + ledger_binding WARN → overall WARN (no FAILs)
    expect(body.overall).toBe('WARN');
    const names = body.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('meta_test_event_code');
    const testCode = body.checks.find((c: { name: string }) => c.name === 'meta_test_event_code');
    expect(testCode.status).toBe('PASS'); // absent = correct for prod
  });

  it('flags a leftover test_event_code as WARN (CLAUDE.md 17)', async () => {
    const withTestCode = { ...goodConfig, meta: { ...goodConfig.meta, test_event_code: 'TEST_PAINLESS' } };
    const res = await handleAdmin(
      req('c3.example.com', 'GET', '/api/event/admin/health-check', TOKEN),
      makeEnv(kvReturning(withTestCode)),
      ctx
    );
    const body = JSON.parse(await res.text());
    const testCode = body.checks.find((c: { name: string }) => c.name === 'meta_test_event_code');
    expect(testCode.status).toBe('WARN');
  });

  it('FAIL when GA4 config incomplete', async () => {
    const badGa4 = { ...goodConfig, ga4: { measurement_id: 'G-1', api_secret: '' } };
    const res = await handleAdmin(
      req('c4.example.com', 'GET', '/api/event/admin/health-check', TOKEN),
      makeEnv(kvReturning(badGa4)),
      ctx
    );
    const body = JSON.parse(await res.text());
    expect(body.overall).toBe('FAIL');
    const ga4 = body.checks.find((c: { name: string }) => c.name === 'ga4_config');
    expect(ga4.status).toBe('FAIL');
  });
});

describe('handleAdmin — dlq replay validation', () => {
  it('400 on invalid JSON body', async () => {
    const r = new Request('https://d1.example.com/api/event/admin/dlq/replay', {
      method: 'POST',
      headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
      body: 'not json'
    });
    const res = await handleAdmin(r, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('discard by key deletes the record (do-not-replay)', async () => {
    const deleted: string[] = [];
    const env = makeEnv({ DEAD_LETTER: { delete: async (k: string) => { deleted.push(k); } } });
    const res = await handleAdmin(
      req('d2.example.com', 'POST', '/api/event/admin/dlq/replay', TOKEN, {
        key: 'painless/meta/dead/x.json',
        discard: true
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.action).toBe('discard');
    expect(deleted).toContain('painless/meta/dead/x.json');
  });
});
