#!/usr/bin/env node
/**
 * check-event-contract.mjs — kanonikus event-szerződés build-guard (§1.3 / §8).
 *
 * Az events.json az EGYETLEN igazságforrás. Ez a script CI-ban ELHASAL (exit 1),
 * ha a forrás belsőleg inkonzisztens, vagy ha egy event-név ütközik egy GA4
 * fenntartott/automatikus névvel (TRK-EVT-002). Így a hibák a CI-ban buknak ki,
 * nem éles forgalomban.
 *
 * Futtatás:  node server/check-event-contract.mjs   (npm run check:events)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENTS_PATH = fileURLToPath(new URL('../src/events.json', import.meta.url));

// GA4 automatikus/fenntartott események — egy kanonikus név SEM ütközhet velük.
const GA4_RESERVED = new Set([
  'scroll', 'form_start', 'form_submit', 'video_start', 'video_progress',
  'video_complete', 'click', 'page_view', 'session_start', 'first_visit',
  'user_engagement', 'first_open'
]);

const KINDS = new Set(['conversion', 'engagement', 'ecommerce', 'offline']);
const MODULES = new Set(['leadgen', 'ecommerce', 'core', 'crm']);
const CHANNELS = new Set(['browser', 'server']);
const FLOWS = new Set(['A', 'B', null]);
const NAME_RE = /^[a-z][a-z0-9_]*$/;

const errors = [];
const fail = (code, msg) => errors.push(`${code}  ${msg}`);

let events;
try {
  events = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
} catch (e) {
  console.error(`TRK-CFG-001  events.json nem olvasható/parse-olható: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(events)) {
  console.error('TRK-CFG-001  events.json gyökere nem tömb');
  process.exit(1);
}

const seenNames = new Set();
const seenLegacy = new Set();
const canonicalNames = new Set(events.map((e) => e && e.name));

for (const e of events) {
  const at = e && e.name ? `(${e.name})` : '(névtelen)';

  // Kötelező mezők + típusok.
  for (const f of ['name', 'kind', 'module', 'ga4_key_event', 'channels', 'provenance', 'description']) {
    if (!(f in e)) fail('TRK-CFG-001', `${at} hiányzó mező: ${f}`);
  }
  if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) {
    fail('TRK-CFG-001', `${at} a name nem snake_case`);
  }
  if (seenNames.has(e.name)) fail('TRK-CFG-001', `${at} duplikált name`);
  seenNames.add(e.name);

  if (!KINDS.has(e.kind)) fail('TRK-CFG-001', `${at} érvénytelen kind: ${e.kind}`);
  if (!MODULES.has(e.module)) fail('TRK-CFG-001', `${at} érvénytelen module: ${e.module}`);
  if (typeof e.ga4_key_event !== 'boolean') fail('TRK-CFG-001', `${at} ga4_key_event nem boolean`);
  if (typeof e.provenance !== 'boolean') fail('TRK-CFG-001', `${at} provenance nem boolean`);
  if (!('flow' in e) || !FLOWS.has(e.flow)) fail('TRK-CFG-001', `${at} érvénytelen flow: ${e.flow}`);

  if (!Array.isArray(e.channels) || e.channels.length === 0 || !e.channels.every((c) => CHANNELS.has(c))) {
    fail('TRK-CFG-001', `${at} érvénytelen channels: ${JSON.stringify(e.channels)}`);
  }
  if (!('meta' in e) || (e.meta !== null && typeof e.meta !== 'string')) {
    fail('TRK-CFG-001', `${at} meta nem string|null`);
  }

  // Reserved-name guard (TRK-EVT-002) — build-time fail.
  if (GA4_RESERVED.has(e.name)) {
    fail('TRK-EVT-002', `${at} a name ütközik egy GA4 fenntartott névvel`);
  }

  // Minden conversion-event-nek van Meta-eseménye és csatornája.
  if (e.kind === 'conversion') {
    if (!e.meta) fail('TRK-CFG-001', `${at} conversion-event Meta-esemény nélkül`);
  }

  // Offline event: kizárólag szerver-csatorna, Meta nélkül (Google Ads/GA4 offline).
  if (e.kind === 'offline') {
    if (!(Array.isArray(e.channels) && e.channels.length === 1 && e.channels[0] === 'server')) {
      fail('TRK-CFG-001', `${at} offline event csatornája nem pontosan ['server']`);
    }
    if (e.meta !== null) fail('TRK-CFG-001', `${at} offline event nem-null Meta-eseménnyel`);
  }

  // Legacy aliasok: egyediek, és nem ütköznek kanonikus névvel.
  for (const [field, val] of [['legacy_ga4', e.legacy_ga4], ['legacy_datalayer', e.legacy_datalayer]]) {
    if (val === undefined) fail('TRK-CFG-001', `${at} hiányzó mező: ${field}`);
    if (val === null) continue;
    if (typeof val !== 'string') fail('TRK-CFG-001', `${at} ${field} nem string|null`);
  }
  if (typeof e.legacy_ga4 === 'string') {
    if (seenLegacy.has(e.legacy_ga4)) fail('TRK-CFG-001', `${at} duplikált legacy_ga4: ${e.legacy_ga4}`);
    seenLegacy.add(e.legacy_ga4);
    if (canonicalNames.has(e.legacy_ga4)) {
      fail('TRK-CFG-001', `${at} legacy_ga4 ütközik egy kanonikus névvel: ${e.legacy_ga4}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`event-contract FAIL — ${errors.length} hiba:`);
  for (const err of errors) console.error(`  ${err}`);
  console.error('\nFuttasd újra a generátort, vagy javítsd az events.json-t.');
  process.exit(1);
}

console.log(`event-contract OK — ${events.length} kanonikus event, 0 hiba.`);
