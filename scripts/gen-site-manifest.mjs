#!/usr/bin/env node
/**
 * gen-site-manifest.mjs — a `src/site-manifest.json` (F4-1) generátora.
 *
 * A LIVE KV site-configokból secret-safe fingerprinteket számol, és kiírja a
 * manifestet, amit a napi digest drift-checkje (src/lib/site-manifest.ts) a LIVE
 * KV-vel összevet. A `canonicalize` + `redactSecrets` a `src/lib/site-manifest.ts`
 * BÁJTPONTOS tükre (node:crypto sync sha256; a Worker Web Crypto-t használ, de a
 * sha256 hex azonos). A paritást a `tests/site-manifest.test.ts` őrzi.
 *
 * Használat (a configok stdin-en, `{ "<host>": <config>, ... }` JSON-map):
 *   NS=edd34e28eee847c09c26f9d9e3ea04ab
 *   node scripts/fetch-kv-configs.mjs $NS | node scripts/gen-site-manifest.mjs --commit $(git rev-parse HEAD) > src/site-manifest.json
 *
 * VAGY kézzel: egy `{ "host": {..config..} }` JSON-t adj stdin-re. A titkokat
 * (`meta.access_token`, `ga4.api_secret`) a generátor a saját sha256-jukkal
 * helyettesíti — a manifestbe SOHA nem kerül plaintext titok.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

// ── src/lib/site-manifest.ts tükre (BÁJTPONTOSAN egyeznie kell) ───────────────
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
  return `{${entries.join(',')}}`;
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function redactSecrets(config) {
  if (config === null || typeof config !== 'object') return config;
  const c = JSON.parse(JSON.stringify(config));
  if (c.meta && typeof c.meta.access_token === 'string' && c.meta.access_token) {
    c.meta.access_token = `sha256:${sha256(c.meta.access_token)}`;
  }
  if (c.ga4 && typeof c.ga4.api_secret === 'string' && c.ga4.api_secret) {
    c.ga4.api_secret = `sha256:${sha256(c.ga4.api_secret)}`;
  }
  return c;
}

export function fingerprintConfig(config) {
  return `sha256:${sha256(canonicalize(redactSecrets(config)))}`;
}

function parseArgs(args) {
  const out = { commit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit') out.commit = args[++i];
    else if (args[i] === '--input') out.input = args[++i];
  }
  return out;
}

// A script akkor is importálható (a paritás-teszt a fenti függvényeket használja),
// ha nem CLI-ként fut. CLI-futásnál: stdin/`--input` → manifest a stdout-ra.
const isMain = argv[1] && argv[1].replace(/\\/g, '/').endsWith('gen-site-manifest.mjs');
if (isMain) {
  const args = parseArgs(argv.slice(2));
  const raw = args.input ? readFileSync(args.input, 'utf8') : readFileSync(0, 'utf8');
  const configs = JSON.parse(raw);
  const sites = {};
  for (const host of Object.keys(configs).sort()) {
    sites[host] = fingerprintConfig(configs[host]);
  }
  const manifest = {
    ...(args.commit ? { source_commit: args.commit } : {}),
    sites
  };
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
