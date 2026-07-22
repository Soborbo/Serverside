#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// F4-1(b) drift-őr — CI-oldal. Lekéri az élő Worker /api/event/version bélyegét
// és ellenőrzi, hogy a `build_commit` az `origin/main` ŐSE-e. Ha nem (vagy
// 'unknown', vagy dirty), a deployolt production olyan kódot futtat, ami nincs
// (rendesen) a fő ágon — pontosan a Fázis-0 „production fut, forrás nincs gitben"
// hibaosztály. Napi GitHub Action hívja (lásd .github/workflows/version-drift.yml).
//
// Nincs Cloudflare API token: a commit a bélyegben utazik, ezt csak egy publikus
// GET olvassa. Az ancestry-t a checkout-olt git-history-ból számoljuk.
// ─────────────────────────────────────────────────────────────────────────────
import { execSync } from 'node:child_process';

/**
 * Tiszta osztályozó (IO nélkül, ezért tesztelhető). A commit-ancestry eldöntését
 * egy injektált predikátum végzi, hogy a teszt ne igényeljen git-repót.
 *
 * @param {{build_commit?: string, build_dirty?: boolean}} version  a /version JSON
 * @param {(commit: string) => boolean} isAncestorOfMain  igaz, ha a commit origin/main őse
 * @returns {{ok: boolean, reason: string, code: string}}
 */
export function classifyVersion(version, isAncestorOfMain) {
  const commit = version?.build_commit;

  if (!commit || commit === 'unknown') {
    return {
      ok: false,
      code: 'UNSTAMPED',
      reason:
        'A deployolt Worker build_commit-ja "unknown" — a deploy NEM a wrangler [build] hookon ment ki, vagy nem git-checkoutból. A forrás-provenance elveszett.'
    };
  }

  if (version.build_dirty === true) {
    return {
      ok: false,
      code: 'DIRTY',
      reason: `A deploy dirty working tree-ből ment ki (build_commit=${commit}). A kiküldött kód eltér a bélyegzett committól — nem reprodukálható gitből.`
    };
  }

  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    return {
      ok: false,
      code: 'MALFORMED',
      reason: `A build_commit nem git-SHA alakú: ${JSON.stringify(commit)}.`
    };
  }

  if (!isAncestorOfMain(commit)) {
    return {
      ok: false,
      code: 'DRIFT',
      reason: `A deployolt commit (${commit}) NEM őse az origin/main-nek — a production egy nem-mergelt / elhagyott ágból fut.`
    };
  }

  return { ok: true, code: 'OK', reason: `A deployolt commit (${commit}) az origin/main őse.` };
}

// ── IO-réteg (a CI futtatja) ────────────────────────────────────────────────
function git(args) {
  return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function isAncestorOfMain(commit) {
  // A commit lehet, hogy nincs a shallow checkoutban — ilyenkor NEM őse (fail-loud).
  try {
    git(`cat-file -e ${commit}^{commit}`);
  } catch {
    return false;
  }
  try {
    execSync(`git merge-base --is-ancestor ${commit} origin/main`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function fetchVersion(baseUrl, attempts = 3) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/event/version`;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'version-drift-check' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`nem sikerült elérni ${url}: ${lastErr?.message ?? lastErr}`);
}

async function main() {
  const baseUrl = process.argv[2] || process.env.WORKER_URL || 'https://event-gateway.golaxo.workers.dev';
  let version;
  try {
    version = await fetchVersion(baseUrl);
  } catch (err) {
    // Elérhetetlen Worker ≠ drift, de egy néma zöld a drift-őr értelmét venné el.
    console.error(`::error::version-drift: ${err.message}`);
    process.exit(2);
  }

  const verdict = classifyVersion(version, isAncestorOfMain);
  const summary = `build_commit=${version.build_commit} dirty=${version.build_dirty} built_at=${version.built_at}`;
  if (verdict.ok) {
    console.log(`✅ version-drift OK — ${summary}\n   ${verdict.reason}`);
    process.exit(0);
  }
  console.error(`::error::version-drift [${verdict.code}] — ${verdict.reason}\n   ${summary}`);
  process.exit(1);
}

// Csak akkor futtatjuk a main-t, ha közvetlenül hívják (nem importként a tesztből).
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
