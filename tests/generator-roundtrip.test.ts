import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs helper, no type declarations by design
import { toGeneratorInput, semanticDiff, SITE_CONFIG_FIELDS } from '../scripts/lib/site-config.mjs';

/**
 * vNext P0.2 / cross-check A8 — GENERÁTOR ROUND-TRIP KONTRAKTUS.
 *
 * A kontraktus:
 *     parse(live_config) → generate → parse(generated) → semantic_equal(live_config)
 *
 * MIÉRT: a `toSiteConfig` fix mezőlistából épített, és a `consent`, `consent_strict`,
 * `recon`, `monitoring` blokkot NÉMÁN ELDOBTA. Következmény: egy sbo-consent pilot
 * site KV-jének puszta újragenerálása visszabillentette volna a site-ot
 * CookieYes-módba — nulla hibaüzenettel, nulla riasztással. Ugyanez vitte volna el
 * a `recon` blokkot (a napi cross-check némán kimarad) és a `monitoring: false`-t
 * (a nem-produkciós dummy minden nap CRITICAL-t adna).
 *
 * RED TEST: a fix ELŐTT az alábbi round-trip-esetek MIND buknak — a generált config
 * `consent`/`recon`/`monitoring`/`consent_strict`/`allowed_origins` nélkül jön vissza,
 * és az `expected_platforms` a hardcode-olt derivált értékre íródik felül.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/generate-site.mjs', import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../soborbo-tracking/server/site-config.schema.json', import.meta.url)), 'utf8')
);

let workdir: string;
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'roundtrip-'));
});
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

let seq = 0;
function generate(input: Record<string, unknown>, extraArgs: string[] = []) {
  const id = `rt-${seq++}`;
  const inputPath = join(workdir, `${id}.json`);
  const outDir = join(workdir, id);
  writeFileSync(inputPath, JSON.stringify(input));
  const r = spawnSync(process.execPath, [SCRIPT, '--input', inputPath, '--out', outDir, ...extraArgs], {
    encoding: 'utf8'
  });
  const configPath = join(outDir, 'site-config.json');
  return {
    status: r.status ?? 1,
    stderr: r.stderr ?? '',
    out: outDir,
    config: existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null
  };
}

/** Egy site KV-configja + a hostnevei → generálás → a visszakapott config. */
function roundTrip(live: Record<string, unknown>, hostnames: string[]) {
  const r = generate(toGeneratorInput(live, hostnames));
  return { ...r, diffs: r.config ? (semanticDiff(live, r.config) as string[]) : ['NO OUTPUT: ' + r.stderr] };
}

// ── Fixture-ök: a flotta ÉLŐ config-alakjai ──────────────────────────────────
// A crm_token_sha256 mindenhol jelen van (mint élesben) — ez engedi a regenerálást
// tokenrotáció nélkül.
const HASH = 'a'.repeat(64);

/** Sima HU leadgen-site (trapezlemezes-osztály). */
const plainLeadgen = () => ({
  site_id: 'trapezlemezes',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  crm_token_sha256: HASH,
  meta: { pixel_id: '1190487559035660', access_token: 'META_TOKEN' },
  gads: { customer_id: '3415114700', login_customer_id: null, conversion_actions: { lead_qualified: '7665215416' } },
  expected_platforms: { smoke: ['meta'], offline: ['gads'] }
});

/** A CMP-pilot site — EZ a legdrágább eset (P3.3, olcsokontenerhaz). */
const sboPilot = () => ({
  site_id: 'olcsokontenerhaz',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  consent_strict: true,
  consent: { provider: 'sbo', mode: 'basic' },
  crm_token_sha256: HASH,
  meta: { pixel_id: '987654321', access_token: 'META_TOKEN' },
  gads: { customer_id: '1234567890', login_customer_id: null },
  // 2026-08-14: az offline elvárás levéve erről a site-ról (terv 5.7). Ha a generátor
  // a hardcode-olt deriváltat írná vissza, ez a döntés minden regeneráláskor elveszne.
  expected_platforms: { smoke: ['meta'] },
  recon: { ga4_property_id: '453881143', gads_onsite_actions: { callback_request_submitted: 'Callback requested' } },
  monitoring: true,
  allowed_origins: ['https://landing.olcsokontenerhaz.hu']
});

/** UK site (PECR-piac) + a monitoringból kivett dummy alakja. */
const ukSite = () => ({
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  require_consent: true,
  crm_token_sha256: HASH,
  meta: { pixel_id: '555555555', access_token: 'META_TOKEN' },
  gads: { customer_id: '9876543210', login_customer_id: '1111111111' },
  monitoring: false
});

/** meta-blokk NÉLKÜLI, élő config (lomtalan-osztály, 2026-07-15). */
const metaLess = () => ({
  site_id: 'lomtalan',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  crm_token_sha256: HASH,
  gads: { customer_id: '6763949425', login_customer_id: null }
});

/** Legacy diagnostics ga4-blokk + _comment (a séma engedi mindkettőt). */
const legacyGa4 = () => ({
  _comment: 'ga4 blokk CSAK a /debug-ga4 + régi DLQ-retry miatt maradt bent',
  site_id: 'beautyflow',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  crm_token_sha256: HASH,
  meta: { pixel_id: '444444444', access_token: 'META_TOKEN' },
  ga4: { measurement_id: 'G-ABC123', api_secret: 'GA4_SECRET' },
  gads: { customer_id: null }
});

