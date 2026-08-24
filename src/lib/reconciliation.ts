import type { Env } from '../env';
import type { SiteConfig } from './config';
import { hasRefreshToken } from './gads-oauth';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import type { Platform } from './deadletter';
import { SKIP_REASONS, type SkipReason } from './skip-reason';

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
  /**
   * CRM offline-loop státuszok száma az ablakban.
   *
   * 2026-08-24-ig HOLT SÚLY volt: feltöltődött, de egyetlen számítás sem olvasta —
   * 500 vagy 0 üzleti eseménnyel a `computeSiteDrift` kimenete bitre ugyanaz volt.
   * A P1.1 óta ugyanabból a sorhalmazból épül az `offline_legs` is, tehát a mező a
   * riport kontextusa, a MÉRÉS pedig a lábakon történik (event-típusonként).
   */
  lead_status_total: number;
  platforms: PlatformCounts[];
  /**
   * P1.1 — az OFFLINE (CRM lifecycle → Google Ads) láb, event-típusonként.
   * Hiányzó/üres tömb → ezen a site-on nem érkezett lifecycle-státusz az ablakban,
   * tehát nincs mit mérni (NEM „minden rendben", hanem „nincs bemenet").
   */
  offline_legs?: OfflineLegInput[];
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

export type DriftKind =
  | 'vendor_failure_rate'
  | 'coverage_drift'
  // ── P1.1 business-leg (offline Google Ads / Data Manager) ──────────────────
  | 'offline_zero_delivery'
  | 'offline_coverage_drift'
  | 'offline_vendor_failure';
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
  // ── P1.3 kötelező riasztás-mezők (csak az offline lábon értelmezettek) ─────
  /** A CRM-lifecycle event neve (lead_qualified, revenue_confirmed, …). */
  event_name?: string;
  /** Elvárt kézbesítés = beérkezett − legitim policy-skip (lásd countsAgainstOfflineCoverage). */
  expected?: number;
  delivered?: number;
  failure_rate?: number;
  last_successful_upload?: string | null;
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
  t: ReconThresholds = DEFAULT_THRESHOLDS,
  ot: OfflineThresholds = DEFAULT_OFFLINE_THRESHOLDS
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  // P1.1 — az OFFLINE business-láb ÚJ LÁB a meglévő számításban, nem a Meta-formula
  // átírása. A böngésző-fan-out alábbi két findingje változatlanul működik.
  for (const leg of input.offline_legs ?? []) findings.push(...computeOfflineDrift(leg, ot));

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
    //
    // A SZÁNDÉKOS kihagyások (deliveries.status='skipped': nincs meta config a
    // site-on, vagy consent-tiltás) NEM elvárt kézbesítések — kivonjuk őket az
    // alapból. Enélkül egy szándékosan meta-nélküli site (lomtalan, amíg nincs
    // CAPI token) minden nap hamis coverage_drift CRITICAL-t adna 0% lefedettségre
    // — pont a Run 6 Fix 1 után, ami a korábbi hamis-'accepted' sorokat őszinte
    // 'skipped'-re váltotta. A kivonás konzervatív: konfigurált site-on a skip
    // ritka (consent-tiltás), így az érzékenység alig csökken; teljesen skip-elt
    // lábon az alap 0 alá esne → clamp + a minSample-őr elnémítja.
    const expectedRaw = coverageExpectedFor(p.platform, input);
    const expected = expectedRaw === null ? null : Math.max(0, expectedRaw - p.skipped);
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

// ═══════════════════════════════════════════════════════════════════════════
// P1.1 — OFFLINE BUSINESS-LEG (CRM lifecycle → Google Ads / Data Manager)
// ═══════════════════════════════════════════════════════════════════════════
//
// A fenti (böngésző-fan-out) formulák pipeline-health-et mérnek. Ez a láb BUSINESS
// TRUTH-t: a beérkezett üzleti eseményekhez képest hány konverzió ért célba.
//
// MIÉRT NEM AZ `ad_eligible` AZ ALAP: az a böngészőből beérkezett, ad-jogosult
// eventek száma. Az offline láb bemenete ettől független — CRM-lifecycle-státuszok,
// nagyságrendekkel kisebb volumen, más ritmus (napok–hetek a lead capture után), más
// jogosultsági szabály. Egy 60 böngésző-eventes naphoz tartozó 2 offline feltöltés
// `ad_eligible`-alapon 97%-os hamis coverage drift lenne, minden nap, minden site-on.

