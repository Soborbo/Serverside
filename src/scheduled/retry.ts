import type { Env } from '../env';
import {
  listPendingRetries,
  deleteDeadLetter,
  writeDeadLetter,
  archiveExpiredRecord,
  type DeadLetterRecord
} from '../lib/deadletter';
import { sendToMetaCAPI, type MetaCAPIPayload } from '../lib/meta';
import { sendToGA4MP, type GA4Payload } from '../lib/ga4';
import { type GAdsPayload } from '../lib/gads';
import { sendToDataManager } from '../lib/datamanager';
import { sendToTikTok, type TikTokPayload } from '../lib/tiktok';
import { sendToLinkedIn, type LinkedInPayload } from '../lib/linkedin';
import { sendToMsAds, type MsAdsPayload } from '../lib/msads';
import { getSiteConfig } from '../lib/config';
import { recordDeliveries } from '../lib/ledger';
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
  let expired: { key: string; record: DeadLetterRecord }[];
  try {
    ({ pending, expired } = await listPendingRetries(env));
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
        // A sikeres retry-t 'retry' origin-nal könyveljük a deliveries táblába,
        // különben a reconciliation (csak 'fanout'-ot számolt accepted-ként) hamis
        // coverage_drift CRITICAL-t adna minden DLQ-ból visszanyert kézbesítésre.
        await recordDeliveries(env, {
          event_id: String(record.event_payload.event_id ?? ''),
          site_id: record.site_id,
          event_name: String(record.event_payload.event_name ?? ''),
          origin: 'retry',
          records: [{ platform: record.platform, status: 'accepted' }]
        });
        await deleteDeadLetter(env, key);
        succeeded++;
      } else {
        const incremented = {
          ...record,
          retry_count: record.retry_count + 1,
          last_attempted_at: new Date().toISOString()
        };
        if (record.platform === 'ga4') {
          // GA4 MP NEM dedup-ol event_id-re (CLAUDE.md #16) → a write-then-delete
          // crash-ablak itt DUPLA konverziót adna. GA4-nél at-most-once: előbb
          // törlünk, aztán írunk — crash esetén inkább elvész egy retry-példány,
          // mint hogy duplán számoljon.
          await deleteDeadLetter(env, key);
          await writeDeadLetter(env, incremented);
        } else {
          // Atomicity: write the new (incremented) record FIRST, then delete the
          // old one ONLY if the write succeeded. If the Worker is killed between
          // the two ops, worst case is a duplicate retry (idempotent via event_id
          // dedup downstream). If the R2 write FAILS, the old record stays put —
          // the previous unconditional delete destroyed the event's only copy.
          const wrote = await writeDeadLetter(env, incremented);
          if (wrote) await deleteDeadLetter(env, key);
        }
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

  // Lejárt (24h+ vagy retry-kimerült) pending rekordok → dead-archívum. Enélkül
  // halhatatlanok: örökre pending-nek számítanak (SLO/digest riasztás-zaj), és
  // 10k+ felett lexikálisan kiszorítják a friss retry-olható rekordokat.
  let archivedExpired = 0;
  for (const { key, record } of expired) {
    try {
      if (await archiveExpiredRecord(env, key, record)) archivedExpired++;
    } catch (err) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.DLQ_WRITE_FAILED,
        message: 'Failed to archive expired DLQ record',
        r2_key: key,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  logStructured({
    level: 'info',
    message: 'Cron retry completed',
    total_pending: pending.length,
    retried: toRetry.length,
    succeeded,
    failed,
    expired_found: expired.length,
    expired_archived: archivedExpired
  });
}

export async function retrySingle(env: Env, record: DeadLetterRecord): Promise<boolean> {
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
    // Modell 2 + Data Manager migráció: a Google Ads offline láb a Data Manager
    // API-n megy, NEM a sunset uploadClickConversions-ön (az új adopternek
    // CUSTOMER_NOT_ALLOWLISTED-et ad). A retry-nak UGYANAZT az utat kell használnia.
    const result = await sendToDataManager(
      siteConfig,
      env,
      eventPayload as unknown as GAdsPayload,
      hashedUserData
    );
    return result.success;
  }
  if (record.platform === 'tiktok') {
    const result = await sendToTikTok(siteConfig, eventPayload as unknown as TikTokPayload, hashedUserData);
    return result.success;
  }
  if (record.platform === 'linkedin') {
    const result = await sendToLinkedIn(siteConfig, eventPayload as unknown as LinkedInPayload, hashedUserData);
    return result.success;
  }
  if (record.platform === 'msads') {
    const result = await sendToMsAds(siteConfig, eventPayload as unknown as MsAdsPayload, hashedUserData);
    return result.success;
  }
  return false;
}
