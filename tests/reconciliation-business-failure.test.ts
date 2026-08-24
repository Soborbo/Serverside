import { describe, it, expect, vi, beforeEach } from 'vitest';

const emails: Array<{ subject: string; html: string; severity: string }> = [];

vi.mock('../src/lib/notify', () => ({
  sendAdminEmail: async (_env: unknown, subject: string, html: string, severity: string) => {
    emails.push({ subject, html, severity });
  },
  sendAlert: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleReconciliation } from '../src/scheduled/reconciliation';

/**
 * 2026-08-24 Codex-review, #2 — a BUKOTT business-source láb nem látszhat tisztának.
 *
 * A hiba nem a pure függvényben volt (az helyesen adott `null`-t), hanem a HÍVÁSI
 * PONTON: a `?? []` a bukást „nincs eltérés"-re fordította. Következmény: a napi riport
 * `business_source_findings: 0`-t írt, a láb kiesett az email-feltételből, és a monitor
 * tisztának látszott — miközben EL SEM INDULT.
 *
 * Élesben ezt a 0007 migráció hiánya produkálja pontosan: a tábla nincs kint, a
 * lekérdezés `no such table`-lel bukik, és a napi riport zöld.
 *
 * RED TEST: a `?? []` visszaállításával mindkét eset bukik (nincs
 * `business_check_failed: true` a log-sorban, és nem megy email).
 */

/** Minden lekérdezés üres, KIVÉVE a business_counts-osakat, amik dobnak. */
function ledgerWithBrokenBusinessCounts() {
  const empty = { results: [] };
  const make = (q: string) => {
    const fail = q.includes('business_counts');
    const run = async () => {
      if (fail) throw new Error('no such table: business_counts');
      return empty;
    };
    return { bind: () => ({ all: run }), all: run };
  };
  return { prepare: (q: string) => make(q) };
}

function makeEnv(over: Record<string, unknown> = {}): any {
  return {
    LEDGER: ledgerWithBrokenBusinessCounts(),
    SITE_CONFIG: { list: async () => ({ keys: [], list_complete: true }) },
    OAUTH_TOKENS: { get: async () => null },
    ...over
  };
}

function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const grab = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])));
    } catch {
      /* nem strukturált sor */
    }
  };
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
  return lines;
}

beforeEach(() => {
  emails.length = 0;
  vi.restoreAllMocks();
});

describe('Codex #2 — a business-source láb bukása látható marad', () => {
  it('a napi összefoglaló log business_check_failed: true-t ír', async () => {
    const lines = captureLogs();
    await handleReconciliation(makeEnv());
    const completed = lines.find((l) => l.message === 'Reconciliation completed');
    expect(completed, 'nincs „Reconciliation completed" log-sor').toBeDefined();
    expect(completed!.business_check_failed).toBe(true);
    // …és a finding-szám 0, ami PONT ezért lenne félrevezető önmagában.
    expect(completed!.business_source_findings).toBe(0);
  });

  it('külön hibasor is megy, ami KIMONDJA, hogy a nulla nem jelent nulla driftet', async () => {
    const lines = captureLogs();
    await handleReconciliation(makeEnv());
    const failLine = lines.find(
      (l) => typeof l.message === 'string' && l.message.includes('Business-source reconciliation did NOT run')
    );
    expect(failLine).toBeDefined();
    expect(String(failLine!.message)).toContain('does NOT mean zero drift');
  });

  it('email MEGY, pedig nulla finding van — és CRITICAL súllyal', async () => {
    captureLogs();
    await handleReconciliation(makeEnv());
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain('business-source NOT RUNNING');
    expect(emails[0].severity).toBe('critical');
    // A levél megnevezi a legvalószínűbb okot és a teendőt.
    expect(emails[0].html).toContain('0007');
    expect(emails[0].html).toContain('business_counts');
  });

  it('ha a business-láb LEFUT és tiszta, NINCS ilyen jelzés (nem zajgenerátor)', async () => {
    const empty = { results: [] };
    const lines = captureLogs();
    await handleReconciliation(
      makeEnv({
        LEDGER: {
          prepare: () => ({ bind: () => ({ all: async () => empty }), all: async () => empty })
        }
      })
    );
    const completed = lines.find((l) => l.message === 'Reconciliation completed');
    expect(completed!.business_check_failed).toBe(false);
    // A levél ATTÓL MÉG kimehet — ebben a stubban nulla site-config van, tehát a
    // cross-check jogosan jelzi, hogy NEM FUT (meglévő, helyes viselkedés, nem ez a
    // teszt tárgya). Amit itt állítunk: a BUSINESS-láb nem tesz hozzá zajt.
    expect(emails.every((e) => !e.subject.includes('business-source NOT RUNNING'))).toBe(true);
    expect(emails.every((e) => !e.html.includes('business-source check MA NEM FUTOTT'))).toBe(true);
    expect(
      lines.some(
        (l) => typeof l.message === 'string' && l.message.includes('Business-source reconciliation did NOT run')
      )
    ).toBe(false);
  });
});

