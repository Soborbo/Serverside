import { describe, it, expect, vi, afterEach } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd daily-digest.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { collectEmqStatus } from '../src/scheduled/daily-digest';
import { detectCoverageDrops, type CoverageStats } from '../src/lib/emq';

/**
 * Meta EMQ monitorozás a napi digestben. A smoke-őr kézbesítést bizonyít,
 * match-minőséget nem — itt azt őrizzük, hogy az EMQ (vagy a ledger-proxy
 * match-kulcs lefedettség) nem esett-e. A Dataset Quality API hibája SOHA nem
 * buktathatja a digestet: proxy-fallback, végső esetben "n/a".
 */

const META_SITE = {
  site_id: 'painless',
  meta: { pixel_id: '111222333', access_token: 'token-a' }
};
const NO_META_SITE = { site_id: 'lomtalan' }; // nincs meta → hangtalan skip

function makeEnv(opts: {
  configs?: Record<string, unknown>;
  coverageRow?: Record<string, number> | Error | null;
}) {
  const configs = opts.configs ?? { 'painlessremovals.com': META_SITE };
  return {
    SITE_CONFIG: {
      list: async () => ({
        keys: Object.keys(configs).map((name) => ({ name })),
        list_complete: true
      }),
      get: async (name: string) => configs[name] ?? null
    },
    LEDGER:
      opts.coverageRow === undefined
        ? undefined
        : {
            prepare: () => ({
              bind: () => ({
                first: async () => {
                  if (opts.coverageRow instanceof Error) throw opts.coverageRow;
                  return opts.coverageRow;
                }
              })
            })
          }
  } as any;
}

function mockEmqFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function emqBody(scores: Array<[string, number]>) {
  return {
    web: scores.map(([event_name, composite_score]) => ({
      event_name,
      event_match_quality: { composite_score }
    }))
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collectEmqStatus — Dataset Quality API út', () => {
  it('jó EMQ (minden score ≥ 7) → source=emq, nincs riasztás', async () => {
    mockEmqFetch(emqBody([['Lead', 8.2], ['Contact', 7.4]]));
    const statuses = await collectEmqStatus(makeEnv({}));

    expect(statuses).toHaveLength(1);
    expect(statuses[0].site).toBe('painless');
    expect(statuses[0].source).toBe('emq');
    expect(statuses[0].emqEvents).toEqual([
      { event_name: 'Lead', score: 8.2 },
      { event_name: 'Contact', score: 7.4 }
    ]);
    expect(statuses[0].alerts).toEqual([]);
  });

  it('EMQ < 7 → riasztási sor az érintett eventtel', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockEmqFetch(emqBody([['Lead', 4.1], ['Contact', 9.0]]));
    const statuses = await collectEmqStatus(makeEnv({}));
    consoleSpy.mockRestore();

    expect(statuses[0].source).toBe('emq');
    expect(statuses[0].alerts).toEqual(['Lead EMQ 4.1 < 7']);
  });

  it('a lekérdezés a pixel_id-t dataset_id-ként, az access_tokennel küldi', async () => {
    const fn = mockEmqFetch(emqBody([['Lead', 8]]));
    await collectEmqStatus(makeEnv({}));

    const calledUrl = String(fn.mock.calls[0][0]);
    expect(calledUrl).toContain('/dataset_quality');
    expect(calledUrl).toContain('dataset_id=111222333');
    expect(calledUrl).toContain('access_token=token-a');
    expect(calledUrl).toContain('event_match_quality');
  });

  it('Meta-config nélküli site hangtalan skip (nem szerepel a listában)', async () => {
    mockEmqFetch(emqBody([['Lead', 8]]));
    const statuses = await collectEmqStatus(
      makeEnv({
        configs: {
          'painlessremovals.com': META_SITE,
          'lomtalan.co.uk': NO_META_SITE
        }
      })
    );
    expect(statuses.map((s) => s.site)).toEqual(['painless']);
  });
});

