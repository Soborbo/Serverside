import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendToDataManager } from '../src/lib/datamanager';
import { normalizeEmailForGoogle, hashUserDataForGoogle, sha256Hex } from '../src/lib/hash';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';
import type { GAdsPayload } from '../src/lib/gads';

const baseSiteConfig: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1', access_token: 'T' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { lead_qualified: '99887766' }
  }
};

function envWithCachedToken(extra: Partial<Env> = {}): Env {
  return {
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    },
    ...extra
  } as unknown as Env;
}

const basePayload: GAdsPayload = {
  event_name: 'lead_qualified',
  event_id: 'order-abc-123',
  event_time: 1781122021 // 2026-06-10T20:07:01Z
};

afterEach(() => vi.unstubAllGlobals());

describe('normalizeEmailForGoogle', () => {
  it('strips dots in gmail.com local part', () => {
    expect(normalizeEmailForGoogle('john.smith@gmail.com')).toBe('johnsmith@gmail.com');
  });
  it('strips plus-suffix in gmail.com', () => {
    expect(normalizeEmailForGoogle('john+spam@gmail.com')).toBe('john@gmail.com');
  });
  it('strips both dots and plus in gmail.com', () => {
    expect(normalizeEmailForGoogle('john.smith+promo@gmail.com')).toBe('johnsmith@gmail.com');
  });
  it('applies the same rule to googlemail.com', () => {
    expect(normalizeEmailForGoogle('a.b.c@googlemail.com')).toBe('abc@googlemail.com');
  });
  it('leaves non-gmail domains untouched (dots + plus preserved)', () => {
    expect(normalizeEmailForGoogle('john.smith+x@outlook.com')).toBe('john.smith+x@outlook.com');
  });
  it('lowercases + trims like the Meta normalizer', () => {
    expect(normalizeEmailForGoogle('  John.Smith@Gmail.com ')).toBe('johnsmith@gmail.com');
  });
  it('falls back to the un-stripped address if local part collapses to empty', () => {
    expect(normalizeEmailForGoogle('+only@gmail.com')).toBe('+only@gmail.com');
  });
  it('returns undefined for invalid input', () => {
    expect(normalizeEmailForGoogle('not-an-email')).toBeUndefined();
  });
});

describe('hashUserDataForGoogle', () => {
  it('hashes the Google-normalized email (differs from the Meta hash for Gmail)', async () => {
    const hashed = await hashUserDataForGoogle({ email: 'john.smith@gmail.com' });
    expect(hashed.em).toBe(await sha256Hex('johnsmith@gmail.com'));
  });
});

