import type { Env } from '../env';
import type { SiteConfig } from './config';
import { getAccessToken } from './gads-oauth';
import { logStructured, CANONICAL_EVENTS } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';
import { GADS_API_VERSION } from './gads';

/**
 * Cross-platform reconciliation — a ledger ÉS a külső mérőrendszerek (GA4,
 * Google Ads on-site konverziók) NAPI egyeztetése (2026-07-16-i audit tanulsága).
 *
 * Miért létezik: Modell 2-ben a GA4-et és a Google Ads on-site konverziót a
 * böngésző/GTM birtokolja, a gateway nem — ezért a ledger SZERKEZETILEG nem tud
 * arról, ha a GTM-ág elromlik. 2026-07-15-én ugyanarra a napra a ledger 4
 * callbacket látott, a GA4 2-t, a Google Ads 2-t, és semmi nem vetette össze
 * őket. A meglévő reconciliation (lib/reconciliation.ts) a ledgeren BELÜL néz
 * driftet — ez a modul a ledgeren KÍVÜLI számokat kérdezi le és hasonlítja.
 *
 * Adatforrások:
 *  - Ledger: events_raw count site × event bontásban (smoke-leadek kizárva —
 *    azokra a böngésző-GTM sosem tüzel, örök +1 driftet adnának).
 *  - Google Ads: GAQL `metrics.all_conversions_by_conversion_date` a
 *    `segments.conversion_action_name` bontásban (KONVERZIÓ-dátum szerint, nem
 *    kattintás-dátum szerint — a kettő nagyon eltér, a kattintás-attribúció
 *    napokkal korábbi datumra könyvel). Élőben validált query-alak (2026-07-16).
 *  - GA4 Data API: runReport eventName × eventCount. A GA4 a LEGACY event-neveket
 *    látja (events.json `legacy_ga4` — pl. quote_calculator_conversion), ezért a
 *    térkép innen származik, nem kézzel írt lista.
 *
 * Konfiguráció: SiteConfig `recon` blokk (lásd config.ts). Hiányzó blokk → a
 * site kimarad (a ledger-belső recon fut tovább). A GA4-leg a Google Ads OAuth
 * refresh tokenjét használja — az `analytics.readonly` scope-ot a 2026-07-16
 * utáni re-consent adja meg (oauth-init.ts); régi tokennel a GA4 hívás 403 →
 * logolt skip, nem hiba.
 *
 * Ismert zaj (a küszöbök ezt nyelik el, dokumentáltan):
 *  - Időzóna: a ledger UTC-napot számol, a GA4/Google Ads a property/fiók helyi
 *    napját (Budapest/London) — nap-határ körüli eventek ±1 napot csúszhatnak.
 *  - Consent: a GTM-ág consent-tiltás alatt nem tüzel, a gateway ledgere viszont
 *    (jogosan) számolja az eventet → EEA-site-on a platform-szám kisebb lehet.
 * Ezért a minSample + relatív küszöb: a cél a "néma nulla / feleződés" osztályú
 * törés elkapása, nem az 1-2 darabos eltérés büntetése.
 */

const CROSS_CHECK_API_TIMEOUT_MS = 8000;
const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

export type CrossCheckPlatform = 'ga4' | 'gads';

export interface CrossCheckThresholds {
  /** Relatív eltérés (|ledger-platform| / max) — warning küszöb. */
  relDiffWarn: number;
  /** Relatív eltérés — critical küszöb. */
  relDiffCrit: number;
  /** max(ledger, platform) legalább ennyi legyen, különben nincs finding (zajvédelem). */
  minSample: number;
}

export const DEFAULT_CROSS_CHECK_THRESHOLDS: CrossCheckThresholds = {
  relDiffWarn: 0.25,
  relDiffCrit: 0.5,
  minSample: 3
};

export interface CrossCheckFinding {
  site_id: string;
  platform: CrossCheckPlatform;
  event_name: string;
  ledger_count: number;
  platform_count: number;
  severity: 'warning' | 'critical';
  /** A mért relatív eltérés (0..1), 4 tizedesre kerekítve. */
  value: number;
  detail: string;
}

