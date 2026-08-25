#!/usr/bin/env node
/**
 * P7 — az ÉLŐ GTM konténer conformance-ellenőrzése. READ-ONLY.
 *
 * MIT MÉR. A repóban eddig a `soborbo-tracking/gtm/container.json` volt az
 * igazság — de az a COMMITTOLT artefakt, nem az, ami a látogató böngészőjében
 * fut. Az élő konténer kézzel szerkeszthető, és az ott keletkező hibák NEM
 * hagynak nyomot a gateway-ledgerben: a szerver-láb tökéletesen működik tovább,
 * a napi digest zöld, és a baj csak hetekkel később, a hirdetési riportban
 * látszik — akkorra a bidding már rossz jelre tanult.
 *
 * MIÉRT NEM HÍV API-t EZ A SZKRIPT. A GTM API-hozzáférés OAuth-hoz kötött, és
 * CI-ban nem elérhető. Ha a szkript hálózatra épülne, a leggyakoribb kimenete a
 * „nem tudtam megnézni" lenne — vagyis pont az a néma zöld, ami ellen készült.
 * Ezért a bemenet egy EXPORT-fájl (GTM UI → Admin → Export Container), az
 * elemzés pedig tiszta függvény (`src/lib/gtm-conformance.ts`), ami fixture-
 * ökkel CI-ban is tesztelhető.
 *
 * Használat:
 *   node --experimental-transform-types scripts/check-live-gtm.mjs \
 *     --export <gtm-export.json> --expect <expected.json> [--site <hostname>]
 *
 * Az `--expect` alakja (lásd ExpectedContract):
 *   { "publicId": "GTM-XXXXXXX", "googleAdsConversionId": "AW-…",
 *     "googleAdsConversionLabel": "…", "requireEnhancedConversions": true,
 *     "metaPixelId": "…", "legacyEvents": ["…"] }
 * A `browserEvents` alapból a KANONIKUS `src/events.json`-ból jön.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { analyzeGtmConformance, hasBlockingFindings, reportConformanceFindings } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'lib', 'gtm-conformance.ts')).href
);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const exportPath = arg('export');
const expectPath = arg('expect');
const site = arg('site') ?? 'unknown-site';

if (!exportPath) {
  console.error('Használat: node --experimental-transform-types scripts/check-live-gtm.mjs --export <fájl> [--expect <fájl>] [--site <hostname>]');
  console.error('\nAz exportot a GTM UI adja: Admin → Export Container → a legfrissebb verzió.');
  process.exit(2);
}

/**
 * A KANONIKUS ELVÁRÁS a committolt konténer-artefaktból.
 *
 * MIÉRT NEM az `events.json` TELJES böngésző-készlete. Az `events.json` a
 * flotta ÖSSZES eventjét ismeri, beleértve az ecommerce-ágat (view_item,
 * purchase…), amit egy leadgen-site soha nem emittál. Ha az volna az elvárás,
 * minden leadgen-konténer nyolc hamis „hiányzó trigger" findinget kapna — és a
 * hamis riasztás megtanítja az embert figyelmen kívül hagyni az igazit is.
 *
 * A committolt `gtm/container.json` viszont PONTOSAN az, amit a kanonikus
 * generátor előállít az adott profilra: ez a helyes viszonyítási alap. Egy
 * site-specifikus eltérést az `--expect` felülír.
 */
function canonicalExpectation() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'soborbo-tracking', 'gtm', 'container.json'), 'utf8')
  );
  const cv = raw.containerVersion ?? raw;
  const browserEvents = (cv.trigger ?? [])
    .filter((t) => t.type === 'CUSTOM_EVENT')
    .map((t) => t.customEventFilter?.[0]?.parameter?.find((p) => p.key === 'arg1')?.value)
    .filter(Boolean);
  // A generátor Custom HTML-t használ a Meta pixelhez (arra nincs natív
  // GTM-tagtípus) — ezek KANONIKUSAK, nem kézzel felvett idegen tagek.
  const allowedCustomHtmlTags = (cv.tag ?? [])
    .filter((t) => t.type === 'html')
    .map((t) => t.name)
    .filter(Boolean);
  return { browserEvents, allowedCustomHtmlTags };
}

let live = null;
let readError = null;
try {
  const raw = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  // A GTM-export a konténer-verziót egy burokban adja.
  live = raw.containerVersion ?? raw;
  if (raw.containerVersion?.container?.publicId && !live.publicId) {
    live.publicId = raw.containerVersion.container.publicId;
  }
} catch (e) {
  readError = e.message;
}

const expected = {
  ...canonicalExpectation(),
  ...(expectPath ? JSON.parse(fs.readFileSync(expectPath, 'utf8')) : {})
};

// §17 — ha az exportot nem tudtuk beolvasni, az NEM „nulla finding": az elemző
// `null`-ra külön, kritikus findinget ad (TRK-850-015).
const findings = analyzeGtmConformance({ site, live, expected });

if (readError) console.error(`  (az export beolvasása elbukott: ${readError})`);

// §13 — strukturált, kódos nyom minden findingről (a fleet-nézet és a
// riasztás erre tud rákötni), az ember-olvasható kiírás MELLETT.
reportConformanceFindings(findings);

console.log(`\nÉlő GTM conformance — ${site}\n${'='.repeat(46)}`);
console.log(`konténer: ${live?.publicId ?? 'ismeretlen'}   ·   elvárt böngésző-eventek: ${expected.browserEvents.length}\n`);

if (findings.length === 0) {
  console.log('✅ LIVE_GTM_OK — nincs eltérés a kanonikus elvárástól.\n');
  process.exit(0);
}

const bySeverity = { critical: [], warning: [], info: [] };
for (const f of findings) (bySeverity[f.severity] ?? bySeverity.info).push(f);

for (const [sev, icon] of [['critical', '❌'], ['warning', '⚠️ '], ['info', 'ℹ️ ']]) {
  const list = bySeverity[sev];
  if (!list.length) continue;
  console.log(`── ${sev.toUpperCase()} (${list.length}) ──`);
  for (const f of list) {
    const where = [f.objectName && `"${f.objectName}"`, f.objectId && `#${f.objectId}`]
      .filter(Boolean)
      .join(' ');
    console.log(`${icon} ${f.code}  ${f.message}`);
    if (where) console.log(`      hol: ${where}`);
    if (f.expected !== undefined) console.log(`      elvárt: ${f.expected}`);
    if (f.actual !== undefined) console.log(`      valóság: ${f.actual}`);
    console.log(`      → ${f.remediation}`);
  }
  console.log('');
}

if (hasBlockingFindings(findings)) {
  console.error(`LIVE_GTM_FAIL — ${bySeverity.critical.length} kritikus eltérés.\n`);
  process.exit(1);
}
console.log(`LIVE_GTM_WARN — ${findings.length} nem-kritikus eltérés.\n`);
