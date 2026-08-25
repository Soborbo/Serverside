#!/usr/bin/env node
/**
 * GA4 FOGLALT KAMPÁNY-PARAMÉTEREK ŐRE.
 *
 * ── A hibaosztály ────────────────────────────────────────────────────────────
 * A GA4 a `source` / `medium` / `campaign` NEVŰ event-paramétert NEM sima
 * riport-mezőként kezeli, hanem MANUÁLIS KAMPÁNY-JELZÉSKÉNT. Ha egy ilyen hit
 * nyit egy munkamenetet (vagy korán van benne), a címke a munkamenet FORRÁSA
 * lesz. Egy CTA-címke így felülírja a valódi akvizíciós forrást — és nem csak
 * azon az eventen, hanem az EGÉSZ munkameneten, a benne lévő konverziókkal
 * együtt.
 *
 * ── Ez nem elméleti ──────────────────────────────────────────────────────────
 * A painless GA4-ében (property 413271735) mérve, 2026-08-25-én:
 *
 *   sessionSourceMedium          munkamenet (90 nap)
 *   standalone / (not set)                     57
 *   server / (not set)                         23
 *   after_calculator / (not set)                9
 *   email_click / (not set)                     4
 *
 * Ezek CTA-címkék, nem forgalmi források. A painless a saját forkjában
 * átnevezte őket (`source` → `cta_context`), és a napi bontás bizonyítja, hogy a
 * javítás HATOTT: `standalone / (not set)` 08-15 (5), 08-16 (1), 08-17 (3),
 * azóta **nulla**.
 *
 * ── Miért racsni, és nem azonnali javítás ────────────────────────────────────
 * A kanonikus csomag ma is tolja a `source`-ot a dataLayerbe
 * (`lib/gateway.ts`), a GTM-konténer pedig `DLV - source`-ként GA4-paraméterré
 * teszi. Ennek a javítása EGYÜTTES változás: kód + konténer-újrapublikálás
 * minden site-on. Egy magányos kód-átnevezés csak annyit érne el, hogy a GTM
 * `DLV - source`-a üresen maradna — a paraméter eltűnne a riportból anélkül,
 * hogy bárki döntött volna róla.
 *
 * Ezért ez ŐR, nem javítás: a MEGLÉVŐ előfordulás nevesített alapvonalon van,
 * ÚJ foglalt nevet viszont nem enged be. Ugyanaz az elv, mint az error-code
 * emisszió-racsninál: a hiányt nevesítve tartjuk anélkül, hogy hazudnánk vagy
 * örökre pirosat adnánk.
 *
 * Használat: node scripts/check-ga4-reserved-params.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'soborbo-tracking');

/**
 * A GA4 manuális kampány-paraméterei. `term` és `content` is idetartozik: a
 * `utm_*` párjaik ugyanabba a mechanizmusba futnak.
 */
export const GA4_RESERVED_CAMPAIGN_PARAMS = ['source', 'medium', 'campaign', 'term', 'content'];

/**
 * NEVESÍTETT ALAPVONAL — a MA létező előfordulások. Ez a lista csak SZŰKÜLHET.
 *
 * Minden tétel mellé tartozik, hogy mi kell a megszüntetéséhez: enélkül a
 * kivétel örökre itt maradna, és a racsni önmagát ürítené ki.
 */
export const BASELINE = {
  'gateway.ts:source': {
    where: 'lib/gateway.ts — dataLayer.push({ ..., source: params.source })',
    fix: 'átnevezés `cta_context`-re + a GTM-konténer `DLV - source` változójának és a GA4-tag paraméternevének együttes cseréje, MINDEN site-on újrapublikálva',
    evidence: 'painless GA4 413271735: standalone/server/after_calculator/email_click mint sessionSourceMedium'
  },
  'container.json:source': {
    where: 'gtm/container.json — GA4 event parameter neve `source`, értéke {{DLV - source}}',
    fix: 'ugyanaz az együttes változás; a konténer-oldal a kód-oldallal EGYÜTT megy',
    evidence: 'ugyanaz'
  }
};

