import { describe, it, expect } from 'vitest';
import { normalizePhone as clientNormalize } from '../lib/persistence';
import { normalizePhone as serverNormalize } from '../../src/lib/hash';

/**
 * KLIENS ↔ SZERVER telefon-paritás.
 *
 * A böngésző-Pixel a KLIENS normalizálójából képzett hash-t küldi, a CAPI és a
 * Google EC pedig a SZERVERÉBŐL. Ha a kettő akár egyetlen írásmódnál eltér, a
 * két oldal MÁS embert lát ugyanabban a látogatóban: a dedup és a match némán
 * elromlik, miközben minden mérőszám zöld marad.
 *
 * EZ MEGTÖRTÉNT. A kliens korai `return`-nel kilépett minden `+`-szal kezdődő
 * számnál, tehát a UK/EU-ban általános `+44 (0)7123 456 789` írásmódból
 * `+4407123456789` lett — a szerver ugyanabból `+447123456789`-et csinált.
 * A CLAUDE.md 1. pontja pont ezt a példát írja elő.
 */

const CASES: Array<[string, 'GB' | 'HU']> = [
  // A dokumentált CLAUDE.md-példa.
  ['+44 (0)7123-456.789', 'GB'],
  ['+44 (0)7123 456 789', 'GB'],
  // Nemzeti alakok.
  ['07123 456789', 'GB'],
  ['07123456789', 'GB'],
  ['06 20 123 4567', 'HU'],
  ['06201234567', 'HU'],
  // Már nemzetközi alakok.
  ['+447123456789', 'GB'],
  ['+36201234567', 'HU'],
  ['+36 (0)20 123 4567', 'HU'],
  // Hívókód `+` nélkül.
  ['447123456789', 'GB'],
  ['36201234567', 'HU'],
  // Egyéb trunk-nullás EU-hívókódok a szerver tábláján.
  ['+49 (0)176 12345678', 'GB'],
  ['+33 (0)6 12 34 56 78', 'GB'],
];

describe('a kliens és a szerver UGYANAZT az E.164-et adja', () => {
  for (const [raw, country] of CASES) {
    it(`"${raw}" (${country})`, () => {
      const client = clientNormalize(raw, country);
      const server = serverNormalize(raw, country);
      expect(server, `a szerver eldobta: ${raw}`).toBeDefined();
      expect(client).toBe(server);
    });
  }

  it('a trunk-nullát NEM használó országokat egyik oldal sem csonkítja', () => {
    // Olaszország megtartja a vezető nullát nemzetközi alakban is — ha bármelyik
    // oldal levágná, egy létező számból nem létezőt csinálna.
    const raw = '+39 06 1234 5678';
    expect(clientNormalize(raw, 'GB')).toBe('+390612345678');
    expect(serverNormalize(raw, 'GB')).toBe('+390612345678');
  });
});