/**
 * 2026-08-24 merge-gate review (#71 hotfix) — HIGH: RÉSZLEGES SITE_CONFIG-listázás.
 *
 * A `listMonitoredSiteConfigs` KV-hibánál elkapja a kivételt és az addig összegyűjtött
 * RÉSZLISTÁT adja vissza. A P1.1 ezt teljesnek vette, és exclusion filterként használta:
 *
 *   15 site a KV-ben → a listázás 8 után elbukik → a maradék 7 site offline sorai
 *   kiszűrődnek → nincs finding → a monitor tisztának látszik.
 *
 * Ez pontosan az a hibaosztály, ami ellen az egész lánc épült. RED TEST: a
 * `configsComplete` jel visszavonásával a degraded-jelzés eltűnik, és a szűrő újra
 * a részlistára áll.
 */
describe('#71 HIGH — részleges config-listázás nem szűkítheti némán a mérést', () => {
  /** A listázás az 1. lap után dob — a részlista 1 site-ot tartalmaz. */
  function partialListingEnv(over: Record<string, unknown> = {}) {
    let page = 0;
    const empty = { results: [] };
    return {
      LEDGER: { prepare: () => ({ bind: () => ({ all: async () => empty }), all: async () => empty }) },
      SITE_CONFIG: {
        list: async () => {
          page++;
          if (page > 1) throw new Error('KV list failed mid-pagination');
          return { keys: [{ name: 'painless.example.com' }], list_complete: false, cursor: 'c1' };
        },
        get: async () => ({ site_id: 'painless', country_code: 'GB', currency: 'GBP' })
      },
      OAUTH_TOKENS: { get: async () => null },
      ...over
    } as any;
  }

  it('a napi log DEGRADED-et jelez: config_enumeration_complete: false', async () => {
    const lines = captureLogs();
    await handleReconciliation(partialListingEnv());
    const completed = lines.find((l) => l.message === 'Reconciliation completed');
    expect(completed!.config_enumeration_complete).toBe(false);
  });

  it('külön warning-sor is megy a feloldott site-ok számával', async () => {
    const lines = captureLogs();
    await handleReconciliation(partialListingEnv());
    const warn = lines.find((l) => l.error_code === 'TRK-950-018');
    expect(warn, 'nincs TRK-950-018 sor a részleges listázásra').toBeDefined();
    expect(warn!.resolved_site_configs).toBe(1);
  });

  it('a levél KIMONDJA, hogy a riport bővebb — nem szűkebb', async () => {
    captureLogs();
    await handleReconciliation(partialListingEnv());
    expect(emails).toHaveLength(1);
    expect(emails[0].html).toContain('DEGRADED');
    expect(emails[0].html).toContain('NEM szűrt');
  });

  it('TELJES listázásnál nincs degraded-jelzés (nem zajgenerátor)', async () => {
    const empty = { results: [] };
    const lines = captureLogs();
    await handleReconciliation(
      makeEnv({
        LEDGER: { prepare: () => ({ bind: () => ({ all: async () => empty }), all: async () => empty }) },
        SITE_CONFIG: { list: async () => ({ keys: [], list_complete: true }) }
      })
    );
    const completed = lines.find((l) => l.message === 'Reconciliation completed');
    expect(completed!.config_enumeration_complete).toBe(true);
    expect(lines.some((l) => l.error_code === 'TRK-950-018')).toBe(false);
  });
});
