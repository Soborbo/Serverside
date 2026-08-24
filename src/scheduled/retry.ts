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
import { isGa4AllowedForSite } from '../lib/consent-log';
import { type GAdsPayload } from '../lib/gads';
import { sendToDataManager } from '../lib/datamanager';
import { sendToTikTok, type TikTokPayload } from '../lib/tiktok';
import { sendToLinkedIn, type LinkedInPayload } from '../lib/linkedin';
import { sendToMsAds, type MsAdsPayload } from '../lib/msads';
import { getSiteConfig } from '../lib/config';
import {
  recordDeliveries,
  normalizeDelivery,
  getLatestConsentForLead,
  getConsentState,
  markDoNotReplay,
  type VendorResult
} from '../lib/ledger';
import { isBlockedByConsentState } from '../lib/consent-log';
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
  let suppressed = 0;

  for (const { key, record } of toRetry) {
    try {
      const result = await retrySingle(env, record);
      if (isRealRetrySuccess(result)) {
        await recordRetryDelivery(env, record, result);
        await deleteDeadLetter(env, key);
        succeeded++;
      } else if (result.skipped && result.skip_reason === 'consent_withdrawn') {
        // 2.5: a visszavonás NEM tranziens állapot — a rekord óránkénti újra-
        // skippelése a 7 napos lejáratig csak zaj lenne, és a dead-archívumból
        // egy admin-replay újra kiküldhetné. Ehelyett: do_not_replay=1 (permanens
        // szuppresszió az idempotency táblában) + 'skipped' ledger-sor (a monitor
        // lássa, MIÉRT nincs kézbesítés) + a DLQ-példány törlése. A törlés CSAK a
        // sikeres jelölés után — ha a jelölés elbukik, a rekord marad, és a
        // következő cron-kör újra próbálja.
        await recordDeliveries(env, {
          event_id: String(record.event_payload.event_id ?? ''),
          lead_id: record.lead_id,
          site_id: record.site_id,
          event_name: String(record.event_payload.event_name ?? ''),
          origin: 'retry',
          records: [normalizeDelivery(record.platform, { status: 'fulfilled', value: result })]
        });
        const marked = await markDoNotReplay(
          env,
          record.site_id,
          String(record.event_payload.event_name ?? ''),
          String(record.event_payload.event_id ?? '')
        );
        if (marked) await deleteDeadLetter(env, key);
        logStructured({
          level: 'info',
          message:
            'DLQ record suppressed — consent withdrawn since capture (do_not_replay=1, record removed)',
          site_id: record.site_id,
          platform: record.platform,
          lead_id: record.lead_id
        });
        suppressed++;
      } else {
        if (result.skipped) {
          logSkippedRetry(record);
        } else {
          // Valódi vendor-bukás a retry-n → 'rejected' delivery a ledgerbe. Enélkül a
          // reconciliation vendor-hibarátája PONT kiesés alatt mér alul: az eredeti
          // fan-out kísérlet után minden retry-bukás láthatatlan maradna. (A SKIP nem
          // vendor-hívás → azt NEM könyveljük, különben a 7 napos configblokk
          // óránként új sort írna. A retry_count korlátozza a rejected-sorok számát.)
          await recordRetryDelivery(env, record, result);
        }
        // A retry_count VALÓDI kézbesítési kísérleteket számol. Egy konfigurációs
        // blokk skipje NEM kísérlet: hívás nem történt, a vendor nem is látta az
        // eventet. Ha ezt is számolnánk, az óránkénti cron ~egy nap alatt
        // kimerítené a keretet, és a rekord a dead-archívumba esne még azelőtt,
        // hogy a hiányzó configot bárki visszaírná — vagyis a „tartós retry"
        // pontosan a lomtalan-forgatókönyvben mondana csődöt. Így a rekordot
        // egyedül a 7 napos ablak (retryWindowHoursFor) járatja le.
        const configBlocked = record.blocked_configuration === true && result.skipped === true;
        const incremented = {
          ...record,
          retry_count: configBlocked ? record.retry_count : record.retry_count + 1,
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
    suppressed_consent_withdrawn: suppressed,
    expired_found: expired.length,
    expired_archived: archivedExpired
  });
}

/**
 * Valódi kézbesítés-e a retry-eredmény. `skipped` siker NEM az: azt jelenti, a
 * platform-config épp hiányzik (pl. ideiglenesen kivett meta blokk / conversion
 * action) és hívás NEM történt — ilyenkor a DLQ-rekordot NEM töröljük, hogy a
 * config visszaállítása után az event még kézbesíthető legyen. A rekord a normál
 * retry/expiry úton megy tovább (végül dead-archívum, admin-replay-elhető).
 */
export function isRealRetrySuccess(result: VendorResult): boolean {
  return result.success && result.skipped !== true;
}

/**
 * Retry-kézbesítés könyvelése a ledgerbe 'retry' origin-nal — az EGYETLEN közös
 * pontja mind a négy replay-útnak (cron, Queues consumer, admin single/bulk).
 * SIKER és VALÓDI BUKÁS egyaránt ide fut: a sikeres retry 'accepted', a bukott
 * 'rejected' sort ír (normalizeDelivery dönt a VendorResult alapján) — enélkül a
 * vendor-hibaráta kiesés alatt alulmérne. (A szándékos SKIP-et a hívó NEM adja
 * ide.) A reconciliation csak 'fanout'+'retry' origint számol; enélkül hamis
 * coverage_drift CRITICAL menne minden visszanyert kézbesítésre. accepted CSAK
 * vendor HTTP-státusszal; a lead_id a DLQ-rekordból utazik tovább a lead-trailhez.
 */
export async function recordRetryDelivery(
  env: Env,
  record: DeadLetterRecord,
  result: VendorResult
): Promise<void> {
  await recordDeliveries(env, {
    event_id: String(record.event_payload.event_id ?? ''),
    lead_id: record.lead_id,
    site_id: record.site_id,
    event_name: String(record.event_payload.event_name ?? ''),
    origin: 'retry',
    records: [normalizeDelivery(record.platform, { status: 'fulfilled', value: result })]
  });
}

export function logSkippedRetry(record: DeadLetterRecord): void {
  logStructured({
    level: 'warn',
    message:
      'DLQ retry skipped — platform not configured right now; record kept for a later retry (restore the config or admin-replay)',
    site_id: record.site_id,
    platform: record.platform,
    retry_count: record.retry_count
  });
}

/**
 * Egyetlen DLQ-rekord újraküldése. A TELJES vendor-eredményt adja vissza (nem
 * csupasz boolean-t), hogy a hívók a ledger-könyvelést a normalizeDelivery-n
 * keresztül végezhessék: accepted CSAK valós vendor HTTP-státusszal íródhat,
 * a szándékos skip (időközben eltávolított config) pedig 'skipped'-ként.
 */
export async function retrySingle(env: Env, record: DeadLetterRecord): Promise<VendorResult> {
  const siteConfig = await getSiteConfig(record.hostname, env);
  if (!siteConfig) {
    return {
      success: false,
      error_code: TrackingErrorCode.NO_SITE_CONFIG,
      error: ERROR_DESCRIPTIONS[TrackingErrorCode.NO_SITE_CONFIG]
    };
  }

  const hashedUserData = (record.hashed_user_data || {}) as HashedUserData;
  const eventPayload = record.event_payload;

  if (record.platform === 'meta') {
    return sendToMetaCAPI(
      siteConfig,
      eventPayload as unknown as MetaCAPIPayload,
      hashedUserData
    );
  }
  if (record.platform === 'ga4') {
    // Az offline GA4 láb kikapcsolt (Run 6), de a korábban DLQ-ba került ga4-
    // rekordok leürítéséhez a retry-út megmarad.
    //
    // CMP Fázis 1: `provider='sbo'` site-on a GA4 `analytics_storage='GRANTED'`-hez
    // kötött (a DUAA statisztikai kivétel a GA4-et nem menti meg — lásd
    // consent-log.ts isGa4AllowedForSite). A CookieYes-site-okon a mai szabály áll,
    // tehát ez az ág ott bitre változatlan. A DLQ-rekord a capture-kori jeleket
    // hordozza; ha akkor nem volt analytics-consent, ma sem küldjük fel.
    const ga4Payload = eventPayload as unknown as GA4Payload;
    if (!isGa4AllowedForSite(siteConfig, ga4Payload.consent)) {
      return {
        success: true,
        skipped: true,
        skip_reason: 'consent_denied',
        error: 'GA4 skipped: analytics consent not granted (provider=sbo)'
      };
    }
    return sendToGA4MP(siteConfig, ga4Payload);
  }
  if (record.platform === 'gads') {
    // CMP Fázis 2 (2.5): MINDEN replay előtt a consent_log AKTUÁLIS állapota
    // (legmagasabb revision) dönt, nem a capture-kori jel. Ez a retrySingle az
    // EGYETLEN közös pontja mind a négy replay-útnak (cron, Queues consumer,
    // admin single/bulk), ezért a kapu ide kerül. lead_id vagy consent_id nélkül
    // (a teljes CookieYes-flotta) az ág bitre a mai — a Fázis 2 szerveroldala
    // inert marad, amíg egy site nem ír consent_id-s receiptet.
    if (record.lead_id) {
      const leadConsent = await getLatestConsentForLead(env, record.site_id, record.lead_id);
      if (leadConsent?.consent_id) {
        const state = await getConsentState(env, record.site_id, leadConsent.consent_id);
        if (isBlockedByConsentState(state)) {
          return {
            success: true,
            skipped: true,
            skip_reason: 'consent_withdrawn',
            error: `gads replay skipped: current consent state is ${state?.decision} (revision ${state?.revision})`
          };
        }
      }
    }
    // Modell 2 + Data Manager migráció: a Google Ads offline láb a Data Manager
    // API-n megy, NEM a sunset uploadClickConversions-ön (az új adopternek
    // CUSTOMER_NOT_ALLOWLISTED-et ad). A retry-nak UGYANAZT az utat kell használnia.
    return sendToDataManager(
      siteConfig,
      env,
      eventPayload as unknown as GAdsPayload,
      hashedUserData
    );
  }
  if (record.platform === 'tiktok') {
    return sendToTikTok(siteConfig, eventPayload as unknown as TikTokPayload, hashedUserData);
  }
  if (record.platform === 'linkedin') {
    return sendToLinkedIn(siteConfig, eventPayload as unknown as LinkedInPayload, hashedUserData);
  }
  if (record.platform === 'msads') {
    return sendToMsAds(siteConfig, eventPayload as unknown as MsAdsPayload, hashedUserData);
  }
  return { success: false, error: `unknown platform: ${record.platform}` };
}
