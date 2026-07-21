import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard-teszt a scripts/generate-site.mjs onboarding-generátorra (Run 6).
 *
 * A generátor a repó "source of truth"-ja a site-bekötéshez; a Run 6 tanulságok
 * óta több csendes-hiba-kaput épített be, amiket egy jövőbeli szerkesztés nem
 * bonthat meg észrevétlenül:
 *  - #4  a checklist KÜLÖN sorolja a böngésző- és a szerver-only konverziókat
 *        (server_ingress_only), hogy egy új site ne a böngésző-útra huzalozza a
 *        form-leadeket (TRK-400-017 + néma konverzióvesztés lenne);
 *  - Turnstile KIKERÜLT a böngésző-útból (Origin-gate) → a generált checklist NEM
 *        írhat elő Turnstile-widgetet a tracking miatt;
 *  - #17 KV `test_event_code` default HIBA (Meta Test-stream leak), csak explicit
 *        --allow-test-event-code opt-innel megy át;
 *  - a gads.conversion_actions kulcsai CSAK kanonikus event-nevek lehetnek.
 *
 * A valós scriptet futtatjuk alfolyamatként (nem importáljuk — a main() top-level
 * fut és stdin-t olvasna).
 */

const SCRIPT = fileURLToPath(new URL('../scripts/generate-site.mjs', import.meta.url));

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'gensite-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

interface GenResult {
  status: number;
  stdout: string;
  stderr: string;
  out: string;
}

let seq = 0;
function runGen(config: Record<string, unknown>, extraArgs: string[] = []): GenResult {
  const id = `case-${seq++}`;
  const inputPath = join(workdir, `${id}.json`);
  const outDir = join(workdir, id);
  writeFileSync(inputPath, JSON.stringify(config));
  // spawnSync (nem execFileSync): a stderr-t SIKERES futásnál is elkapjuk — a
  // generátor a token-üzenetet (GENERÁLVA) exit 0-nál is stderr-re írja.
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--input', inputPath, '--out', outDir, ...extraArgs],
    { encoding: 'utf8' }
  );
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: outDir
  };
}

const baseConfig = (): Record<string, any> => ({
  site_id: 'guardtest',
  hostnames: ['guardtest.hu', 'www.guardtest.hu'],
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  meta: { pixel_id: '123456', access_token: 'TESTTOKEN' },
  gads: { customer_id: null, login_customer_id: null },
  // Determinisztikus token — így ezek a tesztek a token-rotációs guardtól
  // FÜGGETLENÜL futnak (a guardnak külön blokkja van lentebb). Valós onboardingnál
  // a crm_token gyakran hiányzik → generálódik, de akkor --new-site/--rotate-token kell.
  crm_token: 'fixed-deterministic-test-crm-token-32chars'
});

describe('generate-site.mjs — Run 6 onboarding invariánsok', () => {
  it('valid config → exit 0 és INTEGRATION.md legenerálódik', () => {
    const r = runGen(baseConfig());
    expect(r.status).toBe(0);
    const checklist = readFileSync(join(r.out, 'INTEGRATION.md'), 'utf8');
    expect(checklist).toContain('guardtest');
  });

  it('a checklist SZÉTVÁLASZTJA a böngésző- és a szerver-only konverziókat (#4)', () => {
    const r = runGen(baseConfig());
    const checklist = readFileSync(join(r.out, 'INTEGRATION.md'), 'utf8');
    // Szerver-only út: külön a form/lead-eventek + a hitelesített ingress + a 403-kód.
    expect(checklist).toContain('/api/event/conversion-server');
    expect(checklist).toContain('TRK-400-017');
    expect(checklist).toContain('quote_calculator_submitted'); // server_ingress_only
    // Böngésző-út: a kis kockázatú klikk-event.
    expect(checklist).toContain('phone_number_clicked');
  });

  it('a checklist NEM ír elő Turnstile-t a tracking miatt (Origin-gate, Run 6)', () => {
    const r = runGen(baseConfig());
    const checklist = readFileSync(join(r.out, 'INTEGRATION.md'), 'utf8');
    expect(checklist).not.toContain('PUBLIC_TURNSTILE_SITE_KEY');
    expect(checklist).not.toContain('cf-turnstile-invisible');
    expect(checklist).toContain('Origin allow-list');
  });

  it('KV test_event_code default HIBA (#17 Meta Test-stream leak)', () => {
    const cfg = baseConfig();
    cfg.meta.test_event_code = 'TEST_GUARD';
    const r = runGen(cfg);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('test_event_code');
  });

  it('KV test_event_code CSAK explicit --allow-test-event-code opt-innel megy át', () => {
    const cfg = baseConfig();
    cfg.meta.test_event_code = 'TEST_GUARD';
    const r = runGen(cfg, ['--allow-test-event-code']);
    expect(r.status).toBe(0);
  });

  it('gads.conversion_actions kanonikus offline event-nevet elfogad', () => {
    const cfg = baseConfig();
    cfg.gads.customer_id = '1234567890';
    cfg.gads.conversion_actions = { revenue_confirmed: '7665215416' };
    const r = runGen(cfg);
    expect(r.status).toBe(0);
    const sc = JSON.parse(readFileSync(join(r.out, 'site-config.json'), 'utf8'));
    expect(sc.gads.conversion_actions.revenue_confirmed).toBe('7665215416');
  });

  it('gads.conversion_actions NEM-kanonikus event-nevet elutasít (halott config-guard)', () => {
    const cfg = baseConfig();
    cfg.gads.customer_id = '1234567890';
    cfg.gads.conversion_actions = { quote_calculator_conversion: '123' }; // régi on-site név
    const r = runGen(cfg);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('conversion_actions');
  });
});

describe('generate-site.mjs — token-rotációs guard (F2-1)', () => {
  // A guard NÉLKÜL egy sima újrafuttatás (crm_token nélkül) új random tokent gyártana,
  // ami felülírná a KV-ben élő tokent → a site backendje 401-et kapna a /lead-status-on.
  const noToken = (): Record<string, any> => {
    const c = baseConfig();
    delete c.crm_token;
    return c;
  };

  it('crm_token nélkül, flag nélkül → MEGTAGADJA (exit 1)', () => {
    const r = runGen(noToken());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--new-site');
    expect(r.stderr).toContain('--rotate-token');
  });

  it('crm_token nélkül + --new-site → exit 0, token GENERÁLVA', () => {
    const r = runGen(noToken(), ['--new-site']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('GENERÁLVA');
    const sc = JSON.parse(readFileSync(join(r.out, 'site-config.json'), 'utf8'));
    expect(sc.crm_token_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('crm_token nélkül + --rotate-token → exit 0 (szándékos rotáció)', () => {
    const r = runGen(noToken(), ['--rotate-token']);
    expect(r.status).toBe(0);
  });

  it('crm_token az inputban → exit 0 flag NÉLKÜL, és determinisztikus (reuse)', () => {
    const a = runGen(baseConfig()); // baseConfig már ad crm_token-t
    const b = runGen(baseConfig());
    expect(a.status).toBe(0);
    const scA = JSON.parse(readFileSync(join(a.out, 'site-config.json'), 'utf8'));
    const scB = JSON.parse(readFileSync(join(b.out, 'site-config.json'), 'utf8'));
    // Ugyanaz az input crm_token → ugyanaz a hash (nem generálódik új).
    expect(scA.crm_token_sha256).toBe(scB.crm_token_sha256);
    expect(a.stderr).not.toContain('GENERÁLVA');
  });
});
