#!/usr/bin/env node
/**
 * Contract sync-guard (F1-4) — a vendored `src/events.json` és a deklarált hash őre.
 *
 * MIÉRT: az `events.json` kanonikus otthona a `Soborbo/claudeskills` repo
 * (`soborbo-tracking/events.json`); ez a fájl itt VENDORED MÁSOLAT. Egy kézzel
 * beleírt sor itt némán szétvinné a két repót, és a drift csak akkor derülne ki,
 * amikor egy event már rossz néven megy ki egy hirdetési platformra.
 *
 * A HASH DETERMINISZTIKUS — kizárólag a *normalizált szerződéstartalomból* képződik:
 *   - az objektum-kulcsok rekurzívan rendezve  → a kulcssorrend nem számít
 *   - az események `name` szerint rendezve     → a tömb-sorrend nem számít
 *   - `undefined` értékű kulcsok eldobva
 *   - kompakt szerializálás                    → a formázás/behúzás nem számít
 * NEM bemenete a `generated_at`, a `source_commit` és a fájlformázás — különben
 * minden build „driftet" jelentene (a terv F1-4 kikötése).
 *
 * Használat:
 *   node scripts/contract-hash.mjs            # kiírja a jelenlegi hash-t
 *   node scripts/contract-hash.mjs --check    # összeveti a lockkal (CI; hibán exit 1)
 *   node scripts/contract-hash.mjs --update   # ÚJRAÍRJA a lockot (szándékos frissítés)
 *
 * Az `--update` SOHA ne fusson automatikusan CI-ben: az elfedné pontosan azt a
 * driftet, amit ez a guard észlelni hivatott.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH = join(ROOT, 'src', 'events.json');
export const LOCK_PATH = join(ROOT, 'src', 'events.contract.json');

/** Rekurzív kulcs-rendezés — a JSON-kulcssorrend nem lehet hash-bemenet. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = canonicalize(value[key]);
    if (v !== undefined) out[key] = v; // az undefined nem szerződéstartalom
  }
  return out;
}

/**
 * A szerződés normalizált alakja. Az eseménylista HALMAZ, nem sorozat, ezért
 * `name` szerint rendezzük: egy puszta átrendezés nem jelent szerződésváltozást.
 * (Ha valaha sorrendfüggő lesz a lista, EZT a döntést kell először visszavonni.)
 */
export function normalizeContract(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('events.json: tömböt vártam a gyökérben');
  }
  const sorted = [...parsed].sort((a, b) => String(a?.name).localeCompare(String(b?.name)));
  return JSON.stringify(canonicalize(sorted));
}

/** `sha256:<hex>` a normalizált tartalomból. */
export function contractHash(raw) {
  return `sha256:${createHash('sha256').update(normalizeContract(raw), 'utf8').digest('hex')}`;
}

export function readContractHash() {
  return contractHash(readFileSync(CONTRACT_PATH, 'utf8'));
}

export function readLock() {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const mode = process.argv[2];
  const actual = readContractHash();

  if (mode === '--update') {
    const lock = readLock();
    const previous = lock.contract_hash;
    lock.contract_hash = actual;
    lock.generated_at = new Date().toISOString();
    writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(previous === actual ? `változatlan: ${actual}` : `frissítve:\n  ${previous}\n→ ${actual}`);
    console.log('FIGYELEM: a source_commit mezőt KÉZZEL állítsd a claudeskills commitjára.');
  } else if (mode === '--check') {
    const lock = readLock();
    if (lock.contract_hash !== actual) {
      console.error('CONTRACT DRIFT — a vendored src/events.json nem egyezik a deklarált hash-sel.');
      console.error(`  deklarált: ${lock.contract_hash}`);
      console.error(`  tényleges: ${actual}`);
      console.error('');
      console.error('Ha a változtatás SZÁNDÉKOS: előbb a kanonikus repóban (Soborbo/claudeskills,');
      console.error('soborbo-tracking/events.json) módosíts, hozd át ide, majd futtasd:');
      console.error('  node scripts/contract-hash.mjs --update');
      console.error('és állítsd a source_commit-ot a claudeskills commitjára.');
      process.exit(1);
    }
    console.log(`contract OK: ${actual}`);
  } else {
    console.log(actual);
  }
}
