import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

export const MAX_RETRIES = 3;
const RETRY_WINDOW_HOURS = 24;

/**
 * Konfigurációs blokk (hiányzó config egy ELVÁRT platformon) — külön retry-keret.
 *
 * Egy 500-as vendor-hiba percek alatt magától elmúlhat, ezért ott a [60s, 5p, 30p]
 * backoff és a 3 próbálkozás helyes. Egy hiányzó config viszont SOHA nem javul meg
 * magától — csak akkor, ha valaki visszaírja a KV-t. A rövid kerettel a rekord
 * ~35 perc alatt kimerülne és a dead-archívumba esne, jóval azelőtt, hogy bárki
 * észrevenné a riasztást. Ezért: ritka próbálkozás, hosszú ablak.
 *
 * Az ablak felső határát a Meta CAPI 7 napos elfogadási ablaka szabja meg — ezen
 * túl a retry amúgy is értelmetlen, a rekord mehet a dead-archívumba.
 */
const BLOCKED_CONFIG_BACKOFF_SECONDS = 6 * 3600; // 6 óra
const BLOCKED_CONFIG_WINDOW_HOURS = 7 * 24; // 7 nap (Meta CAPI ablak)
export const MAX_RETRIES_BLOCKED_CONFIG = Math.floor(
  (BLOCKED_CONFIG_WINDOW_HOURS * 3600) / BLOCKED_CONFIG_BACKOFF_SECONDS
); // = 28

/** A rekordra érvényes retry-plafon (a konfigurációs blokk külön keretet kap). */
export function maxRetriesFor(record: Pick<DeadLetterRecord, 'blocked_configuration'>): number {
  return record.blocked_configuration === true ? MAX_RETRIES_BLOCKED_CONFIG : MAX_RETRIES;
}

/** A rekordra érvényes retry-ablak órában. */
export function retryWindowHoursFor(
  record: Pick<DeadLetterRecord, 'blocked_configuration'>
): number {
  return record.blocked_configuration === true ? BLOCKED_CONFIG_WINDOW_HOURS : RETRY_WINDOW_HOURS;
}

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
  // CRM join-kulcs (ha az eredeti eventen volt): enélkül a DLQ-ból visszanyert
  // kézbesítés deliveries-sora lead_id=NULL lenne, és a lead-trail sosem
  // mutatná, hogy a platform végül megkapta az eventet.
  lead_id?: string;
  event_payload: Record<string, unknown>;
  hashed_user_data?: Record<string, unknown>;
  failure_reason: string;
  // true → nem vendor-hiba, hanem KONFIGURÁCIÓS blokk: az elvárt platformnak
  // nincs config-blokkja ezen a site-on, tehát hívás nem is történt. Magától soha
  // nem javul meg → ritka próbálkozás, hosszú ablak (maxRetriesFor /
  // retryWindowHoursFor), különben a rekord percek alatt kimerülne.
  blocked_configuration?: boolean;
  retry_count: number;
  first_failed_at: string;
  last_attempted_at: string;
}

/**
 * Sikertelen platform-hívás → újrapróba-sorba. Ha a Cloudflare Queues binding
 * (`env.DLQ`) elérhető, oda küldjük a rekordot delivery-delay backoff-fal;
 * különben visszaesünk az R2-alapú DLQ-ra (writeDeadLetter). A Queues consumer
 * a worker.ts `queue()` handlerében fut.
 *
 * Visszatérés: `true` CSAK akkor, ha a retry-rekord BIZTOSAN tárolva van
 * (Queue send OK vagy R2 write OK). `false` = az event retry-példánya sehol
 * sincs — a hívónak ilyenkor NEM szabad dispatched-nek jelölnie az eventet,
 * különben az idempotencia a kliens-retry-t is elnyomná és az event végleg
 * elveszne (platform-hiba + Queue-hiba + R2-hiba hármas kiesés).
 */
