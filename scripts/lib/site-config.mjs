/**
 * site-config.mjs — a KV SiteConfig alakjának EGYETLEN, gépi forrása.
 *
 * MIÉRT LÉTEZIK (2026-08-24, vNext P0.2 / cross-check A8): a generátor korábbi
 * `toSiteConfig`-ja FIX MEZŐLISTÁBÓL épített, és minden mást NÉMÁN ELDOBOTT — a
 * `consent`, `consent_strict`, `recon`, `monitoring` blokkot is. Egy sbo-consent
 * pilot site KV-jének puszta újragenerálása így csendben visszabillentette volna a
 * site-ot CookieYes-módba, config-vesztésként, riasztás nélkül. Ugyanez a
 * mechanizmus vitte volna el a `recon` blokkot (a napi cross-check némán kimarad)
 * és a `monitoring: false`-t (a nem-produkciós dummy minden nap CRITICAL-t adna).
 *
 * A javítás elve: NE legyen kézi mezőlista. A pass-through lista a
 * `soborbo-tracking/server/site-config.schema.json` `properties` kulcsaiból
 * származik — vagyis egy új SiteConfig-mező felvétele a sémába AUTOMATIKUSAN
 * átengedetté teszi, egy sémából kihagyott mező pedig a round-trip-teszten bukik
 * (tests/generator-roundtrip.test.ts), nem élesben.
 *
 * A modul tiszta (nincs I/O a séma beolvasásán túl) és determinisztikus.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMA = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../soborbo-tracking/server/site-config.schema.json', import.meta.url)),
    'utf8'
  )
);

/** A KV SiteConfig összes támogatott mezője, séma-sorrendben. */
export const SITE_CONFIG_FIELDS = Object.keys(SCHEMA.properties);

/**
 * A generátor-input CSAK ezeket a plusz kulcsokat ismeri a SiteConfig-mezőkön túl.
 * A `hostnames` a KV KULCSA (nem érték), a `crm_token` a plaintext token, amiből a
 * `crm_token_sha256` származik. Minden más ismeretlen kulcs HIBA — pontosan az a
 * néma elnyelés, amiért ez a modul létezik (egy elgépelt `expected_platform`
 * korábban nyomtalanul eltűnt).
 */
export const INPUT_ONLY_FIELDS = ['hostnames', 'crm_token'];

const COMMENT_KEY = /^_comment/;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** `_comment*` kulcsok az input-sorrendben. A séma minden szinten engedi őket, és
 *  a round-trip csak akkor lossless, ha meg is maradnak. */
function commentKeys(obj) {
  return Object.keys(obj).filter((k) => COMMENT_KEY.test(k));
}

/**
 * generátor-input → KV SiteConfig. LOSSLESS: minden séma-ismerte mezőt átenged.
 *
 * A NEM puszta átengedés csak három helyen van, és mindhárom indokolt:
 *  - `crm_token_sha256`: a hívó adja (a plaintext tokenből hash-elve VAGY az
 *    inputbeli hash-ből átengedve) — az input `crm_token`-je maga SOHA nem kerül KV-be;
 *  - `meta.test_event_code`: opt-in nélkül itt már nem is lehet jelen (a validate
 *    hard-errort ad rá), opt-innel pedig a hívó dönt, hogy egyáltalán kiír-e
 *    production-használható kv-put scriptet (CLAUDE.md 17);
 *  - `expected_platforms`: ÚJ site-nál (`deriveExpectedPlatforms`) a derivált default
 *    áll be (smoke: meta, ha van meta blokk; offline: gads, ha van customer_id), hogy
 *    egy friss bekötés automatikusan megkapja a néma-kiesés elleni védelmet. Meglévő
 *    config REGENERÁLÁSAKOR viszont soha nem deriválunk: ha az input megadja, verbatim
 *    megy (enélkül a 2026-08-14-i `expected_platforms.offline` levételek —
 *    olcso/skinlab/szello — minden regeneráláskor visszaíródnának); ha NEM adja meg, a
 *    hiány is megmarad, mert a hozzáírás VISELKEDÉST VÁLTOZTAT (a digest a megfigyelt
 *    előzmény helyett explicit elvárásra vált) — az elvárás felvétele legyen tudatos
 *    config-döntés, ne egy regenerálás mellékhatása.
 */
export function toSiteConfig(
  input,
  { crmTokenSha256, allowTestEventCode = false, deriveExpectedPlatforms = false } = {}
) {
  const sc = {};

  for (const k of commentKeys(input)) sc[k] = deepClone(input[k]);

  for (const field of SITE_CONFIG_FIELDS) {
    if (field === 'crm_token_sha256') continue; // a hívó teszi rá, lentebb
    const value = input[field];
    if (value === undefined) continue;
    sc[field] = deepClone(value);
  }

  // gads.customer_id a sémában KÖTELEZŐ a blokkon belül — egy `{"conversion_actions":…}`
  // alakú input ne termeljen séma-sértő configot.
  if (isPlainObject(sc.gads) && sc.gads.customer_id === undefined) sc.gads.customer_id = null;

  // #17: opt-in nélkül ide el sem jutunk (validate hard error). Opt-innel a kód
  // BENNE MARAD a teszt-configban — a production-védelem a kv-put oldalon van
  // (lásd generate-site.mjs testEventCodeBuild), nem a JSON csonkításában.
  if (isPlainObject(sc.meta) && !allowTestEventCode) delete sc.meta.test_event_code;

  if (input.expected_platforms === undefined && deriveExpectedPlatforms) {
    const derived = {};
    if (isPlainObject(input.meta)) derived.smoke = ['meta'];
    if (isPlainObject(input.gads) && input.gads.customer_id) derived.offline = ['gads'];
    if (Object.keys(derived).length > 0) sc.expected_platforms = derived;
  }

  if (crmTokenSha256) sc.crm_token_sha256 = crmTokenSha256;

  return sc;
}

/**
 * KV SiteConfig + a KV-kulcsai → generátor-input. A round-trip kontraktus BAL
 * oldala: enélkül a `parse(live) → generate → parse` lánc le sem futtatható, mert
 * a generátor-input eddig MÁS ALAKÚ volt, mint a live SiteConfig (a terv P0.2
 * megjegyzése). A `crm_token_sha256` VERBATIM megy vissza — így egy élő site
 * configja a plaintext token ISMERETE NÉLKÜL, tokenrotáció NÉLKÜL regenerálható.
 */
export function toGeneratorInput(siteConfig, hostnames) {
  return { ...deepClone(siteConfig), hostnames: [...hostnames] };
}

/** Rekurzív, kulcssorrend-független összehasonlítás. Diffek JSON-pointer-szerű úttal. */
export function semanticDiff(expected, actual, path = '') {
  const diffs = [];
  const at = path || '(root)';

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of [...keys].sort()) {
      if (!(k in actual)) diffs.push(`${path}/${k}: DROPPED (expected ${JSON.stringify(expected[k])})`);
      else if (!(k in expected)) diffs.push(`${path}/${k}: ADDED (${JSON.stringify(actual[k])})`);
      else diffs.push(...semanticDiff(expected[k], actual[k], `${path}/${k}`));
    }
    return diffs;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      diffs.push(`${at}: array length ${expected.length} → ${actual.length}`);
      return diffs;
    }
    for (let i = 0; i < expected.length; i++) diffs.push(...semanticDiff(expected[i], actual[i], `${path}/${i}`));
    return diffs;
  }

  if (expected !== actual) diffs.push(`${at}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
  return diffs;
}

export function semanticEqual(expected, actual) {
  return semanticDiff(expected, actual).length === 0;
}
