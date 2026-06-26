import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendToGoogleAdsCAPI } from '../src/lib/gads';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';

const baseSiteConfig: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1', access_token: 'T' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: { customer_id: '1234567890', login_customer_id: null }
};

const minimalEnv: Env = {
  GADS_DEVELOPER_TOKEN: 'devtoken',
  GADS_OAUTH_CLIENT_ID: 'client',
  GADS_OAUTH_CLIENT_SECRET: 'secret'
} as unknown as Env;

describe('sendToGoogleAdsCAPI — null customer_id skip (audit fix)', () => {
  it('returns success:true without making any HTTP call when customer_id is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cfg: SiteConfig = {
      ...baseSiteConfig,
      gads: { customer_id: null, login_customer_id: null }
    };
    const result = await sendToGoogleAdsCAPI(
      cfg,
      minimalEnv,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-1',
        event_time: Math.floor(Date.now() / 1000)
      },
      {}
    );
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('sendToGoogleAdsCAPI — addressInfo normalization (audit #1)', () => {
  it('sends NORMALIZED plain city/postal/country (not raw client input)', async () => {
    let captured: any = null;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}] }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    // OAUTH_TOKENS KV mock — cached access token → nincs refresh fetch.
    const env: Env = {
      GADS_DEVELOPER_TOKEN: 'devtoken',
      GADS_OAUTH_CLIENT_ID: 'client',
      GADS_OAUTH_CLIENT_SECRET: 'secret',
      OAUTH_TOKENS: {
        get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
        put: async () => undefined
      }
    } as unknown as Env;

    const cfg: SiteConfig = {
      ...baseSiteConfig,
      country_code: 'GB',
      gads: {
        customer_id: '1234567890',
        login_customer_id: null,
        conversion_actions: { callback_conversion: '99887766' }
      }
    };

    const result = await sendToGoogleAdsCAPI(
      cfg,
      env,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-addr',
        event_time: Math.floor(Date.now() / 1000),
        city: '  Bristol  ',
        postal_code: 'sw1a 1aa',
        country: 'United Kingdom'
      },
      // addressInfo csak akkor épül, ha van hashed fn/ln
      { fn: 'a'.repeat(64), ln: 'b'.repeat(64) }
    );

    expect(result.success).toBe(true);
    const addressInfo = captured.conversions[0].userIdentifiers.find(
      (u: any) => u.addressInfo
    ).addressInfo;
    expect(addressInfo.city).toBe('bristol'); // lowercase + trim
    expect(addressInfo.postalCode).toBe('SW1A1AA'); // upper + whitespace strip
    expect(addressInfo.countryCode).toBe('GB'); // name → gb → uppercase
    vi.unstubAllGlobals();
  });
});

describe('sendToGoogleAdsCAPI — MISSING_CONVERSION_ACTION skip (audit fix)', () => {
  it('returns success:true (permanent skip — not DLQ-bound) when conversion_action missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cfg: SiteConfig = {
      ...baseSiteConfig,
      gads: {
        customer_id: '1234567890',
        login_customer_id: null,
        conversion_actions: {} // empty — no mapping for any event
      }
    };
    const result = await sendToGoogleAdsCAPI(
      cfg,
      minimalEnv,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-1',
        event_time: Math.floor(Date.now() / 1000)
      },
      {}
    );
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
