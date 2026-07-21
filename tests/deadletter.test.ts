import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isDeadKey,
  writeDeadLetter,
  enqueueFailure,
  listPendingRetries,
  archiveExpiredRecord,
  MAX_RETRIES,
  type DeadLetterRecord
} from '../src/lib/deadletter';
import type { Env } from '../src/env';

// Fix 3: az enqueueFailure IGAZ/HAMIS-t ad vissza aszerint, hogy a retry-rekord
// BIZTOSAN tárolva van-e (Queue send VAGY R2 write). A hívó (fanOut) erre
// alapozva dönt a markDispatched-ről — false esetén az event dispatched=0 marad.
describe('enqueueFailure — a visszatérési érték a tárolás bizonyítéka (Fix 3)', () => {
  const record: DeadLetterRecord = {
    platform: 'meta',
    site_id: 's',
    hostname: 'h.example.com',
    event_payload: { event_id: 'evt-1', event_name: 'contact_form_submitted' },
    failure_reason: 'HTTP 500',
    retry_count: 0,
    first_failed_at: new Date().toISOString(),
    last_attempted_at: new Date().toISOString()
  };

  afterEach(() => vi.restoreAllMocks());

  it('Queue send OK → true (R2-t nem is érinti)', async () => {
    const put = vi.fn();
    const env = {
      DLQ: { send: async () => {} },
      DEAD_LETTER: { put }
    } as unknown as Env;
    await expect(enqueueFailure(env, record)).resolves.toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it('Queue fail + R2 OK → true (fallback tárolt)', async () => {
    const env = {
      DLQ: { send: async () => { throw new Error('Queue down'); } },
      DEAD_LETTER: { put: async () => {} }
    } as unknown as Env;
    await expect(enqueueFailure(env, record)).resolves.toBe(true);
  });

  it('Queue fail + R2 fail → FALSE (az event retry-példánya SEHOL sincs)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      DLQ: { send: async () => { throw new Error('Queue down'); } },
      DEAD_LETTER: { put: async () => { throw new Error('R2 down'); } }
    } as unknown as Env;
    await expect(enqueueFailure(env, record)).resolves.toBe(false);
  });

  it('nincs Queue binding + R2 fail → FALSE', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      DEAD_LETTER: { put: async () => { throw new Error('R2 down'); } }
    } as unknown as Env;
    await expect(enqueueFailure(env, record)).resolves.toBe(false);
  });
});

describe('isDeadKey — segment match', () => {
  it('detects /dead/ as segment 2', () => {
    expect(isDeadKey('painless/meta/dead/12345.json')).toBe(true);
  });

  it('does not match date-prefixed key', () => {
    expect(isDeadKey('painless/meta/2026-04-29/timestamp_eventid_0.json')).toBe(false);
  });

  it('does not false-positive when /dead/ appears in event_id', () => {
    expect(
      isDeadKey('painless/meta/2026-04-29/12-00-00_my_dead_event_0.json')
    ).toBe(false);
  });

  it('does not false-positive when site_id contains "dead"', () => {
    // Hypothetical site_id "deadlinepro" — substring match `/dead/` would
    // false-positive on this; segment match correctly returns false.
    expect(isDeadKey('deadlinepro/meta/2026-04-29/file.json')).toBe(false);
  });

  it('handles unexpectedly short keys', () => {
    expect(isDeadKey('foo/bar')).toBe(false);
    expect(isDeadKey('')).toBe(false);
  });

  it('matches all platforms', () => {
    expect(isDeadKey('painless/meta/dead/x.json')).toBe(true);
    expect(isDeadKey('painless/ga4/dead/x.json')).toBe(true);
    expect(isDeadKey('painless/gads/dead/x.json')).toBe(true);
  });
});

describe('writeDeadLetter — key uniqueness (audit #9)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function recordWithoutEventId(): DeadLetterRecord {
    return {
      platform: 'meta',
      site_id: 'painless',
      hostname: 'painless.com',
      event_payload: {}, // NINCS event_id → 'unknown' fallback
      failure_reason: 'boom',
      retry_count: 0,
      first_failed_at: '2026-06-26T12:00:00.000Z',
      last_attempted_at: '2026-06-26T12:00:00.000Z'
    };
  }

  it('two event_id-less failures in the SAME second get DISTINCT keys (no overwrite)', async () => {
    const keys: string[] = [];
    const env = {
      DEAD_LETTER: {
        put: async (k: string) => {
          keys.push(k);
        }
      }
    } as unknown as Env;

    await writeDeadLetter(env, recordWithoutEventId());
    await writeDeadLetter(env, recordWithoutEventId());

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]); // a random suffix garantálja az egyediséget
    // mindkettő ugyanazt a másodperc-prefixet kapja, csak a suffix tér el
    expect(keys[0].startsWith('painless/meta/2026-06-26/12-00-00_unknown_0_')).toBe(true);
    expect(keys[1].startsWith('painless/meta/2026-06-26/12-00-00_unknown_0_')).toBe(true);
  });

  it('returns true on success and false when the R2 put throws (write-then-delete guard)', async () => {
    const okEnv = {
      DEAD_LETTER: { put: async () => undefined }
    } as unknown as Env;
    expect(await writeDeadLetter(okEnv, recordWithoutEventId())).toBe(true);

    const failEnv = {
      DEAD_LETTER: {
        put: async () => {
          throw new Error('R2 down');
        }
      }
    } as unknown as Env;
    expect(await writeDeadLetter(failEnv, recordWithoutEventId())).toBe(false);
  });
});

