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
