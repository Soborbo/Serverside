import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

/**
 * vNext P0.3 — CONSENT-KÖTELES PIACOK (a UK-rés).
 *
 * RED TEST: a fix előtt a kapu `EEA_COUNTRIES`-nak hívta magát, és a `GB` — jogilag
 * helyesen — nem volt EGT-tag, tehát kimaradt belőle. A KÖVETKEZMÉNY viszont hibás
 * volt: egy UK-site SEMMILYEN require_consent-figyelmeztetést nem kapott, pont azon a
 * piacon, ahol a PECR + UK GDPR előzetes hozzájárulást követel a süti-alapú
 * marketing-trackinghez. A fix visszavonásával (GB kivétele a halmazból) az első két
 * teszt bukik.
 */
describe('generate-site.mjs — consent-köteles piacok (P0.3)', () => {
  const gbSite = (): Record<string, any> => ({
    ...baseConfig(),
    site_id: 'ukguard',
    hostnames: ['ukguard.co.uk'],
    country_code: 'GB',
    currency: 'GBP',
    require_consent: false
  });

  it('GB + marketing-tracking + require_consent:false + ÚJ site → HARD ERROR', () => {
    const r = runGen(gbSite(), ['--new-site']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('require_consent');
    expect(r.stderr).toContain('GB');
    expect(r.stderr).toContain('PECR');
  });

  it('GB + require_consent hiányzik teljesen + ÚJ site → HARD ERROR (nem csak false-ra)', () => {
    const cfg = gbSite();
    delete cfg.require_consent;
    const r = runGen(cfg, ['--new-site']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('require_consent');
  });

  it('GB + require_consent:true → átmegy', () => {
    const cfg = gbSite();
    cfg.require_consent = true;
    const r = runGen(cfg, ['--new-site']);
    expect(r.status).toBe(0);
  });

  it('MEGLÉVŐ site regenerálása fail-open configgal → hangos WARNING, de nem blokkol', () => {
    // A regenerálást nem szabad blokkolni: enélkül pont a legacy configokat nem
    // lehetne javítani, és a P0.2 round-trip is futtathatatlan lenne rajtuk.
    const r = runGen(gbSite());
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('require_consent');
    expect(r.stderr).toContain('Figyelmeztetések');
  });

  it('US site → nincs consent-kapu (nem consent-köteles piac)', () => {
    const cfg = gbSite();
    cfg.country_code = 'US';
    cfg.currency = 'USD';
    const r = runGen(cfg, ['--new-site']);
    expect(r.status).toBe(0);
  });
});

/**
 * vNext P0.4 — a `test_event_code` bypass MARADÉK-RÉSE.
 *
 * Az alap hard gate megvolt (flag nélkül exit 1), de `--allow-test-event-code`-dal a
 * kód a KV-configba is beíródott, ÉS a legenerált `kv-put.sh` egy azonnal futtatható
 * production-parancs volt — pontosan az a recept, amivel kétszer szivárgott éles
 * konverzió a Meta Test streambe.
 *
 * RED TEST: a fix előtt az opt-inos futás `kv-put.sh`-t írt, benne csupasz
 * `wrangler kv key put` sorokkal, kapu nélkül.
 */
describe('generate-site.mjs — test_event_code bypass nem termel production-kimenetet (P0.4)', () => {
  const withTestCode = (): Record<string, any> => {
    const c = baseConfig();
    c.meta.test_event_code = 'TEST_GUARD';
    return c;
  };

  it('opt-innel NINCS kv-put.sh (a production-nevű script nem jön létre)', () => {
    const r = runGen(withTestCode(), ['--allow-test-event-code']);
    expect(r.status).toBe(0);
    expect(existsSync(join(r.out, 'kv-put.sh'))).toBe(false);
    expect(existsSync(join(r.out, 'kv-put.TEST-EVENT-CODE.sh'))).toBe(true);
  });

  it('a teszt-script FUTTATVA megáll (exit != 0), és nem hív wranglert', () => {
    const r = runGen(withTestCode(), ['--allow-test-event-code']);
    const script = join(r.out, 'kv-put.TEST-EVENT-CODE.sh');
    // A guard a fájl legelején van: a `wrangler kv key put` sorok mögötte állnak,
    // tehát a script nem futtathat KV-írást a kapu kinyitása nélkül.
    const run = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('REFUSING');
    expect(run.stdout ?? '').not.toContain('wrangler kv key put');
  });

  it('a kapu CSAK explicit env-változóval nyílik (eldobható teszt-namespace-hez)', () => {
    const r = runGen(withTestCode(), ['--allow-test-event-code']);
    const body = readFileSync(join(r.out, 'kv-put.TEST-EVENT-CODE.sh'), 'utf8');
    expect(body).toContain('SBO_ALLOW_TEST_EVENT_CODE_KV_WRITE');
    expect(body).toContain('CLAUDE.md 17');
  });

  it('az INTEGRATION.md tetején BLOKKOLÓ banner áll, nem egy checklist-sor a közepén', () => {
    const r = runGen(withTestCode(), ['--allow-test-event-code']);
    const checklist = readFileSync(join(r.out, 'INTEGRATION.md'), 'utf8');
    expect(checklist.split('\n')[0]).toContain('TESZT-BUILD');
    expect(checklist).toContain('NEM PRODUCTION');
  });

  it('test_event_code NÉLKÜL az opt-in flag semmit nem változtat (production-út ép)', () => {
    const r = runGen(baseConfig(), ['--allow-test-event-code']);
    expect(r.status).toBe(0);
    expect(existsSync(join(r.out, 'kv-put.sh'))).toBe(true);
    expect(existsSync(join(r.out, 'kv-put.TEST-EVENT-CODE.sh'))).toBe(false);
    expect(readFileSync(join(r.out, 'INTEGRATION.md'), 'utf8')).not.toContain('TESZT-BUILD');
  });
});

/**
 * 2026-08-24 review #4 — a GENERÁLT INTEGRATION.md provider-aware.
 *
 * RED TEST: a fix előtt a checklist minden site-nak ugyanazt írta — köztük
 * „CookieYes (GTM-ből) aktív" és „client-lib/ … bemásolva". Az első egy
 * `consent.provider: 'sbo'` confignál egyenesen HAMIS (ott nincs CookieYes-szkript,
 * a consent-boot szinkron, és a TrackingNoscript-et KI kell venni), a második pedig
 * MÁR MA is hamis: a flat `client-lib/` F2-2 óta törölve.
 *
 * Ez azért drágább hiba, mint egy elavult doksi-sor: a checklist minden új site
 * bekötésekor ÚJRATERMELŐDIK, és az onboardoló ember ebből dolgozik.
 */
describe('generate-site.mjs — a generált checklist provider-aware (review #4)', () => {
  const sboConfig = (): Record<string, any> => ({ ...baseConfig(), consent: { provider: 'sbo' } });

  it('sbo config → NINCS CookieYes-bekötés a checklistben', () => {
    const r = runGen(sboConfig());
    expect(r.status).toBe(0);
    const md = readFileSync(join(r.out, 'INTEGRATION.md'), 'utf8');
    expect(md).not.toContain('cookieYesId');
    expect(md).not.toContain('cookieyes-consent');
    expect(md).not.toContain('CookieYes aktív');
  });

  it('sbo config → a pilot-specifikus lépések MIND ott vannak', () => {
    const md = readFileSync(join(runGen(sboConfig()).out, 'INTEGRATION.md'), 'utf8');
    expect(md).toContain('PUBLIC_TRACKING_CONSENT_PROVIDER=sbo');
    expect(md).toContain('PUBLIC_TRACKING_POLICY_VERSION');
    expect(md).toContain('ConsentBanner');
    expect(md).toContain('consentId');
    // A noscript KIVÉTELE a lépés — nem a bekötése.
    expect(md).toContain('KIVÉVE');
    expect(md).not.toContain('<TrackingNoscript gtmId');
  });

  it('sbo config → a checklist FIGYELMEZTET, hogy ez pilot, nem onboarding-lépés', () => {
    const md = readFileSync(join(runGen(sboConfig()).out, 'INTEGRATION.md'), 'utf8');
    expect(md).toContain('PILOT');
    expect(md).toContain('cmp-fazis2-pilot-runbook');
  });

  it('provider nélküli (default) config → VÁLTOZATLANUL a CookieYes-ág', () => {
    const md = readFileSync(join(runGen(baseConfig()).out, 'INTEGRATION.md'), 'utf8');
    expect(md).toContain('CookieYes aktív');
    expect(md).toContain('TrackingNoscript');
    expect(md).not.toContain('PUBLIC_TRACKING_CONSENT_PROVIDER=sbo');
  });

  it('a törölt client-lib/ MÁR NEM telepítési lépés (mindkét providernél)', () => {
    for (const cfg of [baseConfig(), sboConfig()]) {
      const md = readFileSync(join(runGen(cfg).out, 'INTEGRATION.md'), 'utf8');
      expect(md).not.toMatch(/client-lib\/[^\n]{0,80}bemásolva/i);
      expect(md).toContain('soborbo-tracking');
    }
  });

  it('a provider a checklist FEJLÉCÉBEN is látszik (ne kelljen végigolvasni)', () => {
    expect(readFileSync(join(runGen(sboConfig()).out, 'INTEGRATION.md'), 'utf8')).toContain(
      '**Consent-provider:** `sbo`'
    );
    expect(readFileSync(join(runGen(baseConfig()).out, 'INTEGRATION.md'), 'utf8')).toContain(
      '**Consent-provider:** `cookieyes`'
    );
  });
});
