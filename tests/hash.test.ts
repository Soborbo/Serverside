import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  normalizePhone,
  normalizePostalCode,
  normalizeCity,
  normalizeName,
  normalizeCountry,
  sha256Hex,
  hashUserData,
  normalizePostalCodeForMeta,
  normalizeCityForMeta
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

/**
 * 2026-08-16 audit, H-pont. Az 'EU' korábban a GB-ággal EGY ágon futott
 * (`countryCode === 'GB' || countryCode === 'EU'`), vagyis egy EU-generikus site
 * NÉMET nemzeti száma (`0176…`) `+44176…`-ként hash-elődött: szintaktikailag
 * érvényes UK-szám, ami garantáltan SENKIVEL nem match-el, és semmilyen hibát nem
 * jelez. Az 'EU' régió-kód, nem ország — nincs hívókódja.
 */
describe('normalizePhone — az EU régió-kód nem UK (audit 2026-08-16)', () => {
  it('EU + nemzeti formátumú (trunk-0) szám → eldobva, NEM +44-esítve', () => {
    expect(normalizePhone('0176 1234567', 'EU')).toBeUndefined();
    expect(normalizePhone('06 30 123 4567', 'EU')).toBeUndefined();
  });

  it('EU + teljes nemzetközi szám → változatlanul átmegy', () => {
    expect(normalizePhone('+49 176 1234567', 'EU')).toBe('+491761234567');
    expect(normalizePhone('49 176 1234567', 'EU')).toBe('+491761234567');
  });

  it('GB viszont TOVÁBBRA IS trunk-0 → +44 (a valódi országkódnál ez helyes)', () => {
    expect(normalizePhone('07123 456789', 'GB')).toBe('+447123456789');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// META-SPECIFIKUS zp/ct NORMALIZÁLÁS (2026-09-10)
//
// A MÉRT HIÁNY, AMIÉRT EZEK A TESZTEK LÉTEZNEK. A fenti `hashUserData` esetek
// CSAK annyit állítottak, hogy a `zp` 64 hex karakter, és hogy két EGYENÉRTÉKŰ
// bemenet UGYANAZT adja. Egyik sem mondta meg, MELYIK byte-stringet hash-eljük —
// ezért zöldek maradtak akkor is, amikor `SW1A1AA`-t küldtünk, és zöldek
// maradnának `sw1a1aa`-val is. A vendor-illeszkedés szempontjából ez nulla
// információ: a teszt kevesebbet igazolt, mint amennyit ígért.
//
// A Meta CAPI doksi (Customer information parameters):
//   zp — „Use lowercase with no spaces and no dash. Use only the first 5 digits
//        for U.S. zip codes."
//   ct — „Lowercase only with no punctuation, no special characters, and no spaces."
// A SHA-256 kis/nagybetű-érzékeny, tehát a nagybetűs alak SOHA nem találhatott.
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizePostalCodeForMeta — a hash-elendő alak', () => {
  it('kisbetűs, szóköz nélkül (UK)', () => {
    expect(normalizePostalCodeForMeta('SW1A 1AA')).toBe('sw1a1aa');
    expect(normalizePostalCodeForMeta('sw1a 1aa')).toBe('sw1a1aa');
  });
  it('a KÖTŐJEL kiesik (a plain ág megtartja — ez a különbség lényege)', () => {
    expect(normalizePostalCodeForMeta('12345-6789')).toBe('123456789');
    expect(normalizePostalCode('12345-6789')).toBe('12345-6789');
  });
  it('US: csak az első 5 számjegy', () => {
    expect(normalizePostalCodeForMeta('12345-6789', 'US')).toBe('12345');
    expect(normalizePostalCodeForMeta('90210', 'US')).toBe('90210');
  });
  it('HU 4-jegyű változatlan', () => {
    expect(normalizePostalCodeForMeta('1011', 'HU')).toBe('1011');
  });
  it('üres / nem-string → undefined', () => {
    expect(normalizePostalCodeForMeta('   ')).toBeUndefined();
    expect(normalizePostalCodeForMeta(null)).toBeUndefined();
  });
});

describe('normalizeCityForMeta — a hash-elendő alak', () => {
  it('a SZÓKÖZ kiesik (a plain ág megtartja)', () => {
    expect(normalizeCityForMeta('New York')).toBe('newyork');
    expect(normalizeCity('New York')).toBe('new york');
  });
  it('a központozás kiesik', () => {
    expect(normalizeCityForMeta('Stoke-on-Trent')).toBe('stokeontrent');
    expect(normalizeCityForMeta("St. John's")).toBe('stjohns');
  });
  it('az ÉKEZET MARAD — ezt a Meta nem kérte, és nem találunk ki szabályt', () => {
    expect(normalizeCityForMeta('Pécs')).toBe('pécs');
    expect(normalizeCityForMeta('Győr')).toBe('győr');
    expect(normalizeCityForMeta('Székesfehérvár')).toBe('székesfehérvár');
  });
  it('üres → undefined', () => {
    expect(normalizeCityForMeta('  ')).toBeUndefined();
  });
});

describe('hashUserData — MELYIK byte-stringet hash-eljük (a hiányzó őr)', () => {
  it('a zp a KISBETŰS, kötőjel-mentes alak hash-e', async () => {
    const result = await hashUserData({ postal_code: 'SW1A 1AA' }, 'GB');
    expect(result.zp).toBe(await sha256Hex('sw1a1aa'));
    // És NEM a régi, nagybetűs alaké — ez a regresszió, amit zárunk.
    expect(result.zp).not.toBe(await sha256Hex('SW1A1AA'));
  });

  it('a ct a SZÓKÖZ-MENTES alak hash-e', async () => {
    const result = await hashUserData({ city: 'New York' }, 'GB');
    expect(result.ct).toBe(await sha256Hex('newyork'));
    expect(result.ct).not.toBe(await sha256Hex('new york'));
  });

  it('US ZIP+4: az első 5 számjegy hash-e megy ki', async () => {
    const result = await hashUserData({ postal_code: '12345-6789' }, 'US');
    expect(result.zp).toBe(await sha256Hex('12345'));
  });

  it('ékezetes város: a hash az ékezetes alaké', async () => {
    const result = await hashUserData({ city: 'Pécs' }, 'HU');
    expect(result.ct).toBe(await sha256Hex('pécs'));
  });
});

describe('a GOOGLE plain-ág NEM változott (platform-split regresszió-őr)', () => {
  // A Data Manager `addressInfo.postalCode` PLAIN megy (CLAUDE.md §7). Ha a
  // Meta-igazítás átszivárogna ide, a Google feltöltés alakja megváltozna —
  // pont az a fajta néma mellékhatás, amiért a split egyáltalán készült.
  it('a plain postal továbbra is NAGYBETŰS, kötőjellel', () => {
    expect(normalizePostalCode('sw1a 1aa')).toBe('SW1A1AA');
    expect(normalizePostalCode('12345-6789')).toBe('12345-6789');
  });
  it('a plain city továbbra is megtartja a szóközt és az ékezetet', () => {
    expect(normalizeCity('  Pécs  ')).toBe('pécs');
    expect(normalizeCity('New York')).toBe('new york');
  });
});
