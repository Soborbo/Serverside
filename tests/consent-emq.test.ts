import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseConsent, resolveConsent } from '../src/lib/consent';
import { hashUserData, sha256Hex } from '../src/lib/hash';
import { sendToMetaCAPI } from '../src/lib/meta';
import { sendToGA4MP } from '../src/lib/ga4';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';

const baseSiteConfig: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: { customer_id: null, login_customer_id: null }
};

describe('parseConsent', () => {
  it('returns undefined for non-object / empty', () => {
    expect(parseConsent(undefined)).toBeUndefined();
    expect(parseConsent(null)).toBeUndefined();
    expect(parseConsent('granted')).toBeUndefined();
    expect(parseConsent({})).toBeUndefined();
    expect(parseConsent({ ad_user_data: 'MAYBE' })).toBeUndefined();
  });

  it('keeps only valid signals', () => {
    const c = parseConsent({
      ad_user_data: 'GRANTED',
      ad_personalization: 'DENIED',
      ad_storage: 'BOGUS',
      analytics_storage: 'UNSPECIFIED'
    });
    expect(c).toEqual({
      ad_user_data: 'GRANTED',
      ad_personalization: 'DENIED',
      ad_storage: undefined,
      analytics_storage: 'UNSPECIFIED'
    });
  });
});

describe('resolveConsent', () => {
  it('absent consent + require_consent=false → ad allowed (backward-compat)', () => {
    const d = resolveConsent(undefined, false);
    expect(d.adAllowed).toBe(true);
  });

  it('absent consent + require_consent=true → ad blocked (fail-closed)', () => {
    const d = resolveConsent(undefined, true);
    expect(d.adAllowed).toBe(false);
  });

  it('ad_user_data DENIED → ad blocked', () => {
    const d = resolveConsent({ ad_user_data: 'DENIED' }, false);
    expect(d.adAllowed).toBe(false);
  });

  it('ad_user_data GRANTED → ad allowed', () => {
    const d = resolveConsent({ ad_user_data: 'GRANTED' }, true);
    expect(d.adAllowed).toBe(true);
  });

  it('require_consent + partial consent WITHOUT ad_user_data → blocked (no bypass)', () => {
    // GDPR fail-closed: részleges consent objektum (csak analytics_storage)
    // NEM kerülheti meg a require_consent kaput.
    expect(resolveConsent({ analytics_storage: 'DENIED' }, true).adAllowed).toBe(false);
    expect(resolveConsent({ ad_personalization: 'GRANTED' }, true).adAllowed).toBe(false);
    expect(resolveConsent({ ad_user_data: 'UNSPECIFIED' }, true).adAllowed).toBe(false);
  });

  it('require_consent=false + UNSPECIFIED ad_user_data → allowed (fail-open)', () => {
    expect(resolveConsent({ ad_user_data: 'UNSPECIFIED' }, false).adAllowed).toBe(true);
  });
});

describe('hashUserData — external_id', () => {
  it('hashes external_id (trim+lowercase) into result.external_id', async () => {
    const expected = await sha256Hex('user-42');
    const h = await hashUserData({ external_id: '  User-42 ' }, 'GB');
    expect(h.external_id).toBe(expected);
  });

  it('omits external_id when absent/empty', async () => {
    expect((await hashUserData({}, 'GB')).external_id).toBeUndefined();
    expect((await hashUserData({ external_id: '' }, 'GB')).external_id).toBeUndefined();
  });
});

describe('sendToMetaCAPI — external_id + LDU', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes hashed external_id through to user_data', async () => {
    const hashed = await hashUserData({ external_id: 'abc' }, 'GB');
    await sendToMetaCAPI(
      baseSiteConfig,
      { event_name: 'callback_conversion', event_id: 'e1', event_time: Math.floor(Date.now() / 1000) },
      hashed
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].user_data.external_id).toBe(hashed.external_id);
  });

  it('adds data_processing_options=[LDU] only for US sites', async () => {
    const usCfg: SiteConfig = { ...baseSiteConfig, country_code: 'US' };
    await sendToMetaCAPI(
      usCfg,
      { event_name: 'callback_conversion', event_id: 'e2', event_time: Math.floor(Date.now() / 1000) },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Meta a LDU mezőket a REQUEST TOP-LEVEL-jén várja, NEM az event objektumon.
    expect(body.data_processing_options).toEqual(['LDU']);
    expect(body.data_processing_options_country).toBe(0);
    expect(body.data_processing_options_state).toBe(0);
    expect(body.data[0]).not.toHaveProperty('data_processing_options');
  });

  it('does NOT add LDU for non-US sites', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      { event_name: 'callback_conversion', event_id: 'e3', event_time: Math.floor(Date.now() / 1000) },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('data_processing_options');
  });
});

describe('sendToGA4MP — session_id + consent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('includes session_id param when provided', async () => {
    await sendToGA4MP(baseSiteConfig, {
      event_name: 'contact_form_submit',
      event_id: 'e1',
      client_id: '111.222',
      session_id: '1693412345'
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.events[0].params.session_id).toBe('1693412345');
    expect(body.events[0].params.engagement_time_msec).toBe(100);
  });

  it('includes consent object (ad_user_data/ad_personalization)', async () => {
    await sendToGA4MP(baseSiteConfig, {
      event_name: 'contact_form_submit',
      event_id: 'e2',
      client_id: '111.222',
      consent: { ad_user_data: 'GRANTED', ad_personalization: 'DENIED' }
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.consent).toEqual({ ad_user_data: 'GRANTED', ad_personalization: 'DENIED' });
  });

  it('omits consent when not provided', async () => {
    await sendToGA4MP(baseSiteConfig, {
      event_name: 'contact_form_submit',
      event_id: 'e3',
      client_id: '111.222'
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('consent');
  });
});

// A `sendToGoogleAdsCAPI — consent` blokk TÖRÖLVE (2026-08-16): a legacy
// uploadClickConversions transport megszűnt (lásd lib/gads.ts). Az ekvivalens
// fedezet a Data Manager úton él: tests/datamanager.test.ts →
// „maps consent signals to CONSENT_GRANTED / CONSENT_DENIED".
