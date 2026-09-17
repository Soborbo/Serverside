#!/usr/bin/env node
/**
 * consent-rate-report — a saját CMP (sbo) elfogadási aránya, bannerváltozatonként.
 *
 * MIÉRT. A banner-UI minden megjelenést ID-mentesen rögzít (`consent_metrics`,
 * POST /api/consent/shown), minden döntést pedig a `consent_log`-ba. A kettő
 * aránya az egyetlen őszinte mérőszám arra, hogy egy szöveg- vagy elrendezés-
 * változat (banner_version) többet hoz-e — szabályos változatok A/B-jéhez.
 *
 * Használat (a Serverside gyökeréből, wrangler-bejelentkezéssel):
 *   node scripts/consent-rate-report.mjs --site befilo [--days 30]
 *
 * Értelmezés:
 *   shown        banner-megjelenés (döntés nélküli látogatás is)
 *   decided      első döntés (revision = 1) — a később módosított döntés NEM számít újra
 *   accept_rate  accept_all / shown   ← a fő szám
 *   decide_rate  decided / shown      ← mennyien hagyják figyelmen kívül
 * A `shown` kliensoldali beacon: adblock/korai kilépés miatt kicsit alulszámol,
 * ezért az arány felső becslés — változatok ÖSSZEHASONLÍTÁSÁRA jó, abszolút
 * benchmarknak óvatosan.
 */
import { execSync } from 'node:child_process';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const site = arg('site');
const days = Number(arg('days', '30'));
if (!site || !/^[a-z0-9_-]+$/i.test(site) || !Number.isInteger(days) || days < 1) {
  console.error('Használat: node scripts/consent-rate-report.mjs --site <site_id> [--days 30]');
  process.exit(2);
}

const since = new Date(Date.now() - days * 86_400_000).toISOString();

// A site_id és a dátum validált/generált — nincs felhasználói szöveg a SQL-ben.
const sql = `
WITH shown AS (
  SELECT banner_version, COUNT(*) AS shown,
         SUM(CASE WHEN device_class = 'mobile' THEN 1 ELSE 0 END) AS shown_mobile,
         CAST(AVG(interaction_ms) AS INTEGER) AS avg_interaction_ms
  FROM consent_metrics
  WHERE site_id = '${site}' AND shown_at >= '${since}'
  GROUP BY banner_version
),
decided AS (
  SELECT banner_version, COUNT(*) AS decided,
         SUM(CASE WHEN decision = 'accept_all' THEN 1 ELSE 0 END) AS accept_all,
         SUM(CASE WHEN decision = 'reject_all' THEN 1 ELSE 0 END) AS reject_all,
         SUM(CASE WHEN decision = 'custom' THEN 1 ELSE 0 END) AS custom,
         SUM(cat_analytics) AS analytics_yes,
         SUM(cat_marketing) AS marketing_yes
  FROM consent_log
  WHERE site_id = '${site}' AND revision = 1 AND server_received_at >= '${since}'
  GROUP BY banner_version
)
SELECT s.banner_version, s.shown, s.shown_mobile, s.avg_interaction_ms,
       COALESCE(d.decided, 0) AS decided, COALESCE(d.accept_all, 0) AS accept_all,
       COALESCE(d.reject_all, 0) AS reject_all, COALESCE(d.custom, 0) AS custom,
       COALESCE(d.analytics_yes, 0) AS analytics_yes, COALESCE(d.marketing_yes, 0) AS marketing_yes
FROM shown s LEFT JOIN decided d ON d.banner_version = s.banner_version
ORDER BY s.banner_version;`;

// Egy sorba tömörítve, dupla idézőjelben: a `--file` mód nem ad vissza sorokat,
// a többsoros --command pedig Windows shellen szétesik. A SQL-ben csak szimpla
// idézőjel van (validált site_id + generált dátum), így a dupla idézőjel biztonságos.
const oneLine = sql.replace(/\s+/g, ' ').trim();
let rows;
try {
  const out = execSync(
    `npx wrangler d1 execute event-gateway-ledger --remote --json --command "${oneLine}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  rows = JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
} catch (e) {
  console.error(`A D1-lekérdezés nem futott le: ${e.message}`);
  process.exit(1);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
console.log(`\nConsent-arány — ${site}, utolsó ${days} nap (${since.slice(0, 10)} óta)\n`);
if (!rows.length) {
  console.log('Nincs adat (nem jelent meg banner, vagy a site nem sbo-n fut).');
  process.exit(0);
}
console.table(
  rows.map((r) => ({
    banner: r.banner_version,
    shown: r.shown,
    mobile: pct(r.shown_mobile, r.shown),
    decided: r.decided,
    decide_rate: pct(r.decided, r.shown),
    accept_all: r.accept_all,
    accept_rate: pct(r.accept_all, r.shown),
    reject_all: r.reject_all,
    custom: r.custom,
    analytics_yes: pct(r.analytics_yes, r.decided),
    marketing_yes: pct(r.marketing_yes, r.decided),
    avg_decision_s: r.avg_interaction_ms ? (r.avg_interaction_ms / 1000).toFixed(1) : '–',
  }))
);
console.log('\nKis mintán (változatonként <300 megjelenés) a különbség zaj — ne dönts belőle.\n');