describe('P0.2 — generátor round-trip (parse → generate → parse → semantic_equal)', () => {
  const cases: Array<[string, () => Record<string, unknown>, string[]]> = [
    ['sima HU leadgen', plainLeadgen, ['trapezlemezes.hu', 'www.trapezlemezes.hu']],
    ['sbo CONSENT-PILOT', sboPilot, ['olcsokontenerhaz.hu', 'www.olcsokontenerhaz.hu']],
    ['UK site + monitoring:false', ukSite, ['painlessremovals.com', 'www.painlessremovals.com']],
    ['meta-blokk NÉLKÜL', metaLess, ['lomtalan.hu', 'www.lomtalan.hu']],
    ['legacy ga4 + _comment', legacyGa4, ['beautyflow.pro', 'www.beautyflow.pro']]
  ];

  for (const [name, fixture, hosts] of cases) {
    it(`zero-diff: ${name}`, () => {
      const r = roundTrip(fixture(), hosts);
      expect(r.status, `generátor stderr:\n${r.stderr}`).toBe(0);
      expect(r.diffs, `GENERATOR_ROUNDTRIP_FAIL:\n${r.diffs.join('\n')}`).toEqual([]);
    });
  }

  it('a CMP-pilot flag TÚLÉLI az újragenerálást (a P3.3 flip előfeltétele)', () => {
    const r = roundTrip(sboPilot(), ['olcsokontenerhaz.hu']);
    // Ez az egyetlen mező, aminek az elvesztése némán VISSZABILLENTI a pilotot.
    expect(r.config.consent).toEqual({ provider: 'sbo', mode: 'basic' });
    expect(r.config.consent_strict).toBe(true);
  });

  it('az expected_platforms VERBATIM megy át (a 2026-08-14-i offline-levétel nem íródik vissza)', () => {
    const r = roundTrip(sboPilot(), ['olcsokontenerhaz.hu']);
    expect(r.config.expected_platforms).toEqual({ smoke: ['meta'] });
    expect(r.config.expected_platforms.offline).toBeUndefined();
  });

  it('a recon blokk megmarad (enélkül a napi cross-check némán kimaradna)', () => {
    const r = roundTrip(sboPilot(), ['olcsokontenerhaz.hu']);
    expect(r.config.recon?.ga4_property_id).toBe('453881143');
  });

  it('a monitoring:false megmarad (enélkül a dummy minden nap CRITICAL-t adna)', () => {
    const r = roundTrip(ukSite(), ['painlessremovals.com']);
    expect(r.config.monitoring).toBe(false);
  });

  it('crm_token_sha256 ÁTENGEDVE — nincs rotáció, flag sem kell', () => {
    const r = roundTrip(plainLeadgen(), ['trapezlemezes.hu']);
    expect(r.status).toBe(0);
    expect(r.config.crm_token_sha256).toBe(HASH);
    expect(r.stderr).not.toContain('GENERÁLVA');
    expect(r.stderr).toContain('ÁTENGEDVE');
  });

  it('crm_token + NEM egyező crm_token_sha256 → hard error (nem csendes felülírás)', () => {
    const input = toGeneratorInput(plainLeadgen(), ['trapezlemezes.hu']);
    input.crm_token = 'some-other-plaintext-token-32-chars';
    const r = generate(input);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NEM egyeznek');
  });

  it('ÚJ site (--new-site): a derivált expected_platforms default beáll', () => {
    const input: Record<string, any> = toGeneratorInput(plainLeadgen(), ['trapezlemezes.hu']);
    delete input.expected_platforms;
    const r = generate(input, ['--new-site']);
    expect(r.config.expected_platforms).toEqual({ smoke: ['meta'], offline: ['gads'] });
  });

  it('MEGLÉVŐ config regenerálása NEM ír hozzá expected_platforms-ot (viselkedésváltozás lenne)', () => {
    // Egy élő config, aminek nincs expected_platforms blokkja, a digest MEGFIGYELT
    // előzményére támaszkodik. A hozzáírás explicit elvárásra váltana — ezt tudatos
    // config-döntésként kell megtenni, nem egy regenerálás mellékhatásaként.
    const input: Record<string, any> = toGeneratorInput(plainLeadgen(), ['trapezlemezes.hu']);
    delete input.expected_platforms;
    const r = generate(input);
    expect(r.status).toBe(0);
    expect(r.config.expected_platforms).toBeUndefined();
  });

  it('ismeretlen input-mező HARD ERROR (a néma elnyelés-osztály lezárása)', () => {
    const input: Record<string, any> = toGeneratorInput(sboPilot(), ['olcsokontenerhaz.hu']);
    input.expected_platform = { smoke: ['meta'] }; // egyes szám — elgépelés
    const r = generate(input);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Ismeretlen input-mező');
    expect(r.stderr).toContain('expected_platform');
  });
});

describe('P0.2 — a séma az EGYETLEN mezőforrás (drift-őr)', () => {
  it('minden SiteConfig top-level mező szerepel a sémában', () => {
    const configTs = readFileSync(fileURLToPath(new URL('../src/lib/config.ts', import.meta.url)), 'utf8');
    const start = configTs.indexOf('export interface SiteConfig {');
    expect(start).toBeGreaterThan(-1);
    const end = configTs.indexOf('\n}', start);
    const body = configTs.slice(start, end);
    // Top-level mezők: PONTOSAN két szóköz behúzás (a beágyazott blokkok mélyebbek).
    const declared = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10); // a regex tényleg talált valamit

    const schemaFields = new Set(Object.keys(SCHEMA.properties));
    const missing = declared.filter((f) => !schemaFields.has(f));
    expect(
      missing,
      `Ezek a SiteConfig-mezők HIÁNYOZNAK a site-config.schema.json properties-ből, ezért a generátor ` +
        `NÉMÁN ELDOBNÁ őket egy KV-újragenerálásnál: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('a generátor pass-through listája a sémából jön (nem kézi felsorolás)', () => {
    expect(new Set(SITE_CONFIG_FIELDS)).toEqual(new Set(Object.keys(SCHEMA.properties)));
  });
});
