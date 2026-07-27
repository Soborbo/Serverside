import type { Env } from '../env';
import { sendAdminEmail, sendCriticalSMS, sendAlert, throttleOncePer, escapeHtml } from '../lib/notify';
import { listDeadRecords, summarizeDeadRecord, type DeadRecordSummary } from '../lib/deadletter';
import { countSiteConfigs } from '../lib/config';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import { logStructured } from '../types';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 10; // 10 × 1000 = 10K records sample window

function isDeadKey(key: string): boolean {
  const segments = key.split('/');
  return segments.length >= 4 && segments[2] === 'dead';
}

async function countDlqRecords(env: Env): Promise<{ pending: number; dead: number; truncated: boolean }> {
  let pending = 0;
  let dead = 0;
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const list = await env.DEAD_LETTER.list({ cursor, limit: PAGE_LIMIT });
    for (const obj of list.objects) {
      if (isDeadKey(obj.key)) dead++;
      else pending++;
    }
    if (!list.truncated) break;
    cursor = list.cursor;
    pages++;
  }
  if (pages >= MAX_PAGES) truncated = true;
  return { pending, dead, truncated };
}

// ── Konverzió-spike detektálás (a tokenless böngésző-ág ára) ─────────────────
// A Turnstile eltávolításával a böngésző-ág egyetlen visszamaradt kockázata a
// konverzió-spam (hamisított Origin + rotáló IP-k). Az Origin allow-list és a
// rate limit csökkenti a blast-radiust, de nem nullázza — ezért LÁTNI akarjuk,
// ha megtörténik. A „0 konverzió" (kiesés) felét már a daily-digest riasztja
// (collectAcceptedCounts → zeroSites); ez itt a MÁSIK fél, 30 percenként.
//
// Baseline: az elmúlt 7 nap átlaga UGYANEKKORA (30 perces) ablakra vetítve.
// Küszöb: a friss szám érje el az abszolút padlót ÉS lépje túl a baseline
// SPIKE_FACTOR-szorosát. A padló nélkül egy 0.2-es baseline mellett már 2 valódi
// konverzió is riasztana — az ilyen fals pozitív pár nap alatt megtanítja az
// embert figyelmen kívül hagyni a riasztást, ami rosszabb, mint ha nem lenne.
const SPIKE_WINDOW_MINUTES = 30;
const SPIKE_BASELINE_DAYS = 7;
const SPIKE_FACTOR = 5;
const SPIKE_MIN_EVENTS = 20;

export interface SpikeHit {
  site_id: string;
  recent: number;
  baselinePerWindow: number;
}

/** Pure — tesztelhető a küszöb-logika D1 nélkül. */
export function detectSpikes(
  recent: Map<string, number>,
  baselineTotals: Map<string, number>,
  windowsInBaseline: number
): SpikeHit[] {
  const hits: SpikeHit[] = [];
  for (const [siteId, count] of recent) {
    if (count < SPIKE_MIN_EVENTS) continue;
    const baselinePerWindow = (baselineTotals.get(siteId) ?? 0) / windowsInBaseline;
    if (count > baselinePerWindow * SPIKE_FACTOR) {
      hits.push({ site_id: siteId, recent: count, baselinePerWindow });
    }
  }
  return hits.sort((a, b) => b.recent - a.recent);
}

