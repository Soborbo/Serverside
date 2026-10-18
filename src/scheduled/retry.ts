import type { Env } from '../env';
import {
  listPendingRetries,
  listSitePrefixes,
  deleteDeadLetter,
  writeDeadLetter,
  archiveExpiredRecord,
  type DeadLetterRecord
} from '../lib/deadletter';
import { sendToMetaCAPI, type MetaCAPIPayload } from '../lib/meta';
import { sendToGA4MP, type GA4Payload } from '../lib/ga4';
import { decideAdConsent, isConsentProviderSbo } from '../lib/consent-log';
import { isTerminalSkip } from '../lib/skip-reason';
import { type GAdsPayload } from '../lib/gads';
import { assessUploadWindow, sendToDataManager } from '../lib/datamanager';
import { sendToTikTok, type TikTokPayload } from '../lib/tiktok';
import { sendToLinkedIn, type LinkedInPayload } from '../lib/linkedin';
import { sendToMsAds, type MsAdsPayload } from '../lib/msads';
import { lookupSiteConfig, type SiteConfig } from '../lib/config';
import {
  recordDeliveries,
  normalizeDelivery,
  readLatestConsentForLead,
  readConsentState,
  markDoNotReplay,
  skipReasonFromErrorCode,
  type VendorResult
} from '../lib/ledger';
import type { HashedUserData } from '../lib/hash';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';