/** A dataLayer-push foglalt kulcsai a csomag böngésző-libjében. */
export function scanLibPushes(text) {
  const hits = [];
  // A `dataLayer.push({ ... })` blokkok tartalmát nézzük, nem az egész fájlt:
  // egy `utm_source` mező vagy egy kommentbeli „source" szó nem találat.
  //
  // A ZÁRÁS a SAJÁT SORÁBAN álló `})` — nem az első `}`-ra illesztünk. A push
  // törzsében ugyanis spread-objektumok vannak
  // (`...(params.source && { source: params.source })`), és egy nem-mohó
  // „az első `}` után `)`" minta MÁR AZ ELSŐ spreadnél lezárult volna. Pont a
  // `source` maradt volna kívül a vizsgált törzsön — vagyis az őr csendben
  // átengedte volna azt az egy előfordulást, amiért megszületett.
  const re = /dataLayer\s*\.\s*push\s*\(\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    for (const key of GA4_RESERVED_CAMPAIGN_PARAMS) {
      // `key:` vagy `key: x` — de NEM `utm_source:`, `cta_source:` stb.
      const keyRe = new RegExp(`(^|[^A-Za-z0-9_.])${key}\\s*:`, 'm');
      if (keyRe.test(body)) hits.push(key);
    }
  }
  return [...new Set(hits)];
}

/** A GTM-konténer GA4-paraméterei közül a foglalt nevűek. */
export function scanContainerParams(container) {
  const hits = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    // A GA4 event-paraméter alakja: { type: 'MAP', map: [{key:'name',value:'source'}, {key:'value',...}] }
    if (Array.isArray(node.map)) {
      const nameEntry = node.map.find((e) => e && e.key === 'name');
      const valueEntry = node.map.find((e) => e && e.key === 'value');
      if (nameEntry && valueEntry && GA4_RESERVED_CAMPAIGN_PARAMS.includes(nameEntry.value)) {
        hits.add(nameEntry.value);
      }
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(container);
  return [...hits];
}

if (process.argv[1]?.endsWith('check-ga4-reserved-params.mjs')) {
  const libText = fs.readFileSync(path.join(PKG, 'lib', 'gateway.ts'), 'utf8');
  const container = JSON.parse(fs.readFileSync(path.join(PKG, 'gtm', 'container.json'), 'utf8'));

  const found = [
    ...scanLibPushes(libText).map((k) => `gateway.ts:${k}`),
    ...scanContainerParams(container).map((k) => `container.json:${k}`)
  ].sort();

  const known = Object.keys(BASELINE).sort();
  const isNew = found.filter((f) => !known.includes(f));
  const gone = known.filter((k) => !found.includes(k));

  let failed = false;

  if (isNew.length > 0) {
    failed = true;
    console.error('GA4_RESERVED_PARAM_NEW — ÚJ foglalt kampány-paraméter került be:');
    for (const f of isNew) console.error(`  - ${f}`);
    console.error('');
    console.error('A GA4 a `source`/`medium`/`campaign`/`term`/`content` NEVŰ event-paramétert');
    console.error('MANUÁLIS KAMPÁNY-JELZÉSNEK veszi: a címke a MUNKAMENET forrása lesz, és');
    console.error('felülírja a valódi akvizíciót — az egész munkamenetre, a konverziókkal együtt.');
    console.error('Nevezd át (pl. `cta_context`), vagy — ha tudatos — vedd fel a BASELINE-ba');
    console.error('azzal együtt, MI kell a megszüntetéséhez.');
  }

  if (gone.length > 0) {
    failed = true;
    console.error('GA4_RESERVED_PARAM_BASELINE_STALE — ezek MÁR nincsenek meg, szűkítsd az alapvonalat:');
    for (const g of gone) console.error(`  - ${g}`);
  }

  if (failed) process.exit(1);

  console.log(
    `✅ GA4_RESERVED_PARAM_OK — ${found.length} ismert előfordulás az alapvonalon, új nincs.\n` +
      '   Nyitott tétel: a `source` → `cta_context` átnevezés kód + GTM-konténer EGYÜTTES\n' +
      '   változása (lásd BASELINE.fix). Bizonyíték a hatásra: painless GA4, 2026-08-17 után nulla.'
  );
}
