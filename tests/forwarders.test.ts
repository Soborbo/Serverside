import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendToTikTok, TIKTOK_DEFAULT_EVENT_MAP } from '../src/lib/tiktok';
import { sendToLinkedIn } from '../src/lib/linkedin';
import { sendToMsAds, buildOfflineConversion } from '../src/lib/msads';
import type { SiteConfig } from '../src/lib/config';
import type { HashedUserData } from '../src/lib/hash';

const HASHED: HashedUserData = { em: 'a'.repeat(64), ph: 'b'.repeat(64) };

function siteConfig(extra: Partial<SiteConfig> = {}): SiteConfig {
  return {
    site_id: 'painless',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: 'PX', access_token: 'T' },
    ga4: { measurement_id: 'G-1', api_secret: 'S' },
    gads: { customer_id: null, login_customer_id: null },
    ...extra
  } as SiteConfig;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

afterEach(() => vi.restoreAllMocks());

describe('TikTok forwarder', () => {
  const payload = {
    event_name: 'contact_form_submitted',
    event_id: 'evt-1',
    event_time: 1750000000,
    value: 100,
    currency: 'GBP',
    ttclid: 'TT-123'
  };

  it('skips (no fetch) when not configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await sendToTikTok(siteConfig(), payload, HASHED);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts hashed em/ph + ttclid and maps the event; code:0 = success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ code: 0 }));
    const cfg = siteConfig({ tiktok: { pixel_code: 'PIX', access_token: 'TT-TOKEN' } });
    const r = await sendToTikTok(cfg, payload, HASHED);
    expect(r.success).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const data = body.data[0];
    expect(body.event_source_id).toBe('PIX');
    expect(data.event).toBe(TIKTOK_DEFAULT_EVENT_MAP['contact_form_submitted']); // SubmitForm
    expect(data.user.ttclid).toBe('TT-123');
    expect(data.user.email).toBe(HASHED.em);
    expect(data.user.phone).toBe(HASHED.ph);
    expect(data.properties.value).toBe(100);
  });

  it('non-zero code = failure with error_code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ code: 40001, message: 'bad' }));
    const cfg = siteConfig({ tiktok: { pixel_code: 'PIX', access_token: 'TT' } });
    const r = await sendToTikTok(cfg, payload, HASHED);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('TRK-820-001');
  });

  it('honors a per-site event-name override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ code: 0 }));
    const cfg = siteConfig({
      tiktok: { pixel_code: 'PIX', access_token: 'TT', event_names: { contact_form_submitted: 'Lead' } }
    });
    await sendToTikTok(cfg, payload, HASHED);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.data[0].event).toBe('Lead');
  });
});

describe('LinkedIn forwarder', () => {
  const payload = {
    event_name: 'contact_form_submitted',
    event_time: 1750000000,
    value: 50,
    currency: 'GBP',
    li_fat_id: 'LI-FAT-1'
  };

  it('skips when the event has no conversion rule', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cfg = siteConfig({ linkedin: { access_token: 'X', conversion_rules: {} } });
    const r = await sendToLinkedIn(cfg, payload, HASHED);
    expect(r.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds userIds (SHA256_EMAIL + li_fat_id) and posts; 2xx = success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 201 }));
    const cfg = siteConfig({
      linkedin: {
        access_token: 'BEARER',
        conversion_rules: { contact_form_submitted: 'urn:lla:llaPartnerConversion:99' }
      }
    });
    const r = await sendToLinkedIn(cfg, payload, HASHED);
    expect(r.success).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.conversion).toBe('urn:lla:llaPartnerConversion:99');
    expect(body.conversionHappenedAt).toBe(1750000000 * 1000);
    const idTypes = body.user.userIds.map((u: { idType: string }) => u.idType);
    expect(idTypes).toContain('SHA256_EMAIL');
    expect(idTypes).toContain('LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID');
    expect(body.conversionValue).toEqual({ currencyCode: 'GBP', amount: '50.00' });
  });

  it('skips when there is no matchable identifier', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cfg = siteConfig({
      linkedin: { access_token: 'B', conversion_rules: { contact_form_submitted: 'urn:x' } }
    });
    const r = await sendToLinkedIn(cfg, { event_name: 'contact_form_submitted', event_time: 1 }, {});
    expect(r.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('non-2xx = failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }));
    const cfg = siteConfig({
      linkedin: { access_token: 'B', conversion_rules: { contact_form_submitted: 'urn:x' } }
    });
    const r = await sendToLinkedIn(cfg, payload, HASHED);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('TRK-830-001');
  });
});

describe('Microsoft Ads forwarder (scaffold)', () => {
  const payload = {
    event_name: 'phone_number_clicked',
    event_time: 1750000000,
    value: 0,
    currency: 'GBP',
    msclkid: 'MS-123'
  };

  it('buildOfflineConversion returns null without config or msclkid', () => {
    expect(buildOfflineConversion(siteConfig(), payload)).toBeNull();
    const cfg = siteConfig({ microsoft_ads: { conversion_names: { phone_number_clicked: 'Phone' } } });
    expect(buildOfflineConversion(cfg, { ...payload, msclkid: undefined })).toBeNull();
  });

  it('buildOfflineConversion builds the canonical record (omits value:0)', () => {
    const cfg = siteConfig({ microsoft_ads: { conversion_names: { phone_number_clicked: 'Phone Lead' } } });
    const rec = buildOfflineConversion(cfg, payload);
    expect(rec).toEqual({
      microsoftClickId: 'MS-123',
      conversionName: 'Phone Lead',
      conversionTime: new Date(1750000000 * 1000).toISOString()
    });
    expect(rec).not.toHaveProperty('conversionValue'); // value:0 omitted
  });

  it('sendToMsAds never fires a live call; returns scaffolded+skipped when configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cfg = siteConfig({ microsoft_ads: { conversion_names: { phone_number_clicked: 'Phone' } } });
    const r = await sendToMsAds(cfg, payload, HASHED);
    expect(r.success).toBe(true);
    expect(r.scaffolded).toBe(true);
    expect(r.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled(); // live transport is TODO, not faked
  });

  it('skips silently when not configured', async () => {
    const r = await sendToMsAds(siteConfig(), payload, HASHED);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.scaffolded).toBeUndefined();
  });
});
