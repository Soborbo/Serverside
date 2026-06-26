import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  normalizePhone,
  normalizePostalCode,
  normalizeCity,
  normalizeName,
  normalizeCountry,
  sha256Hex,
  hashUserData
} from '../src/lib/hash';

describe('normalizeEmail', () => {
  it('lowercases', () => {
    expect(normalizeEmail('Jane@Email.com')).toBe('jane@email.com');
  });
  it('trims whitespace', () => {
    expect(normalizeEmail('  jane@email.com  ')).toBe('jane@email.com');
  });
  it('preserves plus-suffix', () => {
    expect(normalizeEmail('john+spam@gmail.com')).toBe('john+spam@gmail.com');
  });
  it('preserves Gmail dots', () => {
    expect(normalizeEmail('john.smith@gmail.com')).toBe('john.smith@gmail.com');
  });
  it('returns undefined for empty', () => {
    expect(normalizeEmail('')).toBeUndefined();
  });
  it('returns undefined for whitespace', () => {
    expect(normalizeEmail('   ')).toBeUndefined();
  });
  it('returns undefined for non-email', () => {
    expect(normalizeEmail('not-an-email')).toBeUndefined();
  });
  it('returns undefined for null/undefined/non-string', () => {
    expect(normalizeEmail(null)).toBeUndefined();
    expect(normalizeEmail(undefined)).toBeUndefined();
    expect(normalizeEmail(123 as unknown as string)).toBeUndefined();
  });
});

describe('normalizePhone GB', () => {
  it('handles UK national format', () => {
    expect(normalizePhone('07123456789', 'GB')).toBe('+447123456789');
  });
  it('handles UK with spaces', () => {
    expect(normalizePhone('07123 456 789', 'GB')).toBe('+447123456789');
  });
  it('handles UK with parentheses', () => {
    expect(normalizePhone('+44 (0)7123 456 789', 'GB')).toBe('+447123456789');
  });
  it('handles UK with dashes', () => {
    expect(normalizePhone('07123-456-789', 'GB')).toBe('+447123456789');
  });
  it('handles already E.164', () => {
    expect(normalizePhone('+447123456789', 'GB')).toBe('+447123456789');
  });
  it('handles 44 without +', () => {
    expect(normalizePhone('447123456789', 'GB')).toBe('+447123456789');
  });
  it('returns undefined for too short', () => {
    expect(normalizePhone('+1234', 'GB')).toBeUndefined();
  });
});

describe('normalizePhone HU', () => {
  it('handles 06 prefix', () => {
    expect(normalizePhone('06301234567', 'HU')).toBe('+36301234567');
  });
  it('handles 06 with spaces', () => {
    expect(normalizePhone('06 30 123 4567', 'HU')).toBe('+36301234567');
  });
  it('handles +36 with dashes', () => {
    expect(normalizePhone('+36-30-123-4567', 'HU')).toBe('+36301234567');
  });
  it('handles 36 without +', () => {
    expect(normalizePhone('36301234567', 'HU')).toBe('+36301234567');
  });
});

describe('normalizePostalCode', () => {
  it('uppercases UK postcode', () => {
    expect(normalizePostalCode('sw1a 1aa')).toBe('SW1A1AA');
  });
  it('strips spaces', () => {
    expect(normalizePostalCode('SW1A 1AA')).toBe('SW1A1AA');
  });
  it('handles HU postcode', () => {
    expect(normalizePostalCode('1011')).toBe('1011');
  });
  it('preserves dashes (US ZIP+4)', () => {
    expect(normalizePostalCode('12345-6789')).toBe('12345-6789');
  });
});

describe('normalizeCity', () => {
  it('lowercases and trims', () => {
    expect(normalizeCity('  Bristol  ')).toBe('bristol');
  });
  it('preserves accents', () => {
    expect(normalizeCity('Pécs')).toBe('pécs');
    expect(normalizeCity('Győr')).toBe('győr');
  });
});

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Jane  ')).toBe('jane');
  });
});