/**
 * A GA4-legben ellenőrzött eventek: konverzió-kind + GA4 key event. A GA4-ben
 * várt név a legacy alias (ha van) — a GTM azt küldi, nem a kanonikus nevet.
 */
export const GA4_CHECK_EVENTS: ReadonlyArray<{ event_name: string; ga4_name: string }> =
  CANONICAL_EVENTS.filter((e) => e.kind === 'conversion' && e.ga4_key_event).map((e) => ({
    event_name: e.name,
    ga4_name: e.legacy_ga4 ?? e.name
  }));

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Ledger vs platform count összevetés a megadott event-halmazon (pure). A nem
 * listázott eventek NEM számítanak — a platformon lévő, nálunk nem mért
 * konverziók (pl. hívás-követés) nem adhatnak hamis driftet.
 */
export function compareCrossCounts(
  site_id: string,
  platform: CrossCheckPlatform,
  events: readonly string[],
  ledgerByEvent: Record<string, number>,
  platformByEvent: Record<string, number>,
  t: CrossCheckThresholds = DEFAULT_CROSS_CHECK_THRESHOLDS
): CrossCheckFinding[] {
  const findings: CrossCheckFinding[] = [];
  for (const event_name of events) {
    const ledger = ledgerByEvent[event_name] ?? 0;
    const vendor = platformByEvent[event_name] ?? 0;
    const base = Math.max(ledger, vendor);
    if (base < t.minSample) continue;
    const relDiff = Math.abs(ledger - vendor) / base;
    if (relDiff < t.relDiffWarn) continue;
    const severity: 'warning' | 'critical' = relDiff >= t.relDiffCrit ? 'critical' : 'warning';
    findings.push({
      site_id,
      platform,
      event_name,
      ledger_count: ledger,
      platform_count: vendor,
      severity,
      value: round4(relDiff),
      detail: `${event_name}: ledger=${ledger} vs ${platform}=${vendor} (${(relDiff * 100).toFixed(0)}% diff)`
    });
  }
  return findings;
}

/** event_name → action name térkép megfordítása (action name → event_name). */
export function invertOnsiteActions(map: Record<string, string>): Record<string, string> {
  const inverted: Record<string, string> = {};
  for (const [eventName, actionName] of Object.entries(map)) {
    inverted[actionName] = eventName;
  }
  return inverted;
}

// ── Google Ads (on-site konverziók, GAQL) ────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Konverzió-dátum szerinti napi bontás. FROM customer + conversion_action_name
 * segment — a conversion_action resource NEM támogatja a *_by_conversion_date
 * metrikát (PROHIBITED_METRIC..., élőben ellenőrizve), a customer igen.
 */
export function buildGadsCrossCheckQuery(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`invalid date for GAQL: ${date}`);
  return (
    'SELECT customer.id, segments.conversion_action_name, ' +
    'metrics.all_conversions_by_conversion_date FROM customer ' +
    `WHERE segments.date = '${date}'`
  );
}

interface GadsSearchResponse {
  results?: Array<{
    segments?: { conversionActionName?: string };
    metrics?: { allConversionsByConversionDate?: number | string };
  }>;
  error?: { message?: string };
}

/** GAQL válasz → event_name szerinti count (a config action-név térképén át). */
export function parseGadsCrossCheckResponse(
  response: GadsSearchResponse,
  actionNameToEvent: Record<string, string>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of response.results ?? []) {
    const actionName = row.segments?.conversionActionName;
    if (!actionName) continue;
    const eventName = actionNameToEvent[actionName];
    if (!eventName) continue;
    const value = Number(row.metrics?.allConversionsByConversionDate ?? 0);
    if (!Number.isFinite(value)) continue;
    counts[eventName] = (counts[eventName] ?? 0) + value;
  }
  return counts;
}