const MAX_RETRIES_PER_RUN = 100;
/** A lejart rekordok archivalasi kerete egy futasra (a listPendingRetries default-ja). */
const MAX_EXPIRED_PER_RUN = 200;

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
    // SITE-ONKÉNTI, MÉLTÁNYOS begyűjtés. A prefix nélküli listázás R2
    // KULCS-SORRENDBEN adja a rekordokat, és a 100-as futás-keret az első
    // site-oknál elfogy: egy alfabetikusan korai site tartós
    // `blocked_configuration` backlogja (eseményenként egy 7 napig élő rekord)
    // minden utána következő site-ot ELÉHEZTET — azok 24 órás ablakú, VALÓDI
    // vendor-hibái egyetlen újrapróbálkozás nélkül járnak le.
    //
    // A prefixeket delimiter-listázás adja (olcsó), a keretet pedig elosztjuk.
    // Egy site sem kaphat 5-nél kevesebbet: különben sok tenantnál a méltányos
    // rész nullára kerekedne, és senki nem haladna.
    const prefixes = await listSitePrefixes(env);
    if (prefixes.length > 1) {
      const perSite = Math.max(5, Math.floor(MAX_RETRIES_PER_RUN / prefixes.length));
      const perSiteExpired = Math.max(5, Math.floor(MAX_EXPIRED_PER_RUN / prefixes.length));
      pending = [];
      expired = [];
      for (const prefix of prefixes) {
        const page = await listPendingRetries(env, prefix, perSite, perSiteExpired);
        pending.push(...page.pending);
        expired.push(...page.expired);
      }
    } else {
      ({ pending, expired } = await listPendingRetries(env));
    }
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
      } else if (isTerminalRetrySkip(record, result)) {
        // TERMINÁLIS skip — UGYANAZ a szabály, mint a Queue-consumerben (worker.ts):
        // a consent-tiltás/-hiány, a nem-elvárt platform és a hiányzó azonosító
        // magától SOSEM javul meg, tehát a rekord óránkénti újra-skippelése a
        // lejáratig csak zaj, és a dead-archívumba vinné a (hash-elt) PII-t.
        // 'skipped' ledger-sor (a monitor lássa, MIÉRT nincs kézbesítés) + a
        // DLQ-példány törlése. Visszavonásnál ELŐBB do_not_replay=1 (permanens
        // szuppresszió), és a törlés CSAK a sikeres jelölés után — ha a jelölés
        // elbukik, a rekord marad, és a következő cron-kör újra próbálja.
        await recordDeliveries(env, {
          event_id: String(record.event_payload.event_id ?? ''),
          lead_id: record.lead_id,
          site_id: record.site_id,
          event_name: String(record.event_payload.event_name ?? ''),
          origin: 'retry',
          records: [normalizeDelivery(record.platform, { status: 'fulfilled', value: result })]
        });
        const withdrawn = result.skip_reason === 'consent_withdrawn';
        const marked = withdrawn
          ? await markDoNotReplay(
              env,
              record.site_id,
              String(record.event_payload.event_name ?? ''),
              String(record.event_payload.event_id ?? '')
            )
          : true;
        if (marked) await deleteDeadLetter(env, key);
        logStructured({
          level: 'info',
          message: withdrawn
            ? 'DLQ record suppressed — consent withdrawn since capture (do_not_replay=1, record removed)'
            : 'DLQ record closed — terminal skip on retry (record removed)',
          site_id: record.site_id,
          platform: record.platform,
          skip_reason: result.skip_reason,
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
 * Lezárható-e a DLQ-rekord egy skip-eredmény alapján — a cron ÉS a Queue-consumer
 * KÖZÖS szabálya (worker.ts). A Data Manager config-skipje `skip_reason` nélkül,
 * csak `error_code`-dal jön: az okot abból vezetjük le (skipReasonFromErrorCode),
 * különben az `isTerminalSkip(undefined) === true` a 7 napos konfigurációs
 * blokkot az első futáson törölné. A `blocked_configuration` rekord SOHA nem
 * terminális skip: azt kifejezetten a config visszaírásáig őrizzük.
 */
export function isTerminalRetrySkip(record: DeadLetterRecord, result: VendorResult): boolean {
  if (result.skipped !== true || record.blocked_configuration === true) return false;
  return isTerminalSkip(result.skip_reason ?? skipReasonFromErrorCode(result.error_code));
}

/**
 * Replay consent-kapu, CSATORNAFÜGGETLENÜL: minden újraküldés (cron, Queues
 * consumer, admin single/bulk) a retrySingle-en megy át, és ITT ugyanazt a közös
 * szabályt kérdezi, mint a CRM-esemény (consent-log.ts decideAdConsent). A
 * kategória a csatornától függ: a GA4 az analitika-, a többi a hirdetési jelet.
 *
 * Visszatérés: `null` = mehet a küldés; különben a hívónak visszaadandó eredmény:
 *  - tiltott (visszavont) → `skipped` + `consent_withdrawn` (terminális,
 *    do_not_replay + a rekord törlése);
 *  - új döntés szükséges (saját CMP, nincs consent_log-sor / consent_id) →
 *    24 óráig újrapróbálható (a döntés még úton lehet), utána `skipped` +
 *    `consent_missing_failclosed` (terminális) — a capture-kori engedélyre NEM
 *    esünk vissza;
 *  - nem ellenőrizhető (D1-hiba) → `success:false` + CONSENT_STATE_UNAVAILABLE:
 *    hívás nem történik, a rekord a normál retry-úton marad.
 *
 * CookieYes-site-on (nincs consent_log, nincs visszavonás-forrás) a capture-kori
 * kapu döntése áll — a mai viselkedés; a lead-olvasás hibája ott nem állít meg.
 */
/** Ennyi ideig várunk egy még úton lévő consent-döntésre a replay-en (24 óra). */
const NEEDS_DECISION_GRACE_MS = 24 * 60 * 60 * 1000;

export async function checkReplayConsent(
  env: Env,
  siteConfig: SiteConfig,
  record: DeadLetterRecord
): Promise<VendorResult | null> {
  let consentId = typeof record.consent_id === 'string' && record.consent_id ? record.consent_id : null;
  const lead = !consentId && record.lead_id
    ? await readLatestConsentForLead(env, record.site_id, record.lead_id)
    : null;
  if (lead?.kind === 'found') consentId = lead.record.consent_id;
  const verdict = decideAdConsent({
    sbo: isConsentProviderSbo(siteConfig),
    requireConsent: siteConfig.require_consent === true,
    category: record.platform === 'ga4' ? 'analytics' : 'ads',
    consentLog: consentId ? await readConsentState(env, record.site_id, consentId) : null,
    // A replay-en a receipt csak a consent_id forrása, nem evidencia: a capture-
    // kori kapu már döntött. A hibája viszont saját CMP-n számít (lásd decide).
    receipt: lead && lead.kind !== 'found' ? lead : null,
    passedCaptureGate: true
  });
  if (verdict.kind === 'allowed') return null;
  // Az „új döntés szükséges" a capture után nem feltétlenül végleges: a böngésző
  // a 503-at kapott döntését a következő oldalletöltéskor küldi újra. A rekord
  // ezért NEEDS_DECISION_GRACE_MS-ig újrapróbálható (nincs küldés), csak utána
  // zárul terminális skippel — se engedély, se idő előtti végleges vesztés.
  const young =
    Date.now() - Date.parse(record.first_failed_at) < NEEDS_DECISION_GRACE_MS;
  if (verdict.kind === 'unavailable' || (verdict.kind === 'needs_decision' && young)) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.CONSENT_STATE_UNAVAILABLE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.CONSENT_STATE_UNAVAILABLE],
      site_id: record.site_id,
      platform: record.platform,
      // 'unavailable' = D1-hiba; 'needs_decision' = a döntés még nem érkezett meg.
      reason: verdict.kind
    });
    return {
      success: false,
      error_code: TrackingErrorCode.CONSENT_STATE_UNAVAILABLE,
      error: ERROR_DESCRIPTIONS[TrackingErrorCode.CONSENT_STATE_UNAVAILABLE]
    };
  }
  return {
    success: true,
    skipped: true,
    skip_reason: verdict.skip_reason,
    error: `${record.platform} replay skipped: ${verdict.kind === 'denied' ? 'current consent state does not allow it' : 'no valid consent decision on record'}`
  };
}

