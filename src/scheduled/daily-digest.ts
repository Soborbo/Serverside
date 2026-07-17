import type { Env } from '../env';
import { sendAdminEmail } from '../lib/notify';
import { countSiteConfigs, listConfiguredSiteIds, listMonitoredSiteConfigs } from '../lib/config';
import {
  fetchDatasetEmq,
  collectKeyCoverage,
  detectCoverageDrops,
  type EmqEventScore,
  type CoverageStats,
  type KeyCoverage
} from '../lib/emq';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import { logStructured } from '../types';

/**
 * Site-onkénti elfogadott (ledger-be írt) event-szám az elmúlt 24 órából, a
 * konfigurált site-okkal összevetve. A visszaadott `zeroSites` = konfigurált,
 * de 0 elfogadott konverziójú site-ok — pont az a néma-kiesés jelzés, ami a
 * 2026-06-28→07-13 incidensnél hetekig hiányzott. LEDGER binding nélkül üres
 * eredményt ad (nincs mire riasztani).
 */
export async function collectAcceptedCounts(
  env: Env
): Promise<{ counts: Map<string, number>; zeroSites: string[] }> {
  const counts = new Map<string, number>();
  const zeroSites: string[] = [];
  if (!env.LEDGER) return { counts, zeroSites };

  const configured = await listConfiguredSiteIds(env);
  if (configured.size === 0) return { counts, zeroSites };

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await env.LEDGER.prepare(
      'SELECT site_id, COUNT(*) AS cnt FROM events_raw WHERE received_at >= ? GROUP BY site_id'
    )
      .bind(since)
      .all<{ site_id: string; cnt: number }>();
    for (const row of rows.results ?? []) {
      counts.set(row.site_id, row.cnt);
    }
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: ledger accepted-count query failed',
      error: err instanceof Error ? err.message : String(err)
    });
    // Lekérdezési hiba → ne riasszunk fals "0 konverzió"-t minden site-ra.
    return { counts, zeroSites };
  }

  for (const siteId of configured) {
    if (!counts.has(siteId)) zeroSites.push(siteId);
  }
  zeroSites.sort();
  return { counts, zeroSites };
}

export interface SmokeStatus {
  /** Az SMOKE_SITES-ban elvárt site-ok. Üres → a check kikapcsolt. */
  expected: string[];
  /** Elvárt site, aminek NINCS smoke- prefixű delivery-sora az elmúlt 24 órából. */
  missing: string[];
  /** Smoke-sor van, de a Meta-lába 'rejected' — a lánc él, a vendor-hívás bukik. */
  broken: { site: string; error_code: string | null }[];
}

/**
 * Napi synthetic-lead füstteszt ellenőrzése (#Run6 utó). A site workerek 04:4x
 * UTC-kor determinisztikus `smoke-<site>-YYYYMMDD` eventet tolnak át a teljes
 * szerver-láncon; itt (08:00) azt nézzük, hogy MINDEN elvárt site-nak landolt-e
 * sora a ledgerben. A 'skipped' Meta-láb OK (szándékosan meta-nélküli site,
 * pl. lomtalan amíg nincs CAPI token); a 'rejected' és a HIÁNYZÓ sor riasztás.
 * Query-hiba → üres missing (nem riasztunk falsot minden site-ra).
 */
