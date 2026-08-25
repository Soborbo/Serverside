#!/usr/bin/env node
/**
 * Lockfile-teljesség őr — a Windows↔Linux csapda ellen.
 *
 * A Windowson futtatott `npm install|update` KIPUCOLJA a lockfile-ból a más
 * platformra való optional ágakat (wasm32/linux), miközben a Linux-builder
 * ideal-tree-je továbbra is hivatkozik rájuk. Az `npm ci` ott EUSAGE-dzsel bukik
 * ("Missing: @emnapi/runtime@… from lock file") — a fejlesztő gépén viszont
 * MINDEN zöld, a `npm ci --dry-run` is. 2026-08-25-én ez két repó CI-ját fogta meg.
 *
 * Amit mérünk: a lockfile-ban minden deklarált függőség FELOLDHATÓ-e a lockon
 * belül, a Node felfelé-kereső feloldásával. Ez pont az a kérdés, amire az
 * `npm ci` is választ vár, csak platform-függetlenül és egy másodperc alatt.
 */
import { readFileSync } from 'node:fs';

const lockPath = process.argv[2] ?? 'package-lock.json';
const pkgs = JSON.parse(readFileSync(lockPath, 'utf8')).packages ?? {};

/** Node-feloldás: a fa-útvonalon felfelé keressük a `node_modules/<név>`-et. */
function resolvable(from, name) {
  let dir = from;
  for (;;) {
    if (pkgs[`${dir ? dir + '/' : ''}node_modules/${name}`]) return true;
    if (!dir) return false;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i === -1 ? '' : dir.slice(0, i);
  }
}

const missing = [];
for (const [key, entry] of Object.entries(pkgs)) {
  const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
  for (const dep of Object.keys(deps)) {
    if (!resolvable(key, dep)) missing.push(`${key.replace('node_modules/', '') || '<root>'} → ${dep}`);
  }
}

if (missing.length === 0) {
  console.log(`check-lockfile: OK — ${Object.keys(pkgs).length} bejegyzés, minden függőség feloldható.`);
  process.exit(0);
}
console.error(`check-lockfile: ${missing.length} FELOLDHATATLAN függőség a ${lockPath}-ban:`);
for (const m of missing.slice(0, 20)) console.error('  -', m);
console.error('\nEz Linuxon `npm ci` hibát ad (EUSAGE / "Missing … from lock file").');
console.error('Ok: Windowson futtatott npm install/update kipucolta a más-platformos ágakat.');
console.error('Javítás: a hiányzó bejegyzések visszapótlása a main lockfile-jából (resolved+integrity),');
console.error('a lock-írás UTOLSÓ lépéseként — egy újabb `npm install` ismét kiütné őket.');
process.exit(1);
