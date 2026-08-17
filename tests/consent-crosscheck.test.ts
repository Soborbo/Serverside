import { describe, it, expect } from 'vitest';
import {
  evaluateConsentCrossCheck,
  expandFindingCounts,
  runConsentCrossCheck,
  DEFAULT_CONSENT_CROSS_CHECK_THRESHOLDS,
  type ConsentCrossCheckInput
} from '../src/lib/consent-crosscheck';

/**
 * Fázis D · S3 — napi consent-keresztellenőrzés.
 *
 * A riasztási szabály tétje: a 9 GRANTED-consent melletti skip MINDEGYIKE jelzés
 * (nincs „elfogadható napi darabszám"), a forrás-konzisztencia viszont arány,
 * amit csak a 7 napos átlaghoz képest érdemes nézni.
 */

const EMPTY: ConsentCrossCheckInput = {
  grantedSkips: [],
  findings: [],
  today: { inconsistent: 0, comparable: 0 },
  baseline: { inconsistent: 0, comparable: 0 },
  nullSources: [],
  debugRows: 0,
  failedLegs: []
};

describe('evaluateConsentCrossCheck', () => {
  it('tiszta nap → nincs riasztás', () => {
    const s = evaluateConsentCrossCheck(EMPTY);
    expect(s.alert).toBe(false);
    expect(s.alert_reasons).toEqual([]);
    expect(s.inconsistent_rate).toBeNull();
  });

  it('EGYETLEN GRANTED-melletti skip is riaszt', () => {
    const s = evaluateConsentCrossCheck({
      ...EMPTY,
      grantedSkips: [
        { site_id: 'lomtalan', platform: 'meta', skip_reason: 'consent_denied', total: 1 }
      ]
    });
    expect(s.alert).toBe(true);
    expect(s.granted_but_skipped_total).toBe(1);
    expect(s.alert_reasons[0]).toContain('lomtalan/meta:consent_denied=1');
  });

  it('a megnevezetlen (migráció előtti) skip is látszik a bontásban', () => {
    const s = evaluateConsentCrossCheck({
      ...EMPTY,
      grantedSkips: [
        { site_id: 'agykontroll', platform: 'meta', skip_reason: '(unnamed)', total: 3 }
      ]
    });
    expect(s.granted_but_skipped_total).toBe(3);
    expect(s.alert).toBe(true);
  });

  it('a source_consistent arány elmozdulása riaszt (küszöb felett, elég mintán)', () => {
    const s = evaluateConsentCrossCheck({
      ...EMPTY,
      today: { inconsistent: 30, comparable: 100 },
      baseline: { inconsistent: 35, comparable: 700 }
    });
    expect(s.inconsistent_rate).toBe(0.3);
    expect(s.baseline_inconsistent_rate).toBe(0.05);
    expect(s.inconsistent_rate_delta).toBe(0.25);
    expect(s.alert).toBe(true);
  });

  it('kis minta → nincs arány-riasztás (zajvédelem)', () => {
    const s = evaluateConsentCrossCheck({
      ...EMPTY,
      today: { inconsistent: 2, comparable: 3 },
      baseline: { inconsistent: 0, comparable: 700 }
    });
    expect(s.inconsistent_rate).toBeGreaterThan(0.5);
    expect(s.alert).toBe(false);
  });

  it('küszöb alatti elmozdulás → nincs riasztás', () => {
    const s = evaluateConsentCrossCheck({
      ...EMPTY,
      today: { inconsistent: 12, comparable: 100 },
      baseline: { inconsistent: 70, comparable: 700 }
    });
    expect(Math.abs(s.inconsistent_rate_delta!)).toBeLessThan(
      DEFAULT_CONSENT_CROSS_CHECK_THRESHOLDS.inconsistentRateDelta
    );
    expect(s.alert).toBe(false);
  });

  it('a hirtelen JAVULÁS is riaszt — rendszerint egy forrás némult el', () => {
    const s = evaluateConsentCrossCheck({
      ...EMPTY,
      today: { inconsistent: 0, comparable: 100 },
      baseline: { inconsistent: 210, comparable: 700 }
    });
    expect(s.inconsistent_rate_delta).toBe(-0.3);
    expect(s.alert).toBe(true);
  });

  it('elbukott lekérdezés-láb: vakfolt ≠ „nincs jel" → riaszt', () => {
    const s = evaluateConsentCrossCheck({ ...EMPTY, failedLegs: ['granted_skips'] });
    expect(s.alert).toBe(true);
    expect(s.alert_reasons[0]).toContain('vakfolt');
  });
});

