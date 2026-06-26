import { describe, it, expect } from 'vitest';
import { checkIdempotency, markDispatched, isOfflineUploadBlocked } from '../src/lib/ledger';

// Fake D1: prepare().bind().first() returns a queued row (or throws), .run() no-ops.
function envWith(firstResult: unknown, opts: { throwOnFirst?: boolean } = {}): any {
  const runCalls: string[] = [];
  return {
    _runCalls: runCalls,
    LEDGER: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (opts.throwOnFirst) throw new Error('D1 down');
                return firstResult;
              },
              async run() {
                runCalls.push(sql);
                return {};
              }
            };
          }
        };
      }
    }
  };
}

describe('checkIdempotency — dispatched-flag gate (conversion-loss fix)', () => {
  it('first sight (dispatched=0) → dispatch', async () => {
    const env = envWith({ seen_count: 1, dispatched: 0, do_not_replay: 0 });
    const d = await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    expect(d.shouldDispatch).toBe(true);
  });

  it('re-sight AFTER successful delivery (dispatched=1) → suppress', async () => {
    const env = envWith({ seen_count: 2, dispatched: 1, do_not_replay: 0 });
    const d = await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    expect(d.shouldDispatch).toBe(false);
    expect(d.seenCount).toBe(2);
  });

  it('re-sight while NOT yet delivered (dispatched=0, crash recovery) → RE-dispatch', async () => {
    // This is the core fix: the old seen_count===1 gate permanently suppressed a
    // never-delivered conversion on the 2nd sight. Now it re-fires (vendor dedups).
    const env = envWith({ seen_count: 2, dispatched: 0, do_not_replay: 0 });
    const d = await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    expect(d.shouldDispatch).toBe(true);
  });

  it('do_not_replay=1 → never dispatch', async () => {
    const env = envWith({ seen_count: 1, dispatched: 0, do_not_replay: 1 });
    const d = await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    expect(d.shouldDispatch).toBe(false);
  });

  it('no LEDGER binding → fail-open dispatch', async () => {
    const d = await checkIdempotency({} as any, 's', 'e', 'evt');
    expect(d.shouldDispatch).toBe(true);
  });

  it('D1 error → fail-open dispatch (never drop a real conversion)', async () => {
    const env = envWith(null, { throwOnFirst: true });
    const d = await checkIdempotency(env, 's', 'e', 'evt');
    expect(d.shouldDispatch).toBe(true);
  });
});

describe('markDispatched', () => {
  it('issues an UPDATE on the ledger', async () => {
    const env = envWith({});
    await markDispatched(env, 's', 'callback_conversion', 'evt');
    expect(env._runCalls.some((s: string) => /UPDATE idempotency SET dispatched/.test(s))).toBe(true);
  });

  it('no-op without LEDGER binding', async () => {
    await expect(markDispatched({} as any, 's', 'e', 'evt')).resolves.toBeUndefined();
  });
});

describe('isOfflineUploadBlocked — consent gate', () => {
  it('explicit ad_allowed=false → blocked', () => {
    expect(isOfflineUploadBlocked({ ad_allowed: false }, false)).toBe(true);
    expect(isOfflineUploadBlocked({ ad_allowed: false }, true)).toBe(true);
  });

  it('ad_allowed=true → allowed', () => {
    expect(isOfflineUploadBlocked({ ad_allowed: true }, true)).toBe(false);
  });

  it('no record + require_consent=true → blocked (fail-closed, EEA / D1 outage safe)', () => {
    expect(isOfflineUploadBlocked(null, true)).toBe(true);
  });

  it('no record + require_consent=false → allowed (business responsibility)', () => {
    expect(isOfflineUploadBlocked(null, false)).toBe(false);
  });
});
