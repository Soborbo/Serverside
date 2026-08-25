#!/usr/bin/env node
/**
 * A harness ÖNTESZTJE — élő oldal nélkül bizonyítja, hogy a mérőműszer működik.
 *
 * Elindítja a helyi fixture-szervert, ráfuttatja a teljes harness-t, majd
 * ELVÁRÁSOKAT ellenőriz a keletkezett riporton:
 *   - a szándékos szabálysértéseket MIND megtalálta (nem hallgat el egyet sem),
 *   - a safety-net tartott: a fixture-szerverhez EGYETLEN nem-GET kérés sem ért be,
 *     pedig a fixture kétszer is próbálkozott (form.submit() + fetch POST).
 *
 * Kilépési kód != 0, ha bármelyik elvárás sérül — ez az egyetlen pont, ahol a
 * harness „bukhat"; a flotta-mérés FAIL-jei NEM futáshibák.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(HERE, 'last-run');
const PORT = process.env.COMPLIANCE_SELFTEST_PORT || '4187';

const run = (cmd, args, opts = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
    p.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${cmd} exit ${code}`))));
    p.on('error', rejectRun);
  });

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* még nem él */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`A fixture-szerver nem indult el: ${url}`);
}

const EXPECTED_FAILS = [
  'A_no_consent_bound_requests',
  'A_gtm_not_loaded_before_decision',
  'A_no_nonessential_cookies',
  'A_no_nonessential_storage_write',
  'A_no_nonessential_storage_read',
  'A_consent_default_before_gtm',
  'A_noscript_iframe_absent',
  'UI_reject_equal_prominence',
  'C_no_consent_bound_requests',
  'C_pings_carry_no_identifiers',
  'D_withdrawal_purges',
  // F7 — a fixture PII-t tol a dataLayerbe (CLAUDE.md 15.). Ez a szerzőtől
  // függetlenül jogsértés, tehát a statikus scannek FAIL-t kell adnia rá.
  'STATIC_no_pii_in_source'
];

/**
 * F7 — REPORT-ONLY megállapítások. Ezek szándékosan nem buktatnak, de az
 * öntesztnek bizonyítania KELL, hogy a műszer LÁTJA őket: egy néma INFO és egy
 * hiányzó ellenőrzés a riportban megkülönböztethetetlen lenne.
 */
const EXPECTED_INFOS = [
  'INV_unknown_vendors',
  'INV_unknown_vendor_pre_consent',
  'STATIC_no_forbidden_calls',
  'STATIC_runtime_gap'
];

const EXPECTED_PASSES = ['UI_reject_button_present', 'UI_clicks_to_reject', 'MISC_cookie_policy_names_third_parties'];

