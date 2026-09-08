import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkBackendContract,
  detectSboCapable,
  parseBaseVersion,
  RULES,
  MIN_BACKEND_BASE_VERSION
} from '../scripts/check-backend-contract.mjs';

/**
 * A SZERVER-LÁB SZERZŐDÉS-ŐRÉNEK harness-e.
 *
 * ── Miért kell megmérni magát az őrt ─────────────────────────────────────────
 * Ez az őr FORRÁS-MINTÁKRA épül. Egy ilyen ellenőrzés a legkönnyebben úgy romlik
 * el, hogy CSENDBEN mindent átenged: a minta elavul egy refaktor után, a szabály
 * lefut, zöldet ad, és attól kezdve nulla információt hordoz. Pontosan az a
 * hibaosztály, amit a repó már kétszer megélt (a nem futó `typecheck`, és a
 * `--require-semver` nélküli lockfile-őr).
 *
 * Ezért minden szabályhoz TARTOZIK egy pozitív ÉS egy negatív fixture: a bukó
 * változatnak buknia KELL. Így egy elavuló minta nem zöldül, hanem itt esik szét.
 *
 * A fixture-ök nem kitaláltak: a `BROKEN_*` darabok a 2026-09-08-án ÉLESBEN
 * megtalált két site-állapot lecsupaszított másai (olcso `v1`-parser, Beautyflow
 * hiányzó sbo-út).
 */

const CANONICAL = fs.readFileSync(
  path.join(process.cwd(), 'soborbo-tracking/server/backend/gateway-dispatch.ts'),
  'utf8'
);

