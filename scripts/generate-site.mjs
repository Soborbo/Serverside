#!/usr/bin/env node
/**
 * generate-site.mjs — determinisztikus per-site bekötés-generátor.
 *
 * A repó a "source of truth": ez a script egy site-config inputból előállítja a
 * KV-bejegyzés(eke)t, a wrangler route-blokkot, a `wrangler kv key put`
 * parancsokat és egy integrációs ellenőrzőlistát. Az onboard-site skill ezt
 * hívja, miután az MCP-connectorokból összegyűjtötte az ID-ket.
 *
 * Használat:
 *   node scripts/generate-site.mjs --input site.json --new-site [--out dir/] [--kv-namespace-id ID]
 *   node scripts/generate-site.mjs --input site.json --rotate-token   # meglévő site tokenrotáció
 *   cat site.json | node scripts/generate-site.mjs --new-site
 *
 * LOSSLESS (2026-08-24, vNext P0.2). Az input alakja = a KV SiteConfig alakja +
 * `hostnames` (a KV kulcsa) + opcionálisan `crm_token` (plaintext). A generátor
 * MINDEN séma-ismerte mezőt átenged — a mezőlista a
 * `soborbo-tracking/server/site-config.schema.json`-ból jön, nem kézi felsorolásból
 * (scripts/lib/site-config.mjs). Korábban fix lista épült, ami a `consent`,
 * `consent_strict`, `recon` és `monitoring` blokkot NÉMÁN ELDOBTA: egy sbo-consent
 * pilot site KV-jének puszta újragenerálása visszabillentette volna a site-ot
 * CookieYes-módba, riasztás nélkül.
 *
 * Ebből következik a round-trip kontraktus, amit a CI futtat
 * (tests/generator-roundtrip.test.ts) és amit élő KV ellen a
 * `scripts/roundtrip-check.mjs` futtat:
 *     parse(live_config) → generate → parse(generated) → semantic_equal(live_config)
 *
 * Token-rotációs guard: ha az input NEM ad `crm_token`-t és `crm_token_sha256`-ot
 * sem, a generátor új random tokent gyártana — ami felülírná a KV-ben élő tokent.
 * Ezért ilyenkor EXPLICIT szándék kell: `--new-site` (első onboarding) vagy
 * `--rotate-token` (szándékos rotáció). MEGLÉVŐ site regenerálásához add vissza a
 * KV-ben lévő `crm_token_sha256`-ot — az verbatim átmegy, tokenrotáció nélkül, és
 * a plaintextet nem is kell ismerni (a hash-ből amúgy sem fejthető vissza).
 *
 * Nincs külső függőség (csak Node built-in). Determinisztikus: ugyanaz az input
 * ugyanazt a kimenetet adja (a generált token kivételével).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { toSiteConfig, SITE_CONFIG_FIELDS, INPUT_ONLY_FIELDS } from './lib/site-config.mjs';
import { integrationChecklist } from './lib/integration-checklist.mjs';

// A wrangler.toml-ban rögzített SITE_CONFIG KV namespace (alapértelmezett).
const DEFAULT_SITE_CONFIG_NS = 'edd34e28eee847c09c26f9d9e3ea04ab';

// Kanonikus event-forrás — a repó SINGLE SOURCE OF TRUTH-ja (src/events.json).
// NINCS kézi másolat: a generátor pontosan azt fogadja el, amit a worker (§1).
const EVENTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/events.json', import.meta.url)), 'utf8')
);
// A checklist (és a benne felsorolt böngésző-/szerver-only event-nevek) a
// scripts/lib/integration-checklist.mjs-ben él — onnan a check-doc-truth kapu is
// importálni tudja, és a GENERÁLT kimenetre futtatja a tiltó szabályokat.
// gads.conversion_actions kulcsai CSAK kanonikus event-nevek lehetnek (Modell
// 2-ben jellemzően az offline CRM-eventek: lead_qualified, booking_confirmed, …).
// A legacy GA4 aliasokat SZÁNDÉKOSAN nem fogadjuk el: az ingress a lookup előtt
// kanonikusra normalizál (conversion.ts canonicalizeEventName), így egy
// legacy-kulcsú map SOHA nem matchelne futásidőben — a generátor eddig
// csendben átengedte az ilyen halott configot (2026-07-13-i auditlelet).
const VALID_ACTION_EVENTS = new Set(EVENTS.map((e) => e.name));

const ALLOWED_COUNTRIES = new Set(['GB', 'HU', 'EU', 'US', 'DE', 'FR', 'IT', 'ES']);
// A CONSENT-KÖTELES PIACOK — NEM „EEA". A korábbi `EEA_COUNTRIES` névből a `GB`
// jogilag helyesen hiányzott (az Egyesült Királyság 2020 óta nem EGT-tag), a
// KÖVETKEZMÉNY viszont hibás volt: egy UK-site SEMMILYEN `require_consent`
// figyelmeztetést nem kapott — pont azon a piacon, ahol a PECR + UK GDPR a
// süti-alapú marketing-trackinghez előzetes hozzájárulást követel, és ahol az ICO
// 2025 óta aktívan bírságol. A kapu neve ezért a JOGI KÖVETELMÉNYT nevezi meg, nem
// egy földrajzi klubot — így egy új piac felvételekor a kérdés is a helyes:
// „kell-e ide consent?", nem „EGT-tag-e?".
const CONSENT_REQUIRED_MARKETS = new Set(['GB', 'HU', 'EU', 'DE', 'FR', 'IT', 'ES']);

function parseArgs(args) {
  const out = {
    input: null,
    out: null,
    kvNamespaceId: DEFAULT_SITE_CONFIG_NS,
    allowTestEventCode: false,
    newSite: false,
    rotateToken: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') out.input = args[++i];
    else if (args[i] === '--out') out.out = args[++i];
    else if (args[i] === '--kv-namespace-id') out.kvNamespaceId = args[++i];
    else if (args[i] === '--allow-test-event-code') out.allowTestEventCode = true;
    else if (args[i] === '--new-site') out.newSite = true;
    else if (args[i] === '--rotate-token') out.rotateToken = true;
  }
  return out;
}

function readInput(path) {
  if (path) return readFileSync(path, 'utf8');
  // stdin
  return readFileSync(0, 'utf8');
}

const ERRORS = [];
const WARNINGS = [];
function err(m) {
  ERRORS.push(m);
}
function warn(m) {
  WARNINGS.push(m);
}

function validate(cfg, opts = {}) {
  if (!cfg || typeof cfg !== 'object') return err('Input nem objektum.');

  if (!cfg.site_id || typeof cfg.site_id !== 'string') err('site_id kötelező (string).');
  if (!Array.isArray(cfg.hostnames) || cfg.hostnames.length === 0)
    err('hostnames kötelező (nem üres tömb, pl. ["trapezlemezes.hu","www.trapezlemezes.hu"]).');
  else
    for (const h of cfg.hostnames) {
      if (typeof h !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h))
        err(`Érvénytelen hostname: ${JSON.stringify(h)}`);
    }

  if (!ALLOWED_COUNTRIES.has(cfg.country_code))
    err(`country_code érvénytelen (${cfg.country_code}); engedett: ${[...ALLOWED_COUNTRIES].join(', ')}.`);
  if (!cfg.currency || typeof cfg.currency !== 'string') err('currency kötelező (pl. "HUF", "GBP").');
  else if (!/^[A-Z]{3}$/.test(cfg.currency))
    err(`currency érvénytelen (3-betűs ISO 4217 kell, pl. "HUF", "GBP", "EUR"), kapott: ${cfg.currency}`);

  // Ismeretlen input-kulcs = HARD ERROR. Pontosan ez a néma elnyelés-osztály, ami
  // miatt a P0.2 fix megszületett: egy elgépelt `expected_platform` (egyes szám)
  // vagy `reccon` korábban nyomtalanul eltűnt, és a hiányát csak élesben, egy
  // kimaradó riasztásból lehetett volna észrevenni.
  const KNOWN_INPUT_KEYS = new Set([...SITE_CONFIG_FIELDS, ...INPUT_ONLY_FIELDS]);
  for (const k of Object.keys(cfg)) {
    if (/^_comment/.test(k)) continue;
    if (!KNOWN_INPUT_KEYS.has(k))
      err(
        `Ismeretlen input-mező: "${k}". Engedett: ${[...KNOWN_INPUT_KEYS].sort().join(', ')} (+ _comment*). ` +
          'Ha ez egy ÚJ SiteConfig-mező, előbb vedd fel a site-config.schema.json-be — a generátor onnan ' +
          'veszi az átengedett mezők listáját, és ami ott nincs, az a KV-ből is kimaradna.'
      );
  }

  // Meta — OPCIONÁLIS a runtime-ban (config.ts `meta?`): egy site bekötődhet a CAPI
  // access token elkészülte ELŐTT, és egy élő site el is veszítette már ezt a blokkot
  // (lomtalan, 2026-07-15). A generátor viszont ÚJ site-ra megköveteli: aki most köt be
  // egy site-ot, annak legyen Meta-lába. Meglévő config regenerálásakor csak warning —
  // különben a round-trip (P0.2) pont a hiányos élő configokon bukna el, és a
  // „regeneráld a KV-t" művelet elérhetetlenné válna ott, ahol a legfontosabb lenne.
  if (cfg.meta === undefined || cfg.meta === null) {
    if (opts.newSite) err('meta blokk kötelező ÚJ site-nál (--new-site): pixel_id + access_token.');
    else
      warn(
        'meta blokk hiányzik — a Meta CAPI láb SKIP marad ennél a site-nál (a cső és a ledger működik; ' +
          'a láb a token KV-be írásával, redeploy nélkül él fel).'
      );
  } else if (typeof cfg.meta !== 'object' || Array.isArray(cfg.meta)) {
    err('meta blokk objektum kell legyen (vagy hagyd el teljesen).');
  } else {
    if (!/^\d{5,}$/.test(String(cfg.meta.pixel_id || '')))
      err(`meta.pixel_id érvénytelen (numerikus pixel ID kell), kapott: ${cfg.meta.pixel_id}`);
    if (!cfg.meta.access_token) err('meta.access_token kötelező (CAPI token).');
    // #17 hard-gate: a test_event_code production-ban minden konverziót a Meta
    // Test stream-be terel (csendes ROAS-nullázás). Alapból HIBA, ami megállítja
    // a generálást; Sprint 4-8 alatti szándékos teszthez explicit opt-in kell:
    //   node scripts/generate-site.mjs --input site.json --allow-test-event-code
    if (cfg.meta.test_event_code) {
      if (opts.allowTestEventCode)
        warn(
          `meta.test_event_code = "${cfg.meta.test_event_code}" — engedélyezve (--allow-test-event-code). PRODUCTION-ban KÖTELEZŐ kivenni!`
        );
      else
        err(
          `meta.test_event_code = "${cfg.meta.test_event_code}" jelen van — production-ban minden konverzió a Test stream-be menne (CLAUDE.md #17). Vedd ki a configból, VAGY Sprint 4-8 alatti szándékos teszthez add meg a --allow-test-event-code flaget.`
        );
    }
  }

  // GA4 — a HIÁNYA a HELYES állapot (Modell 2 / Run 6): a gateway NEM küld GA4-et.
  // Az on-site GA4 a böngészőé (GTM), az offline GA4-láb pedig kikapcsolt (valódi
  // client_id nélkül minden esemény új szintetikus GA4-clientbe esne). A `ga4` blokk
  // LEGACY/diagnosztikai: már csak a /debug-ga4 és a régi ga4-DLQ-rekordok retry-ja
  // olvassa. A korábbi warning („kimarad ennél a site-nál") azt sugallta, hogy a blokk
  // KELLENE — új site-nál pont fordítva: ha van, azt kell indokolni.
  if (cfg.ga4 === undefined || cfg.ga4 === null) {
    // Nincs warning: ez az elvárt állapot.
  } else if (typeof cfg.ga4 !== 'object') {
    err('ga4 blokk objektum kell legyen (vagy hagyd el teljesen).');
  } else {
    if (!/^G-[A-Z0-9]+$/.test(String(cfg.ga4.measurement_id || '')))
      err(`ga4.measurement_id érvénytelen (G-XXXX formátum kell), kapott: ${cfg.ga4.measurement_id}`);
    if (!cfg.ga4.api_secret) err('ga4.api_secret kötelező (MP api_secret a GA4 admin felületről).');
    warn(
      'ga4 blokk JELEN VAN — a gateway NEM küld GA4-et (Modell 2 / Run 6): az on-site GA4 a böngészőé, ' +
        'az offline GA4-láb kikapcsolt. A blokkot már csak a /debug-ga4 és a régi ga4-DLQ-retry olvassa, ' +
        'viszont egy élő api_secretet tárol a KV-ben. Új site-nál hagyd el; meglévőnél a kivezetés a ' +
        'Fázis-0 E-2 tétele (visszavonás a GA4 adminban, majd törlés a KV-ből).'
    );
  }

  // Google Ads — ugyanaz az optionality-szabály, mint a metánál (config.ts `gads?`:
  // egy kézzel írt / migrációs config érkezhet nélküle is).
  if (cfg.gads === undefined || cfg.gads === null) {
    if (opts.newSite) err('gads blokk kötelező ÚJ site-nál (--new-site) — a customer_id lehet null.');
    else warn('gads blokk hiányzik — a Google Ads offline (Data Manager) láb no-op ennél a site-nál.');
  } else if (typeof cfg.gads !== 'object' || Array.isArray(cfg.gads)) {
    err('gads blokk objektum kell legyen (vagy hagyd el teljesen).');
  } else {
    const cid = cfg.gads.customer_id;
    if (cid !== null && cid !== undefined) {
      if (!/^\d{10}$/.test(String(cid)))
        err(`gads.customer_id 10 számjegy KÖTŐJEL NÉLKÜL (UI: 123-456-7890 → 1234567890), kapott: ${cid}`);
    }
    const lcid = cfg.gads.login_customer_id;
    if (lcid !== null && lcid !== undefined && !/^\d{10}$/.test(String(lcid)))
      err(`gads.login_customer_id 10 számjegy kötőjel nélkül vagy null, kapott: ${lcid}`);
    if (cfg.gads.conversion_actions) {
      for (const [ev, id] of Object.entries(cfg.gads.conversion_actions)) {
        if (!VALID_ACTION_EVENTS.has(ev))
          err(`gads.conversion_actions ismeretlen event-név: ${ev} (engedett: ${[...VALID_ACTION_EVENTS].join(', ')}).`);
        if (!/^\d+$/.test(String(id)))
          err(`gads.conversion_actions["${ev}"] numerikus conversionAction ID kell, kapott: ${id}`);
      }
    }
    // ── P6.4 — Enhanced Conversions NEM opcionális ────────────────────
    //
    // INV-009: „Google Ads-enabled site Enhanced Conversions-compatible legyen
    // AUTOMATIKUSAN". A `conversion_actions` hiánya eddig sima warning volt, és
    // pontosan úgy viselkedett, ahogy a néma hibák szoktak: a site „be van
    // kötve", a ledger tele van eventtel, a Google felé viszont EGYETLEN
    // konverzió sem megy fel — mert nincs mire leképezni. A monitorozás is
    // zöld marad, hiszen a skip szándékosnak látszik (PLATFORM_NOT_CONFIGURED).
    //
    // Új site-nál ezért HARD ERROR (TRK-CFG-002). Meglévő config
    // regenerálásakor hangos warning — ugyanaz a szabály, mint a
    // consent-kapunál: a regenerálást nem blokkolhatjuk, különben a P0.2
    // round-trip lehetetlen lenne, és pont a hibás legacy configokat nem
    // lehetne javítani.
    const ecCount = cfg.gads.conversion_actions
      ? Object.keys(cfg.gads.conversion_actions).length
      : 0;
    if (cid && ecCount === 0) {
      const msg =
        'TRK-CFG-002  gads.customer_id meg van adva, de nincs (nem üres) conversion_actions. ' +
        'A Google Ads offline láb így NÉMÁN nulla konverziót szállít: az eventek beérkeznek, ' +
        'a leképezés hiányzik, a skip pedig szándékosnak látszik a monitorozásban.';
      if (opts.newSite)
        err(
          msg +
            ' Enhanced Conversions kötelező minden Google Ads-es site-on (INV-009) — ' +
            'add meg legalább egy lifecycle-eventhez a conversionAction ID-t.'
        );
      else warn(msg + ' Meglévő site: pótold a conversion_actions blokkot.');
    }
  }

  // Per-site CRM token (opcionális input). Ha megadod, determinisztikusan
  // hash-eljük; ha nem, a generátor generál egyet (lásd resolveCrmToken).
  if (cfg.crm_token !== undefined && cfg.crm_token !== null) {
    if (typeof cfg.crm_token !== 'string' || cfg.crm_token.length < 16)
      err('crm_token érvénytelen (string, ≥16 karakter) vagy hagyd ki (akkor generálódik).');
  }
  // A KÉSZ hash közvetlen átengedése — ez teszi lefuttathatóvá a round-trip
  // kontraktust (P0.2) egy ÉLŐ configon: a plaintext tokent nem lehet visszafejteni
  // a KV-ből, tehát enélkül minden regenerálás vagy tokenrotációt (401 a
  // /lead-status-on), vagy a titok kézi előkeresését követelné meg.
  if (cfg.crm_token_sha256 !== undefined && cfg.crm_token_sha256 !== null) {
    if (typeof cfg.crm_token_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cfg.crm_token_sha256))
      err('crm_token_sha256 érvénytelen (64 karakteres lowercase hex SHA-256).');
    else if (typeof cfg.crm_token === 'string' && cfg.crm_token.length >= 16) {
      const derived = createHash('sha256').update(cfg.crm_token).digest('hex');
      if (derived !== cfg.crm_token_sha256)
        err(
          'crm_token és crm_token_sha256 EGYSZERRE van megadva, és NEM egyeznek. ' +
            'Add meg csak az egyiket (a plaintextet, VAGY a KV-ben élő hash-t az átengedéshez).'
        );
    }
  }

  // Consent-kapu a consent-köteles piacokon (GB is! — lásd CONSENT_REQUIRED_MARKETS).
  // ÚJ site-nál HARD ERROR, ha marketing-tracking engedélyezett: egy ilyen piacon
  // fail-open configgal élesíteni jogi kockázat, és a „majd később beállítom" néma
  // állapot évekig eláll. Meglévő config regenerálásakor hangos warning — a
  // regenerálást nem blokkolhatjuk (különben a P0.2 round-trip lehetetlen lenne, és
  // pont a legacy configokat nem lehetne javítani).
  const marketingTracking =
    (!!cfg.meta && typeof cfg.meta === 'object') ||
    (!!cfg.gads && typeof cfg.gads === 'object' && !!cfg.gads.customer_id);
  if (CONSENT_REQUIRED_MARKETS.has(cfg.country_code) && cfg.require_consent !== true && marketingTracking) {
    const msg =
      `country_code=${cfg.country_code} consent-köteles piac (GDPR / UK PECR+GDPR), és a site-on ` +
      `marketing-tracking van bekapcsolva, de require_consent !== true (jelenleg: ${JSON.stringify(cfg.require_consent)}). ` +
      'Fail-open konfiguráció: hozzájárulás-bizonyíték nélkül is menne ad-platform konverzió.';
    if (opts.newSite)
      err(
        msg +
          ' ÚJ site-ot így nem kötünk be — állítsd require_consent: true-ra. ' +
          '(Ha tényleg szándékos kivétel, azt külön, dokumentált döntésként kell megtenni, nem a generátorban.)'
      );
    else warn(msg + ' Meglévő site: állítsd át require_consent: true-ra.');
  }
}

/**
 * Per-site CRM offline-loop token. A KV-be CSAK a SHA-256 hash kerül
 * (crm_token_sha256); a plaintext a crm-secret.env-be megy a CRM-deploynak.
 *
 * Három út, csökkenő preferencia szerint:
 *   1. `crm_token_sha256` az inputban → ÁTENGEDÉS. Nincs új token, nincs rotáció,
 *      a plaintextet nem is kell ismerni. Ez a MEGLÉVŐ site regenerálásának útja
 *      (P0.2 round-trip), és a helyes válasz arra, hogy a KV-ből a plaintext
 *      elvileg sem fejthető vissza.
 *   2. `crm_token` az inputban → determinisztikusan hash-eljük (a token újrahasznosul).
 *   3. semmi → random 32 bájt (base64url), és a hívó token-rotációs guardja
 *      EXPLICIT szándékot kér (--new-site / --rotate-token).
 */
