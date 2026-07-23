import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleLeadStatus } from '../src/routes/lead-status';
import { sendAlert } from '../src/lib/notify';
import { TrackingErrorCode } from '../src/lib/error-codes';

const BASE_CONFIG = {
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { lead_qualified: '99887766' }
  },
  expected_platforms: { offline: ['gads'] }
};

function request(userData: Record<string, unknown> = { email: 'jane@example.com' }): Request {
  return new Request('https://painlessremovals.com/api/event/lead-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'admin-token' },
    body: JSON.stringify({
      lead_id: 'lead-durable-12345678',
      status: 'lead_qualified',
      ad_allowed: true,
      user_data: userData
    })
  });
}

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined
  } as unknown as ExecutionContext;
}

function env(options: {
  queueFails?: boolean;
  r2Fails?: boolean;
  config?: Record<string, unknown>;
  deadLetterWrites?: Array<{ key: string; body: string }>;
} = {}): any {
  return {
    ADMIN_API_TOKEN: 'admin-token',
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    SITE_CONFIG: { get: async () => options.config ?? BASE_CONFIG },
    OAUTH_TOKENS: {
      get: async (key: string) => (key.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    },
    DLQ: {
      send: async () => {
        if (options.queueFails) throw new Error('Queue down');
      }
    },
    DEAD_LETTER: {
      put: async (key: string, body: string) => {
        if (options.r2Fails) throw new Error('R2 down');
        options.deadLetterWrites?.push({ key, body });
      }
    }
  };
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

describe('lead-status server response follows delivery durability', () => {
  it('Data Manager + Queue + R2 failure returns retryable 503', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 500 })
    );

    const response = await handleLeadStatus(
      request(),
      env({ queueFails: true, r2Fails: true }),
      ctx()
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, retryable: true });
    expect(
      vi.mocked(sendAlert).mock.calls.some(
        (call) => call[1] === TrackingErrorCode.RETRY_PERSIST_FAILED
      )
    ).toBe(true);
  });

  it('Data Manager failure with a stored Queue retry returns 202', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 500 })
    );

    const response = await handleLeadStatus(request(), env(), ctx());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, queued_for_retry: true });
  });

  it('missing conversion-action configuration is queued for the 7-day replay, never a green 200', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = structuredClone(BASE_CONFIG);
    config.gads.conversion_actions = {};
    const deadLetterWrites: Array<{ key: string; body: string }> = [];

    const response = await handleLeadStatus(request(), env({ config, deadLetterWrites }), ctx());

    // A config-hiba determinisztikus: a CRM retry-ja magától soha nem oldja meg,
    // csak elégeti a ~2 órás keretét. Ha a gateway átvette az őrzést, 202-t adunk
    // — de sem itt, sem sehol nem lehet 200/zöld egy el nem indult hívásra.
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      queued_for_retry: true,
      configuration_blocked: true,
      uploaded_to_gads: false
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // A visszanyerés BIZONYÍTÉKA: a rekord tényleg letéve, `blocked_configuration`
    // jelöléssel — ez adja a 7 napos ablakot a rövid Queue-keret helyett, és ezt
    // olvassa az óránkénti cron a config helyreállítása után.
    expect(deadLetterWrites).toHaveLength(1);
    expect(JSON.parse(deadLetterWrites[0].body)).toMatchObject({
      platform: 'gads',
      blocked_configuration: true,
      lead_id: 'lead-durable-12345678'
    });
  });

  it('config block whose retry record cannot be stored falls back to 503', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = structuredClone(BASE_CONFIG);
    config.gads.conversion_actions = {};

    const response = await handleLeadStatus(request(), env({ config, r2Fails: true }), ctx());

    // Ha a gateway NEM tudta letenni a replay-példányt, nem hazudhat 202-t: a CRM
    // outboxa az egyetlen megmaradt őrző, tehát neki kell megtartania az eventet.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'gads_configuration_blocked',
      retryable: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('identifier nélküli lifecycle payload 422 és nem látszik upload-sikernek', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleLeadStatus(request({}), env(), ctx());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'no_match_identifiers', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
