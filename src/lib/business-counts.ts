import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode } from './error-codes';
import { listMonitoredSiteConfigsWithCompleteness } from './config';

/**
 * P1.2 — CRM business-source reconciliation (gateway-fél).
 *
 * A gateway ledger önmagában nem tudja észrevenni azt az esetet, amikor a CRM→gateway
 * hívás el sem indul. Ezért a CRM naponta egy PII-mentes, teljes lifecycle-snapshotot
 * küld: csak (event_name, count) párokat.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 1_000_000;
const MAX_ENTRIES = 64;

export const BUSINESS_REPORT_HEARTBEAT = '__report__';

export interface BusinessCountEntry {
  event_name: string;
  count: number;
}

export interface BusinessCountsPayload {
  date: string;
  /** A CRM-ben készült snapshot időpontja. Retry-sorrend helyett SOURCE ordering. */
  generated_at: string;
  counts: BusinessCountEntry[];
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

export function validateBusinessCounts(
  payload: unknown,
  allowedEventNames: ReadonlySet<string>
): { ok: true; value: BusinessCountsPayload } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.date !== 'string' || !DATE_RE.test(p.date)) {
    return { ok: false, error: 'date must be YYYY-MM-DD (UTC day)' };
  }
  const [yy, mm, dd] = p.date.split('-').map(Number);
  const parsed = new Date(Date.UTC(yy, mm - 1, dd));
  if (
    parsed.getUTCFullYear() !== yy ||
    parsed.getUTCMonth() !== mm - 1 ||
    parsed.getUTCDate() !== dd
  ) {
    return { ok: false, error: `date is not a real calendar day: ${p.date}` };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (p.date > today) return { ok: false, error: `date is in the future (today=${today})` };

  if (!isCanonicalIsoTimestamp(p.generated_at)) {
    return { ok: false, error: 'generated_at must be a canonical UTC ISO timestamp' };
  }

  if (!Array.isArray(p.counts)) return { ok: false, error: 'counts must be an array' };
  if (p.counts.length > MAX_ENTRIES) {
    return { ok: false, error: `counts has more than ${MAX_ENTRIES} entries` };
  }

  const seen = new Set<string>();
  const entries: BusinessCountEntry[] = [];
  for (const raw of p.counts) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'counts entries must be objects' };
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.event_name !== 'string' || !allowedEventNames.has(e.event_name)) {
      return { ok: false, error: `unknown event_name: ${String(e.event_name)}` };
    }
    if (seen.has(e.event_name)) {
      return { ok: false, error: `duplicate event_name: ${e.event_name}` };
    }
    seen.add(e.event_name);
    if (
      typeof e.count !== 'number' ||
      !Number.isInteger(e.count) ||
      e.count < 0 ||
      e.count > MAX_COUNT
    ) {
      return { ok: false, error: `count for ${e.event_name} must be an integer in [0, ${MAX_COUNT}]` };
    }
    entries.push({ event_name: e.event_name, count: e.count });
  }

  return {
    ok: true,
    value: { date: p.date, generated_at: p.generated_at, counts: entries }
  };
}

/**
 * Teljes napi snapshot-csere, monoton source-orderinggel.
 *
 * A `received_at` NEM használható orderingre: egy régi snapshot retryja később érkezhet,
 * mint egy frissebb snapshot. A külön `business_count_snapshots` sor a CRM által adott
 * `generated_at`-ot őrzi. Egy stale retry batch-e lefut ugyan, de a feltételes DELETE/
 * INSERT-ek semmit nem módosítanak.
 */
