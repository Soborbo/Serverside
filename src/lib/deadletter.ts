import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

const MAX_RETRIES = 3;
const RETRY_WINDOW_HOURS = 24;

export type Platform = 'meta' | 'ga4' | 'gads';

export interface DeadLetterRecord {
  platform: Platform;
  site_id: string;
  hostname: string;
  event_payload: Record<string, unknown>;
  hashed_user_data?: Record<string, unknown>;
  failure_reason: string;
  retry_count: number;
  first_failed_at: string;
  last_attempted_at: string;
}

export async function writeDeadLetter(env: Env, record: DeadLetterRecord): Promise<void> {
  const date = new Date(record.last_attempted_at);
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '-');

  const eventId = (record.event_payload.event_id as string) || 'unknown';
  const safeEventId = eventId.slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '_');

  const prefix =
    record.retry_count >= MAX_RETRIES
      ? `${record.site_id}/${record.platform}/dead`
      : `${record.site_id}/${record.platform}/${dateStr}`;

  const key = `${prefix}/${timeStr}_${safeEventId}_${record.retry_count}.json`;

  try {
    await env.DEAD_LETTER.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }
    });

    const isDead = record.retry_count >= MAX_RETRIES;
    logStructured({
      level: isDead ? 'warn' : 'info',
      error_code: isDead ? TrackingErrorCode.MAX_RETRIES_EXCEEDED : undefined,
      message: isDead ? ERROR_DESCRIPTIONS[TrackingErrorCode.MAX_RETRIES_EXCEEDED] : 'Wrote event to dead letter queue',
      site_id: record.site_id,
      platform: record.platform,
      retry_count: record.retry_count,
      r2_key: key
    });
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.DLQ_WRITE_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_WRITE_FAILED],
      site_id: record.site_id,
      platform: record.platform,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export function isDeadKey(key: string): boolean {
  // Key format: {site_id}/{platform}/{date_or_dead}/{filename}.json
  // Use segment-match instead of substring to avoid false positives if a
  // site_id ever contained "/dead/" in its name.
  const segments = key.split('/');
  return segments.length >= 4 && segments[2] === 'dead';
}

export async function listPendingRetries(
  env: Env,
  sitePrefix?: string,
  maxResults = 100
): Promise<{ key: string; record: DeadLetterRecord }[]> {
  const now = Date.now();
  const cutoffMs = RETRY_WINDOW_HOURS * 60 * 60 * 1000;

  const results: { key: string; record: DeadLetterRecord }[] = [];
  let cursor: string | undefined = undefined;
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    const listResult: R2Objects = await env.DEAD_LETTER.list({
      prefix: sitePrefix,
      cursor,
      limit: 1000
    });

    for (const obj of listResult.objects) {
      if (isDeadKey(obj.key)) continue;
      if (results.length >= maxResults) break;

      try {
        const body = await env.DEAD_LETTER.get(obj.key);
        if (!body) continue;
        const record = (await body.json()) as DeadLetterRecord;

        const firstFailedMs = new Date(record.first_failed_at).getTime();
        if (now - firstFailedMs > cutoffMs) continue;
        if (record.retry_count >= MAX_RETRIES) continue;

        results.push({ key: obj.key, record });
      } catch (err) {
        logStructured({
          level: 'warn',
          error_code: TrackingErrorCode.DLQ_CORRUPT_RECORD,
          message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_CORRUPT_RECORD],
          r2_key: obj.key,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    if (results.length >= maxResults) break;
    if (!listResult.truncated) break;
    cursor = listResult.cursor;
    iterations++;
  }

  return results;
}

export async function deleteDeadLetter(env: Env, key: string): Promise<void> {
  try {
    await env.DEAD_LETTER.delete(key);
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.DLQ_DELETE_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_DELETE_FAILED],
      r2_key: key,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
