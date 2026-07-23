import { describe, it, expect, vi, afterEach } from 'vitest';
// cloudflare:email runtime-import elkerülése (a lead-status.ts a sendAlert-en
// keresztül húzná be a notify.ts-t — lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s) => s
}));

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

function makeEnv(receiptRow?: {
  ad_allowed: number;
  ad_user_data: string | null;
  ad_personalization?: string | null;
}): Env {
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
    },
    // Fake LEDGER: a consent_receipts SELECT-re a megadott receipt-sort adja,
    // minden más statementre no-op (recordDeliveries/recordLeadStatus).
    ...(receiptRow !== undefined
      ? {
          LEDGER: {
            prepare: (sql: string) => ({
              bind: () => ({
                first: async () => (/FROM consent_receipts/.test(sql) ? receiptRow : null),
                run: async () => undefined,
                all: async () => ({ results: [] })
              })
            })
          }
        }
      : {})
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

/**
 * Receipt-precedencia (2026-07-17 consent-audit): a Worker saját, capture-kori
 * EXPLICIT consent-receiptje (ad_user_data GRANTED/DENIED) megelőzi a CRM
 * ad_allowed jelét. Ok: a CRM marketingConsent-je newsletter-optin szemantikájú,
 * a site-ok nem töltik a CookieYes ad-consentből → önmagában minden offline
 * uploadot némán blokkolna, miközben a ledgerben ott a bizonyítható GRANTED.
 */
describe('handleLeadStatus — receipt-precedencia a CRM ad_allowed felett', () => {
  it('explicit GRANTED receipt + CRM ad_allowed=false → upload MEGY, CONSENT_GRANTED-del', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        ad_allowed: false,
        user_data: { email: 'jane@example.com' }
      }),
      // Valósághű CookieYes-receipt: az `advertisement` egységként adja mindkét
      // jelet, ezért ad_user_data ÉS ad_personalization is GRANTED.
      makeEnv({ ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured.events[0].consent).toEqual({
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_GRANTED'
    });
  });

  // Regresszió-őr (#7): az ad_personalization KÜLÖN jel — NEM vezethető le az
  // ad_user_data-ból. Ha a user a data-használatot engedte, de a személyre szabást
  // NEM (receipt: ad_user_data=GRANTED, ad_personalization=DENIED), akkor a Google
  // felé CSAK adUserData=GRANTED mehet; adPersonalization NEM fabrikálható GRANTED-re.
  it('ad_personalization=DENIED a receiptben → NEM megy hamis GRANTED a Google-nek', async () => {
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
      makeEnv({ ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'DENIED' }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured.events[0].consent).toEqual({
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_DENIED'
    });
  });

  it('explicit DENIED receipt + CRM ad_allowed=true → nincs Google-hívás', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        ad_allowed: true,
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv({ ad_allowed: 0, ad_user_data: 'DENIED' }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('jel nélküli (fail-open) receipt NEM evidencia → a CRM ad_allowed=false blokkol', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        ad_allowed: false,
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv({ ad_allowed: 1, ad_user_data: null }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('jel nélküli receipt + CRM jel nélkül → require_consent=false enged, de consent mező kimarad', async () => {
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
      makeEnv({ ad_allowed: 1, ad_user_data: null }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured.events[0].consent).toBeUndefined();
  });
});