describe('normalizeCountry', () => {
  it('handles 2-letter codes', () => {
    expect(normalizeCountry('GB')).toBe('gb');
  });
  it('converts 3-letter to 2-letter', () => {
    expect(normalizeCountry('GBR')).toBe('gb');
    expect(normalizeCountry('HUN')).toBe('hu');
  });
  it('converts country names', () => {
    expect(normalizeCountry('United Kingdom')).toBe('gb');
    expect(normalizeCountry('Magyarország')).toBe('hu');
  });
  it('returns undefined for unknown', () => {
    expect(normalizeCountry('Atlantis')).toBeUndefined();
  });
  it('rejects EU (region, not a valid ISO 3166-1 alpha-2 country)', () => {
    // #3: 'EU' korábban átment 'eu' invalid hash-ként → Meta EMQ / GAds match szennyezés.
    expect(normalizeCountry('EU')).toBeUndefined();
    expect(normalizeCountry('eu')).toBeUndefined();
  });
  it('rejects bogus 2-letter codes not on the ISO allowlist', () => {
    expect(normalizeCountry('xx')).toBeUndefined();
    expect(normalizeCountry('zz')).toBeUndefined();
  });
  it('maps raw "uk" to gb via the name map (uk is not ISO alpha-2)', () => {
    expect(normalizeCountry('uk')).toBe('gb');
  });
  it('accepts real ISO codes beyond the core set', () => {
    expect(normalizeCountry('DE')).toBe('de');
    expect(normalizeCountry('fr')).toBe('fr');
    expect(normalizeCountry('US')).toBe('us');
  });
});

describe('sha256Hex', () => {
  it('produces 64-char hex string', async () => {
    const hash = await sha256Hex('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic', async () => {
    const a = await sha256Hex('jane@email.com');
    const b = await sha256Hex('jane@email.com');
    expect(a).toBe(b);
  });
});

describe('hashUserData', () => {
  it('hashes all provided fields', async () => {
    const result = await hashUserData(
      {
        email: 'Jane@Email.com',
        phone_number: '07123456789',
        first_name: 'Jane',
        last_name: 'Smith',
        city: 'Bristol',
        postal_code: 'SW1A 1AA',
        country: 'GB'
      },
      'GB'
    );
    expect(result.em).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ph).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fn).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ln).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ct).toMatch(/^[0-9a-f]{64}$/);
    expect(result.zp).toMatch(/^[0-9a-f]{64}$/);
    expect(result.country).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits fields not provided', async () => {
    const result = await hashUserData({ email: 'jane@email.com' }, 'GB');
    expect(result.em).toBeDefined();
    expect(result.ph).toBeUndefined();
  });

  it('produces same hash for normalized-equivalent inputs', async () => {
    const a = await hashUserData({ email: 'Jane@Email.com' }, 'GB');
    const b = await hashUserData({ email: 'jane@email.com  ' }, 'GB');
    expect(a.em).toBe(b.em);
  });

  it('phone normalized equivalence', async () => {
    const a = await hashUserData({ phone_number: '07123456789' }, 'GB');
    const b = await hashUserData({ phone_number: '+44 (0)7123-456-789' }, 'GB');
    expect(a.ph).toBe(b.ph);
  });

  it('postcode normalized equivalence', async () => {
    const a = await hashUserData({ postal_code: 'SW1A 1AA' }, 'GB');
    const b = await hashUserData({ postal_code: 'sw1a1aa' }, 'GB');
    expect(a.zp).toBe(b.zp);
  });
});

describe('SHA-256 reference vector', () => {
  it('SHA-256 of "joe@eg.com" matches RFC test vector', async () => {
    const hash = await sha256Hex('joe@eg.com');
    expect(hash).toBe('8830eedd6c6b5ea97d181563a349476ca1bb25ace1f94b5c5e48d9cad727941b');
  });
});
