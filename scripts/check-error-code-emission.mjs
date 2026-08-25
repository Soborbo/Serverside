#!/usr/bin/env node
/**
 * §15 — „minden error code legalább egy tesztben TÉNYLEGESEN kiváltódik".
 *
 * A `tests/setup/record-error-codes.ts` a suite alatt begyűjti, mely kódok
 * mentek át ténylegesen a `logStructured`-en. Ez a szkript utána összeolvassa
 * a worker-fájlokat, és három dolgot kényszerít ki:
 *
 *  1. RACSNI. A lefedetlen kódok listája egy COMMITOLT alapvonal
 *     (`tests/error-code-emission-baseline.json`). Új lefedetlen kód → BUKÁS.
 *     Ez az egyetlen mechanizmus, ami a hiányt nevesítve tartja anélkül, hogy
 *     vagy hazudna (elhallgatja), vagy örökre pirosat adna (megtanítva az
 *     embert, hogy hagyja figyelmen kívül).
 *
 *  2. A RACSNI CSAK SZŰKÜLHET. Ha egy alapvonalbeli kód MOST már lefedett, a
 *     szkript szintén bukik, és kéri az alapvonal szűkítését. Enélkül a lista
 *     örökre a legrosszabb állapotot konzerválná.
 *
 *  3. §17 — A MÉRÉS SAJÁT HIBÁJA NEM ZÖLD. Ha az emisszió-könyvtár üres vagy
 *     hiányzik, az NEM „nulla hiba": a megfigyelő halt meg. Ilyenkor BUKUNK,
 *     nem gratulálunk magunknak.
 *
 * Használat (a `npm test` UTÁN, mert annak a melléktermékét olvassa):
 *   node --experimental-transform-types scripts/check-error-code-emission.mjs
 *   … --update-baseline   → az alapvonal újraírása (szándékos változásnál)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMISSION_DIR = process.env.ERROR_CODE_EMISSION_DIR ?? path.join(ROOT, '.error-code-emission');
const BASELINE = path.join(ROOT, 'tests', 'error-code-emission-baseline.json');

const { allErrorCodes } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'lib', 'error-codes.ts')).href
);
const { CODE_STATUS } = await import(
  pathToFileURL(path.join(ROOT, 'scripts', 'gen-error-code-table.mjs')).href
);

function readEmitted() {
  if (!fs.existsSync(EMISSION_DIR)) return null;
  const files = fs.readdirSync(EMISSION_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  const seen = new Set();
  for (const f of files) {
    try {
      for (const c of JSON.parse(fs.readFileSync(path.join(EMISSION_DIR, f), 'utf8'))) seen.add(c);
    } catch {
      /* egy sérült worker-fájl nem teheti vakká az egészet — a többi számít */
    }
  }
  return seen;
}

const emitted = readEmitted();

// (3) A megfigyelő halála NEM zöld.
if (emitted === null) {
  console.error('ERROR_CODE_EMISSION_NO_DATA — nincs mérési adat.');
  console.error('Ez NEM „nulla hiba": a megfigyelő nem futott le.');
  console.error('Futtasd előbb: npm test   (a setupFiles hook írja az adatot)');
  process.exit(1);
}

const active = allErrorCodes().filter((c) => !CODE_STATUS[c]);
const uncovered = active.filter((c) => !emitted.has(c)).sort();

if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(
    BASELINE,
    `${JSON.stringify({ _comment: 'GENERÁLT RACSNI — csak szűkülhet. Lásd scripts/check-error-code-emission.mjs', generated_from_active_codes: active.length, uncovered }, null, 2)}\n`,
    'utf8'
  );
  console.log(`✅ alapvonal frissítve — ${uncovered.length} lefedetlen kód / ${active.length} aktív.`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`ERROR_CODE_EMISSION_NO_BASELINE — hiányzik: ${path.relative(ROOT, BASELINE)}`);
  console.error('Futtasd: npm run test && node --experimental-transform-types scripts/check-error-code-emission.mjs --update-baseline');
  process.exit(1);
}

const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE, 'utf8')).uncovered);

// (1) Új lefedetlen kód → bukás.
const newlyUncovered = uncovered.filter((c) => !baseline.has(c));
// (2) A racsni csak szűkülhet.
const nowCovered = [...baseline].filter((c) => !uncovered.includes(c)).sort();

let failed = false;

if (newlyUncovered.length > 0) {
  failed = true;
  console.error('ERROR_CODE_EMISSION_REGRESSION — ÚJ lefedetlen error code:');
  for (const c of newlyUncovered) console.error(`  - ${c}`);
  console.error('Írj hozzá tesztet, ami TÉNYLEGESEN kiváltja, vagy — ha a kód szándékosan');
  console.error('nem aktív — vedd fel a CODE_STATUS regiszterbe indoklással.');
}

if (nowCovered.length > 0) {
  failed = true;
  console.error('ERROR_CODE_EMISSION_BASELINE_STALE — ezek MÁR lefedettek, szűkítsd az alapvonalat:');
  for (const c of nowCovered) console.error(`  - ${c}`);
  console.error('Futtasd: node --experimental-transform-types scripts/check-error-code-emission.mjs --update-baseline');
}

if (failed) process.exit(1);

const covered = active.length - uncovered.length;
const pct = ((covered / active.length) * 100).toFixed(1);
console.log(
  `✅ ERROR_CODE_EMISSION_OK — ${covered}/${active.length} aktív kód (${pct}%) ténylegesen kiváltódik a suite-ban; ` +
    `${uncovered.length} nevesített hiány az alapvonalon, ${Object.keys(CODE_STATUS).length} kód deklaráltan nem aktív.`
);
