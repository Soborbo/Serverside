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

const [hostname, patchRaw] = process.argv.slice(2);
if (!hostname || !patchRaw) {
  console.error('usage: patch-site-config.mjs <hostname> <json-patch>');
  process.exit(1);
}

const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', shell: true });

const current = JSON.parse(
  wrangler(['kv', 'key', 'get', '--binding', 'SITE_CONFIG', '--remote', hostname])
);
const patch = JSON.parse(patchRaw);

const merged = { ...current };
for (const [k, v] of Object.entries(patch)) {
  if (v === null) {
    delete merged[k];
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    merged[k] = { ...(current[k] ?? {}) };
    for (const [ik, iv] of Object.entries(v)) {
      if (iv === null) delete merged[k][ik];
      else merged[k][ik] = iv;
    }
  } else {
    merged[k] = v;
  }
}

wrangler([
  'kv',
  'key',
  'put',
  '--binding',
  'SITE_CONFIG',
  '--remote',
  hostname,
  JSON.stringify(JSON.stringify(merged))
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
