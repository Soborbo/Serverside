import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';

/**
 * Meta EMQ (Event Match Quality) lekérdezés — Dataset Quality API.
 *
 * Elsődleges forrás: `GET graph.facebook.com/v25.0/dataset_quality` a site KV-beli
 * `meta.pixel_id` (= dataset_id) + `meta.access_token` párosával, fields =
 * `web{event_match_quality,event_name}`. A válasz eventenként adja a 0-10-es
 * composite score-t.
 *
 * FONTOS korlát (Meta docs, Dataset Quality API): a "client system user access
 * token onboarding method is not compatible with the EMQ API at the moment" — az
 * Events Managerben a CAPI-onboardinggal kiállított (dataset-scoped) token tehát
 * kaphat permission-hibát, miközben az events-küldésre tökéletes. Ezért a hívó
 * (scheduled/daily-digest.ts) MINDEN hibánál a ledger-alapú proxy-metrikára esik
 * vissza (match-kulcs lefedettség: em/ph/fbc/fbp jelenlét-arány, PII nélkül).
 * A hiba itt 'info' szintű (TRK-950-008) — lásd error-codes.ts indoklását.
 *
 * PII: a válasz csak aggregált score-okat + kulcs-lefedettséget tartalmaz, PII-t
 * nem. A hibaüzenet sanitizálva logolódik; a tokent SOHA nem logoljuk.
 */

const META_API_VERSION = 'v25.0';
const EMQ_API_TIMEOUT_MS = 5000;

export interface EmqEventScore {
  event_name: string;
  /** Composite EMQ score, 0-10. */
  score: number;
}

export type EmqFetchResult =
  | { ok: true; events: EmqEventScore[] }
  | { ok: false; error: string };

interface DatasetQualityResponse {
  web?: Array<{
    event_name?: string;
    event_match_quality?: { composite_score?: number };
  }>;
  error?: { message?: string; code?: number };
}