/**
 * A skip SZÁMÍT-E hiánynak az offline coverage-nevezőben.
 *
 * A 2026-08-24-i review kulcskorrekciója: NEM minden skip veszteség. Három
 * `lead_status`, mindhárom visszavont marketing-consenttel → 3 skipped, 0 accepted.
 * Ez NEM halott Google-láb, hanem PONTOSAN HELYES működés — riasztani rá hamis
 * pozitív, és a riasztás-fáradtság pont azt a néma hibát fedné el, amiért a lánc van.
 *
 * A vízválasztó: POLICY vagy HIBA?
 *  - policy (consent/regionális/dedup) → nem számít hiánynak, a rendszer jól döntött;
 *  - config / adatminőség / transport → SZÁMÍT, mert a pénz emiatt nem ér célba.
 *
 * FONTOS: ez NEM ugyanaz a tengely, mint az `isTerminalSkip` (retryable-e). A
 * `no_identifiers` például terminális (a retry sem segítene), de a coverage
 * szempontjából VESZTESÉG: jött egy lead, akit nem tudunk feltölteni, mert nincs
 * matchelhető azonosítója — ez adatminőségi hiba, nem policy-döntés.
 */
const OFFLINE_SKIP_COUNTS_AS_LOSS: Record<SkipReason, boolean> = {
  // ── POLICY: a rendszer helyesen döntött úgy, hogy nem küld ───────────────
  consent_denied: false,
  consent_withdrawn: false,
  consent_missing_failclosed: false,
  consent_missing_legacy: false,
  consent_uncertain_failclosed: false,
  not_expected: false,
  eea_rule: false,
  dedup: false,
  // ── HIBA: a konverzió emiatt NEM ért célba ───────────────────────────────
  not_configured: true,
  invalid_identifier: true,
  no_identifiers: true,
  template_guard: true
};

/**
 * Ismeretlen ok → SZÁMÍT. A pénzúton a „nem tudjuk, miért nem ment el" nem
 * minősülhet rendben lévőnek. Ha egy új, legitim policy-skip jelenik meg, a
 * fenti táblát kell bővíteni — a teljességet teszt kényszeríti ki (SKIP_REASONS).
 */
export function countsAgainstOfflineCoverage(reason: string | null | undefined): boolean {
  if (reason === null || reason === undefined || reason === '') return true;
  const known = OFFLINE_SKIP_COUNTS_AS_LOSS[reason as SkipReason];
  return known === undefined ? true : known;
}

/** Teszt-/dokumentációs kiegészítő: minden ismert ok osztályozva van-e. */
export const OFFLINE_SKIP_CLASSIFICATION: Readonly<Record<SkipReason, boolean>> =
  OFFLINE_SKIP_COUNTS_AS_LOSS;
export const ALL_SKIP_REASONS: readonly SkipReason[] = SKIP_REASONS;

/**
 * Az offline láb MÉRHETŐSÉGI állapota. A 2026-08-24-i review 2. korrekciója: ne
 * emberi munkasorrend döntse el, mikor szabad riasztani, hanem a kód.
 *
 *  BLOCKED_DEPENDENCY — hiányzik egy előfeltétel (OAuth secret / refresh token /
 *      customer_id / conversion action). Ilyenkor SEMMILYEN drift-finding nem
 *      keletkezik: a hiba ISMERT, és a health-check már jelzi — egy második
 *      riasztás ugyanarról csak zajt termel. A recon viszont NEM néma: a blokkolt
 *      lábak külön, informatív blokként mennek a logba és a napi riportba.
 *  UNARMED — az előfeltételek rendben, de MÉG NINCS bizonyított sikeres feltöltés.
 *      A 24 órás REGRESSZIÓ-detektor ilyenkor nem alkalmazható (nincs mihez mérni),
 *      a 7 napos ABSZOLÚT detektor viszont igen: ha egy hete jönnek a státuszok és
 *      egy hete nincs kézbesítés, az akkor is hiba, ha sosem működött.
 *  ARMED — van legalább egy bizonyított feltöltés (accepted + nem-NULL http_status
 *      + nem szintetikus). Innentől a 24 órás regresszió-detektor is él.
 */
