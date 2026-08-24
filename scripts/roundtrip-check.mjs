#!/usr/bin/env node
/**
 * roundtrip-check.mjs — a generátor LOSSLESS-kontraktusának futtatása ÉLŐ KV
 * configok ellen (vNext P0.2 DoD: „a 15 élő KV-config round-trip-futtatása zero-diff").
 *
 * A kontraktus:
 *     parse(live_config) → generate → parse(generated) → semantic_equal(live_config)
 *
 * Bukásnál a kimenet `GENERATOR_ROUNDTRIP_FAIL`, exit 1, és HOSTONKÉNT kilistázza,
 * MELYIK mező veszett el vagy változott. A „DROPPED" sorok a veszélyesek: azt
 * jelentik, hogy ennek a site-nak a configját újragenerálva a mező eltűnne a
 * KV-ből — pontosan az a néma visszabillentés (sbo consent-pilot → CookieYes),
 * ami miatt ez a kapu megépült.
 *
 * Használat (a fetch-kv-configs.mjs kimeneti alakját várja: { "<host>": <config> }):
 *   NS=edd34e28eee847c09c26f9d9e3ea04ab
 *   node scripts/fetch-kv-configs.mjs $NS | node scripts/roundtrip-check.mjs
 *   node scripts/roundtrip-check.mjs --input /tmp/kv-dump.json
 *
 * BIZTONSÁG: a bemenet NYERS configokat tartalmaz (meta.access_token,
 * ga4.api_secret plaintextben). Ez a script SOHA nem írja ki a mezők ÉRTÉKÉT
 * titok-mezőknél — csak a mező nevét és azt, hogy eltért-e. Ne irányítsd fájlba a
 * bemenetet, és ne commitold.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toGeneratorInput, semanticDiff } from './lib/site-config.mjs';

const GENERATOR = fileURLToPath(new URL('./generate-site.mjs', import.meta.url));

// Titok-mezők: a diffben CSAK a tény jelenik meg, az érték soha.
const SECRET_PATHS = [/\/meta\/access_token$/, /\/ga4\/api_secret$/, /\/crm_token/];

function redact(diff) {
  return SECRET_PATHS.some((re) => re.test(diff.split(':')[0]))
    ? `${diff.split(':')[0]}: <redacted> MISMATCH`
    : diff;
}

function parseArgs(args) {
  const out = { input: null };
  for (let i = 0; i < args.length; i++) if (args[i] === '--input') out.input = args[++i];
  return out;
}

function main() {
  const args = parseArgs(argv.slice(2));
  let dump;
  try {
    dump = JSON.parse(readFileSync(args.input ?? 0, 'utf8'));
  } catch (e) {
    stderr.write(`Hibás JSON bemenet: ${e.message}\n`);
    exit(1);
  }
  if (typeof dump !== 'object' || dump === null || Array.isArray(dump)) {
    stderr.write('A bemenet { "<host>": <site_config> } alakú map kell legyen.\n');
    exit(1);
  }

  // Egy site több hostnéven él (apex + www) UGYANAZZAL a configgal. A generátor a
  // hostnév-listát egyben kapja, ezért site_id szerint csoportosítunk — különben a
  // routes/kv-put oldal hamisan „hiányzó www"-t mutatna.
  const bySite = new Map();
  for (const [host, config] of Object.entries(dump)) {
    const key = config?.site_id ?? `?${host}`;
    if (!bySite.has(key)) bySite.set(key, { hosts: [], config });
    bySite.get(key).hosts.push(host);
  }

  const workdir = mkdtempSync(join(tmpdir(), 'sbo-roundtrip-'));
  const failures = [];
  let checked = 0;

  try {
    for (const [siteId, { hosts, config }] of [...bySite.entries()].sort()) {
      checked++;
      const input = toGeneratorInput(config, hosts.sort());
      const inputPath = join(workdir, `${siteId.replace(/[^a-z0-9_-]/gi, '_')}.json`);
      writeFileSync(inputPath, JSON.stringify(input));

      let generated;
      try {
        // A generátor stderr-je (warningok) itt szándékosan elnyelt: egy legacy config
        // warningja nem round-trip-hiba. A HIBÁK exit-kóddal jönnek.
        const stdoutText = execFileSync(
          process.execPath,
          [GENERATOR, '--input', inputPath, '--out', join(workdir, 'out', siteId)],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        void stdoutText;
        generated = JSON.parse(
          readFileSync(join(workdir, 'out', siteId, 'site-config.json'), 'utf8')
        );
      } catch (e) {
        failures.push({ siteId, hosts, diffs: [`GENERATOR EXIT ${e.status ?? '?'}: ${String(e.stderr ?? e.message).trim()}`] });
        continue;
      }

      const diffs = semanticDiff(config, generated).map(redact);
      if (diffs.length) failures.push({ siteId, hosts, diffs });
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  if (failures.length === 0) {
    stdout.write(`✅ GENERATOR_ROUNDTRIP_OK — ${checked} site (${Object.keys(dump).length} hostnév) zero-diff.\n`);
    return;
  }

  stdout.write('GENERATOR_ROUNDTRIP_FAIL\n\n');
  for (const f of failures) {
    stdout.write(`## ${f.siteId} (${f.hosts.join(', ')})\n`);
    for (const d of f.diffs) stdout.write(`  - ${d}\n`);
    stdout.write('\n');
  }
  stdout.write(
    `${failures.length}/${checked} site NEM round-trip-tiszta. A "DROPPED" sorok élesben azt jelentik:\n` +
      'ennek a site-nak a configját újragenerálva a mező ELTŰNNE a KV-ből.\n' +
      'Javítás: vedd fel a mezőt a soborbo-tracking/server/site-config.schema.json properties-be.\n'
  );
  exit(1);
}

main();
