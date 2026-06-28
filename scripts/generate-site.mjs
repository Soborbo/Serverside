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
 *   node scripts/generate-site.mjs --input site.json [--out dir/] [--kv-namespace-id ID]
 *   cat site.json | node scripts/generate-site.mjs
 *
 * Nincs külső függőség (csak Node built-in). Determinisztikus: ugyanaz az input
 * ugyanazt a kimenetet adja.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// A wrangler.toml-ban rögzített SITE_CONFIG KV namespace (alapértelmezett).
const DEFAULT_SITE_CONFIG_NS = 'edd34e28eee847c09c26f9d9e3ea04ab';

// Kanonikus event-forrás — a repó SINGLE SOURCE OF TRUTH-ja (src/events.json).
// NINCS kézi másolat: a generátor pontosan azt fogadja el, amit a worker (§1).
const EVENTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/events.json', import.meta.url)), 'utf8')
);
// A kliens által küldhető (ingress) event-nevek: server-csatornás, NEM offline.
const INGRESS_EVENT_NAMES = EVENTS.filter(
  (e) => e.channels.includes('server') && e.kind !== 'offline'
).map((e) => e.name);
// gads.conversion_actions kulcsai BÁRMELY kanonikus event lehetnek (Modell 2-ben
// jellemzően az offline CRM-eventek: lead_qualified, booking_confirmed, …), plusz a
// legacy GA4 aliasok a migráció alatt.
const VALID_ACTION_EVENTS = new Set([
  ...EVENTS.map((e) => e.name),
  ...EVENTS.map((e) => e.legacy_ga4).filter(Boolean)
]);

const ALLOWED_COUNTRIES = new Set(['GB', 'HU', 'EU', 'US', 'DE', 'FR', 'IT', 'ES']);
const EEA_COUNTRIES = new Set(['HU', 'EU', 'DE', 'FR', 'IT', 'ES']);

