import { describe, it, expect } from 'vitest';
import { isSyntheticId, SYNTHETIC_ID_PATTERNS } from '../src/lib/reconciliation';
import { fetchReconInputs } from '../src/lib/reconciliation';

/**
 * 2026-08-25 — A SZINTETIKUS-SZŰRŐ LYUKAS VOLT.
 *
 * A szabály `lead_id NOT LIKE 'smoke-%'` volt, PREFIX-illesztéssel. Az ÉLES ledgerben
 * viszont ezek a szintetikus azonosítók vannak (2026-08-25-i lekérdezés):
 *
 *   e2e-smoke-leadstatus-0002 … 0005     ← NEM `smoke-`-kal kezdődik
 *   ga4-smoke-test-001                   ← NEM `smoke-`-kal kezdődik
 *   dm-validate-painless-001 … 006       ← ezt fogta
 *
 * Vagyis ÖT füst-teszt azonosító VALÓDINAK számított. Következmény: a
 * `deriveOfflineState` ARMED horgonya („volt már valódi accepted + http_status")
 * PUSZTÁN FÜST-TESZT ADATON átbillenthetett egy site-ot „bizonyítottan él"-be, és
 * ettől kezdve a néma valódi kiesés nem termelt volna `offline_zero_delivery`-t.
 *
 * A lista NEM kitalált: ezek a `deliveries` tábla tényleges éles lead_id-jai.
 *
 * RED TEST: a `%smoke%` visszaírásával `smoke-%`-ra az első két állítás bukik.
 */

// Az éles ledgerből kiolvasott TÉNYLEGES azonosítók.
const LIVE_SYNTHETIC = [
  'e2e-smoke-leadstatus-0002',
  'e2e-smoke-leadstatus-0003',
  'e2e-smoke-leadstatus-0004',
  'e2e-smoke-leadstatus-0005',
  'ga4-smoke-test-001',
  'dm-validate-painless-001',
  'dm-validate-painless-006'
];

// Ugyanonnan: a VALÓDI lead-ek (CRM UUID-k).
const LIVE_REAL = [
  '88b9fcd8-ed89-4e15-9bb4-0a96a7622079',
  '8a88cabc-9aa7-4676-97c0-649bd6af7dec',
  'b8f619a5-c3f5-4908-8e81-59fdb2664a2d',
  'cb9e066e-591f-45c7-9d8a-a887adc8c7f8'
];

/** A SQL-mintát ugyanúgy értékeli ki, ahogy az SQLite a LIKE-ot: `%` = tetszőleges. */
function sqlLikeExcludes(id: string): boolean {
  return SYNTHETIC_ID_PATTERNS.some((p) => {
    const rx = new RegExp('^' + p.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return rx.test(id);
  });
}

describe('szintetikus-szűrő — az ÉLES azonosítókon mérve', () => {
  it('MINDEN éles füst-teszt azonosítót szintetikusnak ismer fel', () => {
    for (const id of LIVE_SYNTHETIC) {
      expect(isSyntheticId(id), `${id} atcsuszott valodikent`).toBe(true);
    }
  });

  it('a SQL-minta ugyanazt zárja ki, amit a JS-szabály (a kettő nem térhet szét)', () => {
    for (const id of LIVE_SYNTHETIC) {
      expect(sqlLikeExcludes(id), `${id}-t a SQL NEM zarja ki`).toBe(true);
    }
    for (const id of LIVE_REAL) {
      expect(sqlLikeExcludes(id), `${id} VALODI, megsem szabadna kizarni`).toBe(false);
    }
  });

  it('a valódi CRM-UUID-kat nem zárja ki', () => {
    for (const id of LIVE_REAL) {
      expect(isSyntheticId(id), `${id}-t tevesen szintetikusnak veszi`).toBe(false);
    }
  });

  it('a tényleges D1-lekérdezésekbe a %smoke% minta kerül bele', async () => {
    const sql: string[] = [];
    const env: any = {
      LEDGER: {
        prepare: (q: string) => {
          sql.push(q);
          return { bind: () => ({ all: async () => ({ results: [] }) }), all: async () => ({ results: [] }) };
        }
      },
      SITE_CONFIG: { list: async () => ({ keys: [], list_complete: true }) },
      OAUTH_TOKENS: { get: async () => null }
    };
    await fetchReconInputs(env, '2026-08-18T00:00:00.000Z');
    const withFilter = sql.filter((q) => q.includes('NOT LIKE'));
    expect(withFilter.length, 'egyetlen lekerdezes sem szur szintetikusra').toBeGreaterThan(0);
    for (const q of withFilter) {
      expect(q, 'prefix-illesztes maradt a lekerdezesben').not.toContain("LIKE 'smoke-%'");
      expect(q).toContain("'%smoke%'");
    }
  });
});
