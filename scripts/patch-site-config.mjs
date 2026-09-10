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

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ALLOW_TEST_EVENT_CODE = argv.includes('--allow-test-event-code');
const [hostname, patchRaw] = argv.filter((a) => !a.startsWith('--'));
if (!hostname || !patchRaw) {
  console.error(
    'usage: patch-site-config.mjs <hostname> <json-patch> [--dry-run] [--allow-test-event-code]'
  );
  process.exit(1);
}

/**
 * §17-KAPU — a `test_event_code` NEM mehet KV-be.
 *
 * A site-config edge-cache-elt (`cacheTtl=300s`), ezért egy bent felejtett
 * teszt-kód a cache-ablakban VALÓDI konverziókat terel a Meta Test streambe (ez
 * ELŐFORDULT, kétszer). A helyes út a per-request `test_event_code`, amit csak
 * hitelesített szerver-hívótól fogadunk el.
 *
 * A törlés (`null`) SZÁNDÉKOSAN engedett: ez a script az az eszköz, amivel egy
 * bent maradt kódot ki lehet venni.
 */
function assertNoTestEventCode(patch) {
  const code = patch?.meta?.test_event_code;
  if (code === undefined || code === null) return;
  if (ALLOW_TEST_EVENT_CODE) {
    console.warn(
      '⚠️  test_event_code KV-be írása ENGEDÉLYEZVE (--allow-test-event-code).\n' +
        '    A config edge-cache-elt (300s): a cache-ablakban VALÓDI konverziók\n' +
        '    mehetnek a Meta Test streambe. Vedd ki, amint végeztél.'
    );
    return;
  }
  console.error(
    '\n⛔ ELUTASÍTVA — a patch `meta.test_event_code`-ot írna a KV-be (CLAUDE.md 17.).\n\n' +
      '   MIÉRT: a site-config edge-cache-elt (cacheTtl=300s). A beírás utáni ~5 percben\n' +
      '   a VALÓDI konverziók a Meta TEST streambe mennek (néma ROAS-kiesés), a kivétel\n' +
      '   utáni ~5 percben pedig a teszt-event a PRODUCTION streambe. Mindkettő megtörtént.\n\n' +
      '   HELYETTE: küldd a `test_event_code`-ot a KÉRÉS body-jában a\n' +
      '   /api/event/conversion-server végpontra (per-request, determinisztikus,\n' +
      '   élő configot nem érint).\n\n' +
      '   Ha tényleg ezt akarod: --allow-test-event-code\n'
  );
  process.exit(2);
}

/**
 * Azok a mezők, amiknek a TÖRLÉSE (`null`) csendes üzemzavart okoz. A patch
 * `null`-ja mezőt TÖRÖL — egy elgépelt kulcsnév így észrevétlenül kikapcsolhatja
 * a consent-kaput vagy a szerver-ingress hitelesítését.
 */
const DESTRUCTIVE_NULLS = ['require_consent', 'crm_token_sha256', 'site_id', 'country_code', 'currency'];

function warnDestructiveNulls(patch) {
  const hits = DESTRUCTIVE_NULLS.filter((k) => patch?.[k] === null);
  if (hits.length === 0) return;
  console.warn(
    `\n⚠️  A patch TÖRÖLNI fogja: ${hits.join(', ')}\n` +
      '    A `require_consent` törlése fail-OPEN-re állítja a site-ot (GDPR),\n' +
      '    a `crm_token_sha256` törlése kizárja a szerver-ingresst (401 minden\n' +
      '    high-value konverzióra). Ha nem ezt akartad, szakítsd meg most.\n'
  );
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
assertNoTestEventCode(patch);
warnDestructiveNulls(patch);

// Rekurzív merge (scripts/deep-merge.mjs): egy nested map-be írt kulcs NEM cseréli
// le a map többi elemét — lásd ott, miért.
const merged = deepMerge(current, patch);

// A MERGE EREDMÉNYÉT is ellenőrizzük, nem csak a patchet: egy `meta` blokk
// cseréje is behozhat teszt-kódot, anélkül hogy a patchben a kulcs látszana.
assertNoTestEventCode(merged);

if (DRY_RUN) {
  console.log('— DRY RUN: a KV NEM módosul —');
  console.log(JSON.stringify(safe(merged), null, 2));
  process.exit(0);
}

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
function safe(c) {
  return {
  site_id: c.site_id,
  crm_token_sha256: c.crm_token_sha256 ? c.crm_token_sha256.slice(0, 8) + '…' : undefined,
  'meta.pixel_id': c.meta?.pixel_id,
  'meta.test_event_code': c.meta?.test_event_code ?? '(none)',
  'meta.access_token': c.meta?.access_token ? '[set]' : '[MISSING]',
  'ga4.measurement_id': c.ga4?.measurement_id ?? '(none)',
    'gads.customer_id': c.gads?.customer_id ?? '(none)'
  };
}
console.log(`✅ ${hostname}`, JSON.stringify(safe(merged)));