async function checkConversionSpike(env: Env): Promise<void> {
  if (!env.LEDGER) return;

  const now = Date.now();
  const windowStart = new Date(now - SPIKE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const baselineStart = new Date(now - SPIKE_BASELINE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let recent: Map<string, number>;
  let baseline: Map<string, number>;
  try {
    const recentRows = await env.LEDGER.prepare(
      'SELECT site_id, COUNT(*) AS cnt FROM events_raw WHERE received_at >= ? GROUP BY site_id'
    )
      .bind(windowStart)
      .all<{ site_id: string; cnt: number }>();
    // A baseline a friss ablakot KIZÁRJA — különben a spike a saját baseline-ját
    // emelné, és épp a nagy támadás tűnne „normálisnak".
    const baseRows = await env.LEDGER.prepare(
      'SELECT site_id, COUNT(*) AS cnt FROM events_raw WHERE received_at >= ? AND received_at < ? GROUP BY site_id'
    )
      .bind(baselineStart, windowStart)
      .all<{ site_id: string; cnt: number }>();

    recent = new Map((recentRows.results ?? []).map((r) => [r.site_id, r.cnt]));
    baseline = new Map((baseRows.results ?? []).map((r) => [r.site_id, r.cnt]));
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'SLO check: conversion-spike query failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return; // Lekérdezési hiba → inkább ne riasszunk, mint hogy fals pozitívot adjunk.
  }

  const windowsInBaseline = (SPIKE_BASELINE_DAYS * 24 * 60) / SPIKE_WINDOW_MINUTES;
  const hits = detectSpikes(recent, baseline, windowsInBaseline);

  for (const hit of hits) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.CONVERSION_SPIKE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.CONVERSION_SPIKE],
      site_id: hit.site_id,
      recent_count: hit.recent,
      baseline_per_window: Number(hit.baselinePerWindow.toFixed(2)),
      window_minutes: SPIKE_WINDOW_MINUTES
    });
    await sendAlert(env, TrackingErrorCode.CONVERSION_SPIKE, {
      site_id: hit.site_id,
      accepted_last_30min: hit.recent,
      baseline_per_30min: Number(hit.baselinePerWindow.toFixed(2)),
      factor: `${SPIKE_FACTOR}x`,
      hint: 'Tokenless browser path — check the AE datapoints for a forged-Origin flood, and the ledger rows for junk user_data.'
    });
  }
}

// ── Dead-record azonosítás a riasztásban ────────────────────────────────────
/** Ennyi dead rekordot nevesítünk a levélben; a többit a `dlq/dead` végpont adja. */
const DEAD_SAMPLE_LIMIT = 20;

const REPLAY_RUNBOOK = `# 1) list them (PII-free summaries, incl. the R2 key)
curl -s -H "X-Admin-Token: $ADMIN_API_TOKEN" \\
  "https://<site-hostname>/api/event/admin/dlq/dead?max=100"

# 2) replay one by key
curl -s -X POST -H "X-Admin-Token: $ADMIN_API_TOKEN" \\
  -H "Content-Type: application/json" -d '{"key":"<key from step 1>"}' \\
  "https://<site-hostname>/api/event/admin/dlq/replay"

# 3) or replay the whole dead archive (optionally per site)
curl -s -X POST -H "X-Admin-Token: $ADMIN_API_TOKEN" \\
  -H "Content-Type: application/json" -d '{"dead":true,"site_id":"<site>","max":100}' \\
  "https://<site-hostname>/api/event/admin/dlq/replay"

# discard instead (consent withdrawal / junk): {"key":"<key>","discard":true}`;

/**
 * A dead rekordok azonosítói a riasztáshoz. Best-effort: ha a scan elbukik, a
 * riasztás a szám nélküli résszel akkor is kimegy — egy listázási hiba NEM
 * nyelheti el magát a riasztást.
 */
