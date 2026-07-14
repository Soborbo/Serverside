import { describe, it, expect } from 'vitest';
import {
  computeSiteDrift,
  summarize,
  assembleReconInputs,
  DEFAULT_THRESHOLDS,
  type SiteReconInput,
  type PlatformCounts
} from '../src/lib/reconciliation';

function site(partial: Partial<SiteReconInput> & { platforms: PlatformCounts[] }): SiteReconInput {
  return {
    site_id: 'painless',
    events_total: 0,
    ad_eligible: 0,
    lead_status_total: 0,
    ...partial
  };
}

// Modell 2: a szerver-oldali fan-out a Metát + a click-ID forwardereket kézbesíti.
// GA4/Google Ads offline-only → NEM ezen az úton mérve (lásd reconciliation.ts).
const healthy: PlatformCounts[] = [
  { platform: 'meta', accepted: 100, rejected: 0, skipped: 0 },
  { platform: 'tiktok', accepted: 40, rejected: 0, skipped: 0 },
  { platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 },
  { platform: 'msads', accepted: 0, rejected: 0, skipped: 0 }
];

describe('computeSiteDrift — healthy', () => {
  it('returns no findings when everything delivers', () => {
    const input = site({ events_total: 100, ad_eligible: 100, platforms: healthy });
    expect(computeSiteDrift(input)).toEqual([]);
  });
});

describe('computeSiteDrift — vendor failure rate', () => {
  it('warns at >=5% failure rate', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'meta', accepted: 94, rejected: 6, skipped: 0 }]
    });
    const findings = computeSiteDrift(input);
    const f = findings.find((x) => x.kind === 'vendor_failure_rate');
    expect(f?.severity).toBe('warning');
    expect(f?.value).toBe(0.06);
  });

  it('escalates to critical at >=15% failure rate', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'meta', accepted: 80, rejected: 20, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'vendor_failure_rate');
    expect(f?.severity).toBe('critical');
  });

  it('monitors forwarder failure rate too (tiktok), independent of coverage', () => {
    // A forwardereknek NINCS coverage-alapja (click-ID-gated), de a failure-rate
    // figyeli őket: 20% bukás 100 kísérletből → critical, coverage finding NÉLKÜL.
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'tiktok', accepted: 80, rejected: 20, skipped: 0 }]
    });
    const findings = computeSiteDrift(input);
    expect(findings.find((x) => x.kind === 'vendor_failure_rate')?.severity).toBe('critical');
    expect(findings.filter((x) => x.kind === 'coverage_drift')).toEqual([]);
  });

  it('MIN_SAMPLE guard: ignores tiny samples (1 of 2 = 50% but n<10)', () => {
    const input = site({
      events_total: 2,
      ad_eligible: 2,
      platforms: [{ platform: 'meta', accepted: 1, rejected: 1, skipped: 0 }]
    });
    expect(computeSiteDrift(input).filter((x) => x.kind === 'vendor_failure_rate')).toEqual([]);
  });

  it('excludes skipped (consent-blocked) from the failure rate', () => {
    // 100 consent-blocked skips, zero real attempts → no failure finding,
    // and ad_eligible=0 → no coverage finding either (no false alarm).
    const input = site({
      events_total: 100,
      ad_eligible: 0,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 100 }]
    });
    expect(computeSiteDrift(input)).toEqual([]);
  });
});

describe('computeSiteDrift — coverage drift (Meta only under Model 2)', () => {
  it('warns when Meta delivered <90% of eligible (no rejections involved)', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'meta', accepted: 85, rejected: 0, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('warning');
    expect(f?.value).toBe(0.85);
  });

  it('escalates to critical when Meta delivered <70% of eligible', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'meta', accepted: 50, rejected: 0, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('critical');
  });

  it('detects a total Meta outage (0 delivered, events came in)', () => {
    const input = site({
      events_total: 50,
      ad_eligible: 50,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('critical');
    expect(f?.value).toBe(0);
  });

  // Run 6: a szándékosan meta-nélküli site (lomtalan, amíg nincs CAPI token)
  // MINDEN eventje őszinte 'skipped' — ez NEM coverage drift, hanem ismert,
  // szándékos állapot. Enélkül minden nap hamis CRITICAL menne.
  it('NO drift when every eligible event was deliberately skipped (unconfigured meta leg)', () => {
    const input = site({
      events_total: 50,
      ad_eligible: 50,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 50 }]
    });
    expect(computeSiteDrift(input).filter((x) => x.kind === 'coverage_drift')).toEqual([]);
  });

  it('still detects drift on a CONFIGURED leg with a few skips (skips shrink the base, not the signal)', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      // 5 consent-skip mellett 50/95 kézbesített → 52.6% < 70% → critical marad.
      platforms: [{ platform: 'meta', accepted: 50, rejected: 0, skipped: 5 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('critical');
  });

  it('MIN_SAMPLE guard on the eligible base', () => {
    const input = site({
      events_total: 5,
      ad_eligible: 5,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 0 }]
    });
    expect(computeSiteDrift(input).filter((x) => x.kind === 'coverage_drift')).toEqual([]);
  });

  it('does NOT raise coverage drift for offline/forwarder platforms (ga4/gads/tiktok)', () => {
    // Regression guard for the Model-2 bug: GA4 + Google Ads are offline-only and
    // forwarders are click-id-gated, so a 0-accepted row against a large eligible
    // base must NOT produce a (false) coverage_drift CRITICAL.
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [
        { platform: 'ga4', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'gads', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 }
      ]
    });
    expect(computeSiteDrift(input).filter((f) => f.kind === 'coverage_drift')).toEqual([]);
  });
});

