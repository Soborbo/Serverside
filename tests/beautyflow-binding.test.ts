import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendToMetaCAPI } from '../src/lib/meta';
import { sendToGA4MP } from '../src/lib/ga4';
import { ALLOWED_EVENT_NAMES } from '../src/types';
import type { SiteConfig } from '../src/lib/config';

// A migration site (e.g. beautyflow): browser GA4 already fires via GTM, so the
// `ga4` block is OMITTED → the gateway must NOT send GA4 MP (no double-counting).
const noGa4Config = {
  site_id: 'beautyflow',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  meta: { pixel_id: '915395591548632', access_token: 'TOKEN' },
  gads: {
    customer_id: '9796138635',
    login_customer_id: null,
    conversion_actions: { contact_form_submit: '7335562213', phone_conversion: '7335759042' }
  }
} as unknown as SiteConfig;

const withGa4Config: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: { customer_id: null, login_customer_id: null }
};

describe('beautyflow binding — booking_click + optional GA4', () => {
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

  it('booking_click is an allowed gateway event', () => {
    expect(ALLOWED_EVENT_NAMES.has('booking_click')).toBe(true);
  });

  it('Meta CAPI maps booking_click → InitiateCheckout', async () => {
    await sendToMetaCAPI(
      withGa4Config,
      { event_name: 'booking_click', event_id: 'evt-bc', event_time: Math.floor(Date.now() / 1000) },
      {}
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data[0].event_name).toBe('InitiateCheckout');
  });

  it('GA4 MP is skipped (no fetch) when the site omits the ga4 block', async () => {
    const result = await sendToGA4MP(noGa4Config, {
      event_name: 'contact_form_submit',
      event_id: 'evt-1',
      client_id: '123.456'
    });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GA4 MP still fires when the site DOES have a ga4 block', async () => {
    await sendToGA4MP(withGa4Config, {
      event_name: 'contact_form_submit',
      event_id: 'evt-2',
      client_id: '123.456'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