export async function collectSmokeStatus(env: Env): Promise<SmokeStatus> {
  const expected = (env.SMOKE_SITES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const status: SmokeStatus = { expected, missing: [], broken: [] };
  if (!env.LEDGER || expected.length === 0) return status;

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await env.LEDGER.prepare(
      `SELECT site_id, status, error_code FROM deliveries
       WHERE created_at >= ? AND platform = 'meta' AND event_id LIKE 'smoke-%'`
    )
      .bind(since)
      .all<{ site_id: string; status: string; error_code: string | null }>();

    const bySite = new Map<string, { status: string; error_code: string | null }>();
    for (const r of rows.results ?? []) bySite.set(r.site_id, r);

    for (const site of expected) {
      const row = bySite.get(site);
      if (!row) status.missing.push(site);
      else if (row.status === 'rejected') status.broken.push({ site, error_code: row.error_code });
    }
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: smoke-status query failed',
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return status;
}

// ── Meta EMQ (Event Match Quality) szekció ───────────────────────────────────

/** EMQ riasztási küszöb (0-10-es composite score). Meta ajánlás: a jó ≥ 7. */
const EMQ_ALERT_THRESHOLD = 7;

export interface EmqSiteStatus {
  site: string;
  /**
   * Az adatforrás: 'emq' = valódi Dataset Quality API score; 'proxy' = ledger
   * match-kulcs lefedettség (az EMQ API nem volt elérhető — pl. client system
   * user token inkompatibilitás, lásd lib/emq.ts); 'none' = egyik sem ("n/a").
   */
  source: 'emq' | 'proxy' | 'none';
  emqEvents?: EmqEventScore[];
  coverage?: CoverageStats;
  /** Riasztásra okot adó sorok (EMQ < küszöb vagy lefedettség-esés). */
  alerts: string[];
}

/**
 * Site-onkénti EMQ-státusz a Meta-configgal rendelkező, monitorozott site-okra.
 * Meta-config nélküli site (pl. lomtalan) hangtalan skip. Elsődleges forrás a
 * Dataset Quality API; BÁRMILYEN hibájánál a ledger-proxy (em/ph/fbc/fbp
 * jelenlét-lefedettség 24h vs 7 nap); ha az sincs → 'none'. Hibatűrő: soha nem
 * dob — a digestet EMQ-hiba nem buktathatja.
 */
export async function collectEmqStatus(env: Env): Promise<EmqSiteStatus[]> {
  const statuses: EmqSiteStatus[] = [];
  try {
    const configs = await listMonitoredSiteConfigs(env);
    for (const cfg of configs) {
      if (!cfg.meta) continue; // nincs CAPI-láb → nincs mit mérni (hangtalan skip)
      const status: EmqSiteStatus = { site: cfg.site_id, source: 'none', alerts: [] };

      const emq = await fetchDatasetEmq(cfg.site_id, cfg.meta.pixel_id, cfg.meta.access_token);
      if (emq.ok && emq.events.length > 0) {
        status.source = 'emq';
        status.emqEvents = emq.events;
        for (const ev of emq.events) {
          if (ev.score < EMQ_ALERT_THRESHOLD) {
            status.alerts.push(`${ev.event_name} EMQ ${ev.score.toFixed(1)} < ${EMQ_ALERT_THRESHOLD}`);
            logStructured({
              level: 'warn',
              error_code: TrackingErrorCode.EMQ_BELOW_THRESHOLD,
              message: ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_BELOW_THRESHOLD],
              site_id: cfg.site_id,
              event_name: ev.event_name,
              emq_score: ev.score
            });
          }
        }
      } else {
        // EMQ API nem elérhető (vagy üres) → proxy: match-kulcs lefedettség a
        // ledgerből. A hibát a lib már 'info'-n logolta (TRK-950-008).
        const coverage = await collectKeyCoverage(env, cfg.site_id);
        if (coverage) {
          status.source = 'proxy';
          status.coverage = coverage;
          for (const drop of detectCoverageDrops(coverage)) {
            status.alerts.push(
              `${drop.key} coverage ${drop.pct24h}% (7d avg ${drop.pct7d}%)`
            );
            logStructured({
              level: 'warn',
              error_code: TrackingErrorCode.EMQ_COVERAGE_DROP,
              message: ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_COVERAGE_DROP],
              site_id: cfg.site_id,
              match_key: drop.key,
              pct_24h: drop.pct24h,
              pct_7d: drop.pct7d
            });
          }
        }
      }
      statuses.push(status);
    }
  } catch (err) {
    // Defenzív: semmilyen EMQ-hiba nem buktathatja a digestet.
    logStructured({
      level: 'warn',
      message: 'Daily digest: EMQ section failed',
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return statuses;
}

function renderEmqLine(s: EmqSiteStatus): string {
  if (s.source === 'emq' && s.emqEvents) {
    const scores = s.emqEvents
      .map((e) => `${e.event_name} ${e.score.toFixed(1)}`)
      .join(', ');
    return `${s.site}: ${scores}`;
  }
  if (s.source === 'proxy' && s.coverage) {
    const keys = s.coverage.keys
      .map((k: KeyCoverage) => `${k.key} ${k.pct24h}%`)
      .join(' / ');
    return `${s.site}: proxy coverage 24h (${s.coverage.events24h} events) — ${keys}`;
  }
  return `${s.site}: n/a (EMQ API + ledger proxy unavailable)`;
}

export async function handleDailyDigest(env: Env): Promise<void> {
  const siteCount = await countSiteConfigs(env);
  const { counts: acceptedCounts, zeroSites } = await collectAcceptedCounts(env);
  const smoke = await collectSmokeStatus(env);
  const smokeAlarm = smoke.missing.length > 0 || smoke.broken.length > 0;
  const emqStatuses = await collectEmqStatus(env);
  const emqAlerts = emqStatuses.filter((s) => s.alerts.length > 0);

  let totalDlqRecords = 0;
  let totalDeadRecords = 0;
  let truncated = false;
  try {
    let cursor: string | undefined;
    let pages = 0;
    const MAX_PAGES = 10;
    while (pages < MAX_PAGES) {
      const list = await env.DEAD_LETTER.list({ cursor, limit: 1000 });
      for (const obj of list.objects) {
        const segments = obj.key.split('/');
        if (segments.length >= 4 && segments[2] === 'dead') totalDeadRecords++;
        else totalDlqRecords++;
      }
      if (!list.truncated) break;
      cursor = list.cursor;
      pages++;
    }
    if (pages >= MAX_PAGES) truncated = true;
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: failed to count DLQ',
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const html = `
    <h2>Soborbo Tracking — Daily Digest</h2>
    <p><strong>Snapshot:</strong> ${new Date().toISOString()} (a DLQ-számok a teljes bucket pillanatképe, nem 24h-s ablak)</p>

    <h3>Active sites</h3>
    <p>${siteCount} sites configured</p>

    <h3>Accepted conversions (last 24h, D1 ledger)</h3>
    <ul>
      ${
        acceptedCounts.size > 0
          ? [...acceptedCounts.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([site, cnt]) => `<li>${site}: ${cnt}</li>`)
              .join('\n      ')
          : '<li>none</li>'
      }
    </ul>
    ${
      zeroSites.length > 0
        ? `<p><strong>⚠️ ZERO accepted conversions for configured site(s): ${zeroSites.join(', ')} — a silently dead server leg looks exactly like this. Check the client dispatch + Turnstile + Workers logs.</strong></p>`
        : ''
    }

    <h3>Synthetic smoke leads (last 24h)</h3>
    ${
      smoke.expected.length === 0
        ? '<p>check disabled (no SMOKE_SITES)</p>'
        : smokeAlarm
          ? `<p><strong>⚠️ ${
              smoke.missing.length > 0
                ? `NO smoke event from: ${smoke.missing.join(', ')} — the site cron→gateway chain did not run or did not land. `
                : ''
            }${
              smoke.broken.length > 0
                ? `Meta REJECTED the smoke event for: ${smoke.broken
                    .map((b) => `${b.site} (${b.error_code ?? 'no code'})`)
                    .join(', ')}.`
                : ''
            }</strong></p>`
          : `<p>✓ all expected sites delivered (${smoke.expected.join(', ')})</p>`
    }

    <h3>Meta EMQ (Event Match Quality)</h3>
    ${
      emqStatuses.length === 0
        ? '<p>no sites with Meta config</p>'
        : `<ul>
      ${emqStatuses.map((s) => `<li>${renderEmqLine(s)}</li>`).join('\n      ')}
    </ul>`
    }
    ${
      emqAlerts.length > 0
        ? `<p><strong>⚠️ Match-quality alert: ${emqAlerts
            .map((s) => `${s.site} (${s.alerts.join('; ')})`)
            .join(' | ')} — a delivery-green pipeline with falling EMQ usually means broken fbc/fbp or em/ph forwarding.</strong></p>`
        : ''
    }

    <h3>Dead Letter Queue</h3>
    <ul>
      <li>Pending retries: ${totalDlqRecords}${truncated ? ' (≥10000 — list truncated)' : ''}</li>
      <li>Dead (max retries reached): ${totalDeadRecords}</li>
    </ul>

    <h3>Action items</h3>
    ${
      totalDeadRecords > 0
        ? `<p><strong>⚠️ ${totalDeadRecords} dead records require manual intervention.</strong></p>`
        : `<p>✓ No dead records.</p>`
    }
    ${totalDlqRecords > 50 ? `<p><strong>⚠️ DLQ pending records elevated.</strong></p>` : ''}

    <p><em>For detailed metrics: Grafana dashboard</em></p>
  `;

  if (zeroSites.length > 0) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: configured site(s) with ZERO accepted conversions in 24h',
      sites: zeroSites.join(',')
    });
  }
  if (smokeAlarm) {
    logStructured({
      level: 'error',
      message: 'Daily digest: synthetic smoke-lead check FAILED',
      missing: smoke.missing.join(','),
      broken: smoke.broken.map((b) => `${b.site}:${b.error_code ?? '-'}`).join(',')
    });
  }

  const alarmBits = [
    ...(smokeAlarm ? [`smoke failed: ${[...smoke.missing, ...smoke.broken.map((b) => b.site)].join(', ')}`] : []),
    ...(zeroSites.length > 0 ? [`zero conversions: ${zeroSites.join(', ')}`] : []),
    ...(emqAlerts.length > 0 ? [`EMQ alert: ${emqAlerts.map((s) => s.site).join(', ')}`] : [])
  ];
  await sendAdminEmail(
    env,
    alarmBits.length > 0 ? `Daily Digest — ⚠️ ${alarmBits.join(' | ')}` : 'Daily Digest',
    html,
    alarmBits.length > 0 ? 'warning' : 'info'
  );
}