describe('computeSiteDrift — complementary signals', () => {
  it('fires both failure-rate and coverage findings when many reject', () => {
    // 100 eligible, 70 accepted, 30 rejected → 30% failure (crit) AND 70%
    // coverage = 30% shortfall (crit). Two distinct stories: why + impact.
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'meta', accepted: 70, rejected: 30, skipped: 0 }]
    });
    const kinds = computeSiteDrift(input).map((f) => f.kind).sort();
    expect(kinds).toEqual(['coverage_drift', 'vendor_failure_rate']);
  });
});

describe('summarize', () => {
  it('aggregates across sites and reports worst severity', () => {
    const inputs = [
      site({ site_id: 'a', events_total: 100, ad_eligible: 100, platforms: [{ platform: 'meta', accepted: 94, rejected: 6, skipped: 0 }] }),
      site({ site_id: 'b', events_total: 100, ad_eligible: 100, platforms: [{ platform: 'meta', accepted: 50, rejected: 0, skipped: 0 }] })
    ];
    const s = summarize(inputs);
    expect(s.sites_checked).toBe(2);
    expect(s.warning_count).toBe(1);
    expect(s.critical_count).toBe(1);
    expect(s.worst).toBe('critical');
  });

  it('returns worst=none with no findings', () => {
    const s = summarize([site({ events_total: 100, ad_eligible: 100, platforms: healthy })]);
    expect(s.worst).toBe('none');
    expect(s.findings).toEqual([]);
  });
});

describe('assembleReconInputs', () => {
  it('merges event/delivery/lead rows and zero-fills missing fan-out platforms', () => {
    const inputs = assembleReconInputs(
      [{ site_id: 'painless', total: 100, ad_eligible: 80 }],
      [{ site_id: 'painless', platform: 'meta', accepted: 78, rejected: 2, skipped: 20 }],
      [{ site_id: 'painless', total: 5 }]
    );
    expect(inputs).toHaveLength(1);
    const i = inputs[0];
    expect(i.events_total).toBe(100);
    expect(i.ad_eligible).toBe(80);
    expect(i.lead_status_total).toBe(5);
    // The fan-out platforms are meta + the three forwarders; the absent forwarder
    // rows are zero-filled. GA4/Google Ads are NOT fan-out platforms (offline-only).
    const tiktok = i.platforms.find((p) => p.platform === 'tiktok');
    const linkedin = i.platforms.find((p) => p.platform === 'linkedin');
    expect(tiktok).toEqual({ platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 });
    expect(linkedin).toEqual({ platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 });
    expect(i.platforms.find((p) => p.platform === 'ga4')).toBeUndefined();
    expect(i.platforms.find((p) => p.platform === 'gads')).toBeUndefined();
  });

  it('a site with events but ZERO Meta delivery rows surfaces as full coverage drift', () => {
    // Key safety property: a silent total outage (events ingested, nothing
    // dispatched to Meta) must be detectable, not invisible.
    const inputs = assembleReconInputs(
      [{ site_id: 'painless', total: 50, ad_eligible: 50 }],
      [],
      []
    );
    const findings = computeSiteDrift(inputs[0]);
    const critical = findings.filter((f) => f.severity === 'critical' && f.kind === 'coverage_drift');
    // Only Meta has a coverage base under Model 2 → exactly one coverage critical.
    expect(critical).toHaveLength(1);
    expect(critical[0].platform).toBe('meta');
    expect(inputs[0].lead_status_total).toBe(0);
  });

  it('handles defaults threshold object identity', () => {
    expect(DEFAULT_THRESHOLDS.minSample).toBe(10);
  });
});
