import { describe, it, expect } from 'vitest';
import {
  paginateSiteConfigKeys,
  listMonitoredSiteConfigsWithCompleteness,
  KV_LIST_MAX_PAGES
} from '../src/lib/config';

/**
 * 2026-08-25 — VÉGTELEN CIKLUS a SITE_CONFIG-felsorolóban.
 *
 * A `for(;;)` ciklus `list_complete: false`-nál a `page.cursor`-t vette át. Ha a KV
 * cursor NÉLKÜL ad `list_complete: false`-t, a cursor `undefined` marad, és a ciklus
 * ugyanazt a lapot kéri ÖRÖKKÉ. Workerben ez nem kivétel (amit a `catch` elkapna),
 * hanem CPU-limit kill: a cron SOSEM fejeződik be, riasztás nem megy ki, és kívülről
 * ez „nem történt semmi"-nek látszik.
 *
 * Élesben ez fogta meg magát: a #72 teszt-fájlja pontosan ilyen KV-mockot használ, és
 * a `typecheck + test` CI-job 6 ÓRA után `cancelled` lett.
 *
 * RED TEST: az őrök (`if (!res.cursor) return false` + lap-plafon) visszavonásával
 * mindhárom eset VÉGTELENÜL fut és a 3000 ms-os teszt-limitbe ütközve bukik.
 */

/** `list_complete: false`, cursor NÉLKÜL — az őr nélkül ez végtelen ciklus. */
function kvNoCursor() {
  let calls = 0;
  return {
    calls: () => calls,
    SITE_CONFIG: {
      list: async () => {
        calls++;
        return { keys: [{ name: 'a.example.com' }], list_complete: false };
      },
      get: async () => ({ site_id: 'a', country_code: 'GB', currency: 'GBP' })
    }
  };
}

/** Mindig ad cursort, de SOSEM fejezi be — csak a lap-plafon állítja meg. */
function kvNeverComplete() {
  let calls = 0;
  return {
    calls: () => calls,
    SITE_CONFIG: {
      list: async () => {
        calls++;
        return { keys: [], list_complete: false, cursor: `c${calls}` };
      },
      get: async () => null
    }
  };
}

describe('SITE_CONFIG lapozás — az őrzött ciklus', () => {
  it('cursor nélküli list_complete:false MEGÁLL, és nem-teljesnek jelenti magát', { timeout: 3000 }, async () => {
    const kv = kvNoCursor();
    const complete = await paginateSiteConfigKeys(kv as any, () => {});
    expect(complete).toBe(false);
    // Pontosan EGY kérés: nincs mivel továbblapozni, tehát nincs értelme újrakérni.
    expect(kv.calls()).toBe(1);
  });

  it('a soha-be-nem-fejeződő lapozást a lap-plafon állítja meg', { timeout: 3000 }, async () => {
    const kv = kvNeverComplete();
    const complete = await paginateSiteConfigKeys(kv as any, () => {});
    expect(complete).toBe(false);
    expect(kv.calls()).toBe(KV_LIST_MAX_PAGES);
  });

  it('a megszakadt felsorolás complete:false-t ad — nem szűrhető rá', { timeout: 3000 }, async () => {
    const kv = kvNoCursor();
    const res = await listMonitoredSiteConfigsWithCompleteness(kv as any);
    // A RÉSZLISTA megmarad (pozitív használatra jó)…
    expect(res.configs.map((c) => c.site_id)).toEqual(['a']);
    // …de a teljesség-jelzés HAMIS, tehát kizárásra tilos használni.
    expect(res.complete).toBe(false);
  });

  it('teljes felsorolásnál complete:true (nem zajgenerátor)', { timeout: 3000 }, async () => {
    const kv = {
      SITE_CONFIG: {
        list: async () => ({ keys: [{ name: 'a.example.com' }], list_complete: true }),
        get: async () => ({ site_id: 'a', country_code: 'GB', currency: 'GBP' })
      }
    };
    const res = await listMonitoredSiteConfigsWithCompleteness(kv as any);
    expect(res.complete).toBe(true);
    expect(res.configs).toHaveLength(1);
  });
});
