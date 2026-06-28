import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

export const MAX_RETRIES = 3;
const RETRY_WINDOW_HOURS = 24;

// Queues delivery-delay backoff 0-alapú index szerint (másodperc). Cloudflare
// Queues max delaySeconds = 86400 (24h) — a lenti értékek bőven belül vannak.
// HÍVÁSI KONVENCIÓ: a paraméter 0-ALAPÚ (0 = első késleltetés). A consumer a
// 1-alapú `msg.attempts`-ből `msg.attempts - 1`-et ad át, hogy a 60s-os fok is
// ténylegesen használatba kerüljön.
const QUEUE_BACKOFF_SECONDS = [60, 300, 1800];

export function backoffSeconds(zeroBasedIndex: number): number {
  const idx = Math.min(Math.max(zeroBasedIndex, 0), QUEUE_BACKOFF_SECONDS.length - 1);
  return QUEUE_BACKOFF_SECONDS[idx];
}

export type Platform = 'meta' | 'ga4' | 'gads' | 'msads' | 'tiktok' | 'linkedin';

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

/**
 * Sikertelen platform-hívás → újrapróba-sorba. Ha a Cloudflare Queues binding
 * (`env.DLQ`) elérhető, oda küldjük a rekordot delivery-delay backoff-fal;
 * különben visszaesünk az R2-alapú DLQ-ra (writeDeadLetter). A Queues consumer
 * a worker.ts `queue()` handlerében fut.
 */
export async function enqueueFailure(env: Env, record: DeadLetterRecord): Promise<void> {
  if (env.DLQ) {
    try {
      await env.DLQ.send(record, { delaySeconds: backoffSeconds(record.retry_count) });
      logStructured({
        level: 'info',
        message: 'Failure enqueued to Cloudflare Queue',
        site_id: record.site_id,
        platform: record.platform,
        retry_count: record.retry_count
      });
      return;
    } catch (err) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.DLQ_WRITE_FAILED,
        message: 'Queue send failed, falling back to R2 DLQ',
        site_id: record.site_id,
        platform: record.platform,
        error: err instanceof Error ? err.message : String(err)
      });
      // fall through to R2
    }
  }
  await writeDeadLetter(env, record);
}

export async function writeDeadLetter(env: Env, record: DeadLetterRecord): Promise<void> {
  const date = new Date(record.last_attempted_at);
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '-');

  const eventId = (record.event_payload.event_id as string) || 'unknown';
  const safeEventId = eventId.slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '_');

  // A 'dead' marad a 2. szegmens (isDeadKey ezt nézi), de a dátum is bekerül
  // UTÁNA, hogy a dead archívum is lexikálisan dátum-rendezhető/scan-elhető legyen.
  const prefix =
    record.retry_count >= MAX_RETRIES
      ? `${record.site_id}/${record.platform}/dead/${dateStr}`
      : `${record.site_id}/${record.platform}/${dateStr}`;

  // Egyediség-suffix: a kulcs másodperc-felbontású, és event_id hiányában a
  // safeEventId 'unknown' — egy platform-kimaradás SOK eventet bukik ugyanabban a
  // másodpercben, amik különben felülírnák egymást (R2 last-write-wins) → DLQ
  // alulszámol épp amikor a legjobban kell. A random token garantálja az egyediséget.
  const unique = crypto.randomUUID().slice(0, 8);
  const key = `${prefix}/${timeStr}_${safeEventId}_${record.retry_count}_${unique}.json`;

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
  // Pending key:  {site_id}/{platform}/{date}/{filename}.json
  // Dead key:     {site_id}/{platform}/dead/{date}/{filename}.json
  // A 'dead' MINDIG a 2. szegmens → segment-match (NEM substring), így egy
  // "dead"-et tartalmazó site_id sem ad hamis pozitívot. Mindkét régi és új
  // dead-kulcs-formátum egyezik (a 'dead' marad a 2. szegmensen).
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
