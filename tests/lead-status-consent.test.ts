import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleLeadStatus } from '../src/routes/lead-status';
import type { Env } from '../src/env';

/**
 * E2E: a CRM autoritatív ad_allowed=true jele Consent Mode jelekként
 * (CONSENT_GRANTED) landol a Data Manager events:ingest body-ban. EEA/DMA alatt
 * a jelöletlen consentű offline eventet a Google csendben kizárhatja az
 * ads-mérésből — ez a teszt védi, hogy a pozitív evidencia tényleg kimegy.
 */

const SITE_CONFIG_JSON = {
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1', access_token: 'T' },
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { lead_qualified: '99887766' }
  }
};

function makeEnv(): Env {
  return {
    ADMIN_API_TOKEN: 'admin-token',
    GADS_OAUTH_CLIENT_ID: 'c',
    GADS_OAUTH_CLIENT_SECRET: 's',
    SITE_CONFIG: {
      get: async () => SITE_CONFIG_JSON
    },
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    }
  } as unknown as Env;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined
  } as unknown as ExecutionContext;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://painlessremovals.com/api/event/lead-status', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('handleLeadStatus — Consent Mode a Data Manager uploadon', () => {
  it('ad_allowed=true → CONSENT_GRANTED jelek az ingest body-ban', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        ad_allowed: true,
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured.events[0].consent).toEqual({
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_GRANTED'
    });
    // currency conversionValue nélkül nem megy ki (value-mentes státusz)
    expect(captured.events[0].currency).toBeUndefined();
  });

  it('pozitív consent-evidencia nélkül (fail-open site) a consent mező kimarad', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured.events[0].consent).toBeUndefined();
  });

  it('ad_allowed=false → nincs Google-hívás (consent-blokk)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        ad_allowed: false,
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