function resolveCrmToken(cfg) {
  if (cfg.crm_token_sha256) {
    return { token: null, hash: cfg.crm_token_sha256, generated: false, passthrough: true };
  }
  let token = cfg.crm_token;
  let generated = false;
  if (!token) {
    token = randomBytes(32).toString('base64url');
    generated = true;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash, generated, passthrough: false };
}

function crmSecretEnv(cfg, token) {
  const url = `https://${cfg.hostnames[0]}/api/event/lead-status`;
  // Átengedett hash (regenerálás): nincs plaintextünk, és NEM is szabad úgy tenni,
  // mintha lenne — egy placeholderrel kiírt env-fájl deployolva 401-et adna a
  // /lead-status-on, azaz néma offline-loop-szakadást.
  if (token === null) {
    return (
      `# ${cfg.site_id} — a per-site CRM token VÁLTOZATLAN (crm_token_sha256 átengedve).\n` +
      `# A plaintext NEM állítható elő a hash-ből: a CRM-deploy MEGLÉVŐ\n` +
      `# TRACKING_ADMIN_TOKEN secretjét hagyd érintetlenül. Ez a fájl szándékosan\n` +
      `# NEM tartalmaz tokent — ne írj bele placeholdert, mert a deploy 401-et adna.\n` +
      `TRACKING_WORKER_URL=${url}\n` +
      `TRACKING_CURRENCY=${cfg.currency}\n` +
      `TRACKING_COUNTRY_CODE=${cfg.country_code}\n`
    );
  }
  return (
    `# ${cfg.site_id} — CRM offline-loop secrets. Állítsd be a CRM-deploy secretjeiként\n` +
    `# (wrangler secret put / dashboard). A token plaintextje CSAK ITT szerepel —\n` +
    `# a Worker KV-jében csak a SHA-256 hash van. Ne commitold.\n` +
    `TRACKING_WORKER_URL=${url}\n` +
    `TRACKING_ADMIN_TOKEN=${token}\n` +
    `# A CRM ezekkel konvertál minor→major értéket és tölti a user_data.country-t\n` +
    `# (a Worker omit esetén a site currency-jére esik vissza).\n` +
    `TRACKING_CURRENCY=${cfg.currency}\n` +
    `TRACKING_COUNTRY_CODE=${cfg.country_code}\n`
  );
}

