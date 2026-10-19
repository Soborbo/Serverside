import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendToGA4MP } from '../src/lib/ga4';
import type { SiteConfig } from '../src/lib/config';
import { TrackingErrorCode } from '../src/lib/error-codes';

const cfg: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1', access_token: 'T' },
  ga4: { measurement_id: 'G-XXX', api_secret: 'secret' },
  gads: { customer_id: null, login_customer_id: null }
} as unknown as SiteConfig;

function stubFetchCapture() {
  const captured: { body?: any } = {};
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    captured.body = JSON.parse(init.body);
    return { status: 204, ok: true, json: async () => ({}) } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

afterEach(() => vi.unstubAllGlobals());

describe('sendToGA4MP — value handling (audit #4)', () => {
  it('OMITS value and currency when value is 0 (no 0-revenue conversion in GA4)', async () => {
    const captured = stubFetchCapture();
    const result = await sendToGA4MP(cfg, {
      event_name: 'callback_conversion',
      event_id: 'evt-1',
      client_id: '123.456',
      value: 0,
      currency: 'GBP'
    });
    expect(result.success).toBe(true);
    const params = captured.body.events[0].params;
    expect(params.value).toBeUndefined();
    expect(params.currency).toBeUndefined();
  });

  it('OMITS value when present but currency missing (value meaningless alone)', async () => {
    const captured = stubFetchCapture();
    await sendToGA4MP(cfg, {
      event_name: 'callback_conversion',
      event_id: 'evt-2',
      client_id: '123.456',
      value: 250
    });
    const params = captured.body.events[0].params;
    expect(params.value).toBeUndefined();
    expect(params.currency).toBeUndefined();
  });

  it('SENDS value+currency together when value > 0', async () => {
    const captured = stubFetchCapture();
    await sendToGA4MP(cfg, {
      event_name: 'callback_conversion',
      event_id: 'evt-3',
      client_id: '123.456',
      value: 250,
      currency: 'GBP'
    });
    const params = captured.body.events[0].params;
    expect(params.value).toBe(250);
    expect(params.currency).toBe('GBP');
  });
});

describe('sendToGA4MP — no PII (CLAUDE.md #9)', () => {
  it('never includes email/phone/name even if smuggled onto the payload', async () => {
    const captured = stubFetchCapture();
    await sendToGA4MP(cfg, {
      event_name: 'callback_conversion',
      event_id: 'evt-4',
      client_id: '123.456',
      // @ts-expect-error — szándékos: PII-t próbálunk becsempészni, nem mehet ki
      email: 'jane@email.com',
      // @ts-expect-error
      phone_number: '+447123456789',
      // @ts-expect-error
      first_name: 'Jane'
    });
    const serialized = JSON.stringify(captured.body);
    expect(serialized).not.toContain('jane@email.com');
    expect(serialized).not.toContain('447123456789');
    expect(serialized).not.toContain('Jane');
  });
});

describe('sendToGA4MP — session-forrás védelem (Painless audit 2026-08, P0-A)', () => {
  it('client_id nélkül SKIP-el — nem mint random fantom-usert', async () => {
    const captured = stubFetchCapture();
    const result = await sendToGA4MP(cfg, {
      event_name: 'callback_conversion',
      event_id: 'evt-5',
      client_id: undefined
    });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(captured.body).toBeUndefined();
  });

  it('a `source` labelt `cta_context` néven küldi — a foglalt `source` kulcs sosem megy ki a konverziós eventen', async () => {
    const captured = stubFetchCapture();
    await sendToGA4MP(cfg, {
      event_name: 'phone_conversion',
      event_id: 'evt-6',
      client_id: '123.456',
      source: 'standalone'
    });
    const params = captured.body.events[0].params;
    expect(params.cta_context).toBe('standalone');
    expect(params.source).toBeUndefined();
  });
});

describe('sendToGA4MP — hálózati hiba (TRK-700-002)', () => {
  // A fetch elutasítása (DNS / kapcsolat bontva) NEM timeout: a kód a
  // GA4_API_NETWORK_ERROR, és a hívó sikertelen eredményt kap, nem kivételt.
  // Korábban csak véletlenül fedte a hálózat nélküli sandbox, ahol egy nem
  // mockolt fetch bukott — a CI-ban (van hálózat) nem, és a racsni bepirosodott.
  it('fetch reject → success:false, error_code = GA4_API_NETWORK_ERROR', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const result = await sendToGA4MP(cfg, {
      event_name: 'phone_conversion',
      event_id: 'evt-net',
      client_id: '123.456'
    });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe(TrackingErrorCode.GA4_API_NETWORK_ERROR);
    expect(result.error).toBe('fetch failed');
    vi.restoreAllMocks();
  });
});
