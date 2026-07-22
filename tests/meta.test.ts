import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendToMetaCAPI } from '../src/lib/meta';
import type { SiteConfig } from '../src/lib/config';

const baseSiteConfig: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: { customer_id: null, login_customer_id: null }
};

describe('sendToMetaCAPI — value:0 skip (CLAUDE.md rule 3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('OMITS value entirely when payload.value === 0', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-1',
        event_time: Math.floor(Date.now() / 1000),
        value: 0,
        currency: 'GBP'
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].custom_data).not.toHaveProperty('value');
    expect(body.data[0].custom_data).not.toHaveProperty('currency');
  });

  it('INCLUDES value when payload.value > 0', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-2',
        event_time: Math.floor(Date.now() / 1000),
        value: 380,
        currency: 'GBP'
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].custom_data.value).toBe(380);
    expect(body.data[0].custom_data.currency).toBe('GBP');
  });

  it('OMITS value when negative (defensive)', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-3',
        event_time: Math.floor(Date.now() / 1000),
        value: -1,
        currency: 'GBP'
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].custom_data).not.toHaveProperty('value');
  });
});

describe('sendToMetaCAPI — request structure (CLAUDE.md rule 2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses event_time in seconds (not ms)', async () => {
    const tNow = Math.floor(Date.now() / 1000);
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-x',
        event_time: tNow,
        value: 1,
        currency: 'GBP'
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].event_time).toBe(tNow);
    expect(body.data[0].event_time).toBeLessThan(2e10); // sanity: not ms
  });

  it('sets action_source: website', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-x',
        event_time: Math.floor(Date.now() / 1000)
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].action_source).toBe('website');
  });

  it('passes event_id un-hashed', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'plain-event-id-123',
        event_time: Math.floor(Date.now() / 1000)
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].event_id).toBe('plain-event-id-123');
  });

  // §17: a KV `meta.test_event_code` SOHA nem érvényesülhet (edge-cache-ablakban
  // valódi konverziókat terelne a Meta Test streambe — két éles leak történt így).
  // A per-request payload code az EGYETLEN elfogadott forrás.
  it('IGNORES a KV meta.test_event_code-ot (§17), csak a per-request kódot használja', async () => {
    const cfg = {
      ...baseSiteConfig,
      meta: { ...baseSiteConfig.meta, test_event_code: 'TEST_KV_LANDMINE' }
    };
    // (a) KV kód jelen, per-request NINCS → a body NEM tartalmazhat test_event_code-ot.
    await sendToMetaCAPI(
      cfg,
      { event_name: 'callback_conversion', event_id: 'evt-x', event_time: Math.floor(Date.now() / 1000) },
      {}
    );
    const kvOnlyBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(kvOnlyBody).not.toHaveProperty('test_event_code');

    // (b) per-request kód jelen (KV is jelen) → a body a PER-REQUEST kódot viszi.
    fetchMock.mockClear();
    await sendToMetaCAPI(
      cfg,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-y',
        event_time: Math.floor(Date.now() / 1000),
        test_event_code: 'TEST_PER_REQUEST'
      },
      {}
    );
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(reqBody.test_event_code).toBe('TEST_PER_REQUEST');
  });

  it('omits test_event_code when not in config (production flow)', async () => {
    await sendToMetaCAPI(
      baseSiteConfig,
      {
        event_name: 'callback_conversion',
        event_id: 'evt-x',
        event_time: Math.floor(Date.now() / 1000)
      },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('test_event_code');
  });
});