describe('collectEmqStatus — proxy-fallback és n/a', () => {
  it('EMQ API-hiba → ledger-proxy lefedettség (source=proxy), a digest nem bukik', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockEmqFetch({ error: { message: 'permission denied', code: 200 } }, 403);
    const statuses = await collectEmqStatus(
      makeEnv({
        coverageRow: {
          n24: 10, em24: 9, ph24: 8, fbc24: 4, fbp24: 10,
          n7: 70, em7: 63, ph7: 56, fbc7: 28, fbp7: 70
        }
      })
    );
    consoleSpy.mockRestore();

    expect(statuses[0].source).toBe('proxy');
    expect(statuses[0].coverage?.events24h).toBe(10);
    expect(statuses[0].coverage?.keys).toContainEqual({ key: 'fbp', pct24h: 100, pct7d: 100 });
    expect(statuses[0].alerts).toEqual([]);
  });

  it('proxy: jelentős fbc/fbp-esés a 7 napos átlaghoz képest → riasztás (TRK-950-009 osztály)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockEmqFetch({ error: { message: 'nope' } }, 400);
    const statuses = await collectEmqStatus(
      makeEnv({
        // fbp: 7d átlag 95%, 24h 0% → az eltört fbp-forwarding klasszikus képe.
        coverageRow: {
          n24: 20, em24: 18, ph24: 16, fbc24: 8, fbp24: 0,
          n7: 100, em7: 90, ph7: 80, fbc7: 40, fbp7: 95
        }
      })
    );
    consoleSpy.mockRestore();

    expect(statuses[0].source).toBe('proxy');
    expect(statuses[0].alerts).toEqual(['fbp coverage 0% (7d avg 95%)']);
  });

  it('EMQ API-hiba ÉS ledger-hiba → source=none ("n/a"), nem dob', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockEmqFetch({ error: { message: 'nope' } }, 500);
    const statuses = await collectEmqStatus(
      makeEnv({ coverageRow: new Error('D1 down') })
    );
    consoleSpy.mockRestore();

    expect(statuses[0].source).toBe('none');
    expect(statuses[0].alerts).toEqual([]);
  });

  it('EMQ API network-hiba (fetch dob) → proxy-fallback, nem dob', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const statuses = await collectEmqStatus(
      makeEnv({
        coverageRow: {
          n24: 6, em24: 6, ph24: 5, fbc24: 3, fbp24: 6,
          n7: 40, em7: 38, ph7: 30, fbc7: 20, fbp7: 40
        }
      })
    );
    consoleSpy.mockRestore();
    expect(statuses[0].source).toBe('proxy');
  });
});

describe('detectCoverageDrops — pure küszöb-logika', () => {
  const base = (over: Partial<CoverageStats> = {}): CoverageStats => ({
    events24h: 20,
    events7d: 100,
    keys: [
      { key: 'em', pct24h: 90, pct7d: 92 },
      { key: 'ph', pct24h: 80, pct7d: 85 },
      { key: 'fbc', pct24h: 40, pct7d: 42 },
      { key: 'fbp', pct24h: 95, pct7d: 96 }
    ],
    ...over
  });

  it('stabil lefedettség → nincs drop', () => {
    expect(detectCoverageDrops(base())).toEqual([]);
  });

  it('≥25 százalékpont esés élő baseline-nál → drop', () => {
    const stats = base();
    stats.keys[3] = { key: 'fbp', pct24h: 30, pct7d: 96 };
    expect(detectCoverageDrops(stats).map((k) => k.key)).toEqual(['fbp']);
  });

  it('sosem-élt kulcs (baseline < 30%) nem riaszt — pl. ph-mentes site', () => {
    const stats = base();
    stats.keys[1] = { key: 'ph', pct24h: 0, pct7d: 20 };
    expect(detectCoverageDrops(stats)).toEqual([]);
  });

  it('kis 24h-s minta (< 5 event) → zaj, nincs riasztás', () => {
    const stats = base({ events24h: 3 });
    stats.keys[0] = { key: 'em', pct24h: 0, pct7d: 92 };
    expect(detectCoverageDrops(stats)).toEqual([]);
  });
});
