import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseAttribution, buildFbcFromFbclid } from '../src/lib/attribution';
import { sendToGoogleAdsCAPI } from '../src/lib/gads';
import { sendToGA4MP } from '../src/lib/ga4';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';

const baseSiteConfig: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1', access_token: 'T' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: { customer_id: null, login_customer_id: null }
};

describe('parseAttribution', () => {
  it('returns undefined for non-object / empty', () => {
    expect(parseAttribution(undefined)).toBeUndefined();
    expect(parseAttribution(null)).toBeUndefined();
    expect(parseAttribution({})).toBeUndefined();
  });

  it('keeps valid click IDs and UTMs, drops unknown keys', () => {
    const a = parseAttribution({
      gclid: 'EAIaIQobChMI_abc-123.def',
      utm_source: 'google',
      utm_campaign: 'summer sale 2026',
      not_a_real_field: 'x'
    });
    expect(a).toEqual({
      gclid: 'EAIaIQobChMI_abc-123.def',
      utm_source: 'google',
      utm_campaign: 'summer sale 2026'
    });
    expect((a as Record<string, unknown>).not_a_real_field).toBeUndefined();
  });

  it('rejects click IDs with illegal charset', () => {
    // space / quotes not allowed in token fields
    expect(parseAttribution({ gclid: 'bad id with spaces' })).toBeUndefined();
    expect(parseAttribution({ gclid: 'inject"<script>' })).toBeUndefined();
  });

  it('preserves spaces in UTM text but strips control chars', () => {
    const a = parseAttribution({ utm_campaign: 'spring\n\tsale', utm_term: 'red shoes' });
    expect(a?.utm_campaign).toBe('springsale');
    expect(a?.utm_term).toBe('red shoes');
  });

  it('bounds overly long token (DoS guard)', () => {
    expect(parseAttribution({ gclid: 'a'.repeat(2000) })).toBeUndefined();
  });
});

describe('buildFbcFromFbclid', () => {
  it('builds fb.1.<ms>.<fbclid>', () => {
    expect(buildFbcFromFbclid('AbC123', 1700000000)).toBe('fb.1.1700000000000.AbC123');
  });
  it('undefined when no fbclid', () => {
    expect(buildFbcFromFbclid(undefined, 1700000000)).toBeUndefined();
  });
});

describe('sendToGoogleAdsCAPI — click ID priority', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const cfg: SiteConfig = {
    ...baseSiteConfig,
    gads: {
      customer_id: '1234567890',
      login_customer_id: null,
      conversion_actions: { callback_conversion: '99887766' }
    }
  };
  const env: Env = {
    GADS_DEVELOPER_TOKEN: 'devtoken',
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    OAUTH_TOKENS: {
      get: vi.fn(async (key: string) => (key.endsWith(':access_token') ? 'tok' : null))
    }
  } as unknown as Env;

  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [{}] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sets gclid on the conversion when present', async () => {
    await sendToGoogleAdsCAPI(
      cfg,
      env,
      {
        event_name: 'callback_conversion',
        event_id: 'e1',
        event_time: Math.floor(Date.now() / 1000),
        gclid: 'G-abc',
        gbraid: 'GB-xyz'
      },
      { em: 'hashedmail' }
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.conversions[0].gclid).toBe('G-abc');
    // gclid prioritás → gbraid NEM kerül rá
    expect(body.conversions[0]).not.toHaveProperty('gbraid');
    // EC for Leads fallback megmarad
    expect(body.conversions[0].userIdentifiers).toEqual([{ hashedEmail: 'hashedmail' }]);
  });

  it('falls back to gbraid then wbraid', async () => {
    await sendToGoogleAdsCAPI(
      cfg,
      env,
      {
        event_name: 'callback_conversion',
        event_id: 'e2',
        event_time: Math.floor(Date.now() / 1000),
        wbraid: 'WB-1'
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.conversions[0].wbraid).toBe('WB-1');
  });
});

describe('sendToGA4MP — UTM forwarding', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('maps utm_* to GA4 campaign params; does not clobber existing custom source', async () => {
    await sendToGA4MP(baseSiteConfig, {
      event_name: 'contact_form_submit',
      event_id: 'e1',
      client_id: '1.2',
      source: 'contact_form', // existing custom param
      attribution: {
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'brand',
        utm_id: '12345',
        utm_term: 'kw',
        utm_content: 'ad1'
      }
    });
    const p = JSON.parse(fetchMock.mock.calls[0][1].body as string).events[0].params;
    expect(p.source).toBe('contact_form'); // NOT overwritten by utm_source
    expect(p.medium).toBe('cpc');
    expect(p.campaign).toBe('brand');
    expect(p.campaign_id).toBe('12345');
    expect(p.term).toBe('kw');
    expect(p.content).toBe('ad1');
  });

  it('fills source from utm_source when no custom source set', async () => {
    await sendToGA4MP(baseSiteConfig, {
      event_name: 'contact_form_submit',
      event_id: 'e2',
      client_id: '1.2',
      attribution: { utm_source: 'newsletter' }
    });
    const p = JSON.parse(fetchMock.mock.calls[0][1].body as string).events[0].params;
    expect(p.source).toBe('newsletter');
  });
});
