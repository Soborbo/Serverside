import { describe, it, expect } from 'vitest';
import { checkIdempotency, markDispatched, isOfflineUploadBlocked } from '../src/lib/ledger';

// Fake D1: prepare().bind().first() returns a queued row (or throws), .run() no-ops.
function envWith(firstResult: unknown, opts: { throwOnFirst?: boolean } = {}): any {
  const runCalls: string[] = [];
  // A prepare()-hívások SQL-jét is rögzítjük: a `.first()`-tel futó lekérdezések
  // (checkIdempotency) különben nem lennének megfigyelhetők a tesztből.
  const prepareCalls: string[] = [];
  return {
    _runCalls: runCalls,
    _prepareCalls: prepareCalls,
    LEDGER: {
      prepare(sql: string) {
        prepareCalls.push(sql);
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

// A `suppressGa4` mező TÖRÖLVE (2026-08-16 audit): a GA4-leg 2026-06-28 óta nincs a
// fan-outban (Modell 2), tehát a flaget senki nem olvasta. A blokk eredeti ÉRTÉKES
// állítása viszont megmarad, és itt is marad tesztelve: a NEM-kézbesített (dispatched=0)
// duplikátumot MINDIG újra kell dispatch-elni, korától függetlenül — a vendorok
// event_id-vel dedup-olnak, tehát a rosszabbik kimenet egy dupla HÍVÁS, nem egy
// elvesztett konverzió.
describe('checkIdempotency — a nem-kézbesített duplikátum újra dispatch-el', () => {
  it('friss, még in-flight duplikátum (seen>1, dispatched=0) → dispatch', async () => {
    const env = envWith({
      seen_count: 2,
      dispatched: 0,
      do_not_replay: 0
    });
    const d = await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    expect(d.shouldDispatch).toBe(true); // vendor-dedup véd a duplikáció ellen
    expect(d.seenCount).toBe(2);
  });

  it('régi, valószínűleg crash-elt duplikátum (dispatched=0) → szintén dispatch', async () => {
    const env = envWith({
      seen_count: 2,
      dispatched: 0,
      do_not_replay: 0
    });
    const d = await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    expect(d.shouldDispatch).toBe(true); // crash-recovery: az event sosem ment ki
  });

  it('a lekérdezés NEM kéri le a first_seen_at-ot (a suppress-logika megszűnt)', async () => {
    const env = envWith({ seen_count: 1, dispatched: 0, do_not_replay: 0 });
    await checkIdempotency(env, 's', 'callback_conversion', 'evt');
    const sql = env._prepareCalls.join('\n');
    expect(sql).toMatch(/RETURNING seen_count, dispatched, do_not_replay/);
    expect(sql).not.toMatch(/first_seen_at\s*$/m);
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