function routeBlock(hostnames) {
  // A zóna hostnám-onként a SAJÁT apex-e (a www-t ugyanaz a zóna szolgálja ki).
  // NEM egyetlen közös apex az összesre: egy több-domaines site (pl. brand.com +
  // brand.co.uk) esetén a közös (legrövidebb) apex a nem-egyező route-okra rossz
  // zone_name-et adott → a `wrangler deploy` elutasítja / rossz zónára mutat.
  return hostnames
    .map((h) => {
      const zone = h.replace(/^www\./, '');
      return `[[routes]]\npattern = "${h}/api/event/*"\nzone_name = "${zone}"`;
    })
    .join('\n\n');
}

function kvPutCommands(hostnames, json, nsId) {
  const compact = JSON.stringify(JSON.parse(json));
  return hostnames
    .map(
      (h) =>
        `wrangler kv key put --namespace-id ${nsId} "${h}" '${compact.replace(/'/g, "'\\''")}'`
    )
    .join('\n');
}

// P0.4 — a teszt-build kimenetének kapuja. NEM „figyelmeztetés": a script exit 1-gyel
// áll meg, hacsak valaki EXPLICIT, gépelendő env-változóval nem vállalja a
// következményt. Egy figyelmeztető komment a fájl tetején nem elég: a két korábbi
// Meta-leak úgy történt, hogy a parancsot valaki átmásolta anélkül, hogy elolvasta
// volna a fölötte lévő sort.
const TEST_EVENT_CODE_GATE_ENV = 'SBO_ALLOW_TEST_EVENT_CODE_KV_WRITE';