describe('expandFindingCounts', () => {
  it('a többkódos receiptet minden kódjához hozzászámolja', () => {
    const out = expandFindingCounts([
      {
        site_id: 'painless',
        client_lib_version: '6.1.0',
        finding_codes: 'TRK-910-003,TRK-910-005',
        total: 4
      },
      {
        site_id: 'painless',
        client_lib_version: '6.1.0',
        finding_codes: 'TRK-910-003',
        total: 6
      }
    ]);
    expect(out).toEqual([
      { error_code: 'TRK-910-003', site_id: 'painless', client_lib_version: '6.1.0', total: 10 },
      { error_code: 'TRK-910-005', site_id: 'painless', client_lib_version: '6.1.0', total: 4 }
    ]);
  });

  it('site és lib-verzió szerint KÜLÖN vödör (ez dönti el a döntési kaput)', () => {
    const out = expandFindingCounts([
      { site_id: 'a', client_lib_version: '6.1.0', finding_codes: 'TRK-910-006', total: 1 },
      { site_id: 'a', client_lib_version: '(none)', finding_codes: 'TRK-910-006', total: 2 },
      { site_id: 'b', client_lib_version: '6.1.0', finding_codes: 'TRK-910-006', total: 3 }
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      error_code: 'TRK-910-006',
      site_id: 'b',
      client_lib_version: '6.1.0',
      total: 3
    });
  });

  it('üres/hiányzó kódlistát kihagy', () => {
    expect(
      expandFindingCounts([
        { site_id: 'a', client_lib_version: 'x', finding_codes: '', total: 5 }
      ])
    ).toEqual([]);
  });
});

describe('runConsentCrossCheck', () => {
  it('LEDGER binding nélkül null (a cron no-op)', async () => {
    expect(await runConsentCrossCheck({} as never, '2026-08-15')).toBeNull();
  });

  it('összefűzi a lábakat, és a hibás lábat vakfoltként jelenti', async () => {
    const env = {
      LEDGER: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async all() {
                  if (sql.includes('FROM deliveries')) throw new Error('D1 down');
                  if (sql.includes('finding_codes IS NOT NULL')) {
                    return {
                      results: [
                        {
                          site_id: 'lomtalan',
                          client_lib_version: '6.1.0',
                          finding_codes: 'TRK-910-003',
                          total: 7
                        }
                      ]
                    };
                  }
                  if (sql.includes('AS comparable')) {
                    return { results: [{ inconsistent: 1, comparable: 10 }] };
                  }
                  if (sql.includes('cookie_null')) {
                    return {
                      results: [
                        { site_id: 'lomtalan', cookie_null: 0, api_null: 9, server_null: 10, total: 10 }
                      ]
                    };
                  }
                  return { results: [{ total: 2 }] };
                }
              };
            }
          };
        }
      }
    };
    const s = await runConsentCrossCheck(env as never, '2026-08-15');
    expect(s?.failed_legs).toEqual(['granted_skips']);
    expect(s?.alert).toBe(true);
    expect(s?.finding_counts[0].error_code).toBe('TRK-910-003');
    expect(s?.null_sources[0].api_null).toBe(9);
    expect(s?.debug_rows).toBe(2);
  });
});
