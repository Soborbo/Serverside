import { describe, it, expect } from 'vitest';
import { isValidConversionPayload, ALLOWED_EVENT_NAMES } from '../src/types';

const validBase = {
  event_name: 'callback_conversion',
  event_id: 'abc-123',
  event_time: Math.floor(Date.now() / 1000),
  turnstile_token: 'XXX'
};

describe('isValidConversionPayload — happy path', () => {
  it('accepts valid minimal payload', () => {
    expect(isValidConversionPayload({ ...validBase })).toBe(true);
  });

  it('accepts payload with optional value', () => {
    expect(isValidConversionPayload({ ...validBase, value: 380, currency: 'GBP' })).toBe(true);
  });

  it('accepts all ALLOWED_EVENT_NAMES', () => {
    for (const name of ALLOWED_EVENT_NAMES) {
      expect(isValidConversionPayload({ ...validBase, event_name: name })).toBe(true);
    }
  });
});

describe('isValidConversionPayload — event_name allowlist', () => {
  it('rejects unknown event_name (cardinality protection)', () => {
    expect(isValidConversionPayload({ ...validBase, event_name: 'random_attacker_event' })).toBe(false);
  });

  it('rejects empty event_name', () => {
    expect(isValidConversionPayload({ ...validBase, event_name: '' })).toBe(false);
  });

  it('rejects 100B junk event_name', () => {
    const junk = 'x'.repeat(100);
    expect(isValidConversionPayload({ ...validBase, event_name: junk })).toBe(false);
  });
});

describe('isValidConversionPayload — event_id', () => {
  it('rejects empty event_id', () => {
    expect(isValidConversionPayload({ ...validBase, event_id: '' })).toBe(false);
  });

  it('rejects event_id over 60 chars (Google Ads orderId truncation collision risk)', () => {
    expect(isValidConversionPayload({ ...validBase, event_id: 'a'.repeat(61) })).toBe(false);
  });

  it('accepts event_id at 60 chars boundary', () => {
    expect(isValidConversionPayload({ ...validBase, event_id: 'a'.repeat(60) })).toBe(true);
  });

  it('rejects event_id with special chars', () => {
    expect(isValidConversionPayload({ ...validBase, event_id: "id'; DROP TABLE--" })).toBe(false);
  });

  it('accepts UUID-style event_id', () => {
    expect(
      isValidConversionPayload({ ...validBase, event_id: '550e8400-e29b-41d4-a716-446655440000' })
    ).toBe(true);
  });
});

describe('isValidConversionPayload — event_time', () => {
  it('rejects past event_time before 2017', () => {
    expect(isValidConversionPayload({ ...validBase, event_time: 1000000000 })).toBe(false);
  });

  it('rejects far-future event_time (> now+10min)', () => {
    expect(
      isValidConversionPayload({ ...validBase, event_time: Math.floor(Date.now() / 1000) + 7200 })
    ).toBe(false);
  });

  it('rejects NaN event_time', () => {
    expect(isValidConversionPayload({ ...validBase, event_time: NaN })).toBe(false);
  });

  it('rejects Infinity event_time', () => {
    expect(isValidConversionPayload({ ...validBase, event_time: Infinity })).toBe(false);
  });

  it('rejects ms-instead-of-seconds event_time (CLAUDE.md rule 2)', () => {
    expect(isValidConversionPayload({ ...validBase, event_time: Date.now() })).toBe(false);
  });
});

describe('isValidConversionPayload — value', () => {
  it('accepts undefined value', () => {
    const { ...p } = validBase;
    expect(isValidConversionPayload(p)).toBe(true);
  });

  it('accepts value: 0 at validation level (Meta CAPI skip enforced separately)', () => {
    expect(isValidConversionPayload({ ...validBase, value: 0 })).toBe(true);
  });

  it('rejects negative value', () => {
    expect(isValidConversionPayload({ ...validBase, value: -1 })).toBe(false);
  });

  it('rejects NaN value', () => {
    expect(isValidConversionPayload({ ...validBase, value: NaN })).toBe(false);
  });

  it('rejects huge value > 1e9', () => {
    expect(isValidConversionPayload({ ...validBase, value: 2e9 })).toBe(false);
  });
});

describe('isValidConversionPayload — structural', () => {
  it('rejects null', () => {
    expect(isValidConversionPayload(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isValidConversionPayload('string')).toBe(false);
    expect(isValidConversionPayload(42)).toBe(false);
  });

  it('rejects missing turnstile_token', () => {
    const { turnstile_token: _, ...p } = validBase;
    expect(isValidConversionPayload(p)).toBe(false);
  });
});