export async function fetchDatasetEmq(
  siteId: string,
  pixelId: string,
  accessToken: string
): Promise<EmqFetchResult> {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/dataset_quality`);
  url.searchParams.set('dataset_id', pixelId);
  url.searchParams.set('fields', 'web{event_match_quality,event_name}');
  url.searchParams.set('access_token', accessToken);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMQ_API_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeoutId);
    const body = (await response.json()) as DatasetQualityResponse;

    if (!response.ok || body.error) {
      const sanitized = sanitizeErrorMessage(body.error?.message);
      logStructured({
        level: 'info',
        error_code: TrackingErrorCode.EMQ_QUERY_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_QUERY_FAILED],
        site_id: siteId,
        status: response.status,
        meta_error: sanitized,
        meta_error_code: body.error?.code
      });
      return { ok: false, error: `HTTP ${response.status}: ${sanitized}` };
    }

    const events: EmqEventScore[] = [];
    for (const row of body.web ?? []) {
      const score = row.event_match_quality?.composite_score;
      if (row.event_name && typeof score === 'number') {
        events.push({ event_name: row.event_name, score });
      }
    }
    return { ok: true, events };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errMsg = isTimeout ? 'timeout' : sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.EMQ_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_QUERY_FAILED],
      site_id: siteId,
      error: errMsg
    });
    return { ok: false, error: errMsg };
  }
}

// ── Proxy-metrika: match-kulcs lefedettség a ledgerből (PII nélkül) ──────────

/** Egy match-kulcs lefedettsége százalékban (0-100), 24h vs megelőző 7 nap. */
export interface KeyCoverage {
  key: 'em' | 'ph' | 'fbc' | 'fbp';
  pct24h: number;
  pct7d: number;
}

export interface CoverageStats {
  /** Eventek száma az elmúlt 24 órában. */
  events24h: number;
  /** Eventek száma a megelőző 7 napban (24h-8d ablak). */
  events7d: number;
  keys: KeyCoverage[];
}

/** Min. event-szám 24h-ban, ami alatt nem riasztunk (kis minta = zaj). */
const COVERAGE_MIN_EVENTS_24H = 5;
/** Min. 7 napos átlag-lefedettség, ami alatt a kulcsot nem őrizzük (sosem volt élő). */
const COVERAGE_MIN_BASELINE_PCT = 30;
/** Ennyi százalékPONT esés a 7 napos átlaghoz képest → riasztás. */
const COVERAGE_DROP_PCT_POINTS = 25;

/**
 * Pure: jelentős lefedettség-esés detektálása. Egy kulcs akkor riaszt, ha
 * (a) van értékelhető 24h-s minta, (b) a 7 napos baseline szerint a kulcs élt
 * (≥30%), és (c) a 24h-s lefedettség ≥25 százalékponttal a baseline alatt van.
 * Így egy soha-nem-küldött kulcs (pl. ph-mentes site) nem ad fals riasztást.
 */
export function detectCoverageDrops(stats: CoverageStats): KeyCoverage[] {
  if (stats.events24h < COVERAGE_MIN_EVENTS_24H) return [];
  return stats.keys.filter(
    (k) =>
      k.pct7d >= COVERAGE_MIN_BASELINE_PCT &&
      k.pct7d - k.pct24h >= COVERAGE_DROP_PCT_POINTS
  );
}

interface CoverageRow {
  n24: number;
  em24: number;
  ph24: number;
  fbc24: number;
  fbp24: number;
  n7: number;
  em7: number;
  ph7: number;
  fbc7: number;
  fbp7: number;
}

/**
 * A site match-kulcs lefedettsége a D1 ledgerből (jelenlét-flag-ek, NEM PII).
 * null = nincs LEDGER binding vagy query-hiba (pl. a 0002-es migráció még nem
 * futott le) — a hívó ilyenkor "n/a"-t mutat, NEM riaszt.
 */
export async function collectKeyCoverage(
  env: { LEDGER?: D1Database },
  siteId: string
): Promise<CoverageStats | null> {
  if (!env.LEDGER) return null;
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const row = await env.LEDGER.prepare(
      `SELECT
         SUM(CASE WHEN received_at >= ?1 THEN 1 ELSE 0 END) AS n24,
         SUM(CASE WHEN received_at >= ?1 AND em_present = 1 THEN 1 ELSE 0 END) AS em24,
         SUM(CASE WHEN received_at >= ?1 AND ph_present = 1 THEN 1 ELSE 0 END) AS ph24,
         SUM(CASE WHEN received_at >= ?1 AND fbc_present = 1 THEN 1 ELSE 0 END) AS fbc24,
         SUM(CASE WHEN received_at >= ?1 AND fbp_present = 1 THEN 1 ELSE 0 END) AS fbp24,
         SUM(CASE WHEN received_at < ?1 THEN 1 ELSE 0 END) AS n7,
         SUM(CASE WHEN received_at < ?1 AND em_present = 1 THEN 1 ELSE 0 END) AS em7,
         SUM(CASE WHEN received_at < ?1 AND ph_present = 1 THEN 1 ELSE 0 END) AS ph7,
         SUM(CASE WHEN received_at < ?1 AND fbc_present = 1 THEN 1 ELSE 0 END) AS fbc7,
         SUM(CASE WHEN received_at < ?1 AND fbp_present = 1 THEN 1 ELSE 0 END) AS fbp7
       FROM events_raw
       WHERE site_id = ?2 AND received_at >= ?3`
    )
      .bind(dayAgo, siteId, eightDaysAgo)
      .first<CoverageRow>();
    if (!row) return null;

    const pct = (num: number, den: number): number =>
      den > 0 ? Math.round((num / den) * 100) : 0;
    const n24 = row.n24 ?? 0;
    const n7 = row.n7 ?? 0;
    return {
      events24h: n24,
      events7d: n7,
      keys: [
        { key: 'em', pct24h: pct(row.em24 ?? 0, n24), pct7d: pct(row.em7 ?? 0, n7) },
        { key: 'ph', pct24h: pct(row.ph24 ?? 0, n24), pct7d: pct(row.ph7 ?? 0, n7) },
        { key: 'fbc', pct24h: pct(row.fbc24 ?? 0, n24), pct7d: pct(row.fbc7 ?? 0, n7) },
        { key: 'fbp', pct24h: pct(row.fbp24 ?? 0, n24), pct7d: pct(row.fbp7 ?? 0, n7) }
      ]
    };
  } catch (err) {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.EMQ_QUERY_FAILED,
      message: `${ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_QUERY_FAILED]} (ledger coverage)`,
      site_id: siteId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
