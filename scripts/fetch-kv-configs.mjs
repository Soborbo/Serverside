#!/usr/bin/env node
/**
 * fetch-kv-configs.mjs — a LIVE SITE_CONFIG KV összes site-configját egyetlen
 * `{ "<host>": <config>, ... }` JSON-mapbe olvassa a stdout-ra.
 *
 * MIÉRT LÉTEZIK: a `gen-site-manifest.mjs` fejléce 2026-07 óta pontosan ezt a
 * scriptet dokumentálta a manifest-regenerálás első lépéseként — csak épp SOHA nem
 * került be a repóba. Vagyis a site-manifest drift-őr (F4-1) hivatalos frissítési
 * munkafolyamata futtathatatlan volt, és a manifest emiatt 2026-07-22-én
 * megrekedt: a trapezlemezes onboardingja (08-11) és az agykontroll `meta`-blokkja
 * hiányzott belőle, így a napi digest VALÓDI drift nélkül riasztott „config drift"-et.
 * Az a riasztás-fáradtság pont azt a néma config-vesztést fedné el, amiért az őr
 * egyáltalán megépült (lomtalan, 2026-07-15).
 *
 * Használat:
 *   NS=edd34e28eee847c09c26f9d9e3ea04ab
 *   node scripts/fetch-kv-configs.mjs $NS \
 *     | node scripts/gen-site-manifest.mjs --commit $(git rev-parse HEAD) \
 *     > src/site-manifest.json
 *
 * BIZTONSÁG: ez a script NYERS configokat ír a stdout-ra (benne a `meta.access_token`
 * és a `ga4.api_secret` plaintextben) — kizárólag a gen-site-manifest.mjs-be
 * pipe-olva használd, ami a titkokat a saját sha256-jukkal helyettesíti. NE
 * irányítsd fájlba, és ne commitold a kimenetét.
 */

import { execFileSync } from 'node:child_process';
import { argv, exit, stderr, stdout } from 'node:process';

const namespaceId = argv[2];
if (!namespaceId) {
  stderr.write(
    'Usage: node scripts/fetch-kv-configs.mjs <SITE_CONFIG_namespace_id>\n' +
      '  e.g. node scripts/fetch-kv-configs.mjs edd34e28eee847c09c26f9d9e3ea04ab\n'
  );
  exit(1);
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
}

// A `kv key list` lapozott — a wrangler CLI a teljes listát adja vissza egyben,
// de a JSON-parse hibáját külön jelezzük, hogy egy auth-hiba ne „üres flotta"-ként
// olvasódjon (az csendben ÜRES manifestet generálna, ami minden site-ra driftet mond).
let keys;
try {
  keys = JSON.parse(wrangler(['kv', 'key', 'list', '--namespace-id', namespaceId, '--remote']));
} catch (err) {
  stderr.write(`KV key list failed: ${err.message}\n`);
  exit(1);
}
if (!Array.isArray(keys) || keys.length === 0) {
  stderr.write('KV key list returned no keys — refusing to emit an empty manifest input.\n');
  exit(1);
}

const configs = {};
for (const { name } of keys) {
  let raw;
  try {
    raw = wrangler(['kv', 'key', 'get', '--namespace-id', namespaceId, '--remote', name]);
  } catch (err) {
    stderr.write(`KV get failed for ${name}: ${err.message}\n`);
    exit(1);
  }
  try {
    configs[name] = JSON.parse(raw);
  } catch {
    // Egy nem-JSON érték a SITE_CONFIG-ban konfigurációs hiba: hangosan bukunk,
    // nem hagyjuk ki csendben (a kihagyott host a manifestből is kimaradna, és a
    // drift-őr onnantól vakon menne rá).
    stderr.write(`KV value for ${name} is not valid JSON — aborting.\n`);
    exit(1);
  }
}

stdout.write(JSON.stringify(configs, null, 2) + '\n');