function parseArgs(args) {
  const out = { input: null, out: null, kvNamespaceId: DEFAULT_SITE_CONFIG_NS, allowTestEventCode: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') out.input = args[++i];
    else if (args[i] === '--out') out.out = args[++i];
    else if (args[i] === '--kv-namespace-id') out.kvNamespaceId = args[++i];
    else if (args[i] === '--allow-test-event-code') out.allowTestEventCode = true;
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

  // Meta
  if (!cfg.meta || typeof cfg.meta !== 'object') err('meta blokk kötelező.');
  else {
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

  // GA4
  if (!cfg.ga4 || typeof cfg.ga4 !== 'object') err('ga4 blokk kötelező.');
  else {
    if (!/^G-[A-Z0-9]+$/.test(String(cfg.ga4.measurement_id || '')))
      err(`ga4.measurement_id érvénytelen (G-XXXX formátum kell), kapott: ${cfg.ga4.measurement_id}`);
    if (!cfg.ga4.api_secret) err('ga4.api_secret kötelező (MP api_secret a GA4 admin felületről).');
  }

  // Google Ads (opcionális — customer_id lehet null)
  if (!cfg.gads || typeof cfg.gads !== 'object') err('gads blokk kötelező (customer_id lehet null).');
  else {
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
    if (cid && !cfg.gads.conversion_actions)
      warn('gads.customer_id meg van adva, de nincs conversion_actions — a Google Ads konverziók kimaradnak.');
  }

  // Per-site CRM token (opcionális input). Ha megadod, determinisztikusan
  // hash-eljük; ha nem, a generátor generál egyet (lásd resolveCrmToken).
  if (cfg.crm_token !== undefined && cfg.crm_token !== null) {
    if (typeof cfg.crm_token !== 'string' || cfg.crm_token.length < 16)
      err('crm_token érvénytelen (string, ≥16 karakter) vagy hagyd ki (akkor generálódik).');
  }

  // Consent default ajánlás EEA-ra
  if (EEA_COUNTRIES.has(cfg.country_code) && cfg.require_consent !== true)
    warn(
      `country_code=${cfg.country_code} (EEA) — ajánlott require_consent: true (GDPR fail-closed). Jelenleg: ${cfg.require_consent}.`
    );
}

/** A worker SiteConfig alakja (src/lib/config.ts) — pontosan ezt tesszük a KV-be. */
function toSiteConfig(cfg) {
  const sc = {
    site_id: cfg.site_id,
    country_code: cfg.country_code,
    currency: cfg.currency,
    meta: {
      pixel_id: String(cfg.meta.pixel_id),
      access_token: cfg.meta.access_token
    },
    ga4: {
      measurement_id: cfg.ga4.measurement_id,
      api_secret: cfg.ga4.api_secret
    },
    gads: {
      customer_id: cfg.gads.customer_id ?? null,
      login_customer_id: cfg.gads.login_customer_id ?? null
    }
  };
  if (cfg.meta.test_event_code) sc.meta.test_event_code = cfg.meta.test_event_code;
  if (cfg.gads.conversion_actions) sc.gads.conversion_actions = cfg.gads.conversion_actions;
  if (cfg.require_consent === true) sc.require_consent = true;
  return sc;
}

/**
 * Per-site CRM offline-loop token. A KV-be CSAK a SHA-256 hash kerül
 * (crm_token_sha256); a plaintext a crm-secret.env-be megy a CRM-deploynak.
 * Ha az input ad `crm_token`-t → determinisztikus (azt hash-eljük). Ha nem →
 * random 32 bájt (base64url), és figyelmeztetünk, hogy mentsd el MOST.
 */
function resolveCrmToken(cfg) {
  let token = cfg.crm_token;
  let generated = false;
  if (!token) {
    token = randomBytes(32).toString('base64url');
    generated = true;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash, generated };
}

function crmSecretEnv(cfg, token) {
  const url = `https://${cfg.hostnames[0]}/api/event/lead-status`;
  return (
    `# ${cfg.site_id} — CRM offline-loop secrets. Állítsd be a CRM-deploy secretjeiként\n` +
    `# (wrangler secret put / dashboard). A token plaintextje CSAK ITT szerepel —\n` +
    `# a Worker KV-jében csak a SHA-256 hash van. Ne commitold.\n` +
    `TRACKING_WORKER_URL=${url}\n` +
    `TRACKING_ADMIN_TOKEN=${token}\n`
  );
}

function routeBlock(hostnames) {
  // A zóna a fő (apex) domain — a www-t is ugyanaz a zóna szolgálja ki.
  const apex = hostnames
    .map((h) => h.replace(/^www\./, ''))
    .reduce((a, b) => (a.length <= b.length ? a : b));
  return hostnames
    .map((h) => `[[routes]]\npattern = "${h}/api/event/*"\nzone_name = "${apex}"`)
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

function integrationChecklist(cfg) {
  const host = cfg.hostnames[0];
  return `# Integrációs ellenőrzőlista — ${cfg.site_id} (${host})

## Worker oldal
- [ ] KV-bejegyzés(ek) feltöltve (lásd kv-put.sh / a fenti parancsok)
- [ ] wrangler.toml: route-blokk hozzáadva (lásd routes.toml) → \`wrangler deploy\`
- [ ] (ha Google Ads) OAuth elvégezve a customer_id-ra: GET /api/event/oauth-init (X-Admin-Token)
${cfg.meta.test_event_code ? '- [ ] ⚠️ test_event_code KIVÉVE a KV-ből élesítés előtt' : ''}

## CRM offline-loop (server-to-server)
- [ ] CRM-deploy secretjei beállítva a crm-secret.env-ből: \`TRACKING_WORKER_URL\` + \`TRACKING_ADMIN_TOKEN\`
- [ ] A KV site-config tartalmazza a \`crm_token_sha256\`-ot (a kv-put.sh ezt felteszi) → a globális
      ADMIN_API_TOKEN MÁR NEM ír ehhez a site-hoz (tenant-izoláció)
- [ ] Teszt: a CRM \`lezart_nyert\` → POST /api/event/lead-status → 200; ROSSZ tokennel → 401

## Astro site oldal
- [ ] client-lib/ (worker-tracking.ts + uuid.ts) bemásolva az Astro projekt src/lib/-jébe
- [ ] PUBLIC_TURNSTILE_SITE_KEY beállítva (.env) + Turnstile invisible widget az oldalon
      (\`<div id="cf-turnstile-invisible">\`)
- [ ] CookieYes (GTM-ből) aktív → a consent automatikusan a cookieyes-consent cookie-ból jön
- [ ] Konverziós pontokon: \`trackConversion('<event_name>', { value, currency, user_data })\`
      Engedett event-nevek: ${INGRESS_EVENT_NAMES.join(', ')}

## Ellenőrzés (deploy után)
- [ ] curl https://${host}/api/event/health → {"status":"ok"}
- [ ] Meta Events Manager → Test Events: a böngésző + szerver event AZONOS event_id-vel (dedup)
- [ ] GA4 DebugView: a konverzió + (ha UTM) campaign_details látszik
- [ ] Google Ads → Conversions: a feltöltés megjelenik (gclid match vagy Enhanced Conversions)
- [ ] Cloudflare Workers Logs: nincs TRK-* error 24h-n át
`;
}

function main() {
  const args = parseArgs(argv.slice(2));
  let cfg;
  try {
    cfg = JSON.parse(readInput(args.input));
  } catch (e) {
    console.error('Hibás JSON input:', e.message);
    exit(1);
  }

  validate(cfg, { allowTestEventCode: args.allowTestEventCode });
  if (ERRORS.length) {
    console.error('❌ Validációs hibák:\n' + ERRORS.map((e) => '  - ' + e).join('\n'));
    exit(1);
  }

  const siteConfig = toSiteConfig(cfg);
  // Per-site CRM token: a hash a KV-be (SiteConfig), a plaintext a CRM-deploynak.
  const crm = resolveCrmToken(cfg);
  siteConfig.crm_token_sha256 = crm.hash;

  const json = JSON.stringify(siteConfig, null, 2);
  const routes = routeBlock(cfg.hostnames);
  const kv = kvPutCommands(cfg.hostnames, json, args.kvNamespaceId);
  const checklist = integrationChecklist(cfg);
  const secretEnv = crmSecretEnv(cfg, crm.token);

  if (WARNINGS.length) console.error('⚠️  Figyelmeztetések:\n' + WARNINGS.map((w) => '  - ' + w).join('\n') + '\n');
  if (crm.generated)
    console.error(
      `🔑 Per-site CRM token GENERÁLVA — mentsd el MOST (a KV csak a hash-t tárolja, visszafejteni nem lehet):\n   ${crm.token}\n`
    );

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(`${args.out}/site-config.json`, json + '\n');
    writeFileSync(`${args.out}/routes.toml`, routes + '\n');
    writeFileSync(`${args.out}/kv-put.sh`, '#!/usr/bin/env bash\nset -euo pipefail\n' + kv + '\n');
    writeFileSync(`${args.out}/crm-secret.env`, secretEnv);
    writeFileSync(`${args.out}/INTEGRATION.md`, checklist);
    console.error(
      `✅ Kiírva: ${args.out}/ (site-config.json, routes.toml, kv-put.sh, crm-secret.env, INTEGRATION.md)`
    );
  } else {
    console.log('=== KV site-config (' + cfg.hostnames.join(', ') + ') ===\n' + json);
    console.log('\n=== wrangler.toml route-blokk ===\n' + routes);
    console.log('\n=== KV put parancsok ===\n' + kv);
    console.log('\n=== CRM-deploy secrets (crm-secret.env) ===\n' + secretEnv);
    console.log('\n=== Integrációs ellenőrzőlista ===\n' + checklist);
  }
}

main();
