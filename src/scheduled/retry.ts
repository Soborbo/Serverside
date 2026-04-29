import type { Env } from '../env';
import {
  listPendingRetries,
  deleteDeadLetter,
  writeDeadLetter,
  type DeadLetterRecord
} from '../lib/deadletter';
import { sendToMetaCAPI, type MetaCAPIPayload } from '../lib/meta';
import { sendToGA4MP, type GA4Payload } from '../lib/ga4';
import { sendToGoogleAdsCAPI, type GAdsPayload } from '../lib/gads';
import { getSiteConfig } from '../lib/config';
import type { HashedUserData } from '../lib/hash';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';

const MAX_RETRIES_PER_RUN = 100;

export async function handleScheduledRetry(event: ScheduledEvent, env: Env): Promise<void> {
  logStructured({
    level: 'info',
    message: 'Cron retry started',
    cron: event.cron,
    scheduled_time: new Date(event.scheduledTime).toISOString()
  });

  let pending: { key: string; record: DeadLetterRecord }[];
  try {
    pending = await listPendingRetries(env);
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.DLQ_LIST_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_LIST_FAILED],
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  const toRetry = pending.slice(0, MAX_RETRIES_PER_RUN);

  let succeeded = 0;
  let failed = 0;

  for (const { key, record } of toRetry) {
    try {
      const success = await retrySingle(env, record);
      if (success) {
        await deleteDeadLetter(env, key);
        succeeded++;
      } else {
        await deleteDeadLetter(env, key);
        await writeDeadLetter(env, {
          ...record,
          retry_count: record.retry_count + 1,
          last_attempted_at: new Date().toISOString()
        });
        failed++;
      }
    } catch (err) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.CRON_RETRY_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.CRON_RETRY_FAILED],
        r2_key: key,
        error: err instanceof Error ? err.message : String(err)
      });
      failed++;
    }
  }

  logStructured({
    level: 'info',
    message: 'Cron retry completed',
    total_pending: pending.length,
    retried: toRetry.length,
    succeeded,
    failed
  });
}

async function retrySingle(env: Env, record: DeadLetterRecord): Promise<boolean> {
  const siteConfig = await getSiteConfig(record.hostname, env);
  if (!siteConfig) return false;

  const hashedUserData = (record.hashed_user_data || {}) as HashedUserData;
  const eventPayload = record.event_payload;

  if (record.platform === 'meta') {
    const result = await sendToMetaCAPI(
      siteConfig,
      eventPayload as unknown as MetaCAPIPayload,
      hashedUserData
    );
    return result.success;
  }
  if (record.platform === 'ga4') {
    const result = await sendToGA4MP(siteConfig, eventPayload as unknown as GA4Payload);
    return result.success;
  }
  if (record.platform === 'gads') {
    const result = await sendToGoogleAdsCAPI(
      siteConfig,
      env,
      eventPayload as unknown as GAdsPayload,
      hashedUserData
    );
    return result.success;
  }
  return false;
}
