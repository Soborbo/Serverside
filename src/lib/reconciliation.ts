import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import type { Platform } from './deadletter';

/**
 * Reconciliation — a ledger fölött futó drift-detektálás (#11). Két, egymástól
 * FÜGGETLEN hibamódot fog meg:
 *
 *  1. Vendor failure rate — a kézbesítések MEKKORA hányada bukott el
 *     (rejected / (accepted+rejected)). „A vendor hibázik."
 *  2. Coverage drift — a jogosult eventek MEKKORA hányada ért el a platformra
 *     (accepted / expected). „Az eventek be sem jutottak" — pl. hiányzó
 *     conversion action, csendes skip, config-hiba. Ez MÁS, mint a failure rate:
 *     az ilyen event lehet, hogy nem is termel rejected delivery-t.
 *
 * Minden számítás MIN_SAMPLE-guarddal, hogy ne riasszunk apró zajra (1/2 = 50%,
 * de értelmetlen). A függvények pure-ek → D1 nélkül teljesen tesztelhetők.
 */

export interface PlatformCounts {
  platform: Platform;
  accepted: number;
  rejected: number;
  skipped: number;
}

export interface SiteReconInput {
  site_id: string;
  /** Összes elfogadott event a ablakban (events_raw). GA4 elvárt alapja. */
  events_total: number;
  /** Ad-jogosult eventek (events_raw ad_allowed=1). Meta + Google Ads elvárt alapja. */
  ad_eligible: number;
  /** CRM offline-loop státuszok száma (kontextus a digesthez). */
  lead_status_total: number;
  platforms: PlatformCounts[];
}

export interface ReconThresholds {
  failureRateWarn: number;
  failureRateCrit: number;
  coverageShortfallWarn: number;
  coverageShortfallCrit: number;
  minSample: number;
}

export const DEFAULT_THRESHOLDS: ReconThresholds = {
  failureRateWarn: 0.05, // 5%
  failureRateCrit: 0.15, // 15%
  coverageShortfallWarn: 0.1, // delivered < 90% of expected
  coverageShortfallCrit: 0.3, // delivered < 70% of expected
  minSample: 10
};

export type DriftKind = 'vendor_failure_rate' | 'coverage_drift';
export type DriftSeverity = 'warning' | 'critical';

export interface DriftFinding {
  site_id: string;
  platform: Platform;
  kind: DriftKind;
  severity: DriftSeverity;
  /** A mért arány (0..1), 4 tizedesre kerekítve. */
  value: number;
  threshold: number;
  detail: string;
}

// Coverage-drift base. Modell 2-ben CSAK a Meta kapja meg MINDEN ad-jogosult
// konverziós eventet a szerver-oldali fan-outon — ezért csak a Metára van értelmes
// "expected" alap (ad_eligible). A click-ID forwarderek (TikTok/LinkedIn/MsAds) CSAK
// akkor tüzelnek, ha a megfelelő click-ID jelen van, így az ad_eligible NEM a
// coverage-alapjuk (őket a vendor-failure-rate méri). A GA4 és a Google Ads offline-
// only (lead-status, origin='offline') → NEM ezen az úton mérjük. Egy nem-Meta
// platform `null`-t kap → a coverage-blokk kihagyja (nincs hamis 0%-os drift).
const COVERAGE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(['meta']);

