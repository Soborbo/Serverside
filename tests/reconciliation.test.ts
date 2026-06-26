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

const healthy: PlatformCounts[] = [
  { platform: 'meta', accepted: 100, rejected: 0, skipped: 0 },
  { platform: 'ga4', accepted: 100, rejected: 0, skipped: 0 },
  { platform: 'gads', accepted: 100, rejected: 0, skipped: 0 }
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
      platforms: [{ platform: 'gads', accepted: 80, rejected: 20, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'vendor_failure_rate');
    expect(f?.severity).toBe('critical');
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

describe('computeSiteDrift — coverage drift', () => {
  it('warns when delivered <90% of eligible (no rejections involved)', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'meta', accepted: 85, rejected: 0, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('warning');
    expect(f?.value).toBe(0.85);
  });

  it('escalates to critical when delivered <70% of eligible', () => {
    const input = site({
      events_total: 100,
      ad_eligible: 100,
      platforms: [{ platform: 'gads', accepted: 50, rejected: 0, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('critical');
  });

  it('detects a total platform outage (0 delivered, events came in)', () => {
    const input = site({
      events_total: 50,
      ad_eligible: 50,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 0 }]
    });
    const f = computeSiteDrift(input).find((x) => x.kind === 'coverage_drift');
    expect(f?.severity).toBe('critical');
    expect(f?.value).toBe(0);
  });

  it('MIN_SAMPLE guard on the eligible base', () => {
    const input = site({
      events_total: 5,
      ad_eligible: 5,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 0 }]
    });
    expect(computeSiteDrift(input).filter((x) => x.kind === 'coverage_drift')).toEqual([]);
  });

  it('GA4 coverage uses events_total, Meta/GAds use ad_eligible', () => {
    // 100 events, only 10 ad-eligible (consent). GA4 gets all 100, Meta gets 10.
    const input = site({
      events_total: 100,
      ad_eligible: 10,
      platforms: [
        { platform: 'ga4', accepted: 100, rejected: 0, skipped: 0 },
        { platform: 'meta', accepted: 10, rejected: 0, skipped: 90 }
      ]
    });
    expect(computeSiteDrift(input)).toEqual([]); // both at 100% of their own base
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
      site({ site_id: 'b', events_total: 100, ad_eligible: 100, platforms: [{ platform: 'gads', accepted: 50, rejected: 0, skipped: 0 }] })
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
  it('merges event/delivery/lead rows and zero-fills missing platforms', () => {
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
    // ga4 + gads had no delivery rows → zero-filled
    const ga4 = i.platforms.find((p) => p.platform === 'ga4');
    const gads = i.platforms.find((p) => p.platform === 'gads');
    expect(ga4).toEqual({ platform: 'ga4', accepted: 0, rejected: 0, skipped: 0 });
    expect(gads).toEqual({ platform: 'gads', accepted: 0, rejected: 0, skipped: 0 });
  });

  it('a site with events but ZERO delivery rows surfaces as full coverage drift', () => {
    // This is the key safety property: a silent total outage (events ingested,
    // nothing dispatched) must be detectable, not invisible.
    const inputs = assembleReconInputs(
      [{ site_id: 'painless', total: 50, ad_eligible: 50 }],
      [],
      []
    );
    const findings = computeSiteDrift(inputs[0]);
    const critical = findings.filter((f) => f.severity === 'critical' && f.kind === 'coverage_drift');
    expect(critical.length).toBeGreaterThanOrEqual(2); // meta + gads at 0%
    expect(inputs[0].lead_status_total).toBe(0);
  });

  it('handles defaults threshold object identity', () => {
    expect(DEFAULT_THRESHOLDS.minSample).toBe(10);
  });
});
