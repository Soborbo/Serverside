import { describe, it, expect } from 'vitest';
import { parseStorageReadTelemetry } from '../src/lib/storage-telemetry';
import { recordConsentReceipt } from '../src/lib/ledger';

/**
 * PECR read-gate telemetria a szerver oldalon (2. brief · S2).
 *
 * A mező tisztán megfigyelés: a consent-döntést NEM befolyásolja, és soha nem
 * buktathat konverziót. A receipten a NULL és a 0 KÜLÖNBÖZŐ állítás:
 *   NULL = a kliens nem jelentett (régi lib / szerver-ingress),
 *   0    = jelentett, és nem volt blokkolt olvasás.
 */

describe('parseStorageReadTelemetry', () => {
  it('a kliens jelentését átveszi', () => {
    expect(parseStorageReadTelemetry(true, ['sb_tracking', '_fbp'])).toEqual({
      blocked: true,
      keys: 'sb_tracking,_fbp'
    });
  });

  it('nem-blokkolt jelentés: blocked=false, kulcsok nélkül', () => {
    expect(parseStorageReadTelemetry(false, [])).toEqual({ blocked: false, keys: undefined });
  });

  it('semmit nem jelentő kliens → undefined (a receipten NULL, nem 0)', () => {
    expect(parseStorageReadTelemetry(undefined, undefined)).toBeUndefined();
    expect(parseStorageReadTelemetry('igen', 'sb_tracking')).toBeUndefined();
  });

  it('kulcslista boolean nélkül is blokkot bizonyít', () => {
    expect(parseStorageReadTelemetry(undefined, ['sb_tracking'])).toEqual({
      blocked: true,
      keys: 'sb_tracking'
    });
  });

  it('szemetet szűr: rossz típus, túl hosszú kulcs, gyanús charset', () => {
    const r = parseStorageReadTelemetry(true, [
      'sb_tracking',
      42,
      'a@b.com',
      'x'.repeat(64),
      '_fbp'
    ]);
    // Az `a@b.com` (PII-gyanús charset) kiesik; a túl hosszú kulcs 32-re vágva marad.
    expect(r?.keys?.split(',')).toEqual(['sb_tracking', 'x'.repeat(32), '_fbp']);
  });

  it('12 kulcsnál levág (a payload nem nőhet korlátlanul)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `k${i}`);
    expect(parseStorageReadTelemetry(true, many)?.keys?.split(',')).toHaveLength(12);
  });
});

/** A receipt bind-argumentumait őrző minimál D1-stub. */
function makeLedger() {
  const rows: unknown[][] = [];
  return {
    rows,
    env: {
      LEDGER: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async run() {
                  if (sql.includes('INSERT INTO consent_receipts')) rows.push(args);
                  return {};
                }
              };
            }
          };
        }
      }
    } as never
  };
}

describe('recordConsentReceipt — storage oszlopok', () => {
  const write = async (storage: ReturnType<typeof parseStorageReadTelemetry>) => {
    const { rows, env } = makeLedger();
    await recordConsentReceipt(env, {
      event_id: 'evt',
      site_id: 'site',
      require_consent: true,
      ad_allowed: true,
      storage
    });
    // Az utolsó két bind a 0005 migráció két oszlopa.
    return rows[0].slice(-2);
  };

  it('jelentett blokk → 1 + kulcslista', async () => {
    expect(await write({ blocked: true, keys: 'sb_tracking' })).toEqual([1, 'sb_tracking']);
  });

  it('jelentett, de blokk nélkül → 0 + NULL', async () => {
    expect(await write({ blocked: false, keys: undefined })).toEqual([0, null]);
  });

  it('nem jelentett → NULL + NULL (ez NEM azonos a 0-val)', async () => {
    expect(await write(undefined)).toEqual([null, null]);
  });
});
