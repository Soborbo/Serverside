#!/usr/bin/env node
/**
 * Read-modify-write egy SITE_CONFIG KV kulcsra, a többi mező megtartásával.
 *
 * Miért nem `kv key put` nyers JSON-nel: a site-config érzékeny mezőket hordoz
 * (meta.access_token, ga4.api_secret). Egy kézzel összerakott put csendben
 * ELDOBHATJA őket — a fan-out utána 401-et kap a Metától, a ledger meg „accepted"-et
 * ír. Ez a script mindig a MEGLÉVŐ configból indul.
 *
 *   node scripts/patch-site-config.mjs <hostname> '<json-patch>'
 *
 * A patch mély-merge-elődik (egy szint mélyen, pl. { "meta": { "pixel_id": … } }).
 * `null` értékkel a mező TÖRLŐDIK (így vehető ki a test_event_code).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deepMerge } from './deep-merge.mjs';

const [hostname, patchRaw] = process.argv.slice(2);
if (!hostname || !patchRaw) {
  console.error('usage: patch-site-config.mjs <hostname> <json-patch>');
  process.exit(1);
}

// Shell NÉLKÜL, a wrangler JS-belépőjét közvetlenül a futó Node-dal hívjuk (mint a
// recover-blocked-events.ts). shell:true mellett a win32 cmd.exe NEM unescape-eli a
// `\"`-t, így a JSON backslash-manglolva, ÉRVÉNYTELENÜL kerülne a KV-be → a worker
// config-parse elhasal (404/500 a tenantnak, §14/§17-osztályú néma korrupció). Node 24
// a `.cmd`-t shell nélkül elutasítja, ezért a wrangler.js-t közvetlenül hívjuk.
const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);
const wrangler = (args) =>
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], { encoding: 'utf8' });

const current = JSON.parse(
  wrangler(['kv', 'key', 'get', '--binding', 'SITE_CONFIG', '--remote', hostname])
);
const patch = JSON.parse(patchRaw);

// Rekurzív merge (scripts/deep-merge.mjs): egy nested map-be írt kulcs NEM cseréli
// le a map többi elemét — lásd ott, miért.
const merged = deepMerge(current, patch);

wrangler([
  'kv',
  'key',
  'put',
  '--binding',
  'SITE_CONFIG',
  '--remote',
  hostname,
  // SINGLE stringify: a KV-érték a JSON-string. Shell nélkül (fent) nincs
  // re-parse, ezért NEM kell (és nem is szabad) duplán stringify-olni.
  JSON.stringify(merged)
]);

// Csak nem-titkos mezőket írunk ki.
const safe = (c) => ({
  site_id: c.site_id,
  crm_token_sha256: c.crm_token_sha256 ? c.crm_token_sha256.slice(0, 8) + '…' : undefined,
  'meta.pixel_id': c.meta?.pixel_id,
  'meta.test_event_code': c.meta?.test_event_code ?? '(none)',
  'meta.access_token': c.meta?.access_token ? '[set]' : '[MISSING]',
  'ga4.measurement_id': c.ga4?.measurement_id ?? '(none)',
  'gads.customer_id': c.gads?.customer_id ?? '(none)'
});
console.log(`✅ ${hostname}`, JSON.stringify(safe(merged)));
