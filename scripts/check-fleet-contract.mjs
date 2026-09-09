#!/usr/bin/env node
/**
 * A FLOTTA szerver-labainak szerzodes-riportja — EGY paranccsal.
 *
 * ── Miert van kulon a `check-backend-contract.mjs`-tol ───────────────────────
 * Az EGY fajlt mero szkript a kapu: a CI-ban fut, es a KANONIKUS fajlt orzi. Ez
 * itt a RIPORT: vegigmeri a flotta osszes site-jat, es egy tablazatot ad. Ketto
 * kulon dolog, mert a kapu bukhat (exit 1), a riport viszont akkor is ertekes,
 * ha valamelyik site epp piros.
 *
 * ── Miert `gh api`, es miert nem uj titok ────────────────────────────────────
 * A site-ok KULON, privat repokban vannak. Egy Serverside-beli utemezett
 * workflow cross-repo tokent igenyelne — a Serverside-nak MA nulla repo-secretje
 * van, es egy uj PAT bevezetese ops-dontes, nem az enyem. A `gh` CLI viszont a
 * fejleszto gepen MAR hitelesitve van, tehat a flotta-meres ott egy parancs, uj
 * jogosultsag nelkul. Ezert ez LOKALIS szerszam, nem CI-lepes.
 *
 * ── Miert MERJUK az sbo-kepesseget, es nem irjuk fel ─────────────────────────
 * A site sbo-kepesseget a repo git-fajabol allapitjuk meg (van-e valahol
 * `consent-sbo-state.ts`), nem egy kezzel karbantartott oszlopbol. Egy statikus
 * igen/nem lista pontosan ugy sodrodna el, mint a verzio-cimke, amit ez az egesz
 * eszkoz meroszamnak szant — es a hazug „nem sbo-kepes" epp az sbo-szabalyokat
 * kapcsolna ki azon a siteon, ahol szamitanak.
 *
 * Hasznalat:
 *   node scripts/check-fleet-contract.mjs [--json] [--site=<nev>]
 *
 * Kilepesi kod: 0 ha minden site teljesiti az ERVENYES szabalyait, 1 ha barmelyik
 * bukik, 2 ha egy site fajlja/faja egyaltalan nem volt olvashato (a MERETLEN nem
 * ugyanaz, mint a zold — ezt kulon jelezzuk).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBackendContract } from './check-backend-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'scripts', 'fleet-sites.json');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** A repo default aga — nem feltetelezzuk, hogy `main` (a Beautyflow `master`). */
export function defaultBranch(repo, run = gh) {
  return run(['api', `repos/${repo}`, '--jq', '.default_branch']).trim();
}

/** A szerver-lab forrasa a default agrol. */
export function fetchFile(repo, branch, filePath, run = gh) {
  const b64 = run(['api', `repos/${repo}/contents/${filePath}?ref=${branch}`, '--jq', '.content']);
  return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
}

/**
 * Sbo-kepes-e a site — a REPO git-fajabol. A `consent-sbo-state.ts` a sajat CMP
 * suti-formatumanak kanonikus definicioja: ha ott van, a bongeszo IRHAT
 * `sbo_consent`-et, tehat a szerver-labnak OLVASNIA kell.
 */
export function detectSboFromRepo(repo, branch, run = gh) {
  const paths = run([
    'api',
    `repos/${repo}/git/trees/${branch}?recursive=1`,
    '--jq',
    '[.tree[].path] | join("\\n")'
  ]);
  return paths.split('\n').some((p) => /(^|\/)consent-sbo-state\.ts$/.test(p.trim()));
}

function main(argv) {
  const json = argv.includes('--json');
  const only = /^--site=(.+)$/.exec(argv.find((a) => a.startsWith('--site=')) ?? '')?.[1] ?? null;

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const sites = cfg.sites.filter((s) => !only || s.site === only);
  if (sites.length === 0) {
    console.error(`Nincs ilyen site a ${path.relative(ROOT, CONFIG)}-ban: ${only}`);
    process.exit(2);
  }

  const rows = [];
  for (const s of sites) {
    try {
      const branch = defaultBranch(s.repo);
      const sbo = detectSboFromRepo(s.repo, branch);
      const src = fetchFile(s.repo, branch, s.path);
      const r = checkBackendContract(`${s.repo}:${s.path}`, src, s.site, sbo);
      rows.push({ ...r, branch, unreadable: false });
    } catch (err) {
      // A MERETLEN nem zold. Kulon allapot, kulon kilepesi kod.
      rows.push({
        site: s.site,
        file: `${s.repo}:${s.path}`,
        unreadable: true,
        error: String(err?.message ?? err).split('\n')[0],
        rows: [],
        failed: 0,
        skipped: 0
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ sites: rows }, null, 2));
  } else {
    const w = Math.max(...rows.map((r) => r.site.length), 4);
    console.log(`\n  ${'SITE'.padEnd(w)}  ${'BACKEND_LIB_VERSION'.padEnd(26)}  SZERZODES`);
    console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(26)}  ${'-'.repeat(34)}`);
    for (const r of rows) {
      if (r.unreadable) {
        console.log(`  ${r.site.padEnd(w)}  ${'(OLVASHATATLAN)'.padEnd(26)}  ${r.error}`);
        continue;
      }
      const live = r.rows.length - r.skipped;
      const verdict =
        r.failed === 0
          ? `${live}/${live} OK${r.skipped ? ` (${r.skipped} kihagyva — nem sbo-kepes)` : ''}`
          : `${live - r.failed}/${live} — bukik: ${r.rows.filter((x) => x.applies && !x.ok).map((x) => x.id).join(', ')}`;
      console.log(`  ${r.site.padEnd(w)}  ${(r.version ?? '(nincs)').padEnd(26)}  ${verdict}`);
    }
    const bad = rows.filter((r) => !r.unreadable && r.failed > 0).length;
    const blind = rows.filter((r) => r.unreadable).length;
    console.log(
      `\n  ${bad === 0 ? '✓' : '✗'} ${rows.length - blind - bad} site rendben · ${bad} bukik · ${blind} meretlen\n`
    );
  }

  const anyFail = rows.some((r) => !r.unreadable && r.failed > 0);
  const anyBlind = rows.some((r) => r.unreadable);
  process.exit(anyFail ? 1 : anyBlind ? 2 : 0);
}

if (process.argv[1]?.endsWith('check-fleet-contract.mjs')) main(process.argv.slice(2));
