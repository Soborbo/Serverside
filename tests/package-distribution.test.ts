import { describe, it, expect } from 'vitest';
import { collectVersions, versionMismatches } from '../scripts/check-package-version.mjs';
import { compareVendoredCopy, verdict } from '../scripts/check-vendored-copy.mjs';
import { hashContent, buildManifest } from '../scripts/gen-dist-manifest.mjs';

/**
 * F9 · P4 — a csomag-terjesztés őrei.
 *
 * Két dolgot kényszerítenek ki, és mindkettő már bizonyítottan elromlott egyszer:
 *
 *  1. **Egy verzió-tekintély.** A verzió három helyen él (package.json,
 *     CLIENT_LIB_VERSION, BACKEND_LIB_VERSION), mert a (2) böngésző-bundle-be
 *     fordul, a (3) pedig önállóan másolódik a site-okra. Amikor az őr
 *     megszületett, a három érték `6.2.1 / 6.2.1 / 6.2.0` volt.
 *
 *  2. **A bemásolt példány sodródása mérhető.** A `client_lib_version`
 *     telemetria, ami ezt hivatott jelezni, az élő ledgerben 1392 receiptből
 *     1391-en NULL — tehát ma NULLA gépi tudásunk van a flotta verzióiról.
 */

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'soborbo-tracking', version: '7.0.0' }),
  'lib/config.ts': "export const CLIENT_LIB_VERSION = '7.0.0';",
  'server/backend/gateway-dispatch.ts': "export const BACKEND_LIB_VERSION = '7.0.0';"
};

/** A szkript path.join-nal olvas — a végződés alapján szolgáljuk ki. */
function reader(files: Record<string, string>) {
  return (p: string) => {
    const key = Object.keys(files).find((k) => p.replace(/\\/g, '/').endsWith(k));
    if (!key) throw new Error(`nincs ilyen fixture-fájl: ${p}`);
    return files[key];
  };
}

describe('verzió-tekintély', () => {
  it('mindhárom hely egyezik → nincs eltérés', () => {
    expect(versionMismatches(collectVersions(reader(FILES)))).toEqual([]);
  });

  it('a lemaradt backend-konstanst elkapja (ez volt a valóság: 6.2.1 vs 6.2.0)', () => {
    const drifted = {
      ...FILES,
      'server/backend/gateway-dispatch.ts': "export const BACKEND_LIB_VERSION = '6.9.9';"
    };
    const bad = versionMismatches(collectVersions(reader(drifted)));
    expect(bad).toHaveLength(1);
    expect(bad[0].label).toBe('BACKEND_LIB_VERSION');
    expect(bad[0].version).toBe('6.9.9');
  });

  it('a HIÁNYZÓ konstans nem „egyezik" — a verzió-jelentés elvesztése külön hiba', () => {
    const gone = { ...FILES, 'lib/config.ts': 'export const SOMETHING_ELSE = 1;' };
    const bad = versionMismatches(collectVersions(reader(gone)));
    expect(bad).toHaveLength(1);
    expect(bad[0].version).toBeNull();
  });

  it('az ÉLES repó verziói ténylegesen egyeznek (nem csak a fixture-ön)', () => {
    expect(versionMismatches(collectVersions())).toEqual([]);
  });
});

describe('dist-manifest', () => {
  it('a sorvég NEM drift — a repót Windowson és Linuxon is szerkesztjük', () => {
    expect(hashContent('a\r\nb')).toBe(hashContent('a\nb'));
  });

  it('az éles manifeszt a terjesztendő fájlokat fedi (lib + components + backend)', () => {
    const m = buildManifest();
    const roles = new Set(Object.values(m.files).map((f: any) => f.role));
    expect(roles).toEqual(new Set(['browser', 'backend']));
    expect(m.file_count).toBeGreaterThan(20);
    // Tesztfájl SOHA nem kerülhet a terjesztésbe.
    expect(Object.keys(m.files).some((f) => /\.test\.ts$/.test(f))).toBe(false);
  });
});

describe('vendorolt példány drift-riportja', () => {
  const manifest = {
    version: '7.0.0',
    files: {
      'lib/gateway.ts': { sha256: hashContent('GATEWAY'), bytes: 7, role: 'browser' },
      'lib/consent.ts': { sha256: hashContent('CONSENT'), bytes: 7, role: 'browser' },
      'server/backend/gateway-dispatch.ts': { sha256: hashContent('DISPATCH'), bytes: 8, role: 'backend' }
    }
  };

  const run = (present: Record<string, string>) =>
    compareVendoredCopy(
      '/fake',
      manifest,
      () => Object.keys(present),
      (p: string) => present[p.replace(/\\/g, '/').replace('/fake/', '')]
    );

  it('bitre azonos példány → CLEAN', () => {
    const r = run({
      'lib/gateway.ts': 'GATEWAY',
      'lib/consent.ts': 'CONSENT',
      'server/backend/gateway-dispatch.ts': 'DISPATCH'
    });
    expect(r.summary).toEqual({ identical: 3, drifted: 0, missing: 0 });
    expect(verdict(r).level).toBe('CLEAN');
  });

  it('a LAPOS vendorolt elrendezést is megtalálja (az INSTALL.md így másoltat)', () => {
    const r = run({ 'gateway.ts': 'GATEWAY', 'consent.ts': 'CONSENT', 'gateway-dispatch.ts': 'DISPATCH' });
    expect(r.summary.identical).toBe(3);
    expect(r.rows.find((x: any) => x.file === 'lib/gateway.ts').found_as).toBe('gateway.ts');
  });

  it('módosított tartalom → DRIFTED, a fájl megnevezésével', () => {
    const r = run({ 'gateway.ts': 'GATEWAY-PATCHED', 'consent.ts': 'CONSENT', 'gateway-dispatch.ts': 'DISPATCH' });
    expect(r.summary.drifted).toBe(1);
    expect(verdict(r).level).toBe('DRIFTED');
  });

  it('a kiadás többsége hiányzik → FORK, mert az csere és nem frissítés', () => {
    const r = run({ 'gateway.ts': 'GATEWAY' });
    expect(r.summary.missing).toBe(2);
    const v = verdict(r);
    expect(v.level).toBe('FORK');
    expect(v.text).toContain('ÖNÁLLÓ implementáció');
  });

  it('az idegen fájl látszik, de NEM buktat — lehet a site saját kódja', () => {
    const r = run({
      'lib/gateway.ts': 'GATEWAY',
      'lib/consent.ts': 'CONSENT',
      'server/backend/gateway-dispatch.ts': 'DISPATCH',
      'site-only-helper.ts': 'x'
    });
    expect(r.extras).toEqual(['site-only-helper.ts']);
    expect(verdict(r).level).toBe('CLEAN');
  });
});