/**
 * Egyetlen DLQ-rekord újraküldése. A TELJES vendor-eredményt adja vissza (nem
 * csupasz boolean-t), hogy a hívók a ledger-könyvelést a normalizeDelivery-n
 * keresztül végezhessék: accepted CSAK valós vendor HTTP-státusszal íródhat,
 * a szándékos skip (időközben eltávolított config) pedig 'skipped'-ként.
 */
export async function retrySingle(env: Env, record: DeadLetterRecord): Promise<VendorResult> {
  // `lookupSiteConfig`, NEM a `getSiteConfig` compat-burkoló: az a TRANZIENS
  // KV-hibát és a NEM LÉTEZŐ site-ot egyformán `null`-ként adta vissza. Egy pár
  // másodperces KV-blip így `NO_SITE_CONFIG` néven égetett el egy retry-kísérletet
  // ÉS írt egy 'rejected' delivery-sort a ledgerbe (ami a reconciliation
  // vendor-hibarátáját is felhúzza) — három blip alatt a rekord dead lett, holott
  // a site végig létezett. A pénz-utak mind ezt a feloldót használják (lib/config.ts).
  const { config: siteConfig, unavailable } = await lookupSiteConfig(record.hostname, env);
  if (!siteConfig) {
    const code = unavailable ? TrackingErrorCode.KV_READ_FAILED : TrackingErrorCode.NO_SITE_CONFIG;
    return {
      success: false,
      error_code: code,
      error: ERROR_DESCRIPTIONS[code]
    };
  }

  const hashedUserData = (record.hashed_user_data || {}) as HashedUserData;
  const eventPayload = record.event_payload;

  // Minden csatorna (a GA4 is, az analitika-kategóriával) ugyanazon a kapun megy át.
  const blocked = await checkReplayConsent(env, siteConfig, record);
  if (blocked) return blocked;

  if (record.platform === 'meta') {
    return sendToMetaCAPI(
      siteConfig,
      eventPayload as unknown as MetaCAPIPayload,
      hashedUserData
    );
  }
  if (record.platform === 'ga4') {
    // Az offline GA4 láb kikapcsolt (Run 6), de a korábban DLQ-ba került ga4-
    // rekordok leürítéséhez a retry-út megmarad. A consent-kapu fent futott
    // (analitika-kategória: saját CMP-n a consent_log AKTUÁLIS állapota).
    const ga4Payload = eventPayload as unknown as GA4Payload;
    return sendToGA4MP(siteConfig, ga4Payload);
  }
  if (record.platform === 'gads') {
    // Modell 2 + Data Manager migráció: a Google Ads offline láb a Data Manager
    // API-n megy, NEM a sunset uploadClickConversions-ön (az új adopternek
    // CUSTOMER_NOT_ALLOWLISTED-et ad). A retry-nak UGYANAZT az utat kell használnia.
    // A feltöltési határidőt az ÚJRAKÜLDÉS pillanatában ellenőrizzük (review R8):
    // a határidő előtt sorba került, de utána újraküldött esemény kifutott. Az
    // üzleti esemény és a bevétele (lead_status) ettől érintetlen.
    const gadsPayload = eventPayload as unknown as GAdsPayload;
    // Hiányzó / hibás event_time (régi rekord) nem dobhat RangeError-t: ilyenkor
    // csak a click_at-ből ítélünk (ismeretlen → a Google dönt).
    const eventMs = Number(gadsPayload.event_time) * 1000;
    const window = assessUploadWindow(Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : '', {
      clickAtIso: gadsPayload.click_at,
      hasClickId: Boolean(gadsPayload.gclid || gadsPayload.gbraid || gadsPayload.wbraid)
    });
    if (window.status === 'expired') {
      return {
        success: true,
        skipped: true,
        skip_reason: 'conversion_window_expired',
        error: `gads replay skipped: ${window.age_days} days since ${window.reference} > ${window.limit_days}-day upload limit (${window.identification})`
      };
    }
    return sendToDataManager(siteConfig, env, gadsPayload, hashedUserData);
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
