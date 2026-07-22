import { BUILD_COMMIT, BUILD_DIRTY, BUILT_AT } from '../build-info';

/**
 * Publikus build-bélyeg diagnosztika — a deployolt Worker melyik git-commitból
 * készült. A hostname-config lookup ELŐTT szolgáljuk ki (mint a /health), így
 * workers.dev-en és custom domainen egyaránt 200-at ad, config nélkül is.
 *
 * Ez az F4-1(b) drift-őr olvasó vége: a napi CI-job (scripts/check-version-drift.mjs)
 * ezt kéri le és ellenőrzi, hogy a `build_commit` az `origin/main` őse-e. A commit
 * a bélyegben utazik (nincs Cloudflare API token) — lásd scripts/stamp-build-info.mjs.
 *
 * Csak a 40-hexes git-SHA + timestamp szivárog (privát repo, elhanyagolható); PII
 * vagy secret SOHA nem kerül ide.
 */
export function handleVersion(): Response {
  return new Response(
    JSON.stringify({
      build_commit: BUILD_COMMIT,
      build_dirty: BUILD_DIRTY,
      built_at: BUILT_AT,
      version: '0.1.0'
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
