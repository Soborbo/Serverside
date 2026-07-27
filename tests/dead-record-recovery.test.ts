import { describe, it, expect, vi, beforeEach } from 'vitest';

// A `cloudflare:email` runtime-import elkerülése (mint admin.test.ts-ben).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  throttleOncePer: async () => true,
  escapeHtml: (s: string) => s
}));

// A retry-út (vendor-hívás) mockolva: itt a FELFEDEZÉS és a REPLAY-VEZÉRLÉS a
// tárgy, nem a vendor-integráció.
const retrySingle = vi.fn();
const recordRetryDelivery = vi.fn();
vi.mock('../src/scheduled/retry', () => ({
  retrySingle: (...a: unknown[]) => retrySingle(...a),
  recordRetryDelivery: (...a: unknown[]) => recordRetryDelivery(...a),
  isRealRetrySuccess: (r: { success?: boolean; skipped?: boolean }) =>
    r.success === true && r.skipped !== true
}));

import {
  listDeadRecords,
  summarizeDeadRecord,
  type DeadLetterRecord
} from '../src/lib/deadletter';
import { isDoNotReplay } from '../src/lib/ledger';
import { handleAdmin } from '../src/routes/admin';
import type { Env } from '../src/env';

const TOKEN = 'admin-secret-123';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeRecord(over: Partial<DeadLetterRecord> = {}): DeadLetterRecord {
  return {
    platform: 'meta',
    site_id: 'lomtalan',
    hostname: 'lomtalan.hu',
    lead_id: '780a1d0c-0000-4000-8000-000000000000',
    event_payload: {
      event_id: 'evt-dead-1',
      event_name: 'quote_calculator_submitted',
      event_time: 1784144087
    },
    hashed_user_data: { em: 'a'.repeat(64), ph: 'b'.repeat(64) },
    failure_reason: 'HTTP 500 Internal Server Error',
    retry_count: 3,
    first_failed_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    last_attempted_at: new Date().toISOString(),
    ...over
  };
}

/** Minimál R2-stub: kulcs → rekord (vagy a `corrupt` halmazban dobó `json()`). */
function makeBucket(objects: Record<string, DeadLetterRecord>, corrupt: string[] = []) {
  const store = new Map<string, DeadLetterRecord>(Object.entries(objects));
  const deleted: string[] = [];
  return {
    deleted,
    store,
    bucket: {
      list: async ({ prefix }: { prefix?: string } = {}) => ({
        objects: [...store.keys(), ...corrupt]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((key) => ({ key, uploaded: new Date() })),
        truncated: false,
        cursor: undefined
      }),
      get: async (key: string) => {
        if (corrupt.includes(key)) return { json: async () => JSON.parse('{oops') };
        const rec = store.get(key);
        return rec ? { json: async () => rec } : null;
      },
      delete: async (key: string) => {
        deleted.push(key);
        store.delete(key);
      }
    }
  };
}

const DEAD_KEY = 'lomtalan/meta/dead/2026-07-20/10-30-00_evt-dead-1_3_abcd1234.json';
const PENDING_KEY = 'lomtalan/meta/2026-07-26/10-30-00_evt-pending_1_efgh5678.json';
const OTHER_SITE_DEAD = 'painless/meta/dead/2026-07-20/10-30-00_evt-dead-2_3_ijkl9012.json';

