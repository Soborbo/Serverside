import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import { isDeadKey } from '../lib/deadletter';
import {
  buildRetentionPolicies,
  cutoffIso,
  deleteSql,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
  type RetentionPolicy
} from '../lib/retention';

const R2_PAGE_LIMIT = 1000;
const R2_MAX_PAGES = 10; // 10 × 1000 = 10K dead-record sample window / run

/**
 * Napi retention cleanup (#8/#9) — a D1 ledger operatív tábláit és az R2 DLQ
 * 'dead' archívumát purge-öli a megőrzési ablakon túl. A daily-digest /
 * reconciliation MELLETT fut, külön (alacsony forgalmú) cronon.
 *
 * - LEDGER binding nélkül a D1-rész no-op (a Worker D1 nélkül is fut).
 * - Csak a 'dead' R2-kulcsokat purge-öljük; a PENDING (még retry-olható)
 *   rekordokat SOHA — azok ki nem kézbesített valódi konverziók.
 * - Minden lépés try/catch-elt, sosem dob a scheduled() felé.
 */
export async function handleRetention(env: Env): Promise<void> {
  const nowMs = Date.now();
  await purgeLedger(env, nowMs);
  await purgeDeadRecords(env, nowMs);
}

async function purgeLedger(env: Env, nowMs: number): Promise<void> {
  if (!env.LEDGER) {
    logStructured({ level: 'info', message: 'Retention skipped — no D1 LEDGER binding' });
    return;
  }

  const policies = buildRetentionPolicies(env);
  const purged: Record<string, number> = {};

  for (const policy of policies) {
    const cutoff = cutoffIso(nowMs, policy.days);
    try {
      const result = await env.LEDGER.prepare(deleteSql(policy)).bind(cutoff).run();
      purged[policy.table] = result.meta?.changes ?? 0;
    } catch (err) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.RETENTION_QUERY_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.RETENTION_QUERY_FAILED],
        table: policy.table,
        retention_days: policy.days,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  logStructured({
    level: 'info',
    message: 'Ledger retention completed',
    policies: policies.map((p: RetentionPolicy) => `${p.table}:${p.days}d`).join(','),
    purged
  });
}

async function purgeDeadRecords(env: Env, nowMs: number): Promise<void> {
  const days = resolveRetentionDays(env.DEAD_RECORD_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  let deleted = 0;
  let scanned = 0;
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  try {
    while (pages < R2_MAX_PAGES) {
      const list = await env.DEAD_LETTER.list({ cursor, limit: R2_PAGE_LIMIT });
      for (const obj of list.objects) {
        scanned++;
        // CSAK a kimerült 'dead' archívumot purge-öljük; a pending sosem.
        if (!isDeadKey(obj.key)) continue;
        if (obj.uploaded.getTime() >= cutoffMs) continue;
        await env.DEAD_LETTER.delete(obj.key);
        deleted++;
      }
      if (!list.truncated) break;
      cursor = list.cursor;
      pages++;
    }
    if (pages >= R2_MAX_PAGES) truncated = true;

    logStructured({
      level: 'info',
      message: 'Dead-letter retention completed',
      retention_days: days,
      dead_purged: deleted,
      objects_scanned: scanned,
      list_truncated: truncated
    });
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RETENTION_R2_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RETENTION_R2_FAILED],
      dead_purged: deleted,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
