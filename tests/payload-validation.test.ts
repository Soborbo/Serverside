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

  it('rejects event_id over 40 chars (Meta CAPI event_id cap, CLAUDE.md #2/#16)', () => {
    expect(isValidConversionPayload({ ...validBase, event_id: 'a'.repeat(41) })).toBe(false);
  });

  it('accepts event_id at 40 chars boundary', () => {
    expect(isValidConversionPayload({ ...validBase, event_id: 'a'.repeat(40) })).toBe(true);
  });

  it('accepts a standard 36-char UUID event_id', () => {
    expect(
      isValidConversionPayload({ ...validBase, event_id: '123e4567-e89b-42d3-a456-426614174000' })
    ).toBe(true);
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

  // SZERZŐDÉS-VÁLTÁS (szerver-szerver ingress): a hiányzó turnstile_token már
  // STRUKTURÁLISAN érvényes — a szerver-ingressen nincs böngésző, tehát nincs
  // token sem. Az elfogadásról NEM a validátor dönt, hanem a route Turnstile-
  // kapuja (lásd tests/server-ingress.test.ts: token nélkül, érvényes per-site
  // token nélkül → 403). A validátor csak azt köti ki, hogy HA jelen van, string legyen.
  it('accepts a missing turnstile_token structurally (the route gate decides, not the validator)', () => {
    const { turnstile_token: _, ...p } = validBase;
    expect(isValidConversionPayload(p)).toBe(true);
  });

  it('rejects a non-string turnstile_token', () => {
    expect(isValidConversionPayload({ ...validBase, turnstile_token: 123 })).toBe(false);
  });

  it('rejects an over-long client_user_agent / client_ip_address', () => {
    expect(
      isValidConversionPayload({ ...validBase, client_user_agent: 'x'.repeat(513) })
    ).toBe(false);
    expect(isValidConversionPayload({ ...validBase, client_ip_address: 'x'.repeat(46) })).toBe(
      false
    );
    expect(
      isValidConversionPayload({
        ...validBase,
        client_ip_address: '203.0.113.9',
        client_user_agent: 'Mozilla/5.0'
      })
    ).toBe(true);
  });
});