function coverageExpectedFor(platform: Platform, input: SiteReconInput): number | null {
  if (!COVERAGE_PLATFORMS.has(platform)) return null;
  return input.ad_eligible;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function computeSiteDrift(
  input: SiteReconInput,
  t: ReconThresholds = DEFAULT_THRESHOLDS
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  for (const p of input.platforms) {
    const attempts = p.accepted + p.rejected;

    // 1. Vendor failure rate — a kézbesítések elbukási aránya.
    if (attempts >= t.minSample) {
      const rate = p.rejected / attempts;
      if (rate >= t.failureRateCrit) {
        findings.push({
          site_id: input.site_id,
          platform: p.platform,
          kind: 'vendor_failure_rate',
          severity: 'critical',
          value: round4(rate),
          threshold: t.failureRateCrit,
          detail: `${pct(rate)} of ${attempts} ${p.platform} attempts rejected (crit ≥${pct(t.failureRateCrit)})`
        });
      } else if (rate >= t.failureRateWarn) {
        findings.push({
          site_id: input.site_id,
          platform: p.platform,
          kind: 'vendor_failure_rate',
          severity: 'warning',
          value: round4(rate),
          threshold: t.failureRateWarn,
          detail: `${pct(rate)} of ${attempts} ${p.platform} attempts rejected (warn ≥${pct(t.failureRateWarn)})`
        });
      }
    }

    // 2. Coverage drift — a jogosult eventek mekkora hányada ért el a platformra.
    // null → ezen a platformon nincs értelmes coverage-alap (forwarder/offline).
    const expected = coverageExpectedFor(p.platform, input);
    if (expected !== null && expected >= t.minSample) {
      const coverage = p.accepted / expected;
      const shortfall = 1 - coverage;
      if (shortfall >= t.coverageShortfallCrit) {
        findings.push({
          site_id: input.site_id,
          platform: p.platform,
          kind: 'coverage_drift',
          severity: 'critical',
          value: round4(coverage),
          threshold: 1 - t.coverageShortfallCrit,
          detail: `only ${pct(coverage)} of ${expected} eligible events reached ${p.platform} (crit <${pct(1 - t.coverageShortfallCrit)})`
        });
      } else if (shortfall >= t.coverageShortfallWarn) {
        findings.push({
          site_id: input.site_id,
          platform: p.platform,
          kind: 'coverage_drift',
          severity: 'warning',
          value: round4(coverage),
          threshold: 1 - t.coverageShortfallWarn,
          detail: `only ${pct(coverage)} of ${expected} eligible events reached ${p.platform} (warn <${pct(1 - t.coverageShortfallWarn)})`
        });
      }
    }
  }

  return findings;
}

export interface ReconSummary {
  findings: DriftFinding[];
  sites_checked: number;
  warning_count: number;
  critical_count: number;
  worst: DriftSeverity | 'none';
}

export function summarize(inputs: SiteReconInput[], t: ReconThresholds = DEFAULT_THRESHOLDS): ReconSummary {
  const findings = inputs.flatMap((i) => computeSiteDrift(i, t));
  const critical_count = findings.filter((f) => f.severity === 'critical').length;
  const warning_count = findings.filter((f) => f.severity === 'warning').length;
  return {
    findings,
    sites_checked: inputs.length,
    warning_count,
    critical_count,
    worst: critical_count > 0 ? 'critical' : warning_count > 0 ? 'warning' : 'none'
  };
}

// ── D1 query-sorok → SiteReconInput[] összeállítás (pure, tesztelhető) ────────

export interface EventCountRow {
  site_id: string;
  total: number;
  ad_eligible: number;
}
export interface DeliveryCountRow {
  site_id: string;
  platform: string;
  accepted: number;
  rejected: number;
  skipped: number;
}
export interface LeadCountRow {
  site_id: string;
  total: number;
}

// A szerver-oldali fan-out által ténylegesen kézbesített platformok (origin
// 'fanout'/'retry'). Modell 2: GA4 és Google Ads NEM ezen az úton mennek (offline-
// only, lead-status), ezért NEM szerepelnek itt — különben minden aktív site-on
// permanens hamis coverage_drift CRITICAL keletkezne. A forwarderek (tiktok/
// linkedin/msads) viszont itt vannak, hogy a vendor-failure-rate figyelje őket.
const PLATFORMS: Platform[] = ['meta', 'tiktok', 'linkedin', 'msads'];

/**
 * A három aggregált D1-lekérdezés sorait egy site-onkénti SiteReconInput-tá
 * fésüli. Hiányzó platform-sor → 0/0/0 (így a coverage drift észreveszi, ha egy
 * platform EGYÁLTALÁN nem kapott kézbesítést, miközben jöttek be eventek).
 */
export function assembleReconInputs(
  eventRows: EventCountRow[],
  deliveryRows: DeliveryCountRow[],
  leadRows: LeadCountRow[]
): SiteReconInput[] {
  const byDelivery = new Map<string, Map<string, DeliveryCountRow>>();
  for (const d of deliveryRows) {
    if (!byDelivery.has(d.site_id)) byDelivery.set(d.site_id, new Map());
    byDelivery.get(d.site_id)!.set(d.platform, d);
  }
  const leadBySite = new Map<string, number>();
  for (const l of leadRows) leadBySite.set(l.site_id, l.total);

  return eventRows.map((e) => {
    const dmap = byDelivery.get(e.site_id);
    const platforms: PlatformCounts[] = PLATFORMS.map((platform) => {
      const row = dmap?.get(platform);
      return {
        platform,
        accepted: row?.accepted ?? 0,
        rejected: row?.rejected ?? 0,
        skipped: row?.skipped ?? 0
      };
    });
    return {
      site_id: e.site_id,
      events_total: e.total,
      ad_eligible: e.ad_eligible,
      lead_status_total: leadBySite.get(e.site_id) ?? 0,
      platforms
    };
  });
}

/**
 * A három aggregált D1-lekérdezés → SiteReconInput[]. A cron ÉS az on-demand
 * admin endpoint (`GET /api/event/admin/reconciliation`) is ezt hívja.
 * null = a lekérdezés elbukott (már logolva), VAGY nincs LEDGER binding.
 *
 * Itt él (nem a scheduled handlerben), hogy az admin route ne húzza be a
 * notify.ts `cloudflare:email` runtime-importját a függőségi láncon át.
 */
export async function fetchReconInputs(
  env: Env,
  sinceIso: string
): Promise<SiteReconInput[] | null> {
  if (!env.LEDGER) return null;
  try {
    const [events, deliveries, leads] = await Promise.all([
      env.LEDGER.prepare(
        `SELECT site_id, COUNT(*) AS total, COALESCE(SUM(ad_allowed), 0) AS ad_eligible
         FROM events_raw WHERE received_at >= ?1 GROUP BY site_id`
      )
        .bind(sinceIso)
        .all<EventCountRow>(),
      env.LEDGER.prepare(
        `SELECT site_id, platform,
            COALESCE(SUM(status = 'accepted'), 0) AS accepted,
            COALESCE(SUM(status = 'rejected'), 0) AS rejected,
            COALESCE(SUM(status = 'skipped'), 0) AS skipped
         FROM deliveries WHERE created_at >= ?1 AND origin IN ('fanout', 'retry')
         GROUP BY site_id, platform`
      )
        .bind(sinceIso)
        .all<DeliveryCountRow>(),
      env.LEDGER.prepare(
        `SELECT site_id, COUNT(*) AS total
         FROM lead_status WHERE created_at >= ?1 GROUP BY site_id`
      )
        .bind(sinceIso)
        .all<LeadCountRow>()
    ]);
    return assembleReconInputs(
      events.results ?? [],
      deliveries.results ?? [],
      leads.results ?? []
    );
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_QUERY_FAILED],
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
