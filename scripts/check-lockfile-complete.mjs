#!/usr/bin/env node
/**
 * Lockfile-teljesség őr — a Windows↔Linux csapda ellen. KÉT SZINTEN.
 *
 * ── Mit mérünk ───────────────────────────────────────────────────────────────
 * A WINDOWSON futtatott `npm install|update` kipucolja a lockfile-ból a más
 * platformra való optional ágakat (`@emnapi/*`, `@esbuild/linux-*`, `@rollup/*`,
 * `@img/sharp-*`), miközben a Linux-builder ideal-tree-je továbbra is hivatkozik
 * rájuk. Ott az `npm ci` EUSAGE-dzsel bukik ("Missing: @emnapi/runtime@… from lock
 * file") — a fejlesztő gépén viszont MINDEN zöld, a `npm ci --dry-run` is.
 *
 * ── Két szint, és miért nem luxus a második ──────────────────────────────────
 *   1. NÉV-FELOLDÁS — minden deklarált függőség megtalálható-e a lockon belül, a
 *      Node felfelé-kereső feloldásával. `node_modules` NÉLKÜL is fut, egy
 *      másodperc alatt. Ez a szint elég a fenti klasszikus csapdához.
 *   2. VERZIÓ-EGYEZÉS — a megtalált bejegyzés verziója KIELÉGÍTI-e a range-et.
 *      Ehhez `semver` kell a telepített fából, ezért csak `npm ci` UTÁN fut.
 *
 * A 2. szint egy VALÓDI esetből jött (Beautyflow, 2026-08-31): a lock kézi
 * foltozásakor előállt egy állapot, ahol `@emnapi/core@1.11.1` pontosan
 * `wasi-threads@1.2.2`-t követelt, a lockban viszont 1.2.3 volt — az 1. szint ezt
 * ZÖLDNEK látta, az `npm ci` mégis bukott. Ezért van a `--require-semver`: ahol a
 * 2. szintnek futnia KELL, ott a hiánya HIBA, nem csendes visszaesés.
 *
 * ── Bizonyíték, hogy az 1. szint is dolgozik ─────────────────────────────────
 * 2026-09-08: két flotta-repó (femkeriteslechu, jamesdunbar) Cloudflare-buildje
 * halt meg az install lépésnél, kimenet nélkül. Az akkori lockfile-jaikra ez a
 * szkript 3, illetve 5 feloldhatatlan függőséget jelentett — másodpercek alatt,
 * Windowson. A képesség tehát megvolt; azokban a repókban nem volt BEKÖTVE.
 *
 * Használat:
 *   node scripts/check-lockfile-complete.mjs [lockfile] [--require-semver]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const requireSemver = args.includes('--require-semver');
const lockPath = args.find((a) => !a.startsWith('--')) ?? 'package-lock.json';

const pkgs = JSON.parse(readFileSync(lockPath, 'utf8')).packages ?? {};

let semver = null;
try {
  semver = createRequire(`${process.cwd()}/x.js`)('semver');
} catch {
  if (requireSemver) {
    console.error(`check-lockfile: a semver nem érhető el, pedig --require-semver aktív.`);
    console.error('Futtasd `npm ci` UTÁN, hogy a telepített fából feloldható legyen.');
    process.exit(2);
  }
}

/** Node-feloldás: a fa-útvonalon felfelé keressük a `node_modules/<név>`-et. */
function resolveEntry(from, name) {
  let dir = from;
  for (;;) {
    const hit = pkgs[`${dir ? dir + '/' : ''}node_modules/${name}`];
    if (hit) return hit;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i === -1 ? '' : dir.slice(0, i);
  }
}

const missing = [];
const mismatched = [];
for (const [key, entry] of Object.entries(pkgs)) {
  const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
  for (const [dep, range] of Object.entries(deps)) {
    const who = key.replace('node_modules/', '') || '<root>';
    const target = resolveEntry(key, dep);
    if (!target) { missing.push(`${who} → ${dep}@${range}`); continue; }
    if (!semver || !target.version) continue;
    // A nem-semver hivatkozásokat (alias, file:, git:) nem a semver dönti el.
    if (/^(?:npm:|file:|link:|git|github:|https?:)/.test(range)) continue;
    if (!semver.validRange(range)) continue;
    if (!semver.satisfies(target.version, range, { includePrerelease: true })) {
      mismatched.push(`${who} → ${dep}@${range}  (a lockban: ${target.version})`);
    }
  }
}

const mode = semver ? 'név + verzió' : 'CSAK név (semver nem érhető el)';
if (!missing.length && !mismatched.length) {
  console.log(`check-lockfile: OK — ${Object.keys(pkgs).length} bejegyzés, ${mode}.`);
  process.exit(0);
}
if (missing.length) {
  console.error(`check-lockfile: ${missing.length} FELOLDHATATLAN függőség a ${lockPath}-ban:`);
  for (const m of missing.slice(0, 20)) console.error('  -', m);
  console.error('\nEz Linuxon `npm ci` hibát ad (EUSAGE / "Missing … from lock file").');
  console.error('Ok: WINDOWSON futtatott npm install/update kipucolta a más-platformos ágakat.');
  console.error('Javítás: a lockot LINUXON kell újragenerálni (`npm install --package-lock-only`) —');
  console.error('egy újabb Windows-os `npm install` ismét kiütné ezeket az ágakat.');
}
if (mismatched.length) {
  console.error(`check-lockfile: ${mismatched.length} VERZIÓ-ÜTKÖZÉS a ${lockPath}-ban:`);
  for (const m of mismatched.slice(0, 20)) console.error('  -', m);
}
process.exit(1);