describe('listPendingRetries — expired-rekordok szétválasztása', () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeRecord(overrides: Partial<DeadLetterRecord> = {}): DeadLetterRecord {
    return {
      platform: 'meta',
      site_id: 'painless',
      hostname: 'painless.com',
      event_payload: { event_id: 'e1', event_name: 'contact_form_submitted' },
      failure_reason: 'boom',
      retry_count: 0,
      first_failed_at: new Date().toISOString(),
      last_attempted_at: new Date().toISOString(),
      ...overrides
    };
  }

  function envWithObjects(objects: Record<string, DeadLetterRecord>): Env {
    return {
      DEAD_LETTER: {
        list: async () => ({
          objects: Object.keys(objects).map((key) => ({ key })),
          truncated: false
        }),
        get: async (key: string) =>
          objects[key] ? { json: async () => objects[key] } : null
      }
    } as unknown as Env;
  }

  it('friss rekord → pending; 24h-nál öregebb → expired; retry-kimerült → expired', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const env = envWithObjects({
      'painless/meta/2026-06-30/a.json': makeRecord(),
      'painless/meta/2026-06-28/b.json': makeRecord({ first_failed_at: old }),
      'painless/meta/2026-06-30/c.json': makeRecord({ retry_count: MAX_RETRIES })
    });

    const { pending, expired } = await listPendingRetries(env);
    expect(pending.map((p) => p.key)).toEqual(['painless/meta/2026-06-30/a.json']);
    expect(expired.map((e) => e.key).sort()).toEqual([
      'painless/meta/2026-06-28/b.json',
      'painless/meta/2026-06-30/c.json'
    ]);
  });

  it('dead-kulcsokat továbbra is kihagyja (se pending, se expired)', async () => {
    const env = envWithObjects({
      'painless/meta/dead/2026-06-01/x.json': makeRecord({ retry_count: MAX_RETRIES })
    });
    const { pending, expired } = await listPendingRetries(env);
    expect(pending).toHaveLength(0);
    expect(expired).toHaveLength(0);
  });
});

describe('archiveExpiredRecord — dead-archívumba mozgatás', () => {
  it('sikeres archív-írás után törli az eredetit', async () => {
    const puts: string[] = [];
    const deletes: string[] = [];
    const env = {
      DEAD_LETTER: {
        put: async (k: string) => {
          puts.push(k);
        },
        delete: async (k: string) => {
          deletes.push(k);
        }
      }
    } as unknown as Env;
    const record: DeadLetterRecord = {
      platform: 'meta',
      site_id: 'painless',
      hostname: 'painless.com',
      event_payload: { event_id: 'e-exp' },
      failure_reason: 'boom',
      retry_count: 1,
      first_failed_at: '2026-06-01T00:00:00Z',
      last_attempted_at: '2026-06-01T00:00:00Z'
    };
    const ok = await archiveExpiredRecord(env, 'painless/meta/2026-06-01/old.json', record);
    expect(ok).toBe(true);
    // a retry_count MAX_RETRIES-re emelve → dead prefixű kulcs
    expect(puts[0]).toMatch(/^painless\/meta\/dead\//);
    expect(deletes).toEqual(['painless/meta/2026-06-01/old.json']);
  });

  it('blocked_configuration lejárt rekord a DEAD prefixre kerül (zombi-hurok regresszió)', async () => {
    // A retry_count-ot a REKORDRA érvényes plafonra (blocked → 28) kell emelni, NEM
    // a fix MAX_RETRIES-re (3). Enélkül a writeDeadLetter prefix-döntése (3>=28 →
    // hamis) a rekordot VISSZA a pending-prefixre írná → örök órás pending↔archive
    // hurok, a rekord sosem érné el a dead-archívumot (a retention sosem purge-ölné).
    const puts: string[] = [];
    const deletes: string[] = [];
    const env = {
      DEAD_LETTER: {
        put: async (k: string) => { puts.push(k); },
        delete: async (k: string) => { deletes.push(k); }
      }
    } as unknown as Env;
    const record: DeadLetterRecord = {
      platform: 'meta',
      site_id: 'lomtalan',
      hostname: 'lomtalan.hu',
      event_payload: { event_id: 'e-blk' },
      failure_reason: 'config missing',
      blocked_configuration: true,
      retry_count: 0,
      first_failed_at: '2026-06-01T00:00:00Z',
      last_attempted_at: '2026-06-01T00:00:00Z'
    };
    const ok = await archiveExpiredRecord(env, 'lomtalan/meta/2026-06-01/old.json', record);
    expect(ok).toBe(true);
    expect(puts[0]).toMatch(/^lomtalan\/meta\/dead\//); // DEAD, nem pending
    expect(deletes).toEqual(['lomtalan/meta/2026-06-01/old.json']);
  });

  it('ha az archív-írás elbukik, az eredeti kulcs MEGMARAD', async () => {
    const deletes: string[] = [];
    const env = {
      DEAD_LETTER: {
        put: async () => {
          throw new Error('R2 down');
        },
        delete: async (k: string) => {
          deletes.push(k);
        }
      }
    } as unknown as Env;
    const record: DeadLetterRecord = {
      platform: 'ga4',
      site_id: 'painless',
      hostname: 'painless.com',
      event_payload: { event_id: 'e-exp2' },
      failure_reason: 'boom',
      retry_count: 0,
      first_failed_at: '2026-06-01T00:00:00Z',
      last_attempted_at: '2026-06-01T00:00:00Z'
    };
    const ok = await archiveExpiredRecord(env, 'painless/ga4/2026-06-01/old.json', record);
    expect(ok).toBe(false);
    expect(deletes).toHaveLength(0);
  });
});