export async function storeBusinessCounts(
  env: Env,
  siteId: string,
  payload: BusinessCountsPayload
): Promise<boolean> {
  if (!env.LEDGER) return false;
  const receivedAt = new Date().toISOString();

  try {
    const snapshot = env.LEDGER.prepare(
      `INSERT INTO business_count_snapshots (site_id, date, generated_at, received_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(site_id, date) DO UPDATE SET
         generated_at = excluded.generated_at,
         received_at = excluded.received_at
       WHERE excluded.generated_at >= business_count_snapshots.generated_at`
    ).bind(siteId, payload.date, payload.generated_at, receivedAt);

    const clear = env.LEDGER.prepare(
      `DELETE FROM business_counts
       WHERE site_id = ?1 AND date = ?2 AND event_name != ?3
         AND EXISTS (
           SELECT 1 FROM business_count_snapshots
           WHERE site_id = ?1 AND date = ?2 AND generated_at = ?4
         )`
    ).bind(siteId, payload.date, BUSINESS_REPORT_HEARTBEAT, payload.generated_at);

    const insert = env.LEDGER.prepare(
      `INSERT INTO business_counts (site_id, date, event_name, count, received_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (
         SELECT 1 FROM business_count_snapshots
         WHERE site_id = ?1 AND date = ?2 AND generated_at = ?6
       )
       ON CONFLICT(site_id, date, event_name)
       DO UPDATE SET count = excluded.count, received_at = excluded.received_at`
    );

    const rows = [
      snapshot,
      clear,
      insert.bind(
        siteId,
        payload.date,
        BUSINESS_REPORT_HEARTBEAT,
        0,
        receivedAt,
        payload.generated_at
      ),
      ...payload.counts.map((c) =>
        insert.bind(
          siteId,
          payload.date,
          c.event_name,
          c.count,
          receivedAt,
          payload.generated_at
        )
      )
    ];

    await env.LEDGER.batch(rows);
    return true;
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.LEDGER_WRITE_FAILED,
      message: 'business_counts write failed',
      site_id: siteId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

// ── Recon-oldal ──────────────────────────────────────────────────────────────

export interface BusinessCountRow {
  site_id: string;
  date: string;
  event_name: string;
  count: number;
}

export interface LedgerLifecycleRow {
  site_id: string;
  date: string;
  event_name: string;
  count: number;
}

export type BusinessSourceKind = 'business_source_drift' | 'business_source_missing';

export interface BusinessSourceFinding {
  site_id: string;
  event_name: string;
  date: string;
  kind: BusinessSourceKind;
  severity: 'warning' | 'critical';
  crm_count: number;
  gateway_count: number;
  detail: string;
}

export interface BusinessSourceThresholds {
  minSample: number;
  lossWarn: number;
  lossCrit: number;
}

export const DEFAULT_BUSINESS_SOURCE_THRESHOLDS: BusinessSourceThresholds = {
  minSample: 3,
  lossWarn: 0.1,
  lossCrit: 0.3
};

const rowKey = (siteId: string, date: string, eventName: string) =>
  `${siteId} ${date} ${eventName}`;

export function computeBusinessSourceDrift(
  crmRows: BusinessCountRow[],
  ledgerRows: LedgerLifecycleRow[],
  t: BusinessSourceThresholds = DEFAULT_BUSINESS_SOURCE_THRESHOLDS
): BusinessSourceFinding[] {
  const ledger = new Map<string, number>();
  for (const r of ledgerRows) {
    ledger.set(rowKey(r.site_id, r.date, r.event_name), r.count);
  }

  const findings: BusinessSourceFinding[] = [];
  for (const c of crmRows) {
    if (c.event_name === BUSINESS_REPORT_HEARTBEAT) continue;
    if (c.count < t.minSample) continue;
    const got = ledger.get(rowKey(c.site_id, c.date, c.event_name)) ?? 0;
    if (got >= c.count) continue;
    const loss = (c.count - got) / c.count;
    if (loss < t.lossWarn) continue;
    findings.push({
      site_id: c.site_id,
      event_name: c.event_name,
      date: c.date,
      kind: 'business_source_drift',
      severity: loss >= t.lossCrit ? 'critical' : 'warning',
      crm_count: c.count,
      gateway_count: got,
      detail:
        `${c.date} ${c.event_name}: a CRM ${c.count} uzleti esemenyt jelentett, a gateway ` +
        `${got}-t kapott meg (${(loss * 100).toFixed(1)}% el sem indult)`
    });
  }
  return findings;
}

export function findSilentBusinessSources(
  priorRows: BusinessCountRow[],
  todayRows: BusinessCountRow[],
  date: string
): BusinessSourceFinding[] {
  const reportedToday = new Set(todayRows.map((r) => r.site_id));
  const reportedBefore = [...new Set(priorRows.map((r) => r.site_id))];
  return reportedBefore
    .filter((siteId) => !reportedToday.has(siteId))
    .map((siteId) => ({
      site_id: siteId,
      event_name: '*',
      date,
      kind: 'business_source_missing' as const,
      severity: 'warning' as const,
      crm_count: 0,
      gateway_count: 0,
      detail:
        `${siteId}: korabban napi business-count aggregatumot kuldott, ${date}-re NEM — ` +
        'maga a CRM-cron allhatott le (a lifecycle-konverziok igy nema veszteseget szenvednek)'
    }));
}

function filterToMonitored<T extends { site_id: string }>(
  rows: T[],
  monitored: ReadonlySet<string> | null
): T[] {
  return monitored === null ? rows : rows.filter((r) => monitored.has(r.site_id));
}

/**
 * `monitoring:false` site-ok csak TELJES config-felsorolás esetén zárhatók ki.
 * Részleges KV-listából negatív következtetést nem vonunk le: olyankor inkább bővebb,
 * kevésbé pontos riport legyen, mint néma kiesés.
 */
async function resolveBusinessMonitoringScope(env: Env): Promise<ReadonlySet<string> | null> {
  const listed = await listMonitoredSiteConfigsWithCompleteness(env);
  if (!listed.complete) return null;
  return new Set(listed.configs.map((c) => c.site_id));
}

export async function fetchBusinessSourceFindings(
  env: Env,
  date: string,
  priorSinceDate: string
): Promise<BusinessSourceFinding[] | null> {
  if (!env.LEDGER) return null;
  try {
    const [crm, ledgerRows, prior, monitored] = await Promise.all([
      env.LEDGER.prepare(
        `SELECT site_id, date, event_name, count FROM business_counts WHERE date = ?1`
      )
        .bind(date)
        .all<BusinessCountRow>(),
      env.LEDGER.prepare(
        `SELECT site_id, substr(occurred_at, 1, 10) AS date, status AS event_name, COUNT(*) AS count
         FROM lead_status
         WHERE substr(occurred_at, 1, 10) = ?1
           AND lead_id NOT LIKE '%smoke%' AND lead_id NOT LIKE '%dm-validate%'
         GROUP BY site_id, status`
      )
        .bind(date)
        .all<LedgerLifecycleRow>(),
      env.LEDGER.prepare(
        `SELECT site_id, date, event_name, count FROM business_counts
         WHERE date >= ?1 AND date < ?2`
      )
        .bind(priorSinceDate, date)
        .all<BusinessCountRow>(),
      resolveBusinessMonitoringScope(env)
    ]);

    const crmRows = filterToMonitored(crm.results ?? [], monitored);
    const lifecycleRows = filterToMonitored(ledgerRows.results ?? [], monitored);
    const priorRows = filterToMonitored(prior.results ?? [], monitored);

    return [
      ...computeBusinessSourceDrift(crmRows, lifecycleRows),
      ...findSilentBusinessSources(priorRows, crmRows, date)
    ];
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_QUERY_FAILED,
      message: 'business-source reconciliation query failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