async function main() {
  const server = spawn(process.execPath, [join(HERE, 'serve.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, COMPLIANCE_SELFTEST_PORT: PORT }
  });
  const problems = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    await run(process.execPath, [
      join(HERE, '..', 'run.mjs'),
      `--sites-file=${join(HERE, 'sites.json')}`,
      `--out=${OUT}`,
      '--browser=chromium',
      '--scenarios=A,B,C,D'
    ]);

    const report = JSON.parse(await readFile(join(OUT, 'report.json'), 'utf8'));
    const site = report.results[0];
    if (!site || site.status === 'ERROR') throw new Error(`A fixture mérése hibára futott: ${site?.error}`);

    const byId = Object.fromEntries(site.checks.map((c) => [c.id, c]));
    for (const id of EXPECTED_FAILS) {
      if (byId[id]?.status !== 'FAIL') {
        problems.push(`${id}: FAIL-t vártunk, kaptunk ${byId[id]?.status ?? 'semmit'} — a műszer NEM látja a szabálysértést`);
      }
    }
    for (const id of EXPECTED_PASSES) {
      if (byId[id]?.status !== 'PASS') {
        problems.push(`${id}: PASS-t vártunk, kaptunk ${byId[id]?.status ?? 'semmit'} — a műszer HAMIS riasztást ad`);
      }
    }

    for (const id of EXPECTED_INFOS) {
      if (byId[id]?.status !== 'INFO') {
        problems.push(`${id}: INFO-t vártunk, kaptunk ${byId[id]?.status ?? 'semmit'} — a report-only műszer néma`);
      }
    }

    // Az ismeretlen vendort NÉVVEL kell megneveznie: egy szám („1 ismeretlen")
    // nem elég ahhoz, hogy reggel el lehessen dönteni, mit kell csinálni vele.
    const unknownEvidence = JSON.stringify(byId['INV_unknown_vendors']?.evidence ?? []);
    if (!unknownEvidence.includes('selftest-unknown-vendor.test')) {
      problems.push(
        'INV_unknown_vendors: a bizonyíték nem nevezi meg a fixture ismeretlen hostját — ' +
          `kaptuk: ${unknownEvidence.slice(0, 200)}`
      );
    }

    // A leltárnak MINDEN fázisból építkeznie kell, és nem szabad a first-party
    // saját kéréseit vendorként felsorolnia.
    const inv = site.inventory;
    if (!inv || !Array.isArray(inv.rows) || inv.rows.length === 0) {
      problems.push('A vendor-leltár üres — pedig a fixture Google/Meta/ismeretlen kéréseket is indít');
    } else if (inv.rows.some((r) => r.category === 'first_party')) {
      problems.push('A leltárban first-party sor van — a saját kérések nem vendorok, elnyomnák a jelet');
    }

    // A statikus scan a forrásban DEKLARÁLT, de sosem futó Ads-azonosítót is lássa.
    const gapEvidence = JSON.stringify(byId['STATIC_runtime_gap']?.evidence ?? []);
    if (!gapEvidence.includes('google_ads_conversion')) {
      problems.push(
        'STATIC_runtime_gap: a forrásban deklarált, de futásidőben néma Ads-azonosítót nem nevezte meg — ' +
          `kaptuk: ${gapEvidence.slice(0, 200)}`
      );
    }

    // Minden FAIL mellett KELL bizonyíték.
    for (const c of site.checks) {
      if (c.status === 'FAIL' && (c.evidence === null || c.evidence === undefined)) {
        problems.push(`${c.id}: FAIL bizonyíték nélkül — az állítás önmagában nem elég`);
      }
    }

    // A SAFETY-NET: a szerverhez egyetlen nem-GET kérés sem érkezhetett.
    const received = await (await fetch(`http://localhost:${PORT}/__received`)).json();
    if (received.posts.length > 0) {
      problems.push(
        `SAFETY-NET LYUKAS: ${received.posts.length} nem-GET kérés ért be a fixture-szerverhez: ` +
          JSON.stringify(received.posts.slice(0, 5))
      );
    }
    const blocked = site.blocked_first_party_writes || [];
    if (blocked.length === 0) {
      problems.push('A safety-net egyetlen first-party írást sem blokkolt — a fixture kettőt próbál, tehát a hálózati abort nem fut');
    }
    const submits = site.scenarios?.A_before_decision?.page?.blockedSubmits || [];
    if (submits.length === 0) problems.push('A DOM submit-blokk nem fogott meg semmit, pedig a fixture hív egy form.submit()-ot');

    console.log('\n── Önteszt ────────────────────────────────────────────');
    console.log(`Ellenőrzések: ${site.checks.length} · FAIL: ${site.checks.filter((c) => c.status === 'FAIL').length}`);
    console.log(`Blokkolt first-party írás: ${blocked.length} · blokkolt submit: ${submits.length}`);
    console.log(`A fixture-szerverhez beérkezett nem-GET kérés: ${received.posts.length} (elvárás: 0)`);
  } finally {
    server.kill();
  }

  if (problems.length) {
    console.error('\nÖNTESZT BUKOTT:');
    for (const p of problems) console.error(` - ${p}`);
    process.exit(1);
  }
  console.log('Önteszt: OK — a mérőműszer minden szándékos szabálysértést lát, és a safety-net tart.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
