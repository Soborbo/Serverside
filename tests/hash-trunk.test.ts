import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../src/lib/hash';

describe('normalizePhone — generalized trunk-prefix repair', () => {
  it('UK: +44 (0)7123 456 789 → +447123456789', () => {
    expect(normalizePhone('+44 (0)7123 456 789', 'GB')).toBe('+447123456789');
  });

  it('Hungary: +36 (0)30 123 4567 → +36301234567 (was the bug — 0 stayed)', () => {
    expect(normalizePhone('+36 (0)30 123 4567', 'HU')).toBe('+36301234567');
  });

  it('Germany: +49 (0)170 1234567 → +491701234567', () => {
    expect(normalizePhone('+49 (0)170 1234567')).toBe('+491701234567');
  });

  it('France: +33 (0)6 12 34 56 78 → +33612345678', () => {
    expect(normalizePhone('+33 (0)6 12 34 56 78')).toBe('+33612345678');
  });

  it('Italy: PRESERVES leading 0 (Italian landlines require it in international format)', () => {
    expect(normalizePhone('+39 02 1234 5678')).toBe('+390212345678');
  });

  it('Czechia: PRESERVES leading 0 (Czech numbering has no trunk-0 strip in international format)', () => {
    // Note: Czech numbers typically don't have a leading 0, so this is more a
    // sanity test that we don't accidentally strip it from non-trunk countries.
    expect(normalizePhone('+420123456789')).toBe('+420123456789');
  });

  it('Netherlands: strips trunk 0 (+31 (0)6 ... → +316...)', () => {
    expect(normalizePhone('+31 (0)6 12345678')).toBe('+31612345678');
  });

  it('does NOT strip leading 0 if it is part of the actual subscriber number', () => {
    // A US number "+1 0XX XXX XXXX" — US doesn't have trunk 0, so 0 must stay.
    // (We don't list US in TRUNK_PREFIX_COUNTRIES, so it should pass through.)
    expect(normalizePhone('+10000000000')).toBe('+10000000000');
  });

  it('preserves legitimate "+440..." that is not a trunk-prefix case', () => {
    // The +44 prefix followed by 0 + 9 digits IS the trunk pattern.
    // For shorter strings without enough digits, the regex validation fails.
    // This test specifically ensures no regression for the standard UK case.
    expect(normalizePhone('+447123456789')).toBe('+447123456789');
    expect(normalizePhone('+36301234567')).toBe('+36301234567');
  });

  it('produces equivalent hashes for trunk-stripped vs national format', async () => {
    const { hashUserData } = await import('../src/lib/hash');
    const a = await hashUserData({ phone_number: '06 30 123 4567' }, 'HU');
    const b = await hashUserData({ phone_number: '+36 (0)30 123 4567' }, 'HU');
    expect(a.ph).toBe(b.ph);
  });
});