function testEventCodeKvScript(kv, code) {
  return (
    '#!/usr/bin/env bash\n' +
    'set -euo pipefail\n' +
    '# ⛔⛔⛔ EZ NEM PRODUCTION-KIMENET ⛔⛔⛔\n' +
    `# A site-config meta.test_event_code = "${code}" — vagyis MINDEN konverzió, ami\n` +
    '# ezzel a configgal fut, a Meta TEST streambe megy, és a production Events\n' +
    '# Managerben NEM jelenik meg. A KV-config edge-cache-elt (cacheTtl=300s), ezért\n' +
    '# a kivétele után még ~5 percig VALÓDI leadek is a Test streambe eshetnek.\n' +
    '# Ez a hiba KÉTSZER megtörtént élesben (CLAUDE.md 17).\n' +
    '#\n' +
    '# A szentesített teszt-mechanizmus a PER-REQUEST test_event_code (a szerver-\n' +
    '# ingress body `test_event_code` mezője) — ahhoz ezt a scriptet nem kell futtatni.\n' +
    `if [ "\${${TEST_EVENT_CODE_GATE_ENV}:-}" != "1" ]; then\n` +
    '  echo "REFUSING: test_event_code KV write blocked (CLAUDE.md 17)." >&2\n' +
    `  echo "Szándékos, eldobható teszt-namespace-hez: ${TEST_EVENT_CODE_GATE_ENV}=1 $0" >&2\n` +
    '  exit 1\n' +
    'fi\n' +
    kv +
    '\n'
  );
}