export type OfflineReconState = 'BLOCKED_DEPENDENCY' | 'UNARMED' | 'ARMED';

export type OfflineBlockReason =
  | 'customer_id_missing'
  | 'conversion_action_missing'
  | 'oauth_secret_missing'
  | 'oauth_token_missing';

/** skip_reason → darabszám az ablakban. */
export type OfflineSkipCounts = Readonly<Record<string, number>>;

export interface OfflineLegInput {
  site_id: string;
  /** A CRM-lifecycle event neve: lead_qualified | revenue_confirmed | … */
  event_name: string;
  /** 24 órás ablak — a regresszió-detektor és a coverage/vendor-formulák alapja. */
  received: number;
  accepted: number;
  rejected: number;
  skips: OfflineSkipCounts;
  /** 7 napos gördülő ablak — az abszolút detektor alapja. */
  received_7d: number;
  accepted_7d: number;
  skips_7d: OfflineSkipCounts;
  /** null → az előfeltételek rendben. */
  blocked_by: OfflineBlockReason | null;
  /** A legutóbbi BIZONYÍTOTT feltöltés (accepted + non-NULL http_status + nem szintetikus). */
  last_accepted_at: string | null;
}

export interface OfflineThresholds {
  /** A lifecycle-volumen kicsi (2026-07-20: ÖSSZESEN 7 lead_status sor a ledgerben) —
   *  a böngésző-oldali minSample: 10 egy halott lábra SOHA nem sülne el. */
  offlineMinSample: number;
  offlineCoverageWarn: number;
  offlineCoverageCrit: number;
  offlineFailureWarn: number;
  offlineFailureCrit: number;
}

export const DEFAULT_OFFLINE_THRESHOLDS: OfflineThresholds = {
  offlineMinSample: 3,
  offlineCoverageWarn: 0.15, // delivered < 85% of expected
  offlineCoverageCrit: 0.4, // delivered < 60% of expected
  offlineFailureWarn: 0.05,
  offlineFailureCrit: 0.15
};

export function deriveOfflineState(leg: OfflineLegInput): OfflineReconState {
  if (leg.blocked_by !== null) return 'BLOCKED_DEPENDENCY';
  return leg.last_accepted_at === null ? 'UNARMED' : 'ARMED';
}

/** A legitim policy-skipek levonása után MARADÓ elvárás. Soha nem negatív. */
function expectedDelivery(received: number, skips: OfflineSkipCounts): number {
  let policySkips = 0;
  for (const [reason, count] of Object.entries(skips)) {
    if (!countsAgainstOfflineCoverage(reason)) policySkips += count;
  }
  return Math.max(0, received - policySkips);
}

/** Riportsor MINDEN offline lábról — a findingtől függetlenül (a blokkolt sem néma). */
export interface OfflineLegReport {
  site_id: string;
  event_name: string;
  state: OfflineReconState;
  blocked_by: OfflineBlockReason | null;
  received: number;
  expected: number;
  delivered: number;
  rejected: number;
  last_successful_upload: string | null;
}

export function reportOfflineLeg(
  leg: OfflineLegInput,
  state: OfflineReconState = deriveOfflineState(leg)
): OfflineLegReport {
  return {
    site_id: leg.site_id,
    event_name: leg.event_name,
    state,
    blocked_by: leg.blocked_by,
    received: leg.received,
    expected: expectedDelivery(leg.received, leg.skips),
    delivered: leg.accepted,
    rejected: leg.rejected,
    last_successful_upload: leg.last_accepted_at
  };
}