export async function enqueueFailure(env: Env, record: DeadLetterRecord): Promise<boolean> {
  // Konfigurációs blokk → EGYENESEN az R2 DLQ-ba, a Queue megkerülésével.
  // Indok: a Queue saját `max_retries`-e (wrangler.toml) néhány kézbesítés után
  // véglegesen eldobja az üzenetet, és a `delaySeconds` felső korlátja 24 óra —
  // egy config-hiány viszont napokig állhat. Az R2-rekordot az óránkénti cron
  // nézi, a lejáratot pedig a mi 7 napos ablakunk szabja (retryWindowHoursFor),
  // nem a Queue élettartama. Így a rekord túléli a config helyreállításáig.
  if (env.DLQ && record.blocked_configuration !== true) {
    try {
      await env.DLQ.send(record, { delaySeconds: backoffSeconds(record.retry_count) });
      logStructured({
        level: 'info',
        message: 'Failure enqueued to Cloudflare Queue',
        site_id: record.site_id,
        platform: record.platform,
        retry_count: record.retry_count
      });
      return true;
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
  return writeDeadLetter(env, record);
}

/**
 * R2 DLQ-írás. `true` = a rekord biztosan perzisztálva van; `false` = az írás
 * elbukott (logolva). A hívónak a visszatérési értéket ELLENŐRIZNIE kell, ha az
 * írás után törölné a rekord korábbi példányát — különben egy tranziens R2-hiba
 * az event egyetlen példányát is megsemmisítené (write-then-delete atomicity).
 */
export async function writeDeadLetter(env: Env, record: DeadLetterRecord): Promise<boolean> {
  const date = new Date(record.last_attempted_at);
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '-');

  const eventId = (record.event_payload.event_id as string) || 'unknown';
  const safeEventId = eventId.slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '_');

  // A 'dead' marad a 2. szegmens (isDeadKey ezt nézi), de a dátum is bekerül
  // UTÁNA, hogy a dead archívum is lexikálisan dátum-rendezhető/scan-elhető legyen.
  const prefix =
    record.retry_count >= maxRetriesFor(record)
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

    const isDead = record.retry_count >= maxRetriesFor(record);
    logStructured({
      level: isDead ? 'warn' : 'info',
      error_code: isDead ? TrackingErrorCode.MAX_RETRIES_EXCEEDED : undefined,
      message: isDead ? ERROR_DESCRIPTIONS[TrackingErrorCode.MAX_RETRIES_EXCEEDED] : 'Wrote event to dead letter queue',
      site_id: record.site_id,
      platform: record.platform,
      retry_count: record.retry_count,
      r2_key: key
    });
    return true;
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.DLQ_WRITE_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_WRITE_FAILED],
      site_id: record.site_id,
      platform: record.platform,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
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

export interface PendingRetryScan {
  pending: { key: string; record: DeadLetterRecord }[];
  /**
   * A retry-ablakon túli (vagy retry_count-kimerült) PENDING rekordok. Ezeket a
   * hívó (cron retry) dead-archívumba mozgatja — enélkül halhatatlanok lennének:
   * a retention csak 'dead' kulcsot töröl, a scan viszont mindig végigolvassa
   * őket, ami riasztás-zajt és (10k+ rekordnál) retry-éhezést okoz, mert a
   * lexikálisan korábbi lejárt kulcsok kiszorítják a friss retry-olhatókat.
   */
  expired: { key: string; record: DeadLetterRecord }[];
}

export async function listPendingRetries(
  env: Env,
  sitePrefix?: string,
  maxResults = 100,
  maxExpired = 200
): Promise<PendingRetryScan> {
  const now = Date.now();
  // A cutoff rekordonként változik: a konfigurációs blokk hosszabb ablakot kap.

  const results: { key: string; record: DeadLetterRecord }[] = [];
  const expired: { key: string; record: DeadLetterRecord }[] = [];
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
      if (results.length >= maxResults && expired.length >= maxExpired) break;

      try {
        const body = await env.DEAD_LETTER.get(obj.key);
        if (!body) continue;
        const record = (await body.json()) as DeadLetterRecord;

        const firstFailedMs = new Date(record.first_failed_at).getTime();
        const cutoffMs = retryWindowHoursFor(record) * 60 * 60 * 1000;
        if (now - firstFailedMs > cutoffMs || record.retry_count >= maxRetriesFor(record)) {
          if (expired.length < maxExpired) expired.push({ key: obj.key, record });
          continue;
        }

        if (results.length < maxResults) results.push({ key: obj.key, record });
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

    if (results.length >= maxResults && expired.length >= maxExpired) break;
    if (!listResult.truncated) break;
    cursor = listResult.cursor;
    iterations++;
  }

  return { pending: results, expired };
}

export async function deleteDeadLetter(env: Env, key: string): Promise<boolean> {
  try {
    await env.DEAD_LETTER.delete(key);
    return true;
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.DLQ_DELETE_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_DELETE_FAILED],
      r2_key: key,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/**
 * Lejárt pending rekord átmozgatása a dead-archívumba (retention onnan purge-öl).
 * A retry_count-ot MAX_RETRIES-re emeljük, hogy a kulcs a 'dead' prefixre
 * kerüljön; az eredeti kulcs CSAK sikeres archív-írás után törlődik.
 */
export async function archiveExpiredRecord(
  env: Env,
  key: string,
  record: DeadLetterRecord
): Promise<boolean> {
  // A retry_count-ot a REKORDRA érvényes plafonra emeljük, NEM a fix MAX_RETRIES-re.
  // Egy blocked_configuration rekordnál maxRetriesFor = 28; ha itt csak 3-ra emelnénk,
  // a writeDeadLetter prefix-döntése (`retry_count >= maxRetriesFor`) 3>=28 → hamis
  // lenne, és a rekord VISSZA a pending-prefixre kerülne. A cron a következő órában
  // újra lejártként látná → örök pending↔archive hurok, a rekord sosem érné el a
  // 'dead' archívumot (a retention csak azt purge-öli).
  const wrote = await writeDeadLetter(env, {
    ...record,
    retry_count: Math.max(record.retry_count, maxRetriesFor(record)),
    failure_reason: `${record.failure_reason} [expired: retry window elapsed]`,
    last_attempted_at: new Date().toISOString()
  });
  if (!wrote) return false;
  return deleteDeadLetter(env, key);
}
