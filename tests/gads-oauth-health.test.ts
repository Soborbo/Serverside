import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleAdmin } from '../src/routes/admin';
import { handleOAuthInit } from '../src/routes/oauth-init';

/**
 * vNext P2 — GADS OAuth HARD HEALTH RULE.
 *
 * A terv szabálya: „ha `gads.customer_id != null` és vannak offline actions, de
 * OAuth nincs → SITE HEALTH = RED. Nem warning, nem silent skip."
 *
 * RED TEST (a fix előtt): a health-check egyetlen `gads_oauth` sort adott
 * „no access token (run OAuth flow)" szöveggel — ami MISDIAGNOSIS, ha a valódi ok
 * egy hiányzó WORKER-secret. Az OAuth-flow újrafuttatása ilyenkor nem segít (az
 * /oauth-init maga is client_id nélkül építené a Google-URL-t), és az operátor a
 * saját Google-fiókjában keresi a hibát. Ez az osztály vitte a beautyflow offline
 * Google Ads lábát hetekig néma TRK-800-001-be (2026-08-11).
 */

const TOKEN = 'admin-secret-p2';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const offlineSite = {
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  require_consent: true,
  meta: { pixel_id: '123456', access_token: 'T' },
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { revenue_confirmed: '7665215416' }
  },
  expected_platforms: { smoke: ['meta'], offline: ['gads'] }
};

function kvReturning(config: unknown) {
  // A getSiteConfig `type: 'json'`-nal olvas, tehát a mock a MÁR PARSZOLT objektumot
  // adja vissza (ugyanaz a minta, mint tests/admin.test.ts-ben).
  return { SITE_CONFIG: { get: async () => config } };
}

function healthReq(host: string) {
  return new Request(`https://${host}/api/event/admin/health-check`, {
    headers: { 'X-Admin-Token': TOKEN }
  });
}

async function health(host: string, envOver: Record<string, unknown>, config: unknown = offlineSite) {
  const env = { ADMIN_API_TOKEN: TOKEN, ...kvReturning(config), ...envOver } as any;
  const res = await handleAdmin(healthReq(host), env, ctx);
  return JSON.parse(await res.text()) as {
    overall: string;
    checks: Array<{ name: string; status: string; detail: string }>;
  };
}

/**
 * BÖNGÉSZŐ-oldali Google Ads site: van `customer_id` (a cross-check GAQL-lába
 * használja), de NINCS offline conversion action, és az `expected_platforms.offline`
 * sem nevesíti a `gads`-ot. A konverziói AWCT + Enhanced Conversions a GTM-ből —
 * a gateway OAuth-ja a pénzútja szempontjából irreleváns.
 */
const browserOnlyAdsSite = {
  site_id: 'webshop',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  meta: { pixel_id: '123456', access_token: 'T' },
  gads: { customer_id: '1234567890', login_customer_id: null },
  expected_platforms: { smoke: ['meta'] }
};

const find = (b: { checks: Array<{ name: string; status: string; detail: string }> }, name: string) =>
  b.checks.find((c) => c.name === name)!;

describe('P2 — hiányzó worker-secret esetén a site health RED, és a DIAGNÓZIS pontos', () => {
  it('nincs GADS_OAUTH_CLIENT_ID → gads_oauth_secrets FAIL + overall FAIL', async () => {
    const body = await health('p2a.example.com', {
      GADS_OAUTH_CLIENT_SECRET: 'secret',
      OAUTH_TOKENS: { get: async () => null, put: async () => {} }
    });
    const secrets = find(body, 'gads_oauth_secrets');
    expect(secrets.status).toBe('FAIL');
    expect(secrets.detail).toContain('GADS_OAUTH_CLIENT_ID');
    expect(body.overall).toBe('FAIL');
  });

  it('a hibaüzenet KIMONDJA, hogy az OAuth újrafuttatása NEM segít (anti-misdiagnosis)', async () => {
    const body = await health('p2b.example.com', {
      GADS_OAUTH_CLIENT_SECRET: 'secret',
      OAUTH_TOKENS: { get: async () => null, put: async () => {} }
    });
    expect(find(body, 'gads_oauth_secrets').detail).toContain('does NOT fix this');
    // …és a gads_oauth sor is a VALÓDI okra mutat, nem a „run OAuth flow"-ra.
    expect(find(body, 'gads_oauth').detail).toContain('MISSING WORKER SECRET');
  });

  it('offline-váró site-nál a pénzút-állás EXPLICIT (OFFLINE MONEY PATH DOWN)', async () => {
    const body = await health('p2c.example.com', {
      OAUTH_TOKENS: { get: async () => null, put: async () => {} }
    });
    expect(find(body, 'gads_oauth_secrets').detail).toContain('OFFLINE MONEY PATH DOWN');
  });

  it('secretek MEGVANNAK, de nincs refresh token → a diagnózis a customer OAuth-ja', async () => {
    const body = await health('p2d.example.com', {
      GADS_OAUTH_CLIENT_ID: 'client-id',
      GADS_OAUTH_CLIENT_SECRET: 'secret',
      OAUTH_TOKENS: { get: async () => null, put: async () => {} }
    });
    expect(find(body, 'gads_oauth_secrets').status).toBe('PASS');
    const oauth = find(body, 'gads_oauth');
    expect(oauth.status).toBe('FAIL');
    expect(oauth.detail).toContain('oauth-init?customer_id=1234567890');
    expect(oauth.detail).not.toContain('MISSING WORKER SECRET');
  });

  it('developer token hiánya WARN, nem FAIL — a Data Manager upload nem függ tőle', async () => {
    const body = await health('p2e.example.com', {
      GADS_OAUTH_CLIENT_ID: 'client-id',
      GADS_OAUTH_CLIENT_SECRET: 'secret',
      OAUTH_TOKENS: { get: async () => 'cached-access-token', put: async () => {} }
    });
    const dev = find(body, 'gads_developer_token');
    expect(dev.status).toBe('WARN');
    expect(dev.detail).toContain('reconciliation');
    // A pénzút ép: minden OAuth-check PASS.
    expect(find(body, 'gads_oauth').status).toBe('PASS');
    expect(find(body, 'gads_oauth_secrets').status).toBe('PASS');
  });
});

