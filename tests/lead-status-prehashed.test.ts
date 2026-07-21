import { describe, it, expect, vi, afterEach } from 'vitest';
// cloudflare:email runtime-import elkerülése (lásd lead-status-consent.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s) => s
}));

import { handleLeadStatus, validateLeadStatusBody } from '../src/routes/lead-status';
import type { Env } from '../src/env';

/**
 * F3-D · Prehashed PII contract a /lead-status lifecycle-lábon. A CRM outbox CSAK
 * Google-normalizált SHA-256 hash-eket küld (`user_data_hashed`) — a gateway NEM
 * hash-el újra (dupla hash → néma Google EC match-rate esés). Ez a teszt bizonyítja:
 *  (a) a küldött hash VÁLTOZATLANUL landol a Data Manager ingest body-ban;
 *  (b) hibás hash / kettős identity-forrás → fail-loud 400.
 */

// 64-char lowercase hex — a gateway CSAK a formátumot validálja és pass-through-ol
// (nem SHA-256-olja újra), így elég egy fix, valid alakú érték.
const EMAIL_HASH = 'a'.repeat(64);
const PHONE_HASH = 'b'.repeat(64);

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
    SITE_CONFIG: { get: async () => SITE_CONFIG_JSON },
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

describe('validateLeadStatusBody — user_data_hashed shape', () => {
  const base = { lead_id: '550e8400-e29b-41d4-a716-446655440000', status: 'revenue_confirmed' };

  it('accepts an object user_data_hashed', () => {
    const r = validateLeadStatusBody({ ...base, user_data_hashed: { sha256_email: EMAIL_HASH } });
    expect(r?.user_data_hashed).toEqual({ sha256_email: EMAIL_HASH });
  });

  it('rejects user_data_hashed arrays (typeof [] === object)', () => {
    expect(validateLeadStatusBody({ ...base, user_data_hashed: [EMAIL_HASH] })).toBeNull();
  });

  it('leaves user_data_hashed undefined when absent', () => {
    expect(validateLeadStatusBody(base)?.user_data_hashed).toBeUndefined();
  });
});

describe('handleLeadStatus — prehashed user_data_hashed', () => {
  it('a küldött hash VÁLTOZATLANUL megy a Data Manager ingest identifierbe (nincs újra-hash)', async () => {
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
        user_data_hashed: { sha256_email: EMAIL_HASH, sha256_phone: PHONE_HASH }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    const idents = captured.events[0].userData.userIdentifiers;
    expect(idents).toContainEqual({ emailAddress: EMAIL_HASH });
    expect(idents).toContainEqual({ phoneNumber: PHONE_HASH });
  });

  it('plain user_data mellett érkező user_data_hashed → 400 (kölcsönösen kizáró identity)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        user_data: { email: 'jane@example.com' },
        user_data_hashed: { sha256_email: EMAIL_HASH }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plain CÍM (postal_code/country) a user_data-ban MEGENGEDETT a hash-elt identity mellett', async () => {
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
        user_data: { postal_code: 'SW1A 1AA', country: 'gb' },
        user_data_hashed: { sha256_email: EMAIL_HASH }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(captured.events[0].userData.userIdentifiers).toContainEqual({ emailAddress: EMAIL_HASH });
  });

  it('hibás (nem 64-hex) hash → 400 fail-loud a mezőnévvel', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        user_data_hashed: { sha256_email: 'not-a-valid-hash' }
      }),
      makeEnv(),
      makeCtx()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('sha256_email');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