export function computeOfflineDrift(
  leg: OfflineLegInput,
  t: OfflineThresholds = DEFAULT_OFFLINE_THRESHOLDS
): DriftFinding[] {
  const state = deriveOfflineState(leg);
  // Ismert, már jelzett előfeltétel-hiány → NINCS drift-finding (a health-check
  // mondja meg, mit kell javítani). A láb ettől nem tűnik el: reportOfflineLeg.
  if (state === 'BLOCKED_DEPENDENCY') return [];

  const findings: DriftFinding[] = [];
  const base = {
    site_id: leg.site_id,
    platform: 'gads' as Platform,
    event_name: leg.event_name,
    last_successful_upload: leg.last_accepted_at
  };

  const expected24 = expectedDelivery(leg.received, leg.skips);
  const expected7d = expectedDelivery(leg.received_7d, leg.skips_7d);
  const attempts = leg.accepted + leg.rejected;

  // 1. ZERO DELIVERY — a láb halott.
  //    (a) REGRESSZIÓ (24h): csak ARMED állapotban. Volumen NEM kell hozzá: a
  //        bizonyíték az, hogy KORÁBBAN ment, MOST meg nem. Ez adja a tervi DoD-t
  //        („a kikapcsolt offline-láb 24 órán belül piros") ritka eseményeknél is.
  //    (b) ABSZOLÚT (7 nap): UNARMED-ben is él — ha egy hete jönnek a státuszok és
  //        egy hete nincs kézbesítés, az akkor is hiba, ha sosem működött.
  const regression = state === 'ARMED' && expected24 > 0 && leg.accepted === 0;
  const absolute = expected7d >= t.offlineMinSample && leg.accepted_7d === 0;
  if (regression || absolute) {
    findings.push({
      ...base,
      kind: 'offline_zero_delivery',
      severity: 'critical',
      value: 0,
      threshold: 1,
      expected: regression ? expected24 : expected7d,
      delivered: regression ? leg.accepted : leg.accepted_7d,
      failure_rate: attempts > 0 ? round4(leg.rejected / attempts) : 0,
      detail: regression
        ? `offline ${leg.event_name}: ${expected24} elvart kezbesites, 0 accepted az elmult 24h-ban ` +
          `(utolso sikeres feltoltes: ${leg.last_accepted_at}) — a Google offline lab LEALLT`
        : `offline ${leg.event_name}: ${expected7d} elvart kezbesites, 0 accepted 7 nap alatt — ` +
          'a Google offline lab MEG SOHA nem szallitott ezen a site-on'
    });
  } else if (expected24 >= t.offlineMinSample && leg.accepted > 0) {
    // 2. COVERAGE DRIFT — reszleges kieses. Csak accepted > 0 mellett: nulla
    //    kezbesitesnel a zero_delivery mar szolt, ne duplazzunk.
    const coverage = leg.accepted / expected24;
    const shortfall = 1 - coverage;
    const crit = shortfall >= t.offlineCoverageCrit;
    if (crit || shortfall >= t.offlineCoverageWarn) {
      findings.push({
        ...base,
        kind: 'offline_coverage_drift',
        severity: crit ? 'critical' : 'warning',
        value: round4(coverage),
        threshold: 1 - (crit ? t.offlineCoverageCrit : t.offlineCoverageWarn),
        expected: expected24,
        delivered: leg.accepted,
        failure_rate: attempts > 0 ? round4(leg.rejected / attempts) : 0,
        detail:
          `offline ${leg.event_name}: az elvart ${expected24} kezbesitesbol csak ` +
          `${pct(coverage)} ert celba (${leg.accepted} accepted)`
      });
    }
  }

  // 3. VENDOR FAILURE — a Google elutasit (auth, allowlist, formatum).
  if (attempts >= t.offlineMinSample) {
    const rate = leg.rejected / attempts;
    const crit = rate >= t.offlineFailureCrit;
    if (crit || rate >= t.offlineFailureWarn) {
      findings.push({
        ...base,
        kind: 'offline_vendor_failure',
        severity: crit ? 'critical' : 'warning',
        value: round4(rate),
        threshold: crit ? t.offlineFailureCrit : t.offlineFailureWarn,
        expected: expected24,
        delivered: leg.accepted,
        failure_rate: round4(rate),
        detail:
          `offline ${leg.event_name}: a ${attempts} feltoltesi kiserlet ${pct(rate)}-a elutasitva ` +
          `(${leg.rejected} rejected)`
      });
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

/** MINDEN offline láb riportsora (a blokkoltaké is) — a napi riporthoz. */
export function collectOfflineReports(inputs: SiteReconInput[]): OfflineLegReport[] {
  return inputs.flatMap((i) => (i.offline_legs ?? []).map((leg) => reportOfflineLeg(leg)));
}

export function summarize(
  inputs: SiteReconInput[],
  t: ReconThresholds = DEFAULT_THRESHOLDS,
  ot: OfflineThresholds = DEFAULT_OFFLINE_THRESHOLDS
): ReconSummary {
  const findings = inputs.flatMap((i) => computeSiteDrift(i, t, ot));
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

// ── P1.1 offline-láb sorok ────────────────────────────────────────────────────
/** lead_status beérkezés site × event_name bontásban (az ELVÁRT alap). */
export interface OfflineReceivedRow {
  site_id: string;
  event_name: string;
  received: number;
}
/** deliveries origin='offline' platform='gads', site × event_name × (status, skip_reason). */
export interface OfflineDeliveryRow {
  site_id: string;
  event_name: string;
  accepted: number;
  rejected: number;
  skipped: number;
  skip_reason: string | null;
}
/** A legutóbbi BIZONYÍTOTT feltöltés (accepted + non-NULL http_status + nem szintetikus). */
export interface OfflineLastAcceptedRow {
  site_id: string;
  event_name: string;
  last_accepted_at: string;
}

/**
 * A négy nyers sorhalmaz → `OfflineLegInput[]` site-onként. Pure, D1 nélkül tesztelhető.
 *
 * A `blocked_by` feloldása a HÍVÓ dolga (config + KV kell hozzá) — ezért függvényként
 * jön be, nem beégetve: így a pure mag tesztelhető marad.
 */
export function assembleOfflineLegs(
  received24: OfflineReceivedRow[],
  received7d: OfflineReceivedRow[],
  delivered24: OfflineDeliveryRow[],
  delivered7d: OfflineDeliveryRow[],
  lastAccepted: OfflineLastAcceptedRow[],
  resolveBlock: (siteId: string, eventName: string) => OfflineBlockReason | null
): Map<string, OfflineLegInput[]> {
  const key = (s: string, e: string) => `${s}\u0000${e}`;

  const agg = (rows: OfflineDeliveryRow[]) => {
    const m = new Map<string, { accepted: number; rejected: number; skips: Record<string, number> }>();
    for (const r of rows) {
      const k = key(r.site_id, r.event_name);
      if (!m.has(k)) m.set(k, { accepted: 0, rejected: 0, skips: {} });
      const e = m.get(k)!;
      e.accepted += r.accepted;
      e.rejected += r.rejected;
      if (r.skipped > 0) {
        // A `null` skip_reason SZÁNDÉKOSAN külön kulcs ('unknown'): a
        // countsAgainstOfflineCoverage ezt VESZTESÉGNEK számolja — a pénzúton a
        // „nem tudjuk, miért nem ment el" nem minősülhet rendben lévőnek.
        const reason = r.skip_reason ?? 'unknown';
        e.skips[reason] = (e.skips[reason] ?? 0) + r.skipped;
      }
    }
    return m;
  };

  const d24 = agg(delivered24);
  const d7 = agg(delivered7d);
  const r7 = new Map(received7d.map((r) => [key(r.site_id, r.event_name), r.received]));
  const la = new Map(lastAccepted.map((r) => [key(r.site_id, r.event_name), r.last_accepted_at]));

  const bySite = new Map<string, OfflineLegInput[]>();
  for (const r of received24) {
    const k = key(r.site_id, r.event_name);
    const a24 = d24.get(k);
    const a7 = d7.get(k);
    const leg: OfflineLegInput = {
      site_id: r.site_id,
      event_name: r.event_name,
      received: r.received,
      accepted: a24?.accepted ?? 0,
      rejected: a24?.rejected ?? 0,
      skips: a24?.skips ?? {},
      received_7d: r7.get(k) ?? r.received,
      accepted_7d: a7?.accepted ?? 0,
      skips_7d: a7?.skips ?? {},
      blocked_by: resolveBlock(r.site_id, r.event_name),
      last_accepted_at: la.get(k) ?? null
    };
    if (!bySite.has(r.site_id)) bySite.set(r.site_id, []);
    bySite.get(r.site_id)!.push(leg);
  }
  return bySite;
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
  leadRows: LeadCountRow[],
  offlineLegs: Map<string, OfflineLegInput[]> = new Map()
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
      platforms,
      offline_legs: offlineLegs.get(e.site_id) ?? []
    };
  });
}

/**
 * Egy site, ami CSAK offline (lifecycle) forgalmat kapott az ablakban — böngésző-
 * eventet nem. Az `assembleReconInputs` az `events_raw` sorokból indul, tehát az
 * ilyen site KIMARADNA, és vele a halott offline lábának a mérése is. A CRM-lifecycle
 * napokkal-hetekkel a lead capture UTÁN érkezik, tehát ez nem egzotikus eset: egy
 * lassabb site-on teljesen normális, hogy egy adott 24 órában csak `revenue_confirmed`
 * jön be, böngésző-event nem.
 */
export function appendOfflineOnlySites(
  inputs: SiteReconInput[],
  offlineLegs: Map<string, OfflineLegInput[]>
): SiteReconInput[] {
  const seen = new Set(inputs.map((i) => i.site_id));
  const extra: SiteReconInput[] = [];
  for (const [siteId, legs] of offlineLegs) {
    if (seen.has(siteId)) continue;
    extra.push({
      site_id: siteId,
      events_total: 0,
      ad_eligible: 0,
      lead_status_total: legs.reduce((n, l) => n + l.received, 0),
      platforms: PLATFORMS.map((platform) => ({ platform, accepted: 0, rejected: 0, skipped: 0 })),
      offline_legs: legs
    });
  }
  return [...inputs, ...extra];
}

/**
 * A három aggregált D1-lekérdezés → SiteReconInput[]. A cron ÉS az on-demand
 * admin endpoint (`GET /api/event/admin/reconciliation`) is ezt hívja.
 * null = a lekérdezés elbukott (már logolva), VAGY nincs LEDGER binding.
 *
 * Itt él (nem a scheduled handlerben), hogy az admin route ne húzza be a
 * notify.ts `cloudflare:email` runtime-importját a függőségi láncon át.
 */
/**
 * A szintetikus sorok kizárása NEM opcionális: a napi smoke (`smoke-<site>-<dátum>`)
 * és a Data Manager validate-only füst-teszt (`dm-validate*`) különben elfedné a
 * halott lábat — pontosan az a hibaosztály, ami miatt a lomtalan Meta-kiesése öt
 * napon át zölden ment át.
 */
const NOT_SYNTHETIC = "lead_id NOT LIKE 'smoke-%' AND lead_id NOT LIKE 'dm-validate%'";
const NOT_SYNTHETIC_DELIVERY = "event_id NOT LIKE 'smoke-%' AND event_id NOT LIKE 'dm-validate%'";

const OFFLINE_ABSOLUTE_WINDOW_DAYS = 7;

/**
 * Előfeltétel-feloldó a `blocked_by`-hoz: config (KV) + OAuth-token (KV) állapot.
 * Site-onként EGYSZER olvas configot és tokent, nem lábanként.
 */
async function buildOfflineBlockResolver(
  env: Env,
  siteConfigs: SiteConfig[]
): Promise<(siteId: string, eventName: string) => OfflineBlockReason | null> {
  const secretsMissing = !env.GADS_OAUTH_CLIENT_ID || !env.GADS_OAUTH_CLIENT_SECRET;
  const state = new Map<string, { customerId: string | null; actions: Record<string, string>; token: boolean }>();

  for (const cfg of siteConfigs) {
    const customerId = cfg.gads?.customer_id ?? null;
    const actions = cfg.gads?.conversion_actions ?? {};
    // Customer-onként EGY KV-olvasás; hálózati refresh NINCS (lásd hasRefreshToken).
    const token = customerId && !secretsMissing ? await hasRefreshToken(customerId, env) : false;
    state.set(cfg.site_id, { customerId, actions, token });
  }

  return (siteId, eventName) => {
    const st = state.get(siteId);
    // Nincs config-olvasatunk → NEM állítjuk, hogy blokkolt: a „blokkolt" állapot
    // elnémítaná a detektort, és egy KV-hibából csend lenne. Inkább mérjünk.
    if (!st) return null;
    if (!st.customerId) return 'customer_id_missing';
    if (!st.actions[eventName]) return 'conversion_action_missing';
    if (secretsMissing) return 'oauth_secret_missing';
    if (!st.token) return 'oauth_token_missing';
    return null;
  };
}

async function fetchOfflineLegs(
  env: Env,
  sinceIso: string,
  siteConfigs: SiteConfig[]
): Promise<Map<string, OfflineLegInput[]>> {
  const ledger = env.LEDGER!;
  const since7d = new Date(Date.now() - OFFLINE_ABSOLUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [recv24, recv7d, del24, del7d, lastAcc] = await Promise.all([
    ledger
      .prepare(
        `SELECT site_id, status AS event_name, COUNT(*) AS received
         FROM lead_status WHERE created_at >= ?1 AND ${NOT_SYNTHETIC}
         GROUP BY site_id, status`
      )
      .bind(sinceIso)
      .all<OfflineReceivedRow>(),
    ledger
      .prepare(
        `SELECT site_id, status AS event_name, COUNT(*) AS received
         FROM lead_status WHERE created_at >= ?1 AND ${NOT_SYNTHETIC}
         GROUP BY site_id, status`
      )
      .bind(since7d)
      .all<OfflineReceivedRow>(),
    ledger
      .prepare(
        `SELECT site_id, event_name, skip_reason,
            COALESCE(SUM(status = 'accepted'), 0) AS accepted,
            COALESCE(SUM(status = 'rejected'), 0) AS rejected,
            COALESCE(SUM(status = 'skipped'),  0) AS skipped
         FROM deliveries
         WHERE created_at >= ?1 AND origin = 'offline' AND platform = 'gads' AND ${NOT_SYNTHETIC_DELIVERY}
         GROUP BY site_id, event_name, skip_reason`
      )
      .bind(sinceIso)
      .all<OfflineDeliveryRow>(),
    ledger
      .prepare(
        `SELECT site_id, event_name, skip_reason,
            COALESCE(SUM(status = 'accepted'), 0) AS accepted,
            COALESCE(SUM(status = 'rejected'), 0) AS rejected,
            COALESCE(SUM(status = 'skipped'),  0) AS skipped
         FROM deliveries
         WHERE created_at >= ?1 AND origin = 'offline' AND platform = 'gads' AND ${NOT_SYNTHETIC_DELIVERY}
         GROUP BY site_id, event_name, skip_reason`
      )
      .bind(since7d)
      .all<OfflineDeliveryRow>(),
    // ARMED-horgony: `http_status IS NOT NULL` KÖTELEZŐ — az INV-010 (TRK-950-004)
    // előtti korszakból maradt „accepted vendor-státusz nélkül" sorok NEM bizonyítanak
    // sikeres feltöltést, és élesítenék a regresszió-detektort egy sosem működött lábon.
    ledger
      .prepare(
        `SELECT site_id, event_name, MAX(created_at) AS last_accepted_at
         FROM deliveries
         WHERE origin = 'offline' AND platform = 'gads' AND status = 'accepted'
           AND http_status IS NOT NULL AND ${NOT_SYNTHETIC_DELIVERY}
         GROUP BY site_id, event_name`
      )
      .all<OfflineLastAcceptedRow>()
  ]);

  // `monitoring: false` site-ok kihagyása — ugyanaz a szabály, mint a digestben: egy
  // soha-nem-konvertáló dummy minden nap riasztana, és a riasztás-fáradtság pont a
  // valódi néma hibát fedné el. ÜRES config-lista (KV-hiba vagy on-demand hívás)
  // esetén NEM szűrünk: a csend rosszabb, mint egy fölösleges sor.
  const monitored = siteConfigs.length > 0 ? new Set(siteConfigs.map((c) => c.site_id)) : null;
  const received24 = (recv24.results ?? []).filter((r) => !monitored || monitored.has(r.site_id));
  const resolveBlock = await buildOfflineBlockResolver(env, siteConfigs);

  return assembleOfflineLegs(
    received24,
    recv7d.results ?? [],
    del24.results ?? [],
    del7d.results ?? [],
    lastAcc.results ?? [],
    resolveBlock
  );
}

export async function fetchReconInputs(
  env: Env,
  sinceIso: string,
  siteConfigs: SiteConfig[] = []
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
    // P1.1 — az offline láb SAJÁT lekérdezései. Külön try-blokk NÉLKÜL: ha ezek
    // elbuknak, a teljes recon `null`-t ad (már logolva), és a cron nem dől el —
    // ugyanaz a viselkedés, mint a többi lekérdezésnél. Csendes részleges eredményt
    // NEM adunk: az „nincs offline láb" és a „nem tudtuk lekérdezni" nem
    // keverhető össze.
    const offlineLegs = await fetchOfflineLegs(env, sinceIso, siteConfigs);
    return appendOfflineOnlySites(
      assembleReconInputs(
        events.results ?? [],
        deliveries.results ?? [],
        leads.results ?? [],
        offlineLegs
      ),
      offlineLegs
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
