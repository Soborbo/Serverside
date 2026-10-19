/**
 * 6.14.0 — konfigurálható consent-végpont (PUBLIC_TRACKING_CONSENT_ENDPOINT).
 *
 * A `trailingSlash: 'always'` Astro-site-ok (skinlab) a `/api/consent/*`-ot
 * perjeles útvonalra proxyzzák; a kit eddig a `/api/consent` és
 * `/api/consent/shown` URL-t kódolta be. Most minden consent-URL EGY helyről
 * épül (`consentEndpointUrl`), a záró perjel tiszteletben tartva. Perjel
 * nélkül a kimenő kérések bájtra a 6.13-asak — ezt a `consent-sbo.test.ts`
 * meglévő `expect(url).toBe('/api/consent')` állítása is őrzi.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applySboDecision, consentEndpointUrl, postBannerShown } from '../lib/consent-sbo';
import { trackingConfig } from '../lib/config';
import { resetAll } from './helpers';

const CTX = { bannerVersion: '2026-09-a-b2', consentTextVersion: '2026-09-a.ga4' };
const DEFAULT_ENDPOINT = trackingConfig.consentEndpoint;

function mockFetch(status = 204): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ status, ok: status < 400 }) as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const flushAsync = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetAll();
  trackingConfig.consentProvider = 'sbo';
});

afterEach(() => {
  trackingConfig.consentProvider = 'cookieyes';
  trackingConfig.consentEndpoint = DEFAULT_ENDPOINT;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('consentEndpointUrl — egy helper, minden consent-URL', () => {
  it('a default `/api/consent`: a mai URL-ek bájtra változatlanok', () => {
    expect(DEFAULT_ENDPOINT).toBe('/api/consent');
    expect(consentEndpointUrl()).toBe('/api/consent');
    expect(consentEndpointUrl('shown')).toBe('/api/consent/shown');
  });

  it('záró perjellel: a perjel az alapon ÉS a szegmensen is megmarad', () => {
    trackingConfig.consentEndpoint = '/api/consent/';
    expect(consentEndpointUrl()).toBe('/api/consent/');
    expect(consentEndpointUrl('shown')).toBe('/api/consent/shown/');
    // Egy jövőbeli GET `<alap>/<id>/` ugyanezen a szabályon épülne.
    expect(consentEndpointUrl('abc-123')).toBe('/api/consent/abc-123/');
  });

  it('más alap (pl. egy saját proxy-prefix) perjel nélkül', () => {
    trackingConfig.consentEndpoint = '/cmp/consent';
    expect(consentEndpointUrl()).toBe('/cmp/consent');
    expect(consentEndpointUrl('shown')).toBe('/cmp/consent/shown');
  });

  it('üres alap → a default (egy elgépelt üres env nem kapcsolhatja ki a POST-ot)', () => {
    trackingConfig.consentEndpoint = '';
    expect(consentEndpointUrl()).toBe('/api/consent');
    expect(consentEndpointUrl('shown')).toBe('/api/consent/shown');
  });
});

describe('a döntés POST-ja és a megjelenés-ping a konfigurált végpontra megy', () => {
  it('perjel nélkül: POST /api/consent (a credentials és a body változatlan)', async () => {
    const fetchMock = mockFetch(204);
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/consent');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body)).decision).toBe('accept_all');
  });

  it('záró perjellel: POST /api/consent/ — a key-mismatch / rotateChain út ugyanezt az URL-t használja', async () => {
    trackingConfig.consentEndpoint = '/api/consent/';
    const urls: string[] = [];
    const replies = [
      { status: 403, ok: false, text: async () => 'consent_key_mismatch' },
      { status: 403, ok: false, text: async () => 'consent_key_mismatch' },
      { status: 204, ok: true },
    ] as unknown as Response[];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return replies.shift() ?? ({ status: 204, ok: true } as Response); }));
    applySboDecision({ analytics: true, marketing: true }, CTX);
    for (let i = 0; i < 6; i++) await flushAsync();
    expect(urls).toHaveLength(3);
    expect(new Set(urls)).toEqual(new Set(['/api/consent/']));
  });

  it('postBannerShown: sendBeacon a `<alap>/shown` címre, perjel nélkül és perjellel', () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon });

    postBannerShown({ banner_version: '2026-09-a-b2' });
    expect(beacon.mock.calls[0][0]).toBe('/api/consent/shown');

    trackingConfig.consentEndpoint = '/api/consent/';
    postBannerShown({ banner_version: '2026-09-a-b2' });
    expect(beacon.mock.calls[1][0]).toBe('/api/consent/shown/');
  });

  it('postBannerShown: sendBeacon nélkül a fetch-tartalék ugyanarra a címre megy', async () => {
    trackingConfig.consentEndpoint = '/api/consent/';
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: undefined });
    const fetchMock = mockFetch(204);
    postBannerShown({ banner_version: '2026-09-a-b2' });
    await flushAsync();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/consent/shown/');
    expect(init.method).toBe('POST');
  });
});