const TEST_EVENT_CODE_BANNER =
  '> ⛔ **TESZT-BUILD — NEM PRODUCTION.** Ez a config `meta.test_event_code`-ot tartalmaz:\n' +
  '> minden konverzió a Meta Test streambe menne, a production Events Managerben nem\n' +
  '> látszana, és a KV edge-cache miatt a kivétel után is ~5 percig. A KV-feltöltő\n' +
  '> script ezért `kv-put.TEST-EVENT-CODE.sh` néven, futtatáskor megálló kapuval készült.\n' +
  '> Production-configot `test_event_code` NÉLKÜL generálj (CLAUDE.md 17).\n\n';

function main() {
  const args = parseArgs(argv.slice(2));
  let cfg;
  try {
    cfg = JSON.parse(readInput(args.input));
  } catch (e) {
    console.error('Hibás JSON input:', e.message);
    exit(1);
  }

  validate(cfg, { allowTestEventCode: args.allowTestEventCode, newSite: args.newSite });
  if (ERRORS.length) {
    console.error('❌ Validációs hibák:\n' + ERRORS.map((e) => '  - ' + e).join('\n'));
    exit(1);
  }

  // Per-site CRM token: a hash a KV-be (SiteConfig), a plaintext a CRM-deploynak.
  const crm = resolveCrmToken(cfg);

  // Token-rotációs guard: ha a generátor ÚJ random tokent gyártana (nincs `crm_token`
  // az inputban), az felülírná a KV-ben élő `crm_token_sha256`-ot — a site backendje
  // a RÉGI tokennel 401-et kapna a /lead-status-on (néma offline-loop-szakadás).
  // A generátor SZÁNDÉKOSAN tiszta (nem néz KV-t), ezért nem tudja, létezik-e a site;
  // helyette EXPLICIT szándékot kér. Három út:
  //   --new-site       első onboarding — új token OK
  //   --rotate-token   szándékos rotáció meglévő site-on — új token OK (a CRM-et is újradeployolod)
  //   crm_token az inputban → a meglévőt hash-eljük, nincs szükség flagre
  if (crm.generated && !args.newSite && !args.rotateToken) {
    console.error(
      '❌ Új per-site CRM token generálódna, de nincs megadva a szándék.\n' +
        '   Ha ez ELSŐ onboarding:            add hozzá a --new-site flaget.\n' +
        '   Ha SZÁNDÉKOS rotáció (meglévő site): add hozzá a --rotate-token flaget\n' +
        '                                       (és utána deployold újra a CRM-et az új tokennel).\n' +
        '   Ha a MEGLÉVŐ tokent akarod újrahasználni: tedd be `crm_token`-ként az inputba.\n' +
        '   (E guard nélkül egy sima újrafuttatás némán elrontaná a live site auth-ját.)'
    );
    exit(1);
  }

  const siteConfig = toSiteConfig(cfg, {
    crmTokenSha256: crm.hash,
    allowTestEventCode: args.allowTestEventCode,
    // Derivált expected_platforms CSAK első onboardingnál — lásd a helper doc-ját.
    deriveExpectedPlatforms: args.newSite
  });

  // #17 MARADÉK-RÉS BEZÁRÁSA (P0.4). A hard gate eddig csak a flag NÉLKÜLI utat
  // zárta: `--allow-test-event-code`-dal a kód a KV-configba is beíródott, és a
  // legenerált `kv-put.sh` egy közönséges, azonnal futtatható production-parancs
  // volt — pontosan az a recept, amivel KÉTSZER szivárgott éles konverzió a Meta
  // Test streambe. A flag ezután is létezik (a szándékos teszt-config kell), de a
  // kimenet NEM lehet production-használható: más fájlnév + a script tetején egy
  // kapu, amit szándékosan, kézzel kell kinyitni.
  const testEventCodeBuild = !!(args.allowTestEventCode && cfg.meta?.test_event_code);

  const json = JSON.stringify(siteConfig, null, 2);
  const routes = routeBlock(cfg.hostnames);
  const kv = kvPutCommands(cfg.hostnames, json, args.kvNamespaceId);
  const checklist = (testEventCodeBuild ? TEST_EVENT_CODE_BANNER : '') + integrationChecklist(cfg);
  const secretEnv = crmSecretEnv(cfg, crm.token);
  const kvScriptName = testEventCodeBuild ? 'kv-put.TEST-EVENT-CODE.sh' : 'kv-put.sh';
  const kvScript = testEventCodeBuild
    ? testEventCodeKvScript(kv, cfg.meta.test_event_code)
    : '#!/usr/bin/env bash\nset -euo pipefail\n' + kv + '\n';

  if (WARNINGS.length) console.error('⚠️  Figyelmeztetések:\n' + WARNINGS.map((w) => '  - ' + w).join('\n') + '\n');
  if (testEventCodeBuild)
    console.error(
      `⛔ TESZT-BUILD (meta.test_event_code = "${cfg.meta.test_event_code}"). A KV-feltöltő script\n` +
        `   NEM production-kimenet: ${kvScriptName} néven készül, és futtatáskor kapuval megáll.\n` +
        '   Production-configot test_event_code NÉLKÜL generálj (CLAUDE.md 17).\n'
    );
  if (crm.passthrough)
    console.error(
      '🔁 crm_token_sha256 ÁTENGEDVE — a per-site token VÁLTOZATLAN, rotáció nem történt.\n' +
        '   A CRM-deploy meglévő TRACKING_ADMIN_TOKEN secretjéhez ne nyúlj.\n'
    );
  if (crm.generated)
    console.error(
      `🔑 Per-site CRM token GENERÁLVA — mentsd el MOST (a KV csak a hash-t tárolja, visszafejteni nem lehet):\n   ${crm.token}\n`
    );

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(`${args.out}/site-config.json`, json + '\n');
    writeFileSync(`${args.out}/routes.toml`, routes + '\n');
    writeFileSync(`${args.out}/${kvScriptName}`, kvScript);
    writeFileSync(`${args.out}/crm-secret.env`, secretEnv);
    writeFileSync(`${args.out}/INTEGRATION.md`, checklist);
    console.error(
      `✅ Kiírva: ${args.out}/ (site-config.json, routes.toml, ${kvScriptName}, crm-secret.env, INTEGRATION.md)`
    );
  } else {
    console.log('=== KV site-config (' + cfg.hostnames.join(', ') + ') ===\n' + json);
    console.log('\n=== wrangler.toml route-blokk ===\n' + routes);
    console.log(`\n=== KV put parancsok (${kvScriptName}) ===\n` + kvScript);
    console.log('\n=== CRM-deploy secrets (crm-secret.env) ===\n' + secretEnv);
    console.log('\n=== Integrációs ellenőrzőlista ===\n' + checklist);
  }
}

main();
