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

/** GA4 MINDEN eventet kap; Meta + Google Ads csak az ad-jogosultakat (consent). */
function expectedFor(platform: Platform, input: SiteReconInput): number {
  return platform === 'ga4' ? input.events_total : input.ad_eligible;
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
    const expected = expectedFor(p.platform, input);
    if (expected >= t.minSample) {
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

const PLATFORMS: Platform[] = ['meta', 'ga4', 'gads'];

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