describe('sendToDataManager — skips without HTTP', () => {
  it('returns success and makes no call when customer_id is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cfg: SiteConfig = {
      ...baseSiteConfig,
      gads: { customer_id: null, login_customer_id: null }
    };
    const result = await sendToDataManager(cfg, envWithCachedToken(), basePayload, {});
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns success and makes no call when conversion action is unmapped', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cfg: SiteConfig = {
      ...baseSiteConfig,
      gads: { customer_id: '1234567890', login_customer_id: null, conversion_actions: {} }
    };
    const result = await sendToDataManager(cfg, envWithCachedToken(), basePayload, {});
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendToDataManager — request shape', () => {
  it('builds a correct events:ingest body and omits the developer-token header', async () => {
    let captured: any = null;
    let capturedHeaders: any = null;
    let capturedUrl = '';
    const fetchMock = vi.fn(async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'req-1' }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg: SiteConfig = {
      ...baseSiteConfig,
      gads: {
        customer_id: '1234567890',
        login_customer_id: '5556667770',
        conversion_actions: { lead_qualified: '99887766' }
      }
    };
    const payload: GAdsPayload = {
      ...basePayload,
      value: 250,
      currency: 'GBP',
      postal_code: 'sw1a 1aa',
      country: 'gb'
    };
    const hashed = { em: 'EMHASH', ph: 'PHHASH', fn: 'FNHASH', ln: 'LNHASH' };

    const result = await sendToDataManager(cfg, envWithCachedToken(), payload, hashed);
    expect(result.success).toBe(true);

    expect(capturedUrl).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(capturedHeaders.Authorization).toBe('Bearer cached-token');
    expect(capturedHeaders['developer-token']).toBeUndefined();

    // destination
    const dest = captured.destinations[0];
    expect(dest.operatingAccount).toEqual({ accountType: 'GOOGLE_ADS', accountId: '1234567890' });
    expect(dest.loginAccount).toEqual({ accountType: 'GOOGLE_ADS', accountId: '5556667770' });
    expect(dest.productDestinationId).toBe('99887766');

    expect(captured.encoding).toBe('HEX');
    expect(captured.validateOnly).toBe(false);

    // event
    const ev = captured.events[0];
    expect(ev.transactionId).toBe('order-abc-123');
    expect(ev.eventTimestamp).toBe('2026-06-10T20:07:01Z');
    expect(ev.eventSource).toBe('WEB');
    expect(ev.conversionValue).toBe(250);
    expect(ev.currency).toBe('GBP');

    // userData
    const ids = ev.userData.userIdentifiers;
    expect(ids).toContainEqual({ emailAddress: 'EMHASH' });
    expect(ids).toContainEqual({ phoneNumber: 'PHHASH' });
    const addr = ids.find((i: any) => i.address)?.address;
    expect(addr.givenName).toBe('FNHASH'); // hashed
    expect(addr.familyName).toBe('LNHASH'); // hashed
    expect(addr.regionCode).toBe('GB'); // PLAIN, uppercase
    expect(addr.postalCode).toBe('SW1A1AA'); // PLAIN, normalized
  });

  it('omits value:0 entirely (CLAUDE.md Rule 3)', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });
    await sendToDataManager(
      baseSiteConfig,
      envWithCachedToken(),
      { ...basePayload, value: 0, currency: 'GBP' },
      { em: 'EMHASH' }
    );
    expect(captured.events[0].conversionValue).toBeUndefined();
    // currency conversionValue nélkül szintén kimarad
    expect(captured.events[0].currency).toBeUndefined();
  });

  it('maps consent signals to CONSENT_GRANTED / CONSENT_DENIED', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });
    await sendToDataManager(
      baseSiteConfig,
      envWithCachedToken(),
      { ...basePayload, consent: { ad_user_data: 'GRANTED', ad_personalization: 'DENIED' } },
      { em: 'EMHASH' }
    );
    expect(captured.events[0].consent).toEqual({
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_DENIED'
    });
  });

  it('sets validateOnly=true when DATAMANAGER_VALIDATE_ONLY=1', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });
    await sendToDataManager(
      baseSiteConfig,
      envWithCachedToken({ DATAMANAGER_VALIDATE_ONLY: '1' } as Partial<Env>),
      basePayload,
      { em: 'EMHASH' }
    );
    expect(captured.validateOnly).toBe(true);
  });

  it('skips (success, no HTTP) when there is no identifier at all — permanent 400 elkerülése', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, {});
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a click ID alone counts as an identifier (no userData needed)', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });
    const result = await sendToDataManager(
      baseSiteConfig,
      envWithCachedToken(),
      { ...basePayload, gclid: 'Cj0KCQtest' },
      {}
    );
    expect(result.success).toBe(true);
    expect(captured.events[0].adIdentifiers).toEqual({ gclid: 'Cj0KCQtest' });
    expect(captured.events[0].userData).toBeUndefined();
  });
});

describe('sendToDataManager — error handling', () => {
  it('classifies 401 as DATAMANAGER_AUTH_REJECTED', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 401, message: 'invalid auth' } })
    }));
    const result = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, {
      em: 'EMHASH'
    });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('TRK-840-004');
  });

  it('classifies a not-allowlisted message as DATAMANAGER_NOT_ALLOWLISTED', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 400, message: 'destination NOT_ALLOWLISTED for feature' } })
    }));
    const result = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, {
      em: 'EMHASH'
    });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('TRK-840-006');
  });
});
