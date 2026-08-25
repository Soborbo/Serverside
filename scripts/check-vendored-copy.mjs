#!/usr/bin/env node
/**
 * F9 · P4 — A BEMÁSOLT PÉLDÁNY DRIFT-RIPORTJA.
 *
 * ── A probléma, amit mér ─────────────────────────────────────────────────────
 * A csomagot ma bemásolással telepítjük a site repójába. A másolat attól kezdve
 * SODRÓDIK, és eddig semmi nem vette észre — a `client_lib_version` telemetria
 * pedig, ami erre való lenne, az élő ledgerben (2026-08-25) **1392 receiptből
 * 1391-en NULL**. Vagyis a flotta verzió-állapotáról ma NULLA gépi tudásunk van.
 *
 * Ez a szkript ezt fordítja meg: egy site vendorolt könyvtárát összeveti a
 * kiadás `dist-manifest.json`-jával, és fájlonként megmondja, mi a helyzet.
 *
 * ── Amit SZÁNDÉKOSAN nem csinál ──────────────────────────────────────────────
 * Nem javít, nem másol, nem ítélkezik arról, hogy egy eltérés jogos-e. Egy site
 * indokoltan tarthat helyi módosítást — de akkor is TUDNI kell róla. A kimenet
 * bizonyíték, nem verdikt.
 *
 * Használat:
 *   node scripts/check-vendored-copy.mjs <site-könyvtár> [--json] [--paths=lib/,server/]
 *
 * Példa:
 *   node scripts/check-vendored-copy.mjs d:/painlessremovals/src/lib/tracking
 *   node scripts/check-vendored-copy.mjs <dir> --paths=lib/
 *
 * ── A `--paths` és miért NEM lyuk a kapun ────────────────────────────────────
 * Egy site JOGGAL vendorolhatja a csomag EGY RÉSZÉT: a painless React-alapú, az
 * Astro-komponensekre nincs szüksége. Enélkül a riport 8 „hiányzó" komponenst
 * jelentene olyasmiről, amit a site sosem akart — és egy örökké piros riportot
 * két hét alatt megtanulnánk figyelmen kívül hagyni.
 *
 * A szűrő ezért EXPLICIT és SZŰKÍTŐ: a hívó KIMONDJA, mit vendorolt, és CSAK
 * arra kap ítéletet. A kimenet mindig kiírja, hány fájl maradt a vizsgálaton
 * kívül — a szűrés így látható marad, nem tünteti el a különbséget.
 *
 * Kilépési kód: 0, ha nincs `drifted` vagy `missing` fájl; különben 1.
 * (A `unknown_extra` NEM buktat: az lehet a site saját kódja is.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashContent } from './gen-dist-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'soborbo-tracking', 'dist-manifest.json');

/**
 * A vendorolt elrendezés LAPOS: az INSTALL.md a `lib/`-et és a
 * `server/backend/`-et is egy `src/lib/tracking/` alá másoltatja. Ezért a
 * manifeszt `lib/foo.ts` bejegyzését a példányban `foo.ts`-ként IS keressük.
 */
function candidatePaths(manifestPath) {
  const flat = manifestPath.split('/').pop();
  return [manifestPath, flat];
}

/**
 * @param {string} vendorDir
 * @param {object} manifest
 * @returns {{version: string, rows: Array<object>, summary: Record<string, number>, extras: string[]}}
 */
