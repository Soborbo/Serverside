import { describe, it, expect, vi } from 'vitest';
import { normalizeEmail as serverNormalizeEmail } from '../src/lib/hash';
import { normalizeEmail as browserNormalizeEmail } from '../soborbo-tracking/lib/persistence';
import {
  EMAIL_IDENTITY_MAX_OCTETS,
  normalizeEmailIdentity,
  utf8OctetLength
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

/**
 * AZ OKTETSZÁMLÁLÓ RUNTIME-FÜGGETLEN — és a `TextEncoder` az ORÁKULUM, nem a
 * megvalósítás.
 *
 * Egy korábbi változat feature-detectet használt: `TextEncoder`, ha van,
 * különben `length * 4`. Az a fallback nem konzervatív becslés volt, hanem
 * HAMIS: egy 87 oktetes ASCII cím 348-nak számított, tehát egy `TextEncoder`
 * nélküli böngésző ELDOBTA azt, amit a Worker ELFOGADOTT — a feature-detect
 * visszahozta ugyanazt az identity-aszimmetriát, amit a modul felszámol.
 *
 * Az invariáns nem az, hogy „ne engedjen át többet, mint a másik láb", hanem
 * hogy UGYANARRA A STRINGRE MINDEN RUNTIME UGYANAZT A SZÁMOT ADJA.
 */
describe('utf8OctetLength — a TextEncoder csak orákulum', () => {
  const oracle = (s: string) => new TextEncoder().encode(s).length;

  const SAMPLES: Array<[string, string]> = [
    ['tiszta ASCII', 'user-' + 'a'.repeat(70) + '@example.com'],
    ['ures', ''],
    ['2-oktetes latin ekezet', 'áéíóöőúüű@example.com'],
    ['3-oktetes CJK', '日本語@example.com'],
    ['3-oktetes cirill', 'почта@example.com'],
    ['4-oktetes emoji (surrogate par)', '\u{1f44d}\u{1f3af}@example.com'],
    ['emoji ZWJ-szekvencia', '\u{1f468}‍\u{1f469}‍\u{1f467}@example.com'],
    ['maganyos HIGH surrogate', 'a\ud83d@example.com'],
    ['maganyos LOW surrogate', 'a\ude00@example.com'],
    ['ket maganyos surrogate forditva', '\udc00\ud800@example.com'],
    ['vegyes', 'Jo-napot\u{1f44d}@példa.hu']
  ];

  for (const [label, sample] of SAMPLES) {
    it(`${label}: kezi szamlalo === TextEncoder`, () => {
      expect(utf8OctetLength(sample)).toBe(oracle(sample));
    });
  }

  it('a hatar korul minden hosszon egyezik (240-260 ASCII oktet)', () => {
    for (let n = 240; n <= 260; n++) {
      const addr = emailOfOctets(n);
      expect(utf8OctetLength(addr), `n=${n}`).toBe(oracle(addr));
    }
  });
});

describe('a hossz-dontes nem fugghet a runtime-tol', () => {
  it('REGRESSZIO: 80-200 karakteres tiszta ASCII cim SOSEM valik ervenytelenne', () => {
    // Ez bukott a `length * 4` fallbackkel: 64 karakter folott minden ASCII
    // cim 254 fole „nott", es a bongeszo-lab eldobta.
    for (let n = 80; n <= 200; n++) {
      const addr = emailOfOctets(n);
      expect(normalizeEmailIdentity(addr), `${n} oktetes ASCII cim elveszett`).toBe(addr);
    }
  });

  it('ASCII 254 -> ACCEPT, 255 -> REJECT', () => {
    expect(normalizeEmailIdentity(emailOfOctets(254))).toBe(emailOfOctets(254));
    expect(normalizeEmailIdentity(emailOfOctets(255))).toBeUndefined();
  });

  it('multibyte 254 -> ACCEPT, 256 -> REJECT', () => {
    // 121 x U+00E1 (242 oktet) + '@example.com' (12) = 254 pontosan.
    const at254 = 'á'.repeat(121) + '@example.com';
    expect(new TextEncoder().encode(at254).length).toBe(254);
    expect(normalizeEmailIdentity(at254)).toBe(at254);

    const over = 'á'.repeat(122) + '@example.com'; // 256
    expect(new TextEncoder().encode(over).length).toBe(256);
    expect(normalizeEmailIdentity(over)).toBeUndefined();
  });
});

/**
 * A HIÁNYZÓ `TextEncoder` RUNTIME — az egyetlen teszt, ami a hibát MEGFOGJA.
 *
 * A fenti esetek egy `TextEncoder`-rel rendelkező runtime-ban futnak, ezért a
 * feature-detectes megvalósításon IS zöldek voltak: a hibás ág sosem futott le.
 * Pontosan ezért maradt láthatatlan a `length * 4` fallback.
 *
 * Ez a blokk kiveszi a `TextEncoder`-t a globális scope-ból, ÚJRAIMPORTÁLJA a
 * modult, és ugyanazokat az eredményeket várja. A feature-detectes változaton
 * ez bukik; a determinisztikus számlálón átmegy — és őrként megmarad arra az
 * esetre, ha valaki később visszatenne egy runtime-függő kódutat.
 */
describe('TextEncoder nelkuli runtime', () => {
  it('ugyanazt a dontest hozza, mint a TextEncoderes', async () => {
    const ascii = 'user-' + 'a'.repeat(70) + '@example.com';
    const expectedOctets = new TextEncoder().encode(ascii).length;
    expect(expectedOctets).toBe(87);

    vi.resetModules();
    vi.stubGlobal('TextEncoder', undefined);
    try {
      const mod = await import('../soborbo-tracking/lib/email-identity');
      expect(
        mod.utf8OctetLength(ascii),
        'TextEncoder nelkul mas oktetszamot kaptunk ugyanarra a stringre'
      ).toBe(expectedOctets);
      expect(
        mod.normalizeEmailIdentity(ascii),
        'egy 87 oktetes ASCII cim elveszett, mert nem volt TextEncoder'
      ).toBe(ascii);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
