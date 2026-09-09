import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { defaultBranch, fetchFile, detectSboFromRepo } from '../scripts/check-fleet-contract.mjs';

/**
 * A FLOTTA-RIPORT egysegei.
 *
 * A `gh` hivasok INJEKTALHATOK, ezert a viselkedes halozat nelkul merheto — es
 * pont a halozati resz az, amit egy CI-ban nem is akarunk futtatni (privat
 * repok, cross-repo token). A riport LOKALIS szerszam; a kapu a
 * `check-backend-contract.mjs`, az fut a CI-ban.
 */

describe('defaultBranch — nem feltetelezunk `main`-t', () => {
  it('a repo bejelentett default agat adja vissza', () => {
    expect(defaultBranch('Soborbo/Beautyflow_website', () => 'master\n')).toBe('master');
    expect(defaultBranch('Soborbo/olcsokontenerhaz', () => 'main\n')).toBe('main');
  });

  it('a repo NEVEVEL kerdez — nem egy bedrotozott aggal', () => {
    let seen: string[] = [];
    defaultBranch('Soborbo/xy', (args) => {
      seen = args;
      return 'trunk';
    });
    expect(seen).toContain('repos/Soborbo/xy');
  });
});

describe('fetchFile — a base64 valasz dekodolasa', () => {
  it('a GitHub tordelt base64-jet is helyesen olvassa', () => {
    const src = "export const BACKEND_LIB_VERSION = '6.6.8';\n";
    // A contents API SORTORESEKKEL tagolt base64-et ad vissza — a naiv
    // `Buffer.from(x, 'base64')` ezt tolerálja, de a whitespace-strip nelkul
    // egy szigorubb dekodolo elhasalna. A fixture ezert tordelt.
    const wrapped = Buffer.from(src).toString('base64').replace(/(.{8})/g, '$1\n');
    expect(fetchFile('r', 'main', 'p.ts', () => wrapped)).toBe(src);
  });

  it('a kert AGAT is atadja (nem a repo aktualis HEAD-jet talalgatja)', () => {
    let seen = '';
    fetchFile('Soborbo/xy', 'master', 'src/a.ts', (args) => {
      seen = args[1];
      return Buffer.from('x').toString('base64');
    });
    expect(seen).toContain('ref=master');
    expect(seen).toContain('src/a.ts');
  });
});

describe('detectSboFromRepo — a kepesseget MERJUK, nem irjuk fel', () => {
  const tree = (paths: string[]) => () => paths.join('\n');

  it('megtalalja a kit alatt (Beautyflow alakja)', () => {
    expect(
      detectSboFromRepo('r', 'master', tree(['src/lib/x.ts', 'tracking-kit/lib/consent-sbo-state.ts']))
    ).toBe(true);
  });

  it('megtalalja a site src-je alatt (olcso alakja)', () => {
    expect(detectSboFromRepo('r', 'main', tree(['src/lib/consent-sbo-state.ts']))).toBe(true);
  });

  it('nincs sbo-fajl → nem sbo-kepes (trapez / lomtalan / agykontroll alakja)', () => {
    expect(detectSboFromRepo('r', 'main', tree(['src/lib/gateway-dispatch.ts', 'src/lib/consent.ts']))).toBe(
      false
    );
  });

  it('a hasonlo nevu fajl NEM szamit', () => {
    expect(detectSboFromRepo('r', 'main', tree(['src/lib/consent-sbo-state.test.ts']))).toBe(false);
    expect(detectSboFromRepo('r', 'main', tree(['src/lib/my-consent-sbo-state.ts']))).toBe(false);
  });
});

describe('a site-lista ADAT, es teljes', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts/fleet-sites.json'), 'utf8'));

  it('minden bejegyzesnek van site/repo/path mezoje', () => {
    for (const s of cfg.sites) {
      expect(s.site, JSON.stringify(s)).toBeTruthy();
      expect(s.repo, JSON.stringify(s)).toMatch(/^Soborbo\//);
      expect(s.path, JSON.stringify(s)).toMatch(/gateway-dispatch\.ts$/);
    }
  });

  it('a site-nevek egyediek', () => {
    const names = cfg.sites.map((s: { site: string }) => s.site);
    expect(new Set(names).size).toBe(names.length);
  });

  it('NINCS kezzel felirt `sbo` oszlop — az a repo-bol merodik', () => {
    for (const s of cfg.sites) expect(Object.keys(s)).not.toContain('sbo');
  });
});