/**
 * 2026-08-24 review #3 — a hard FAIL feltétele SZŰKÍTVE.
 *
 * RED TEST: a szűkítés előtt a puszta `gads.customer_id` elég volt a site-level
 * FAIL-hez. Egy böngésző-oldali Ads site (AWCT + EC a GTM-ből, CRM/offline lifecycle
 * NÉLKÜL) így minden nap pirosan állt volna egy olyan OAuth miatt, ami a pénzútját
 * nem is érinti — és a riasztás-fáradtság pont azt a néma hibát fedné el, amiért az
 * egész lánc létezik.
 */
describe('P2/review#3 — browser-only Ads site NEM lesz RED a gateway OAuth-tól', () => {
  it('nincs offline action és nincs expected_platforms.offline → WARN, nem FAIL', async () => {
    const body = await health(
      'p2g.example.com',
      { OAUTH_TOKENS: { get: async () => null, put: async () => {} } },
      browserOnlyAdsSite
    );
    expect(find(body, 'gads_oauth_secrets').status).toBe('WARN');
    expect(find(body, 'gads_oauth').status).toBe('WARN');
    // …és a szöveg MEGINDOKOLJA, miért nem piros (különben „elnézésnek" olvasódna).
    expect(find(body, 'gads_oauth_secrets').detail).toContain('browser-owned');
    expect(find(body, 'gads_oauth_secrets').detail).not.toContain('OFFLINE MONEY PATH DOWN');
    // Az overall a többi WARN miatt WARN, de NEM FAIL.
    expect(body.overall).toBe('WARN');
  });

  it('ugyanaz a site conversion_actions-szel MÁR FAIL (a szűkítés nem nyit rést)', async () => {
    const withAction = {
      ...browserOnlyAdsSite,
      gads: { ...browserOnlyAdsSite.gads, conversion_actions: { lead_qualified: '123' } }
    };
    const body = await health(
      'p2h.example.com',
      { OAUTH_TOKENS: { get: async () => null, put: async () => {} } },
      withAction
    );
    expect(find(body, 'gads_oauth_secrets').status).toBe('FAIL');
    expect(body.overall).toBe('FAIL');
  });

  it('conversion_actions nélkül, de expected_platforms.offline=[gads] → FAIL', async () => {
    const expectsOffline = {
      ...browserOnlyAdsSite,
      expected_platforms: { smoke: ['meta'], offline: ['gads'] }
    };
    const body = await health(
      'p2i.example.com',
      { OAUTH_TOKENS: { get: async () => null, put: async () => {} } },
      expectsOffline
    );
    expect(find(body, 'gads_oauth_secrets').status).toBe('FAIL');
    expect(find(body, 'gads_oauth_secrets').detail).toContain('OFFLINE MONEY PATH DOWN');
  });
});

describe('P2 — /oauth-init fail-fast hiányzó worker-secretre', () => {
  const initReq = () =>
    new Request('https://p2f.example.com/api/event/oauth-init?customer_id=1234567890', {
      headers: { 'X-Admin-Token': TOKEN }
    });

  it('503 + megnevezett secret, NEM redirect a Google hibaoldalára', async () => {
    const res = await handleOAuthInit(initReq(), { ADMIN_API_TOKEN: TOKEN } as any);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('GADS_OAUTH_CLIENT_ID');
    expect(text).toContain('GADS_OAUTH_CLIENT_SECRET');
    expect(text).toContain('would NOT help');
  });

  it('secretekkel a flow változatlanul indul (302 a Google consent-képernyőre)', async () => {
    const res = await handleOAuthInit(initReq(), {
      ADMIN_API_TOKEN: TOKEN,
      GADS_OAUTH_CLIENT_ID: 'client-id',
      GADS_OAUTH_CLIENT_SECRET: 'secret',
      OAUTH_TOKENS: { put: async () => {} }
    } as any);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('accounts.google.com');
    // A Data Manager scope a Modell-2 offline út előfeltétele.
    expect(decodeURIComponent(location)).toContain('https://www.googleapis.com/auth/datamanager');
  });
});