beforeEach(() => {
  retrySingle.mockReset();
  recordRetryDelivery.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// A REGRESSZIÓ: a dead rekordokat semmi nem tudta felsorolni, ezért a
// „Permanently lost unless manually reprocessed" riasztás egy nem létező kézi
// útra mutatott (a single-replay pontos R2-kulcsot vár, a bulk-replay pedig a
// listPendingRetries-t hívja, ami az `isDeadKey` kulcsokat átugorja).
// ─────────────────────────────────────────────────────────────────────────────
describe('listDeadRecords — a dead archívum felfedezhető', () => {
  it('CSAK a dead kulcsokat adja vissza (a pending kimarad)', async () => {
    const { bucket } = makeBucket({
      [DEAD_KEY]: makeRecord(),
      [PENDING_KEY]: makeRecord({ retry_count: 1 })
    });
    const { dead, truncated } = await listDeadRecords({ DEAD_LETTER: bucket } as unknown as Env);
    expect(dead.map((d) => d.key)).toEqual([DEAD_KEY]);
    expect(truncated).toBe(false);
  });

  it('site-prefix szűrés — másik tenant rekordja nem szivárog át', async () => {
    const { bucket } = makeBucket({
      [DEAD_KEY]: makeRecord(),
      [OTHER_SITE_DEAD]: makeRecord({ site_id: 'painless' })
    });
    const { dead } = await listDeadRecords(
      { DEAD_LETTER: bucket } as unknown as Env,
      'lomtalan/'
    );
    expect(dead.map((d) => d.key)).toEqual([DEAD_KEY]);
  });

  it('maxResults → truncated=true (a hívó tudja, hogy van még)', async () => {
    const { bucket } = makeBucket({
      [DEAD_KEY]: makeRecord(),
      [OTHER_SITE_DEAD]: makeRecord({ site_id: 'painless' })
    });
    const { dead, truncated } = await listDeadRecords(
      { DEAD_LETTER: bucket } as unknown as Env,
      undefined,
      1
    );
    expect(dead).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('sérült rekord → corrupt lista, nem csendes kihagyás', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badKey = 'lomtalan/meta/dead/2026-07-20/broken.json';
    const { bucket } = makeBucket({ [DEAD_KEY]: makeRecord() }, [badKey]);
    const { dead, corrupt } = await listDeadRecords({ DEAD_LETTER: bucket } as unknown as Env);
    expect(dead.map((d) => d.key)).toEqual([DEAD_KEY]);
    expect(corrupt).toEqual([badKey]);
  });
});

describe('summarizeDeadRecord — PII-mentes (CLAUDE.md 13.)', () => {
  it('sem hash-elt user_data, sem nyers payload nem kerül bele', () => {
    const s = summarizeDeadRecord(DEAD_KEY, makeRecord());
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain('a'.repeat(64)); // hashed email
    expect(serialized).not.toContain('hashed_user_data');
    expect(serialized).not.toContain('event_payload');
    expect(s.event_id).toBe('evt-dead-1');
    expect(s.key).toBe(DEAD_KEY);
    expect(s.age_days).toBeCloseTo(2, 0);
  });

  it('a hosszú vendor-hibaüzenet vágva megy (HTML-hibaoldal ellen)', () => {
    const s = summarizeDeadRecord(DEAD_KEY, makeRecord({ failure_reason: 'x'.repeat(5000) }));
    expect(s.failure_reason).toHaveLength(300);
  });
});

describe('GET /admin/dlq/dead — a riasztás követhetővé válik', () => {
  it('visszaadja a kulcsot és az azonosítókat, PII nélkül', async () => {
    const { bucket } = makeBucket({ [DEAD_KEY]: makeRecord(), [PENDING_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d1.example.com/api/event/admin/dlq/dead', {
        headers: { 'X-Admin-Token': TOKEN }
      }),
      { ADMIN_API_TOKEN: TOKEN, DEAD_LETTER: bucket } as unknown as Env,
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(1);
    expect(body.records[0].key).toBe(DEAD_KEY);
    expect(body.records[0].site_id).toBe('lomtalan');
    expect(JSON.stringify(body)).not.toContain('a'.repeat(64));
  });

  it('R2-listahiba → 503 (nem hamis „nincs dead rekord")', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleAdmin(
      new Request('https://d2.example.com/api/event/admin/dlq/dead', {
        headers: { 'X-Admin-Token': TOKEN }
      }),
      {
        ADMIN_API_TOKEN: TOKEN,
        DEAD_LETTER: { list: async () => { throw new Error('R2 down'); } }
      } as unknown as Env,
      ctx
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /admin/dlq/replay {dead:true} — a dead archívum újrafeldolgozható', () => {
  it('replay-eli a dead rekordot és törli az R2-objektumot', async () => {
    retrySingle.mockResolvedValue({ success: true, http_status: 200 });
    const { bucket, deleted } = makeBucket({ [DEAD_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d3.example.com/api/event/admin/dlq/replay', {
        method: 'POST',
        headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dead: true })
      }),
      { ADMIN_API_TOKEN: TOKEN, DEAD_LETTER: bucket } as unknown as Env,
      ctx
    );
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ scope: 'dead', attempted: 1, succeeded: 1, failed: 0 });
    expect(deleted).toEqual([DEAD_KEY]);
    expect(recordRetryDelivery).toHaveBeenCalledTimes(1);
  });

  it('`dead` nélkül a PENDING kör fut — a dead rekord érintetlen marad', async () => {
    retrySingle.mockResolvedValue({ success: true, http_status: 200 });
    const { bucket, deleted } = makeBucket({ [DEAD_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d4.example.com/api/event/admin/dlq/replay', {
        method: 'POST',
        headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      { ADMIN_API_TOKEN: TOKEN, DEAD_LETTER: bucket } as unknown as Env,
      ctx
    );
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ scope: 'pending', attempted: 0 });
    expect(deleted).toEqual([]);
  });

  it('vendor-bukás → a rekord MARAD (nem semmisítjük meg az egyetlen példányt)', async () => {
    retrySingle.mockResolvedValue({ success: false, error: 'HTTP 500' });
    const { bucket, deleted, store } = makeBucket({ [DEAD_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d5.example.com/api/event/admin/dlq/replay', {
        method: 'POST',
        headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dead: true })
      }),
      { ADMIN_API_TOKEN: TOKEN, DEAD_LETTER: bucket } as unknown as Env,
      ctx
    );
    expect((await res.json()) as any).toMatchObject({ succeeded: 0, failed: 1 });
    expect(deleted).toEqual([]);
    expect(store.has(DEAD_KEY)).toBe(true);
  });

  it('SKIP (hiányzó platform-config) sem törli és sem könyveli kézbesítésnek', async () => {
    retrySingle.mockResolvedValue({ success: true, skipped: true });
    const { bucket, deleted } = makeBucket({ [DEAD_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d6.example.com/api/event/admin/dlq/replay', {
        method: 'POST',
        headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dead: true })
      }),
      { ADMIN_API_TOKEN: TOKEN, DEAD_LETTER: bucket } as unknown as Env,
      ctx
    );
    expect((await res.json()) as any).toMatchObject({ succeeded: 0, skipped: 1 });
    expect(deleted).toEqual([]);
    expect(recordRetryDelivery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A replay ÚJ támadási felület: a dead-bulk feltámasztaná a szándékosan
// eltiltott (consent-visszavonás / admin-discard) eventeket is.
// ─────────────────────────────────────────────────────────────────────────────
describe('do_not_replay kapu — a szuppresszált event NEM támad fel', () => {
  const suppressedLedger = {
    prepare: () => ({ bind: () => ({ first: async () => ({ do_not_replay: 1 }) }) })
  };

  it('single replay → 409, vendor-hívás nem történik, a rekord marad', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bucket, deleted } = makeBucket({ [DEAD_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d7.example.com/api/event/admin/dlq/replay', {
        method: 'POST',
        headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: DEAD_KEY })
      }),
      {
        ADMIN_API_TOKEN: TOKEN,
        DEAD_LETTER: bucket,
        LEDGER: suppressedLedger
      } as unknown as Env,
      ctx
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as any).toMatchObject({ outcome: 'suppressed', succeeded: false });
    expect(retrySingle).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it('bulk dead replay → suppressed számláló, nem „succeeded"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bucket } = makeBucket({ [DEAD_KEY]: makeRecord() });
    const res = await handleAdmin(
      new Request('https://d8.example.com/api/event/admin/dlq/replay', {
        method: 'POST',
        headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dead: true })
      }),
      {
        ADMIN_API_TOKEN: TOKEN,
        DEAD_LETTER: bucket,
        LEDGER: suppressedLedger
      } as unknown as Env,
      ctx
    );
    expect((await res.json()) as any).toMatchObject({ suppressed: 1, succeeded: 0 });
    expect(retrySingle).not.toHaveBeenCalled();
  });
});

describe('isDoNotReplay — read-only, aszimmetrikus hibakezelés', () => {
  it('nincs LEDGER binding → false (a replay-nek működnie kell D1 nélkül is)', async () => {
    await expect(isDoNotReplay({} as unknown as Env, 's', 'e', 'i')).resolves.toBe(false);
  });

  it('D1-hiba → TRUE (fail-closed: tiltott eventet feltölteni rosszabb, mint elveszíteni)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      LEDGER: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) }
    } as unknown as Env;
    await expect(isDoNotReplay(env, 's', 'e', 'i')).resolves.toBe(true);
  });

  it('NEM ír (nem upsertel, mint a checkIdempotency) — csak SELECT megy', async () => {
    const statements: string[] = [];
    const env = {
      LEDGER: {
        prepare: (sql: string) => {
          statements.push(sql);
          return { bind: () => ({ first: async () => ({ do_not_replay: 0 }) }) };
        }
      }
    } as unknown as Env;
    await expect(isDoNotReplay(env, 's', 'e', 'i')).resolves.toBe(false);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*SELECT/i);
    expect(statements[0]).not.toMatch(/INSERT|UPDATE/i);
  });
});
