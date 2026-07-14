import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { checkOrigin, allowedOriginHosts } from '../src/lib/origin';
import { detectSpikes } from '../src/scheduled/slo-check';
import { handleConversion } from '../src/routes/conversion';
import { TrackingErrorCode } from '../src/lib/error-codes';
import type { SiteConfig } from '../src/lib/config';

/**
 * Az Origin allow-list a Turnstile HELYÉRE lépett — ez a böngésző-ág elsődleges
 * kontrollja. Ha ez elromlik, vagy némán elzárja a valódi forgalmat (mint anno a
 * Turnstile), vagy tárva hagyja az endpointot. Mindkettő csendes hiba.
 */

const site: SiteConfig = {
  site_id: 'origin-test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: 'x', access_token: 'y' },
  gads: { customer_id: null, login_customer_id: null }
};

describe('checkOrigin', () => {
  it('allows the site own origin (apex and www, in both directions)', () => {
    expect(checkOrigin('https://example.com', 'example.com', site)).toBe('allowed');
    expect(checkOrigin('https://www.example.com', 'example.com', site)).toBe('allowed');
    expect(checkOrigin('https://example.com', 'www.example.com', site)).toBe('allowed');
    expect(checkOrigin('https://www.example.com', 'www.example.com', site)).toBe('allowed');
  });

  it("rejects another site's origin", () => {
    expect(checkOrigin('https://evil.example.net', 'example.com', site)).toBe('forbidden');
    // Sufffix-trükk: a naiv `endsWith` átengedné.
    expect(checkOrigin('https://notexample.com', 'example.com', site)).toBe('forbidden');
    expect(checkOrigin('https://example.com.evil.net', 'example.com', site)).toBe('forbidden');
  });

  it('rejects an http:// origin on our own host (downgrade signal)', () => {
    expect(checkOrigin('http://example.com', 'example.com', site)).toBe('forbidden');
  });

  it('reports a missing / literal-null Origin as `missing` (fail-closed at the route)', () => {
    expect(checkOrigin(null, 'example.com', site)).toBe('missing');
    expect(checkOrigin('', 'example.com', site)).toBe('missing');
    expect(checkOrigin('null', 'example.com', site)).toBe('missing');
  });

  it('rejects a malformed Origin', () => {
    expect(checkOrigin('not-a-url', 'example.com', site)).toBe('forbidden');
  });

  it('honours SiteConfig.allowed_origins as an ADDITION, never a replacement', () => {
    const s = { ...site, allowed_origins: ['https://landing.example.io'] };
    expect(checkOrigin('https://landing.example.io', 'example.com', s)).toBe('allowed');
    // A saját host attól még engedett marad.
    expect(checkOrigin('https://example.com', 'example.com', s)).toBe('allowed');
    expect(checkOrigin('https://other.example.io', 'example.com', s)).toBe('forbidden');

    expect(allowedOriginHosts('example.com', s)).toEqual(
      new Set(['example.com', 'www.example.com', 'landing.example.io'])
    );
  });

  it('leaves the workers.dev test tenant open (curl smoke tests)', () => {
    expect(checkOrigin(null, 'event-gateway.golaxo.workers.dev', site)).toBe('allowed');
    expect(checkOrigin('https://anything.net', 'event-gateway.golaxo.workers.dev', site)).toBe(
      'allowed'
    );
  });
});

// ── Body cap: a chunked (Content-Length nélküli) kérés KORÁBBAN megkerülte ────
describe('conversion route — body cap is measured, not trusted', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeEnv() {
    const datapoints: any[] = [];
    return {
      env: {
        SITE_CONFIG: { get: async () => site },
        TRACKING_METRICS: { writeDataPoint: (dp: any) => datapoints.push(dp) }
      } as any,
      datapoints
    };
  }

  it('413s an oversized body sent WITHOUT Content-Length (streamed / chunked)', async () => {
    const { env, datapoints } = makeEnv();
    const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;

    // 32 KiB > 16 KiB cap. A ReadableStream body-nak nincs Content-Length-e —
    // pontosan ez volt a rés: a régi kód csak a fejlécet nézte, és ezt átengedte.
    const big = 'x'.repeat(32 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      }
    });
    const req = new Request('https://origin-test.example.com/api/event/conversion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://origin-test.example.com' },
      body: stream,
      // @ts-expect-error — Workers/undici megköveteli stream-body-hoz
      duplex: 'half'
    });

    const res = await handleConversion(req, env, ctx);
    expect(res.status).toBe(413);
    expect(datapoints[0].blobs).toContain(TrackingErrorCode.BODY_TOO_LARGE);
  });
});

// ── Spike-detektor: a tokenless ág egyetlen visszamaradt kockázatának őrszeme ──
describe('detectSpikes', () => {
  const WINDOWS = (7 * 24 * 60) / 30; // 336

  it('fires when a site jumps far above its own baseline', () => {
    // baseline: 336 event / 7 nap = 1 per 30-perces ablak. Most 200 → 200x.
    const hits = detectSpikes(new Map([['painless', 200]]), new Map([['painless', 336]]), WINDOWS);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ site_id: 'painless', recent: 200, baselinePerWindow: 1 });
  });

  it('stays silent on normal traffic', () => {
    const hits = detectSpikes(new Map([['painless', 3]]), new Map([['painless', 336]]), WINDOWS);
    expect(hits).toEqual([]);
  });

  it('does NOT cry wolf on a tiny baseline — the absolute floor guards it', () => {
    // Egy néma site (baseline 0) hirtelen 5 valódi konverziót kap. Ez NEM támadás,
    // és ha riasztana, pár nap alatt megtanulnánk figyelmen kívül hagyni a riasztást.
    const hits = detectSpikes(new Map([['newsite', 5]]), new Map(), WINDOWS);
    expect(hits).toEqual([]);
  });

  it('fires on a zero-baseline site once the flood is unmistakable', () => {
    const hits = detectSpikes(new Map([['newsite', 500]]), new Map(), WINDOWS);
    expect(hits).toHaveLength(1);
    expect(hits[0].site_id).toBe('newsite');
  });

  it('ranks the worst offender first', () => {
    const hits = detectSpikes(
      new Map([
        ['a', 50],
        ['b', 900]
      ]),
      new Map(),
      WINDOWS
    );
    expect(hits.map((h) => h.site_id)).toEqual(['b', 'a']);
  });
});
