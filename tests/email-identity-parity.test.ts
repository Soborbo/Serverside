import { describe, it, expect } from 'vitest';
import { normalizeEmail as serverNormalizeEmail } from '../src/lib/hash';
import { normalizeEmail as browserNormalizeEmail } from '../soborbo-tracking/lib/persistence';
import {
  EMAIL_IDENTITY_MAX_OCTETS,
  normalizeEmailIdentity
} from '../soborbo-tracking/lib/email-identity';

/**
 * EGY IDENTITÁS → EGY NORMALIZÁLT BYTE-STRING → EGY HASH.
 *
 * ── A hiba, amit ez a fájl zár le ────────────────────────────────────────────
 * Az e-mail normalizálása HÁROM helyen élt, és a három NEM ugyanazt csinálta:
 *
 *   böngésző-csomag  trim → lowercase → slice(0, 254)      ← CSONKÍTOTT
 *   Worker hash.ts   trim → lowercase → `@`-őr             ← nem csonkított
 *   painless site    trim → lowercase                      ← se cap, se őr
 *
 * A csonkítás a legrosszabb kimenet: 254 fölött a böngésző egy MESTERSÉGESEN
 * MÁS stringet állít elő (`…@exam`), amit aztán más hash-re képez, mint a
 * szerver ugyanabból a címből. Az RFC 5321 valóban 254 oktetben maximálja a
 * mailboxot — de ebből az következik, hogy a hosszabb cím ÉRVÉNYTELEN, nem
 * hogy le kell vágni. Ezért: 254 fölött ELDOBJUK, sosem csonkítunk.
 *
 * A `@`-őr hiánya nem hash-divergencia, hanem ASZIMMETRIA: egy elgépelt
 * „e-mail" a böngésző-lábon `em`-ként hashelődne, a szerver viszont eldobja.
 * Ez az identity matching / EMQ / EC match rate-et rontja (a Meta dedup
 * továbbra is az `(event_name, event_id)` páron áll, azt nem érinti).
 */

const FIXTURES: Array<{ label: string; input: string | null | undefined; expected: string | undefined }> = [
  { label: 'trim + lowercase', input: ' User@Example.COM ', expected: 'user@example.com' },
  { label: 'már normalizált', input: 'user@example.com', expected: 'user@example.com' },
  { label: 'nincs @ — nem e-mail', input: 'not-an-email', expected: undefined },
  { label: 'domain-szerű, de @ nélkül', input: 'foo.example.com', expected: undefined },
  { label: 'üres', input: '', expected: undefined },
  { label: 'csak whitespace', input: '   ', expected: undefined },
  { label: 'null', input: null, expected: undefined },
  { label: 'undefined', input: undefined, expected: undefined },
  {
    label: 'plus-suffix MARAD (CLAUDE.md 1. — Meta a literal stringet hasheli)',
    input: 'john+spam@gmail.com',
    expected: 'john+spam@gmail.com'
  },
  {
    label: 'Gmail-pont MARAD',
    input: 'john.smith@gmail.com',
    expected: 'john.smith@gmail.com'
  }
];

/** Pontosan `n` oktet hosszú, szintaktikailag e-mail alakú cím. */
function emailOfOctets(n: number): string {
  const suffix = '@example.com'; // 12 oktet, mind ASCII
  return 'a'.repeat(n - suffix.length) + suffix;
}

function octets(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe('normalizeEmailIdentity — a szabály', () => {
  for (const f of FIXTURES) {
    it(f.label, () => {
      expect(normalizeEmailIdentity(f.input)).toBe(f.expected);
    });
  }

  it('a határon (254 oktet) még érvényes, és VÁLTOZATLAN', () => {
    const at = emailOfOctets(EMAIL_IDENTITY_MAX_OCTETS);
    expect(octets(at)).toBe(254);
    expect(normalizeEmailIdentity(at)).toBe(at);
  });

  it('253 oktet változatlan', () => {
    const under = emailOfOctets(EMAIL_IDENTITY_MAX_OCTETS - 1);
    expect(normalizeEmailIdentity(under)).toBe(under);
  });

  it('255 oktet → undefined, és SOHA nem csonkított string', () => {
    const over = emailOfOctets(EMAIL_IDENTITY_MAX_OCTETS + 1);
    const out = normalizeEmailIdentity(over);
    expect(out, 'a túl hosszú cím csonkolva ment tovább — mesterséges másik identitás').toBeUndefined();
  });

  it('a korlát OKTETBEN mér, nem JS-karakterben', () => {
    // Az ékezetes betű UTF-8-ban 2 oktet. Ez a cím `length`-ben 250 alatt van,
    // oktetben viszont 254 FÖLÖTT — a `String.length`-re épülő ellenőrzés
    // átengedné, és a két láb megint más byte-sorozatot hashelne.
    const local = 'á'.repeat(130); // 260 oktet
    const addr = `${local}@example.com`;
    expect(addr.length).toBeLessThan(EMAIL_IDENTITY_MAX_OCTETS);
    expect(octets(addr)).toBeGreaterThan(EMAIL_IDENTITY_MAX_OCTETS);
    expect(normalizeEmailIdentity(addr)).toBeUndefined();
  });
});

describe('PARITÁS — a böngésző-láb és a Worker BITRE ugyanazt adja', () => {
  const cases: Array<string | null | undefined> = [
    ...FIXTURES.map((f) => f.input),
    emailOfOctets(EMAIL_IDENTITY_MAX_OCTETS - 1),
    emailOfOctets(EMAIL_IDENTITY_MAX_OCTETS),
    emailOfOctets(EMAIL_IDENTITY_MAX_OCTETS + 1),
    `${'á'.repeat(130)}@example.com`,
    ' MiXeD@Case.Example.COM '
  ];

  for (const input of cases) {
    const label = input === undefined ? 'undefined' : input === null ? 'null' : `"${input.slice(0, 32)}${input.length > 32 ? `…(${input.length})` : ''}"`;
    it(`azonos kimenet: ${label}`, () => {
      const server = serverNormalizeEmail(input);
      const browser = browserNormalizeEmail(input);
      expect(browser, 'a böngésző-láb és a Worker MÁS identitást állít elő').toBe(server);
      expect(server).toBe(normalizeEmailIdentity(input));
    });
  }
});
