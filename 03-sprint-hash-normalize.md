# Sprint 3 — Hash + normalize library

**Cél:** Egy izolált, alaposan tesztelt library, ami a kliensoldali user_data-t (email, telefon, név, város, postcode, ország) normalizálja és SHA-256-tal hash-eli a Meta/Google API követelményei szerint.

**Idő Claude Code-dal:** 3-4 óra. **Ez a sprint nem deploy-ol semmit production-be**, csak unit-tesztelhető lib-et készít.

## Miért külön sprint a hash-elés

Ez a leghibásabban implementált rész minden tracking projektben. Egyetlen hibás karakter a normalize lépésben → 30-50% EMQ score esés Meta-nál, és a hibát csak 2-4 hét múlva veszed észre.

A Sprint 3 célja: **egyetlen, jól tesztelt függvény** (`hashUserData`), amit a Meta, GA4, és Google Ads integrációk **mind ugyanúgy használnak**.

## Új fájl: `src/lib/hash.ts`

```typescript
/**
 * User data normalization and hashing for Meta CAPI, GA4, Google Ads.
 *
 * KRITIKUS: A hash specifikáció a CLAUDE.md-ben részletezett.
 * Ne térj el tőle. Egyetlen hibás normalizáció Meta-nál EMQ-csökkenést,
 * Google-nál EC match rate-csökkenést okoz.
 */

export type CountryCode = 'GB' | 'HU' | 'EU' | 'US' | 'DE' | 'FR' | 'IT' | 'ES';

export interface PlainUserData {
  email?: string | null;
  phone_number?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface HashedUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  zp?: string;
  country?: string;
}

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeEmail(email: string | null | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@')) return undefined;
  return trimmed;
}

export function normalizePhone(
  phone: string | null | undefined,
  countryCode: CountryCode = 'GB'
): string | undefined {
  if (typeof phone !== 'string') return undefined;
  let cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.length === 0) return undefined;

  if (cleaned.startsWith('+')) {
    if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
    return undefined;
  }

  if (countryCode === 'GB' || countryCode === 'EU') {
    if (cleaned.startsWith('0')) {
      cleaned = '+44' + cleaned.slice(1);
    } else if (cleaned.startsWith('44')) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+44' + cleaned;
    }
  } else if (countryCode === 'HU') {
    if (cleaned.startsWith('06')) {
      cleaned = '+36' + cleaned.slice(2);
    } else if (cleaned.startsWith('0')) {
      cleaned = '+36' + cleaned.slice(1);
    } else if (cleaned.startsWith('36')) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+36' + cleaned;
    }
  } else if (countryCode === 'US') {
    if (cleaned.startsWith('1')) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+1' + cleaned;
    }
  } else {
    cleaned = '+' + cleaned;
  }

  if (!/^\+\d{8,15}$/.test(cleaned)) return undefined;
  return cleaned;
}

export function normalizePostalCode(postal: string | null | undefined): string | undefined {
  if (typeof postal !== 'string') return undefined;
  const cleaned = postal.replace(/\s+/g, '').toUpperCase();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

export function normalizeCity(city: string | null | undefined): string | undefined {
  if (typeof city !== 'string') return undefined;
  const cleaned = city.trim().toLowerCase();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

export function normalizeName(name: string | null | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().toLowerCase();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

const COUNTRY_3_TO_2: Record<string, string> = {
  GBR: 'gb', HUN: 'hu', USA: 'us', DEU: 'de', FRA: 'fr',
  ITA: 'it', ESP: 'es', NLD: 'nl', BEL: 'be', AUT: 'at',
  CHE: 'ch', POL: 'pl', CZE: 'cz', SVK: 'sk', ROU: 'ro'
};
const COUNTRY_NAME_TO_2: Record<string, string> = {
  'united kingdom': 'gb', 'great britain': 'gb', 'uk': 'gb', 'england': 'gb',
  'hungary': 'hu', 'magyarország': 'hu',
  'united states': 'us', 'usa': 'us', 'america': 'us'
};

export function normalizeCountry(country: string | null | undefined): string | undefined {
  if (typeof country !== 'string') return undefined;
  const trimmed = country.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  if (trimmed.length === 2 && /^[a-z]{2}$/.test(trimmed)) return trimmed;
  if (trimmed.length === 3 && /^[a-z]{3}$/.test(trimmed)) {
    return COUNTRY_3_TO_2[trimmed.toUpperCase()] || undefined;
  }
  return COUNTRY_NAME_TO_2[trimmed] || undefined;
}

export async function hashUserData(
  input: PlainUserData,
  countryCode: CountryCode = 'GB'
): Promise<HashedUserData> {
  const result: HashedUserData = {};

  const email = normalizeEmail(input.email);
  if (email) result.em = await sha256Hex(email);

  const phone = normalizePhone(input.phone_number, countryCode);
  if (phone) result.ph = await sha256Hex(phone);

  const firstName = normalizeName(input.first_name);
  if (firstName) result.fn = await sha256Hex(firstName);

  const lastName = normalizeName(input.last_name);
  if (lastName) result.ln = await sha256Hex(lastName);

  const city = normalizeCity(input.city);
  if (city) result.ct = await sha256Hex(city);

  const postal = normalizePostalCode(input.postal_code);
  if (postal) result.zp = await sha256Hex(postal);

  const country = normalizeCountry(input.country) || normalizeCountry(countryCode);
  if (country) result.country = await sha256Hex(country);

  return result;
}
```

## Új fájl: `tests/hash.test.ts`

Add hozzá a dev dependency-t:

```bash
npm install --save-dev vitest @vitest/ui @cloudflare/vitest-pool-workers
```

Frissítsd a `package.json`-t:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Hozz létre `vitest.config.ts`-t:

```typescript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' }
      }
    }
  }
});
```

A test fájl:

```typescript
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
    expect(normalizeEmail(123 as any)).toBeUndefined();
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
    const result = await hashUserData({
      email: 'Jane@Email.com',
      phone_number: '07123456789',
      first_name: 'Jane',
      last_name: 'Smith',
      city: 'Bristol',
      postal_code: 'SW1A 1AA',
      country: 'GB'
    }, 'GB');
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

describe('Meta reference vector', () => {
  it('SHA-256 of "joe@eg.com" matches Meta docs', async () => {
    const hash = await sha256Hex('joe@eg.com');
    expect(hash).toBe('f3ada405ce890b6f8204094deb12d8a8d28909ddc7f5f4c3eb2a45fe44a17f74');
  });
});
```

## Tesztelés

```bash
npm test
```

Minden teszt zöld kell legyen.

## Sprint 3 utáni státusz

- ✅ `hashUserData()` egyetlen entry point
- ✅ Email, phone, name, city, postcode, country normalization
- ✅ UK + HU phone format support
- ✅ 30+ unit teszt
- ✅ Meta reference vector validáció
- ❌ Tényleges Meta CAPI POST: Sprint 4

## Mit KÉRDEZZ a usertől

Semmit. A Sprint 3 független a user-feedback-től. Csak a `npm test` zöld kell legyen.
