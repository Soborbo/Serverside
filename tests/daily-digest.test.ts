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