async function fetchGadsOnsiteCounts(
  env: Env,
  siteConfig: SiteConfig,
  date: string,
  actionNameToEvent: Record<string, string>
): Promise<Record<string, number> | null> {
  const customerId = siteConfig.gads.customer_id;
  if (!customerId) return null;
  if (!env.GADS_DEVELOPER_TOKEN) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_QUERY_FAILED],
      site_id: siteConfig.site_id,
      platform: 'gads',
      error: 'GADS_DEVELOPER_TOKEN missing'
    });
    return null;
  }
  const accessToken = await getAccessToken(customerId, env);
  if (!accessToken) return null; // getAccessToken már logolt

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': env.GADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json'
  };
  if (siteConfig.gads.login_customer_id) {
    headers['login-customer-id'] = siteConfig.gads.login_customer_id;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CROSS_CHECK_API_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${customerId}/googleAds:search`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: buildGadsCrossCheckQuery(date) }),
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);
    const body = (await response.json().catch(() => ({}))) as GadsSearchResponse;
    if (!response.ok) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_QUERY_FAILED],
        site_id: siteConfig.site_id,
        platform: 'gads',
        status: response.status,
        error: sanitizeErrorMessage(body.error?.message)
      });
      return null;
    }
    return parseGadsCrossCheckResponse(body, actionNameToEvent);
  } catch (err) {
    clearTimeout(timeoutId);
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_QUERY_FAILED],
      site_id: siteConfig.site_id,
      platform: 'gads',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

// ── GA4 Data API ─────────────────────────────────────────────────────────────

/** runReport body: eventName × eventCount, a vizsgált napokra, névre szűrve. */
export function buildGa4RunReportBody(date: string, ga4Names: readonly string[]): unknown {
  if (!DATE_RE.test(date)) throw new Error(`invalid date for GA4: ${date}`);
  return {
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: [...ga4Names] }
      }
    }
  };
}

interface Ga4RunReportResponse {
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  error?: { message?: string; status?: string };
}

/** runReport válasz → KANONIKUS event_name szerinti count (legacy név-térképen át). */
export function parseGa4RunReportResponse(
  response: Ga4RunReportResponse,
  ga4NameToEvent: Record<string, string>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of response.rows ?? []) {
    const ga4Name = row.dimensionValues?.[0]?.value;
    if (!ga4Name) continue;
    const eventName = ga4NameToEvent[ga4Name];
    if (!eventName) continue;
    const value = Number(row.metricValues?.[0]?.value ?? 0);
    if (!Number.isFinite(value)) continue;
    counts[eventName] = (counts[eventName] ?? 0) + value;
  }
  return counts;
}

async function fetchGa4Counts(
  env: Env,
  siteConfig: SiteConfig,
  date: string
): Promise<Record<string, number> | null> {
  const customerId = siteConfig.gads.customer_id;
  const propertyId = siteConfig.recon?.ga4_property_id;
  if (!customerId || !propertyId) return null;

  const accessToken = await getAccessToken(customerId, env);
  if (!accessToken) return null;

  const ga4NameToEvent: Record<string, string> = {};
  for (const e of GA4_CHECK_EVENTS) ga4NameToEvent[e.ga4_name] = e.event_name;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CROSS_CHECK_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${GA4_DATA_API_BASE}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildGa4RunReportBody(date, Object.keys(ga4NameToEvent))),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const body = (await response.json().catch(() => ({}))) as Ga4RunReportResponse;
    if (!response.ok) {
      // 403 várható állapot a scope-bővítés előtti refresh tokennel — a
      // re-consent (oauth-init) után magától él. Logolt skip, nem riasztás.
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_QUERY_FAILED],
        site_id: siteConfig.site_id,
        platform: 'ga4',
        status: response.status,
        hint:
          response.status === 403
            ? 'analytics.readonly scope hiányzik — re-consent kell (oauth-init), vagy a GA4 property nem elérhető ezzel a Google-fiókkal'
            : undefined,
        error: sanitizeErrorMessage(body.error?.message)
      });
      return null;
    }
    return parseGa4RunReportResponse(body, ga4NameToEvent);
  } catch (err) {
    clearTimeout(timeoutId);
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_QUERY_FAILED],
      site_id: siteConfig.site_id,
      platform: 'ga4',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

// ── Ledger counts + orchestrátor ─────────────────────────────────────────────

export interface LedgerCrossCountRow {
  site_id: string;
  event_name: string;
  total: number;
}

/** D1 sorok → site_id → (event_name → count) map (pure, tesztelhető). */
export function assembleLedgerCounts(
  rows: LedgerCrossCountRow[]
): Map<string, Record<string, number>> {
  const bySite = new Map<string, Record<string, number>>();
  for (const row of rows) {
    let events = bySite.get(row.site_id);
    if (!events) {
      events = {};
      bySite.set(row.site_id, events);
    }
    events[row.event_name] = (events[row.event_name] ?? 0) + row.total;
  }
  return bySite;
}

async function fetchLedgerCrossCounts(
  env: Env,
  dayStartIso: string,
  dayEndIso: string
): Promise<Map<string, Record<string, number>> | null> {
  if (!env.LEDGER) return null;
  try {
    // Smoke-leadek kizárva: a napi synthetic füstteszt (SMOKE_SITES) eventjeire
    // a böngésző-GTM sosem tüzel — bent hagyva örök hamis driftet adnának.
    const result = await env.LEDGER.prepare(
      `SELECT site_id, event_name, COUNT(*) AS total
       FROM events_raw
       WHERE received_at >= ?1 AND received_at < ?2
         AND (lead_id IS NULL OR lead_id NOT LIKE 'smoke-%')
       GROUP BY site_id, event_name`
    )
      .bind(dayStartIso, dayEndIso)
      .all<LedgerCrossCountRow>();
    return assembleLedgerCounts(result.results ?? []);
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_QUERY_FAILED],
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * A teljes cross-platform check egy adott UTC-napra (YYYY-MM-DD). Site-onként
 * fut a `recon` configblokk szerint; minden fetch-hiba logolt skip (a többi
 * site/leg attól még lefut). LEDGER vagy recon-config nélkül üres lista.
 */
export async function runCrossPlatformCheck(
  env: Env,
  siteConfigs: SiteConfig[],
  date: string,
  thresholds: CrossCheckThresholds = DEFAULT_CROSS_CHECK_THRESHOLDS
): Promise<CrossCheckFinding[]> {
  const reconSites = siteConfigs.filter((c) => c.recon);
  if (reconSites.length === 0) return [];

  const dayStartIso = `${date}T00:00:00.000Z`;
  const dayEndIso = new Date(Date.parse(dayStartIso) + 24 * 60 * 60 * 1000).toISOString();
  const ledger = await fetchLedgerCrossCounts(env, dayStartIso, dayEndIso);
  if (ledger === null) return [];

  const findings: CrossCheckFinding[] = [];
  for (const cfg of reconSites) {
    const recon = cfg.recon!;
    const ledgerByEvent = ledger.get(cfg.site_id) ?? {};

    const onsiteActions = recon.gads_onsite_actions ?? {};
    const gadsEvents = Object.keys(onsiteActions);
    if (cfg.gads.customer_id && gadsEvents.length > 0) {
      const counts = await fetchGadsOnsiteCounts(env, cfg, date, invertOnsiteActions(onsiteActions));
      if (counts !== null) {
        findings.push(
          ...compareCrossCounts(cfg.site_id, 'gads', gadsEvents, ledgerByEvent, counts, thresholds)
        );
      }
    }

    if (cfg.gads.customer_id && recon.ga4_property_id) {
      const counts = await fetchGa4Counts(env, cfg, date);
      if (counts !== null) {
        findings.push(
          ...compareCrossCounts(
            cfg.site_id,
            'ga4',
            GA4_CHECK_EVENTS.map((e) => e.event_name),
            ledgerByEvent,
            counts,
            thresholds
          )
        );
      }
    }
  }
  return findings;
}
