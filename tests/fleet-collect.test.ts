import { describe, it, expect, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { collectFleetHealth } from '../src/lib/fleet-collect';

/**
 * F8 — a GYŰJTŐ réteg tesztjei. A döntési szabályokat a fleet-health.test.ts
 * fedi; itt az a kérdés, hogy a mérés HIÁNYA hogyan jut át a rendszeren.
 *
 * A legfontosabb eset: egy elbukó D1-lekérdezés UNKNOWN-t okoz, NEM nullát —
 * mert a nulla RED-et (vagy rosszabb esetben zöld „nincs baj"-t) jelentene egy
 * olyan site-on, amiről valójában semmit sem tudunk.
 */

const NOW = Date.parse('2026-08-25T12:00:00Z');

const CONFIGS: Record<string, unknown> = {
  'painlessremovals.com': {
    site_id: 'painless',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: '123', access_token: 'tok' },
    gads: { customer_id: '1234567890', login_customer_id: null, conversion_actions: { lead_qualified: '111' } },
    expected_platforms: { smoke: ['meta'], offline: ['gads'] },
    consent: { provider: 'sbo' }
  },
  'dummy.example': {
    site_id: 'dummy',
    country_code: 'HU',
    currency: 'HUF',
    monitoring: false
  }
};

function makeSiteConfigKV(overrides?: { listComplete?: boolean }) {
  return {
    list: async () => ({
      keys: Object.keys(CONFIGS).map((name) => ({ name })),
      list_complete: overrides?.listComplete ?? true,
      cursor: overrides?.listComplete === false ? undefined : undefined
    }),
    get: async (name: string) => CONFIGS[name] ?? null
  };
}

/** Minden D1-lekérdezés dob → MINDEN mért dimenzió UNKNOWN kell legyen. */
function makeThrowingLedger() {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error('D1 down');
        },
        first: async () => {
          throw new Error('D1 down');
        }
      }),
      all: async () => {
        throw new Error('D1 down');
      },
      first: async () => {
        throw new Error('D1 down');
      }
    })
  };
}

/** Üres, de MŰKÖDŐ ledger: a lekérdezések lefutnak, csak nincs soruk. */
function makeEmptyLedger() {
  const empty = { results: [] as unknown[] };
  return {
    prepare: () => ({
      bind: () => ({ all: async () => empty, first: async () => null }),
      all: async () => empty,
      first: async () => null
    })
  };
}

describe('collectFleetHealth', () => {
  it('elbukó D1 → a mért dimenziók UNKNOWN-ok, EGYIK SEM zöld és egyik sem nulla-alapú RED', async () => {
    const env = { SITE_CONFIG: makeSiteConfigKV(), LEDGER: makeThrowingLedger() } as any;
    const report = await collectFleetHealth(env, NOW);

    const painless = report.sites.find((s) => s.site_id === 'painless')!;
    expect(painless).toBeDefined();
    // MINDEN MÉRT dimenzió UNKNOWN. Az `enhanced_conversions` szándékosan kimarad:
    // az tisztán CONFIG-szintű állítás (customer_id + conversion_actions), amihez
    // nem kell D1 — a ledger kiesése nem teheti méretlenné azt, amit a KV-ből tudunk.
    const measured = painless.dimensions.filter((d) => d.dimension !== 'enhanced_conversions');
    expect(measured.some((d) => d.level === 'GREEN')).toBe(false);
    // Az ingest a legárulkodóbb: hibás lekérdezésből SOHA nem lehet „0 konverzió".
    const ingest = painless.dimensions.find((d) => d.dimension === 'ingest')!;
    expect(ingest.level).toBe('UNKNOWN');
    expect(report.fleet_overall).toBe('UNKNOWN');
  });

  it('LEDGER binding nélkül sem állít semmit — nem zöld, nem piros: UNKNOWN', async () => {
    const env = { SITE_CONFIG: makeSiteConfigKV() } as any;
    const report = await collectFleetHealth(env, NOW);
    const painless = report.sites.find((s) => s.site_id === 'painless')!;
    expect(painless.dimensions.find((d) => d.dimension === 'ingest')!.level).toBe('UNKNOWN');
    expect(
      painless.dimensions
        .filter((d) => d.dimension !== 'enhanced_conversions')
        .some((d) => d.level === 'GREEN')
    ).toBe(false);
  });

  it('lefutott, de ÜRES ledger → az ingest RED (valós nulla), nem UNKNOWN', async () => {
    const env = { SITE_CONFIG: makeSiteConfigKV(), LEDGER: makeEmptyLedger() } as any;
    const report = await collectFleetHealth(env, NOW);
    const painless = report.sites.find((s) => s.site_id === 'painless')!;
    expect(painless.dimensions.find((d) => d.dimension === 'ingest')!.level).toBe('RED');
  });

  it('a monitoring:false site SEM tűnik el a nézetből — megjelenik, jelölve', async () => {
    const env = { SITE_CONFIG: makeSiteConfigKV(), LEDGER: makeEmptyLedger() } as any;
    const report = await collectFleetHealth(env, NOW);
    const dummy = report.sites.find((s) => s.site_id === 'dummy');
    expect(dummy).toBeDefined();
    expect(dummy!.monitoring).toBe(false);
  });

  it('SITE_CONFIG nélkül a felsorolás nem teljes → a flotta rollupja UNKNOWN', async () => {
    const env = { LEDGER: makeEmptyLedger() } as any;
    const report = await collectFleetHealth(env, NOW);
    expect(report.config_enumeration_complete).toBe(false);
    expect(report.fleet_overall).toBe('UNKNOWN');
  });
});
