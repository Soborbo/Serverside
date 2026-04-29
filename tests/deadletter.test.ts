import { describe, it, expect } from 'vitest';
import { isDeadKey } from '../src/lib/deadletter';

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
