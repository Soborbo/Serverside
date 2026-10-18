import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendToTikTok } from '../src/lib/tiktok';
import { sendToLinkedIn, linkedInVersionStatus, DEFAULT_VERSION } from '../src/lib/linkedin';
import type { SiteConfig } from '../src/lib/config';
import type { HashedUserData } from '../src/lib/hash';

/**
 * 2026-10-18 review R6 + R11.
 *
 * R6: a TikTok-küldő a JSON-hibát üres objektummá alakította, és a hiányzó
 *     `code`-ot nem tekintette hibának — HTTP 200 + HTML is sikernek számított.
 * R11: a LinkedIn DEFAULT_VERSION '202401' volt, ami 2025-01-22-én megszűnt.
 */

const HASHED: HashedUserData = { em: 'a'.repeat(64) };
const site = (extra: Partial<SiteConfig>) =>
  ({ site_id: 'review', country_code: 'GB', currency: 'GBP', ...extra }) as SiteConfig;

afterEach(() => vi.restoreAllMocks());

describe('R6 — TikTok: csak érvényes JSON + code=0 a siker', () => {
  const cfg = site({ tiktok: { pixel_code: 'PIX', access_token: 'TT' } });
  const payload = { event_name: 'contact_form_submitted', event_id: 'evt-1', event_time: 1750000000, ttclid: 'TT-1' };
  const respond = (body: string, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));

  const failing: Array<[string, string]> = [
    ['HTML-válasz', '<html>unexpected response</html>'],
    ['üres törzs', ''],
    ['hibás JSON', '{"code":0'],
    ['hiányzó code', '{"message":"OK"}'],
    ['nem nulla code', '{"code":40001,"message":"bad"}'],
    ['szöveges "0" code', '{"code":"0"}'],
    ['JSON-tömb', '[0]']
  ];
  for (const [label, body] of failing) {
    it(`${label} → NEM siker (újrapróbálható TRK-820-001)`, async () => {
      respond(body);
      const r = await sendToTikTok(cfg, payload, HASHED);
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('TRK-820-001');
    });
  }

  it('szabályos code=0 → siker', async () => {
    respond('{"code":0,"message":"OK"}');
    expect(await sendToTikTok(cfg, payload, HASHED)).toMatchObject({ success: true, status: 200 });
  });

  it('nem-2xx code=0-val is bukás', async () => {
    respond('{"code":0}', 500);
    expect((await sendToTikTok(cfg, payload, HASHED)).success).toBe(false);
  });
});

describe('R11 — LinkedIn: támogatott alapverzió és lejárat-figyelés', () => {
  const now = new Date('2026-10-18T00:00:00Z');

  it('az alapverzió ma támogatott (nem a megszűnt 202401)', () => {
    expect(DEFAULT_VERSION).not.toBe('202401');
    expect(linkedInVersionStatus(DEFAULT_VERSION, now)).toBe('ok');
  });

  it('a BECSÜLT verzió-állapot: ok / expiring_soon / likely_sunset / invalid', () => {
    expect(linkedInVersionStatus('202609', now)).toBe('ok');
    expect(linkedInVersionStatus('202512', now)).toBe('expiring_soon');
    expect(linkedInVersionStatus('202510', now)).toBe('likely_sunset');
    expect(linkedInVersionStatus('202401', now)).toBe('likely_sunset');
    expect(linkedInVersionStatus('2026-09', now)).toBe('invalid');
  });

  it('hiányzó api_version → a header az alapverzió', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 201 }));
    await sendToLinkedIn(
      site({ linkedin: { access_token: 'X', conversion_rules: { contact_form_submitted: 'urn:lla:llaPartnerConversion:1' } } }),
      { event_name: 'contact_form_submitted', event_id: 'evt-1', event_time: 1750000000, li_fat_id: 'LI' },
      HASHED
    );
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['LinkedIn-Version']).toBe(DEFAULT_VERSION);
  });

  it('valószínűleg megszűnt, explicit api_version → TRK-830-003 a logban (a hívás ettől még megy, a vendor dönt)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 201 }));
    await sendToLinkedIn(
      site({ linkedin: { access_token: 'X', api_version: '202401', conversion_rules: { contact_form_submitted: 'urn:lla:llaPartnerConversion:1' } } }),
      { event_name: 'contact_form_submitted', event_id: 'evt-1', event_time: 1750000000, li_fat_id: 'LI' },
      HASHED
    );
    expect(logs.some((l) => l.includes('TRK-830-003') && l.includes('likely_sunset'))).toBe(true);
  });
});