async function sampleDeadRecords(env: Env): Promise<DeadRecordSummary[]> {
  try {
    const { dead } = await listDeadRecords(env, undefined, DEAD_SAMPLE_LIMIT);
    const now = Date.now();
    return dead.map(({ key, record }) => summarizeDeadRecord(key, record, now));
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'SLO check: dead-record detail scan failed (alert still sent with counts only)',
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

/** PII-mentes HTML-tábla. Minden mező escape-elve (a failure_reason vendor-szöveg). */
export function renderDeadRecordTable(records: DeadRecordSummary[], total: number): string {
  if (records.length === 0) {
    return '<p><em>Could not read the record details — use GET /api/event/admin/dlq/dead.</em></p>';
  }
  const rows = records
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.site_id)}</td><td>${escapeHtml(r.platform)}</td>` +
        `<td>${escapeHtml(r.event_name)}</td><td>${escapeHtml(r.event_id)}</td>` +
        `<td>${r.age_days}d</td><td>${r.retry_count}</td>` +
        `<td>${escapeHtml(r.failure_reason)}</td><td><code>${escapeHtml(r.key)}</code></td></tr>`
    )
    .join('\n      ');
  const more =
    total > records.length
      ? `<p><em>… and ${total - records.length} more — GET /api/event/admin/dlq/dead?max=500</em></p>`
      : '';
  return `<table border="1" cellpadding="4" cellspacing="0">
      <tr><th>site</th><th>platform</th><th>event</th><th>event_id</th><th>age</th><th>tries</th><th>last failure</th><th>R2 key</th></tr>
      ${rows}
    </table>${more}`;
}

export async function handleSloCheck(env: Env): Promise<void> {
  const siteCount = await countSiteConfigs(env);
  const { pending: pendingCount, dead: deadCount, truncated } = await countDlqRecords(env);

  await checkConversionSpike(env);

  const truncNote = truncated ? ` (≥${MAX_PAGES * PAGE_LIMIT} — list truncated)` : '';

  // A throttle a 30 perces cron ismétlődő ÁRADATÁT vágja: azonos állapotra ne
  // menjen leadenkénti/félóránkénti email+SMS (K2-H5). A SZINTET előbb döntjük el,
  // csak UTÁNA throttle-özünk — egy elnyomott 'critical' NEM eshet vissza
  // 'elevated'-re (az az else-ág, ami különben megszólalna). Ablakok: a tartós,
  // alacsony sürgősségű dead-records ritkábban emlékeztet, a critical óránként.
  if (pendingCount > 500 || truncated) {
    if (await throttleOncePer(env, 'slo-dlq-critical', 3600)) {
      await sendCriticalSMS(env, `DLQ critical: ${pendingCount}${truncNote} pending events`);
      await sendAdminEmail(
        env,
        `DLQ Critical: ${pendingCount}${truncNote} events`,
        `
        <h2>DLQ Critical</h2>
        <p>Pending DLQ records: ${pendingCount}${truncNote}</p>
        <p>Suggests platform-wide failures. Investigate immediately.</p>
      `,
        'critical'
      );
    }
  } else if (pendingCount > 100) {
    if (await throttleOncePer(env, 'slo-dlq-elevated', 3 * 3600)) {
      await sendAdminEmail(
        env,
        `DLQ Elevated: ${pendingCount} events`,
        `
        <p>Pending DLQ: ${pendingCount} (warning >100)</p>
        <p>Cron retry should clear in 1-2 hours.</p>
      `,
        'warning'
      );
    }
  }

  if (deadCount > 0) {
    // A puszta SZÁM használhatatlan riasztás volt: „manually reprocessed" —
    // de melyik rekord, melyik site, melyik platform? A kézi útnak (single
    // replay) pontos R2-kulcs kell, amit a levél nem adott meg. A rekordokat
    // ezért AZONOSÍTVA küldjük ki, a futtatható paranccsal együtt.
    //
    // A scan a THROTTLE-ON KÍVÜL fut: az azonosítók a Workers logba minden
    // körben bekerülnek, akkor is, ha az email épp el van nyomva (6h ablak) —
    // különben egy elnyelt levél után 6 órán át semmi nyoma nem lenne annak,
    // MELYIK konverzió veszett el.
    const summaries = await sampleDeadRecords(env);
    for (const r of summaries) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.MAX_RETRIES_EXCEEDED,
        message: 'Dead DLQ record awaiting manual reprocess',
        site_id: r.site_id,
        platform: r.platform,
        event_name: r.event_name,
        event_id: r.event_id,
        retry_count: r.retry_count,
        age_days: r.age_days,
        r2_key: r.key
      });
    }
    if (await throttleOncePer(env, 'slo-dead-records', 6 * 3600)) {
      await sendDeadRecordAlert(env, deadCount, summaries);
    }
  }

  logStructured({
    level: 'info',
    message: 'SLO check completed',
    sites_count: siteCount,
    dlq_pending: pendingCount,
    dlq_dead: deadCount,
    dlq_list_truncated: truncated
  });
}

async function sendDeadRecordAlert(
  env: Env,
  deadCount: number,
  summaries: DeadRecordSummary[]
): Promise<void> {
  await sendAdminEmail(
    env,
    `Dead records: ${deadCount}`,
    `
      <p>Records exceeded max retries: ${deadCount}</p>
      <p>These conversions were <strong>never delivered</strong>. They stay in the
         R2 dead archive until retention purges them (DEAD_RECORD_RETENTION_DAYS,
         default 90 days) — after that they are gone for good.</p>
      ${renderDeadRecordTable(summaries, deadCount)}
      <h3>Reprocess</h3>
      <pre>${escapeHtml(REPLAY_RUNBOOK)}</pre>
      <p>Vendor acceptance windows still apply (Meta CAPI: 7 days) — an older
         record may be accepted by the API and still not attribute.</p>
    `,
    'warning'
  );
}
