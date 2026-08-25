#!/usr/bin/env node
/**
 * F9 · P4 — EGY VERZIÓ-TEKINTÉLY.
 *
 * A csomag verziója HÁROM helyen él, és mind a háromnak egyeznie kell:
 *
 *   1. `soborbo-tracking/package.json` → `version`            ← EZ A FORRÁS
 *   2. `soborbo-tracking/lib/config.ts` → `CLIENT_LIB_VERSION`
 *   3. `soborbo-tracking/server/backend/gateway-dispatch.ts` → `BACKEND_LIB_VERSION`
 *
 * ── Miért nem egy importált konstans ─────────────────────────────────────────
 * A (2) böngésző-bundle-be fordul (a `package.json` beolvasása ott nem opció), a
 * (3) pedig ÖNÁLLÓAN másolódik a site repójába, ahol a csomag package.json-je
 * nem is létezik. A duplikáció tehát szerkezeti, nem lustaság — ezért kap ŐRT,
 * ugyanazzal az elvvel, amivel a böngésző↔backend consent-parser paritása
 * (`consent-backend-parity.test.ts`).
 *
 * ── Miért kellett ez ────────────────────────────────────────────────────────
 * Amikor ez az őr megszületett, a három érték `6.2.1 / 6.2.1 / 6.2.0` volt: a
 * backend egy kiadással le volt maradva, és ezt semmi nem jelezte. Ma ez még
 * ártalmatlan (a gateway `MIN_CLIENT_LIB_VERSION` = 6.1.0), de pontosan az a
 * minta, ami a #93-ban már egyszer elsült: két igazság ugyanarról a dologról.
 *
 * Használat: node scripts/check-package-version.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'soborbo-tracking');

/** @type {Array<{label: string, file: string, re: RegExp}>} */
const SITES = [
  {
    label: 'CLIENT_LIB_VERSION',
    file: 'lib/config.ts',
    re: /export const CLIENT_LIB_VERSION\s*=\s*'([^']+)'/
  },
  {
    label: 'BACKEND_LIB_VERSION',
    file: 'server/backend/gateway-dispatch.ts',
    re: /export const BACKEND_LIB_VERSION\s*=\s*'([^']+)'/
  }
];

export function collectVersions(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const pkg = JSON.parse(readFile(path.join(PKG_DIR, 'package.json')));
  const found = [{ label: 'package.json', file: 'package.json', version: pkg.version }];
  for (const s of SITES) {
    const abs = path.join(PKG_DIR, s.file);
    const m = s.re.exec(readFile(abs));
    // A HIÁNYZÓ konstans nem „egyezik" — az azt jelenti, hogy a verzió-jelentés
    // elveszett. Külön, beszédes hiba, nem néma átcsúszás.
    found.push({ label: s.label, file: s.file, version: m ? m[1] : null });
  }
  return found;
}

export function versionMismatches(found) {
  const source = found[0].version;
  return found.filter((f) => f.version !== source);
}

if (process.argv[1]?.endsWith('check-package-version.mjs')) {
  const found = collectVersions();
  const bad = versionMismatches(found);
  if (bad.length > 0) {
    console.error(`PACKAGE_VERSION_DRIFT — a forrás a package.json: ${found[0].version}`);
    for (const f of bad) {
      console.error(`  - ${f.label} (${f.file}): ${f.version ?? 'HIÁNYZIK'}`);
    }
    console.error('Írd át a konstansokat a package.json verziójára (vagy fordítva, ha az a hibás).');
    process.exit(1);
  }
  console.log(`✅ PACKAGE_VERSION_OK — mind a ${found.length} hely ${found[0].version}.`);
}
