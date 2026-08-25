import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleAdmin } from '../src/routes/admin';

const TOKEN = 'admin-secret-final-health';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function request(host: string) {
  return new Request(`https://${host}/api/event/admin/health-check`, {
    headers: { 'X-Admin-Token': TOKEN }
  });
}

async function run(config: unknown) {
  const env: any = {
    ADMIN_API_TOKEN: TOKEN,
    SITE_CONFIG: { get: async () => config }
  };
  const res = await handleAdmin(request('health.example.com'), env, ctx);
  return JSON.parse(await res.text()) as {
    overall: string;
    checks: Array<{ name: string; status: string; detail: string }>;
  };
}

describe('vNext final health invariant — explicit offline expectation outranks missing config', () => {
  it("expected_platforms.offline=['gads'] + missing customer_id => FAIL", async () => {
    const body = await run({
      site_id: 'painless',
      country_code: 'GB',
      currency: 'GBP',
      require_consent: true,
      expected_platforms: { smoke: ['meta'], offline: ['gads'] },
      meta: { pixel_id: '123456', access_token: 'T' }
    });
    const customer = body.checks.find((c) => c.name === 'gads_customer_id')!;
    expect(customer.status).toBe('FAIL');
    expect(customer.detail).toContain('OFFLINE MONEY PATH DOWN');
    expect(body.overall).toBe('FAIL');
  });

  it('missing customer_id without an offline expectation stays WARN', async () => {
    const body = await run({
      site_id: 'webshop',
      country_code: 'GB',
      currency: 'GBP',
      require_consent: true,
      expected_platforms: { smoke: ['meta'] },
      meta: { pixel_id: '123456', access_token: 'T' }
    });
    const customer = body.checks.find((c) => c.name === 'gads_customer_id')!;
    expect(customer.status).toBe('WARN');
    expect(body.overall).toBe('WARN');
  });
});
