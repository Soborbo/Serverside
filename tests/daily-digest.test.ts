import { describe, it, expect, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { collectAcceptedCounts } from '../src/scheduled/daily-digest';

/**
 * Zero-accepted riasztás (2026-07-13 incidens után): a digest a konfigurált
 * site-okat összeveti a D1 ledger 24h-s accepted-számaival — a 0-s site a néma
 * szerver-leg-kiesés jele.
 */

const CONFIGS: Record<string, { site_id: string }> = {
  'painlessremovals.com': { site_id: 'painless' },
  'www.painlessremovals.com': { site_id: 'painless' },
  'beautyflow.pro': { site_id: 'beautyflow' },
  'www.beautyflow.pro': { site_id: 'beautyflow' }
};

function makeSiteConfigKV() {
  return {
    list: async () => ({
      keys: Object.keys(CONFIGS).map((name) => ({ name })),
      list_complete: true
    }),
    get: async (name: string) => CONFIGS[name] ?? null
  };
}

function makeLedger(rows: Array<{ site_id: string; cnt: number }> | Error) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          if (rows instanceof Error) throw rows;
          return { results: rows };
        }
      })
    })
  };
}

describe('collectAcceptedCounts', () => {
  it('flags configured sites with zero accepted events (www/apex deduped by site_id)', async () => {
    const env = {
      SITE_CONFIG: makeSiteConfigKV(),
      LEDGER: makeLedger([{ site_id: 'painless', cnt: 7 }])
    } as any;

    const { counts, zeroSites } = await collectAcceptedCounts(env);
    expect(counts.get('painless')).toBe(7);
    expect(zeroSites).toEqual(['beautyflow']);
  });

  it('no zero sites when every configured site has accepted events', async () => {
    const env = {
      SITE_CONFIG: makeSiteConfigKV(),
      LEDGER: makeLedger([
        { site_id: 'painless', cnt: 3 },
        { site_id: 'beautyflow', cnt: 1 }
      ])
    } as any;

    const { zeroSites } = await collectAcceptedCounts(env);
    expect(zeroSites).toEqual([]);
  });

  it('ledger query failure → NO false-positive zero alerts', async () => {
    const env = {
      SITE_CONFIG: makeSiteConfigKV(),
      LEDGER: makeLedger(new Error('D1 down'))
    } as any;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { counts, zeroSites } = await collectAcceptedCounts(env);
    consoleSpy.mockRestore();

    expect(counts.size).toBe(0);
    expect(zeroSites).toEqual([]);
  });

  it('missing LEDGER binding → empty result, no alert', async () => {
    const env = { SITE_CONFIG: makeSiteConfigKV() } as any;
    const { counts, zeroSites } = await collectAcceptedCounts(env);
    expect(counts.size).toBe(0);
    expect(zeroSites).toEqual([]);
  });
});

/**
 * A `monitoring: false` config kimarad a zero-conversion riasztásból. Enélkül egy
 * soha-nem-konvertáló (placeholder / deploy-smoke) config MINDEN nap CRITICAL
 * riasztást adna, és a digest két hét alatt zajjá válna — a néma hiba pedig, amiért
 * az egész lánc létezik, észrevétlen maradna.
 */
describe('monitoring opt-out', () => {
  it('a monitoring:false site nem kerül a figyelt site_id-k közé', async () => {
    const { listConfiguredSiteIds } = await import('../src/lib/config');
    const store: Record<string, unknown> = {
      'painlessremovals.com': { site_id: 'painless' },
      'agykontroll.co.uk': { site_id: 'agykontroll', monitoring: false },
      'event-gateway.golaxo.workers.dev': { site_id: 'test-painless', monitoring: false }
    };
    const env = {
      SITE_CONFIG: {
        list: async () => ({ keys: Object.keys(store).map((name) => ({ name })), list_complete: true }),
        get: async (k: string) => store[k] ?? null
      }
    } as unknown as Parameters<typeof listConfiguredSiteIds>[0];

    const ids = await listConfiguredSiteIds(env);
    expect([...ids]).toEqual(['painless']);
  });
});

// ── Napi synthetic smoke-lead ellenőrzés (Run 6 utó) ──────────────────────────

import { collectSmokeStatus } from '../src/scheduled/daily-digest';

function makeSmokeLedger(
  rows: Array<{ site_id: string; status: string; error_code: string | null }> | Error
) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          if (rows instanceof Error) throw rows;
          return { results: rows };
        }
      })
    })
  };
}

describe('collectSmokeStatus — a füstteszt másnapi őre', () => {
  it('minden elvárt site landolt (accepted VAGY skipped) → nincs riasztás', async () => {
    const env: any = {
      SMOKE_SITES: 'painless,beautyflow,lomtalan',
      LEDGER: makeSmokeLedger([
        { site_id: 'painless', status: 'accepted', error_code: null },
        { site_id: 'beautyflow', status: 'accepted', error_code: null },
        // lomtalan: nincs meta config → a smoke Meta-lába szándékos skip. Ez OK.
        { site_id: 'lomtalan', status: 'skipped', error_code: null }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.missing).toEqual([]);
    expect(s.broken).toEqual([]);
  });

  it('hiányzó smoke-sor → missing (a site cron→gateway lánc nem futott le)', async () => {
    const env: any = {
      SMOKE_SITES: 'painless,beautyflow',
      LEDGER: makeSmokeLedger([{ site_id: 'painless', status: 'accepted', error_code: null }])
    };
    const s = await collectSmokeStatus(env);
    expect(s.missing).toEqual(['beautyflow']);
  });

  it("rejected Meta-láb → broken, a vendor-hibakóddal", async () => {
    const env: any = {
      SMOKE_SITES: 'painless',
      LEDGER: makeSmokeLedger([
        { site_id: 'painless', status: 'rejected', error_code: 'TRK-600-004' }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.broken).toEqual([{ site: 'painless', error_code: 'TRK-600-004' }]);
    expect(s.missing).toEqual([]);
  });

  it('query-hiba → üres missing/broken (nincs hamis riasztás minden site-ra)', async () => {
    const env: any = {
      SMOKE_SITES: 'painless,beautyflow',
      LEDGER: makeSmokeLedger(new Error('D1 down'))
    };
    const s = await collectSmokeStatus(env);
    expect(s.missing).toEqual([]);
    expect(s.broken).toEqual([]);
  });

  it('SMOKE_SITES nélkül a check kikapcsolt', async () => {
    const s = await collectSmokeStatus({ LEDGER: makeSmokeLedger([]) } as any);
    expect(s.expected).toEqual([]);
    expect(s.missing).toEqual([]);
  });
});