export function compareVendoredCopy(
  vendorDir,
  manifest,
  readdir = walkFiles,
  read = (p) => fs.readFileSync(p, 'utf8'),
  pathPrefixes = null
) {
  const present = new Set(readdir(vendorDir));
  const rows = [];
  const matched = new Set();

  const inScope = (rel) => pathPrefixes === null || pathPrefixes.some((prefix) => rel.startsWith(prefix));
  const outOfScope = Object.keys(manifest.files).filter((rel) => !inScope(rel));

  for (const [rel, meta] of Object.entries(manifest.files)) {
    if (!inScope(rel)) continue;
    let hit = null;
    for (const cand of candidatePaths(rel)) {
      if (present.has(cand)) {
        hit = cand;
        break;
      }
    }
    if (!hit) {
      rows.push({ file: rel, status: 'missing', role: meta.role });
      continue;
    }
    matched.add(hit);
    const actual = hashContent(read(path.join(vendorDir, hit)));
    rows.push({
      file: rel,
      found_as: hit,
      role: meta.role,
      status: actual === meta.sha256 ? 'identical' : 'drifted'
    });
  }

  const extras = [...present].filter((p) => !matched.has(p)).sort();
  const summary = { identical: 0, drifted: 0, missing: 0 };
  for (const r of rows) summary[r.status] += 1;
  return {
    version: manifest.version,
    rows,
    summary,
    extras,
    // A szűrés MINDIG látszik: enélkül egy szűk `--paths` úgy adna CLEAN-t,
    // hogy közben a csomag felét meg sem néztük.
    out_of_scope: outOfScope
  };
}

function walkFiles(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkFiles(p, base, acc);
    } else if (/\.(ts|astro)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
      acc.push(path.relative(base, p).split(path.sep).join('/'));
    }
  }
  return acc;
}

/**
 * Ember-olvasható ítélet a számokból. A `fork` szó SZÁNDÉKOSAN erős: ha a
 * kiadás fájljainak többsége hiányzik, az nem „elavult másolat", hanem külön
 * implementáció — és a kettő gyökeresen más migrációt kíván.
 */
export function verdict(result) {
  const total = result.rows.length;
  const { identical, drifted, missing } = result.summary;
  if (missing >= total / 2) {
    return {
      level: 'FORK',
      text:
        `A kiadás ${total} fájljából ${missing} egyáltalán NINCS MEG ebben a példányban. ` +
        'Ez nem elavult másolat, hanem ÖNÁLLÓ implementáció — a migráció nem frissítés, hanem csere.'
    };
  }
  if (drifted === 0 && missing === 0) {
    return { level: 'CLEAN', text: `A példány bitre a ${result.version} kiadás (${identical} fájl).` };
  }
  return {
    level: 'DRIFTED',
    text: `${drifted} fájl eltér, ${missing} hiányzik a ${result.version} kiadáshoz képest.`
  };
}

if (process.argv[1]?.endsWith('check-vendored-copy.mjs')) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Használat: node scripts/check-vendored-copy.mjs <site-könyvtár> [--json]');
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    console.error(`A könyvtár nem létezik: ${dir}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const pathsArg = process.argv.find((a) => a.startsWith('--paths='));
  const pathPrefixes = pathsArg
    ? pathsArg
        .slice('--paths='.length)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : null;
  const result = compareVendoredCopy(path.resolve(dir), manifest, undefined, undefined, pathPrefixes);
  const v = verdict(result);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ dir, verdict: v, ...result }, null, 2));
  } else {
    console.log(`\n── Vendorolt példány: ${dir}`);
    console.log(`   Kiadás: ${manifest.name}@${manifest.version}`);
    if (pathPrefixes) {
      console.log(
        `   Szűkítve: ${pathPrefixes.join(', ')} — ${result.out_of_scope.length} fájl a vizsgálaton KÍVÜL`
      );
    }
    console.log(`   ${v.level} — ${v.text}\n`);
    for (const r of result.rows) {
      const mark = { identical: '  ok  ', drifted: ' DRIFT', missing: 'HIÁNYZ' }[r.status];
      if (r.status !== 'identical') console.log(`   ${mark}  ${r.file}${r.found_as && r.found_as !== r.file ? ` (mint ${r.found_as})` : ''}`);
    }
    if (result.extras.length > 0) {
      console.log(`\n   A példányban van, a kiadásban nincs (${result.extras.length}):`);
      for (const e of result.extras.slice(0, 30)) console.log(`     + ${e}`);
    }
    console.log(
      `\n   Összesen: ${result.summary.identical} azonos · ${result.summary.drifted} eltér · ` +
        `${result.summary.missing} hiányzik · ${result.extras.length} idegen\n`
    );
  }
  process.exit(result.summary.drifted + result.summary.missing > 0 ? 1 : 0);
}
