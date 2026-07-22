#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Deploy-idejű build-bélyegző. A wrangler `[build]` hook futtatja (lásd
// wrangler.toml), MIELŐTT bundle-özi a workert — így a deployolt artifact magába
// hordozza a git-commitot, amiből készült. A commitolt `src/build-info.ts`
// placeholder ('unknown'); a futó Worker a valósat adja vissza a
// /api/event/version endpointon.
//
// EZ az F4-1(b) drift-őr alapja: a napi CI-job (check-version-drift.mjs) lekéri
// az élő /version-t és ellenőrzi, hogy a commit az origin/main ŐSE-e. Ha egy
// deploy git-ben nem létező / nem-pushed / dirty állapotból ment ki (a Fázis-0
// „production fut, forrás nincs gitben" hibaosztály), a bélyeg elárulja.
//
// Nincs Cloudflare API token: a bélyeg maga a worker artifactban utazik, a CI
// csak egy publikus GET-tel olvassa. Ha a deploy NEM wranglerrel megy (a hook
// nem fut), a bélyeg 'unknown' marad → a CI drift-et jelez (fail-loud).
// ─────────────────────────────────────────────────────────────────────────────
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'build-info.ts');

function git(args) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// A commit forrása, prioritás szerint: Cloudflare Workers Builds / GitHub Actions
// build-env változók, majd a lokális git HEAD. Ha egyik sincs (nem git-checkout),
// 'unknown' → a CI ezt drift-ként kezeli.
const commit =
  process.env.WORKERS_CI_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  git('rev-parse HEAD') ||
  'unknown';

// Dirty-detektálás CSAK ha a commit lokális gitből jött (a CI env-változóknál a
// build-környezet checkout-ja tiszta, ott nincs értelme). Egy dirty deploy azt
// jelenti, hogy a kiküldött kód eltér a bélyegzett committól → a CI ezt is bukja.
let dirty = false;
if (commit !== 'unknown' && !process.env.WORKERS_CI_COMMIT_SHA && !process.env.GITHUB_SHA) {
  dirty = git('status --porcelain') !== '';
}

const builtAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString();

const body = `// GENERÁLT FÁJL — a scripts/stamp-build-info.mjs írja deploy-időben (wrangler [build] hook).
// KÉZZEL NE SZERKESZD. A gitbe committolt érték a placeholder ('unknown'); a
// deployolt bundle a valós commitot hordozza, amit a /api/event/version ad vissza.
export const BUILD_COMMIT = ${JSON.stringify(commit)};
export const BUILD_DIRTY = ${dirty ? 'true' : 'false'};
export const BUILT_AT = ${JSON.stringify(builtAt)};
`;

// Csak akkor írunk, ha a commit/dirty ténylegesen változik — a BUILT_AT-ot
// figyelmen kívül hagyva, hogy ismételt stamp ugyanarra a commitra ne zajongjon
// a working tree-ben.
if (existsSync(OUT)) {
  const prev = readFileSync(OUT, 'utf8');
  const prevCommit = /BUILD_COMMIT = (".*?"|'.*?')/.exec(prev)?.[1];
  const prevDirty = /BUILD_DIRTY = (true|false)/.exec(prev)?.[1];
  if (prevCommit === JSON.stringify(commit) && prevDirty === (dirty ? 'true' : 'false')) {
    process.exit(0);
  }
}

writeFileSync(OUT, body);
console.log(`stamped build-info: ${commit}${dirty ? ' (dirty)' : ''}`);