describe('a kanonikus szerver-láb teljesíti a saját szerződését', () => {
  it('10/10, kihagyás nélkül', () => {
    const r = checkBackendContract('canonical', CANONICAL, 'kanonikus', true);
    const failing = r.rows.filter((row) => row.applies && !row.ok).map((row) => row.id);
    expect(failing, `bukó szabályok: ${failing.join(', ')}`).toEqual([]);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('minden szabály tartozik valamelyik csoportba', () => {
    for (const r of RULES) expect(['core', 'sbo']).toContain(r.group);
  });

  it('minden szabálynak van `looked_for` és `why` — a bukás magyarázata nélkül az őr használhatatlan', () => {
    for (const r of RULES) {
      expect(r.looked_for, `${r.id}: hiányzó looked_for`).toBeTruthy();
      expect(r.why, `${r.id}: hiányzó why`).toBeTruthy();
    }
  });
});

/**
 * A NEGATÍV fixture-ök. Mindegyik a kanonikus forrásból készül EGY szabály
 * kilövésével — így azt méri, hogy a szabály tényleg CSAK arra érzékeny.
 */
const MUTATIONS: Array<[string, (src: string) => string]> = [
  ['VERSION_PRESENT', (s) => s.replace(/export const BACKEND_LIB_VERSION\s*=\s*'[^']+';/, '')],
  [
    'VERSION_SHAPE',
    (s) => s.replace(/export const BACKEND_LIB_VERSION\s*=\s*'[^']+';/, "export const BACKEND_LIB_VERSION = '6.6.8+fork';")
  ],
  [
    'VERSION_NOT_STALE',
    (s) => s.replace(/export const BACKEND_LIB_VERSION\s*=\s*'[^']+';/, "export const BACKEND_LIB_VERSION = '6.2.0';")
  ],
  ['SBO_READER_EXISTS', (s) => s.replace('export function readSboConsentCookieHeader(', 'function readSboConsentCookieHeaderX(')],
  ['SBO_FORMAT_V2', (s) => s.replace("p.length !== 8 || p[0] !== 'v2'", "p.length !== 7 || p[0] !== 'v1'")],
  ['SBO_EXPIRY', (s) => s.replace(/if \(now - decidedAtSec > SBO_CONSENT_MAX_AGE_S\) return null;/, '')],
  [
    'SBO_POLICY_VERSION',
    (s) =>
      s.replace(
        /if \(opts\.expectedPolicyVersion !== undefined && policyVersion !== opts\.expectedPolicyVersion\) \{/,
        'if (false) {'
      )
  ],
  ['SBO_DECISION_CONSISTENCY', (s) => s.replace(/p\[4\] === 'accept_all'/g, "p[4] === 'ACCEPT'")],
  ['COOKIEYES_ADVERTISEMENT_KEY', (s) => s.replace(/map\.advertisement/g, 'map.marketing')]
];

describe('minden szabály MÉR — a kilövése bukást okoz', () => {
  for (const [id, mutate] of MUTATIONS) {
    it(`${id}: a szabály kilövése után BUKIK`, () => {
      const mutated = mutate(CANONICAL);
      expect(mutated, `${id}: a mutáció nem változtatott a forráson`).not.toBe(CANONICAL);
      const r = checkBackendContract('mutated', mutated, null, true);
      const failed = r.rows.filter((row) => row.applies && !row.ok).map((row) => row.id);
      expect(failed, `${id}: bukó szabályok = [${failed.join(', ')}]`).toContain(id);
    });
  }
});

describe('GATE_CONSULTS_SBO — a kapu, nem csak a telemetria', () => {
  it('bukik, ha a kapu NEM hívja az sbo olvasót (a Beautyflow-eset alakja)', () => {
    // A `readConsentFromCookie` törzséből kivesszük az sbo-ágat, a
    // `buildConsentSources`-ét MEGHAGYVA — pont ez a félig kimondott kockázat.
    const src = CANONICAL.replace(
      /export function readConsentFromCookie\([\s\S]*?\n}/,
      `export function readConsentFromCookie(cookieHeader: string | null): ConsentState | undefined {
  if (!cookieHeader) return undefined;
  return undefined;
}`
    );
    const r = checkBackendContract('no-gate', src, null, true);
    const failed = r.rows.filter((row) => row.applies && !row.ok).map((row) => row.id);
    expect(failed).toContain('GATE_CONSULTS_SBO');
    // A többi sbo-szabály TOVÁBBRA is teljesül: a parser megvan, csak a kapu nem hívja.
    expect(failed).not.toContain('SBO_FORMAT_V2');
  });
});

describe('az sbo-csoport feltételessége', () => {
  const noSbo = CANONICAL.replace('export function readSboConsentCookieHeader(', 'function gone(');

  it('sbo-képes site-on a hiányzó sbo-út BUKTAT', () => {
    expect(checkBackendContract('x', noSbo, null, true).failed).toBeGreaterThan(0);
  });

  it('NEM sbo-képes site-on ugyanaz a fájl ÁTMEGY — különben három egészséges site állna örökké pirosan', () => {
    const r = checkBackendContract('x', noSbo, null, false);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(6);
  });

  it('a kihagyott szabályokat is MEGMÉRJÜK — a riport látja, ha egy CookieYes-site mégis sbo-képes lett', () => {
    const r = checkBackendContract('x', CANONICAL, null, false);
    const skippedButPassing = r.rows.filter((row) => !row.applies && row.ok);
    expect(skippedButPassing.length).toBe(6);
  });

  it('a core-szabályok NEM hagyhatók ki: a verzió-címke sbo nélkül is kötelező', () => {
    const stale = CANONICAL.replace(
      /export const BACKEND_LIB_VERSION\s*=\s*'[^']+';/,
      "export const BACKEND_LIB_VERSION = '6.2.0';"
    );
    expect(checkBackendContract('x', stale, null, false).failed).toBe(1);
  });
});

describe('parseBaseVersion — a fork-jelölés is verzió', () => {
  it.each([
    ['6.6.8', [6, 6, 8]],
    ['6.6.4-lomtalan-fork', [6, 6, 4]],
    ['6.2.0', [6, 2, 0]],
    ['0.0.0-painless-fork', [0, 0, 0]]
  ])('%s → %j', (input, expected) => {
    expect(parseBaseVersion(input as string)).toEqual(expected);
  });

  it.each(['', 'fork', 'v6.6.8', '6.6'])('%s → null', (input) => {
    expect(parseBaseVersion(input)).toBeNull();
  });

  it('a padló felett van a mai flotta minden ÉLŐ jelölése', () => {
    for (const v of ['6.6.8', '6.6.7', '6.6.8-olcso-fork', '6.6.4-lomtalan-fork']) {
      const base = parseBaseVersion(v)!;
      const min = parseBaseVersion(MIN_BACKEND_BASE_VERSION)!;
      const below = base[0] < min[0] || (base[0] === min[0] && base[1] < min[1]);
      expect(below, `${v} a padló alá esett`).toBe(false);
    }
  });
});

describe('detectSboCapable — a bizonyíték a repóból jön', () => {
  it('megtalálja a consent-sbo-state.ts-t bárhol a fában', () => {
    const walk = () => ['/x/src/lib/gateway.ts', '/x/tracking-kit/lib/consent-sbo-state.ts'];
    expect(detectSboCapable('/x', walk)).toBe(true);
  });

  it('nem téveszt meg a hasonló nevű fájl', () => {
    const walk = () => ['/x/src/lib/consent-sbo-state.test.ts', '/x/src/lib/consent.ts'];
    expect(detectSboCapable('/x', walk)).toBe(false);
  });

  it('üres fa → nem sbo-képes', () => {
    expect(detectSboCapable('/x', () => [])).toBe(false);
  });
});
