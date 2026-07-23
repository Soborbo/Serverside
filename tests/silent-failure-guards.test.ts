/**
 * A 2026-07-23-i mélyaudit három „csendes zöld" rését zárja be. Mindhárom közös
 * mintája ugyanaz: a rendszer OLYAN kimenetet könyvelt sikernek vagy véglegesnek,
 * ami valójában nem volt az — és pont ezért egyik sem bukott meg tesztben.
 *
 *  - normalizeDelivery: az offline Data Manager skip hibakódja elveszett, így a
 *    config-blokk megkülönböztethetetlen volt a jogos consent-kihagyástól.
 *  - lookupSiteConfig: a tranziens KV-hiba ugyanazt a 404-et adta, mint a nem
 *    létező site — a CRM ezt VÉGLEGESNEK osztályozza (failed_permanent).
 *  - sendToDataManager validate-only: a Google validált, de semmit nem rögzített,
 *    a ledger mégis `accepted`-et és uploaded_to_gads:true-t látott.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { normalizeDelivery, getLatestConsentForLead } from '../src/lib/ledger';
import { lookupSiteConfig, getSiteConfig, type SiteConfig } from '../src/lib/config';
import { sendToDataManager } from '../src/lib/datamanager';
import { TrackingErrorCode } from '../src/lib/error-codes';
import type { Env } from '../src/env';
import type { GAdsPayload } from '../src/lib/gads';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('normalizeDelivery propagates vendor skip error codes', () => {
  it('carries the Data Manager skip error_code into the ledger row', () => {
    // A Data Manager `skip_reason` NÉLKÜL, csak `error_code`-dal jelez. A skip-ág
    // korábban kizárólag a skip_reason-t nézte, így ezek a sorok csupasz
    // 'skipped'-ként landoltak — a napi digest nem tudta megkülönböztetni őket a
    // jogos consent-kihagyástól (ez rejtette el a lomtalan Meta-kiesését is).
    const r = normalizeDelivery('gads', {
      status: 'fulfilled',
      value: {
        success: true,
        skipped: true,
        error_code: TrackingErrorCode.MISSING_CONVERSION_ACTION
      }
    });

    expect(r).toMatchObject({
      platform: 'gads',
      status: 'skipped',
      error_code: TrackingErrorCode.MISSING_CONVERSION_ACTION
    });
  });

  it('keeps not_configured mapping ahead of a vendor-supplied code', () => {
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: {
        success: true,
        skipped: true,
        skip_reason: 'not_configured',
        error_code: TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS
      }
    });

    expect(r).toMatchObject({
      status: 'skipped',
      error_code: TrackingErrorCode.PLATFORM_NOT_CONFIGURED
    });
  });

  it('leaves a plain consent skip without an error code', () => {
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true, skipped: true, skip_reason: 'consent_denied' }
    });

    expect(r).toEqual({ platform: 'meta', status: 'skipped' });
  });
});

describe('getLatestConsentForLead prefers signal-bearing receipts', () => {
  it('asks SQL for the signal-bearing receipt ahead of the merely-newer one', async () => {
    let captured = '';
    const env = {
      LEDGER: {
        prepare(sql: string) {
          captured = sql;
          return { bind: () => ({ first: async () => null }) };
        }
      }
    } as unknown as Env;

    await getLatestConsentForLead(env, 'painless', 'lead-1');

    // Az e2e stateful fake ezt a rendezést TÜKRÖZI kézzel. Ha a valós SQL-ből
    // kikerülne a jel-preferencia, a fake attól még zöld maradna — ezért a
    // szerződést magán a lekérdezésen is rögzítjük. Enélkül egy későbbi, jel
    // nélküli szerver-receipt újra elárnyékolhatná a capture-kori GRANTED-et.
    expect(captured.replace(/\s+/g, ' ')).toContain(
      'ORDER BY (ad_user_data IS NOT NULL) DESC, received_at DESC'
    );
  });
});

describe('lookupSiteConfig separates a transient KV outage from a missing site', () => {
  function envWithKv(get: () => Promise<unknown>): Env {
    return { SITE_CONFIG: { get } } as unknown as Env;
  }

  it('flags a KV read failure as unavailable (retryable), not as missing config', async () => {
    const result = await lookupSiteConfig('kv-outage.example', envWithKv(async () => {
      throw new Error('KV unavailable');
    }));

    expect(result).toEqual({ config: null, unavailable: true });
  });

  it('reports a genuinely absent host as missing, not unavailable', async () => {
    const result = await lookupSiteConfig('nope.example', envWithKv(async () => null));

    expect(result).toEqual({ config: null, unavailable: false });
  });

  it('does not negative-cache a KV failure (a blip must not freeze into "no such site")', async () => {
    let calls = 0;
    const config = { site_id: 'painless' } as SiteConfig;
    const env = envWithKv(async () => {
      calls += 1;
      if (calls === 1) throw new Error('KV unavailable');
      return config;
    });

    const first = await lookupSiteConfig('blip.example', env);
    const second = await lookupSiteConfig('blip.example', env);

    expect(first.unavailable).toBe(true);
    // Ha a hibát negatívan cache-elnénk, a második hívás a cache-ből adna null-t
    // és a site percekig „nem létezőnek" látszana a KV helyreállása után is.
    expect(second.config).toEqual(config);
  });

  it('getSiteConfig stays backwards compatible for non money-path callers', async () => {
    const cfg = await getSiteConfig('kv-outage-compat.example', envWithKv(async () => {
      throw new Error('KV unavailable');
    }));

    expect(cfg).toBeNull();
  });
});

describe('Data Manager validate-only is never booked as a delivery', () => {
  const siteConfig = {
    site_id: 'test',
    country_code: 'GB',
    currency: 'GBP',
    gads: {
      customer_id: '1234567890',
      login_customer_id: null,
      conversion_actions: { lead_qualified: '99887766' }
    }
  } as unknown as SiteConfig;

  const payload: GAdsPayload = {
    event_name: 'lead_qualified',
    event_id: 'order-abc-123',
    event_time: 1781122021
  };

  function env(extra: Partial<Env> = {}): Env {
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

  it('returns a skipped result so the ledger cannot write accepted', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ requestId: 'r1' }), { status: 200 }));

    const result = await sendToDataManager(
      siteConfig,
      env({ DATAMANAGER_VALIDATE_ONLY: '1' } as unknown as Partial<Env>),
      payload,
      { em: 'a'.repeat(64) }
    );

    // A Google 200-at ad, de SEMMIT nem rögzít. Ha ezt sikeres kézbesítésnek
    // vennénk, a ledger 'accepted'|200-at írna és az uploaded_to_gads true lenne —
    // a monitorok zöldet mutatnának nulla valós konverzió fölött.
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.error_code).toBe(TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY);

    expect(normalizeDelivery('gads', { status: 'fulfilled', value: result })).toMatchObject({
      status: 'skipped',
      error_code: TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY
    });
  });

  it('still books a real ingest as accepted when the switch is off', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ requestId: 'r1' }), { status: 200 }));

    const result = await sendToDataManager(siteConfig, env(), payload, { em: 'a'.repeat(64) });

    expect(result).toMatchObject({ success: true, conversions_processed: 1, status: 200 });
    expect(result.skipped).toBeUndefined();
    expect(normalizeDelivery('gads', { status: 'fulfilled', value: result })).toMatchObject({
      status: 'accepted',
      http_status: 200
    });
  });
});
