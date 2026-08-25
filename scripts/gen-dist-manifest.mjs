#!/usr/bin/env node
/**
 * F9 · P4 — A CSOMAG TERJESZTÉSI MANIFESZTJE (verzió-tekintély + tartalom-hash).
 *
 * ── Miért létezik ────────────────────────────────────────────────────────────
 * A `soborbo-tracking` csomagot ma ÚGY telepítjük, hogy a fájlokat BEMÁSOLJUK a
 * site repójába (INSTALL.md 2. és 3. lépés). Ennek a modellnek két, mérhető
 * következménye van:
 *
 *   1. A másolat SODRÓDIK, és ezt semmi nem veszi észre. A painless
 *      `src/lib/tracking/` ma már nem elavult másolat, hanem ÖNÁLLÓ
 *      implementáció (más fájlnevek, saját tesztek, nulla verzió-konstans).
 *   2. A sodródást hivatott mérni a `client_lib_version` telemetria — csakhogy
 *      az élő ledgerben (2026-08-25) **1392 consent-receiptből 1391 NULL**, és
 *      az egyetlen kitöltött sor is `6.2.0`-t jelent a kanonikus `6.2.1` helyett.
 *      Vagyis a `TRK-910-006` (CONSENT_CLIENT_LIB_OUTDATED) őr SOHA nem tüzelhet:
 *      a mérőműszer maga vak.
 *
 * Ez a szkript a sodródást MÉRHETŐVÉ teszi: minden terjesztendő fájlról
 * tartalom-hash készül, a verzióval együtt. Innentől egy bemásolt példányról
 * eldönthető, MELYIK kiadásból származik, és MELYIK fájlban tér el tőle.
 *
 * ── Miért nem sima `npm publish` ─────────────────────────────────────────────
 * A csomag `private: true`, és a site-ok külön repók, amiket a Cloudflare
 * Workers Builds épít. Egy privát registry minden site build-környezetébe
 * tokent kívánna. A manifeszt ennél olcsóbb ELSŐ lépcső: nem váltja ki a
 * másolást, de auditálhatóvá teszi — és ez az, ami ma teljesen hiányzik.
 *
 * Használat:
 *   node scripts/gen-dist-manifest.mjs            # megírja a manifesztet
 *   node scripts/gen-dist-manifest.mjs --check    # CI: szinkronban van-e
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'soborbo-tracking');
const MANIFEST = path.join(PKG_DIR, 'dist-manifest.json');

/**
 * A TERJESZTENDŐ fájlkészlet — pontosan az, amit az INSTALL.md bemásoltat.
 *
 * A tesztek, a fixture-ök és a generátorok SZÁNDÉKOSAN nincsenek benne: azok a
 * csomag fejlesztéséhez kellenek, nem a site futásához. Ha egy site mégis
 * átmásolja őket, az `unknown_extra`-ként fog megjelenni a drift-riportban —
 * nem hibaként, de láthatóan.
 */
export const DISTRIBUTED = [
  { dir: 'lib', exts: ['.ts'], role: 'browser' },
  { dir: 'components', exts: ['.astro'], role: 'browser' },
  { dir: 'server/backend', exts: ['.ts'], role: 'backend' }
];

/** A csomag-fejlesztéshez tartozó fájlok — sosem kerülnek site-ra. */
const EXCLUDE_RE = /\.(test|spec)\.[tj]s$/;

function walk(dir, exts, acc = [], base = dir) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, exts, acc, base);
    } else if (exts.some((e) => entry.name.endsWith(e)) && !EXCLUDE_RE.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Tartalom-hash. A sorvég-normalizálás NEM kozmetika: a repót Windowson és
 * Linuxon is szerkesztjük (`core.autocrlf`), és egy CRLF↔LF különbség
 * ÖNMAGÁBAN driftnek látszana — mire a riport megtanulná, hogy mindent
 * pirosnak mutat, senki nem nézné többé. A tartalmi eltérés így marad az
 * egyetlen jel.
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

export function hashContent(text) {
  return crypto.createHash('sha256').update(normalizeEol(text), 'utf8').digest('hex');
}

export function buildManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const files = {};
  for (const group of DISTRIBUTED) {
    const abs = path.join(PKG_DIR, group.dir);
    for (const file of walk(abs, group.exts)) {
      const rel = path.relative(PKG_DIR, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      files[rel] = {
        sha256: hashContent(text),
        // A méret is NORMALIZÁLT tartalomból számol, nem `statSync`-ből. A
        // lemezes méret Windowson (CRLF) nagyobb, mint Linuxon (LF) — a
        // manifeszt így platformonként MÁS lett volna, és a CI ezt driftnek
        // látta (pontosan így is bukott először). A hash mit sem ért volna, ha
        // mellette egy nem-normalizált mező visszahozza ugyanazt a csapdát.
        bytes: Buffer.byteLength(normalizeEol(text), 'utf8'),
        role: group.role
      };
    }
  }
  return {
    _comment:
      'GENERÁLT — ne szerkeszd kézzel. Forrás: scripts/gen-dist-manifest.mjs. ' +
      'A `version` a package.json-é; a hash-ek sorvég-normalizáltak (CRLF→LF).',
    name: pkg.name,
    version: pkg.version,
    file_count: Object.keys(files).length,
    files
  };
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gen-dist-manifest.mjs')) {
  const manifest = buildManifest();
  const next = serialize(manifest);

  if (process.argv.includes('--check')) {
    if (!fs.existsSync(MANIFEST)) {
      console.error('DIST_MANIFEST_MISSING — futtasd: node scripts/gen-dist-manifest.mjs');
      process.exit(1);
    }
    const current = fs.readFileSync(MANIFEST, 'utf8');
    if (current.replace(/\r\n/g, '\n') !== next) {
      console.error('DIST_MANIFEST_STALE — a csomag tartalma változott, a manifeszt nem.');
      console.error('Futtasd: node scripts/gen-dist-manifest.mjs');
      process.exit(1);
    }
    console.log(`✅ DIST_MANIFEST_OK — ${manifest.name}@${manifest.version}, ${manifest.file_count} terjesztett fájl.`);
  } else {
    fs.writeFileSync(MANIFEST, next, 'utf8');
    console.log(`✅ dist-manifest.json megírva — ${manifest.name}@${manifest.version}, ${manifest.file_count} fájl.`);
  }
}
