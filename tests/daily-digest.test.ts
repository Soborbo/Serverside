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

type SmokeRow = {
  site_id: string;
  platform: string;
  status: string;
  http_status?: number | null;
  error_code?: string | null;
};

/**
 * A `recent` (utolsó 24h, minden platform) és a `baseline` (SELECT DISTINCT,
 * korábban accepted) lekérdezést a SQL alapján kell szétválasztani — a smoke-őr
 * kettőt futtat, és pont az összjátékukon áll a regresszió-felismerés.
 */
function makeSmokeLedger(recent: SmokeRow[] | Error, baseline: SmokeRow[] = []) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => {
          if (recent instanceof Error) throw recent;
          return { results: sql.includes('DISTINCT') ? baseline : recent };
        }
      })
    })
  };
}

/** SITE_CONFIG stub a `expected_platforms` explicit ágához. */
function makeSiteConfigKv(configs: Record<string, unknown>) {
  return {
    list: async () => ({ keys: Object.keys(configs).map((name) => ({ name })), list_complete: true }),
    get: async (name: string) => configs[name] ?? null
  };
}

describe('collectSmokeStatus — a füstteszt másnapi őre', () => {
  it('minden elvárt platform accepted, HTTP-státusszal → nincs riasztás', async () => {
    const env: any = {
      SMOKE_SITES: 'painless,beautyflow',
      SITE_CONFIG: makeSiteConfigKv({
        'painlessremovals.com': { site_id: 'painless', expected_platforms: { smoke: ['meta'] } },
        'beautyflow.pro': { site_id: 'beautyflow', expected_platforms: { smoke: ['meta'] } }
      }),
      LEDGER: makeSmokeLedger([
        { site_id: 'painless', platform: 'meta', status: 'accepted', http_status: 200 },
        { site_id: 'beautyflow', platform: 'meta', status: 'accepted', http_status: 200 },
        // Nem elvárt platformok szándékos kihagyása változatlanul OK.
        { site_id: 'painless', platform: 'tiktok', status: 'skipped' },
        { site_id: 'beautyflow', platform: 'linkedin', status: 'skipped' }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.missing).toEqual([]);
    expect(s.failures).toEqual([]);
  });

  it('REGRESSZIÓ: elvárt platform skipped → CRITICAL (a lomtalan 2026-07-15 esete)', async () => {
    const env: any = {
      SMOKE_SITES: 'lomtalan',
      SITE_CONFIG: makeSiteConfigKv({
        'lomtalan.hu': { site_id: 'lomtalan', expected_platforms: { smoke: ['meta'] } }
      }),
      LEDGER: makeSmokeLedger([
        // A meta blokk kiesett a KV-ből → a fan-out némán skip-re váltott.
        { site_id: 'lomtalan', platform: 'meta', status: 'skipped' }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.failures).toEqual([
      {
        site: 'lomtalan',
        platform: 'meta',
        reason: 'skipped',
        error_code: null,
        expectation: 'config'
      }
    ]);
  });

  it('expected_platforms nélkül is bukik, ha a platform KORÁBBAN accepted volt', async () => {
    const env: any = {
      SMOKE_SITES: 'lomtalan',
      SITE_CONFIG: makeSiteConfigKv({ 'lomtalan.hu': { site_id: 'lomtalan' } }),
      LEDGER: makeSmokeLedger(
        [{ site_id: 'lomtalan', platform: 'meta', status: 'skipped' }],
        [{ site_id: 'lomtalan', platform: 'meta', status: 'accepted' }]
      )
    };
    const s = await collectSmokeStatus(env);
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0]).toMatchObject({ platform: 'meta', reason: 'skipped', expectation: 'history' });
  });

  it('sosem-volt-accepted platform kihagyása NEM hiba', async () => {
    const env: any = {
      SMOKE_SITES: 'agykontroll',
      SITE_CONFIG: makeSiteConfigKv({ 'agykontroll.co.uk': { site_id: 'agykontroll' } }),
      LEDGER: makeSmokeLedger([{ site_id: 'agykontroll', platform: 'meta', status: 'skipped' }])
    };
    const s = await collectSmokeStatus(env);
    expect(s.failures).toEqual([]);
    expect(s.missing).toEqual([]);
  });

  it('accepted vendor HTTP-státusz NÉLKÜL → CRITICAL (belső ellentmondás)', async () => {
    const env: any = {
      SMOKE_SITES: 'painless',
      SITE_CONFIG: makeSiteConfigKv({
        'painlessremovals.com': { site_id: 'painless', expected_platforms: { smoke: ['meta'] } }
      }),
      LEDGER: makeSmokeLedger([
        { site_id: 'painless', platform: 'meta', status: 'accepted', http_status: null }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.failures[0]).toMatchObject({
      platform: 'meta',
      reason: 'accepted_without_http_status'
    });
  });

  it('rejected elvárt láb → a vendor-hibakóddal együtt', async () => {
    const env: any = {
      SMOKE_SITES: 'painless',
      SITE_CONFIG: makeSiteConfigKv({
        'painlessremovals.com': { site_id: 'painless', expected_platforms: { smoke: ['meta'] } }
      }),
      LEDGER: makeSmokeLedger([
        {
          site_id: 'painless',
          platform: 'meta',
          status: 'rejected',
          http_status: 400,
          error_code: 'TRK-600-004'
        }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.failures).toEqual([
      {
        site: 'painless',
        platform: 'meta',
        reason: 'rejected',
        error_code: 'TRK-600-004',
        expectation: 'config'
      }
    ]);
    expect(s.missing).toEqual([]);
  });

  it('egyetlen sor sincs → site-szintű missing, nem N darab platform-hiba', async () => {
    const env: any = {
      SMOKE_SITES: 'painless,beautyflow',
      SITE_CONFIG: makeSiteConfigKv({
        'beautyflow.pro': { site_id: 'beautyflow', expected_platforms: { smoke: ['meta'] } }
      }),
      LEDGER: makeSmokeLedger([
        { site_id: 'painless', platform: 'meta', status: 'accepted', http_status: 200 }
      ])
    };
    const s = await collectSmokeStatus(env);
    expect(s.missing).toEqual(['beautyflow']);
    expect(s.failures).toEqual([]);
  });

  it('query-hiba → üres eredmény (nincs hamis riasztás minden site-ra)', async () => {
    const env: any = {
      SMOKE_SITES: 'painless,beautyflow',
      SITE_CONFIG: makeSiteConfigKv({}),
      LEDGER: makeSmokeLedger(new Error('D1 down'))
    };
    const s = await collectSmokeStatus(env);
    expect(s.missing).toEqual([]);
    expect(s.failures).toEqual([]);
  });

  it('SMOKE_SITES nélkül a check kikapcsolt', async () => {
    const s = await collectSmokeStatus({ LEDGER: makeSmokeLedger([]) } as any);
    expect(s.expected).toEqual([]);
    expect(s.missing).toEqual([]);
  });
});
