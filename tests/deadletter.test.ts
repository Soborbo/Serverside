import { describe, it, expect, vi, afterEach } from 'vitest';
import { isDeadKey, writeDeadLetter, type DeadLetterRecord } from '../src/lib/deadletter';
import type { Env } from '../src/env';

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
});
