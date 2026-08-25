import { describe, it, expect } from 'vitest';
import {
  FLEET_DIMENSIONS,
  assessSite,
  buildFleetReport,
  rollupSite,
  worseOf,
  type FleetSiteInput,
  type HealthLevel
} from '../src/lib/fleet-health';
import type { OfflineLegReport } from '../src/lib/reconciliation';

/**
 * F8 · P12 — fleet health. A tesztek TÖBBSÉGE egyetlen invariánst őriz:
 * **UNKNOWN soha nem lesz GREEN**, és a `null` (nem futott le a mérés) soha nem
 * viselkedik `0`-ként. A többi szabály ezt a magot veszi körül.
 */

const NOW = Date.parse('2026-08-25T12:00:00Z');

/** Alap: MINDEN mérhető dimenzió egészséges, minden mérés lefutott. */
function healthy(over: Partial<FleetSiteInput> = {}): FleetSiteInput {
  return {
    site_id: 'painless',
    hostname: 'painlessremovals.com',
    monitoring: true,
    expected_smoke: ['meta'],
    expected_offline: ['gads'],
    consent_provider: 'sbo',
    meta_configured: true,
    gads_customer_id: '1234567890',
    gads_conversion_action_count: 3,
    accepted_events_24h: 12,
    accepted_events_7d: 90,
    platform_deliveries_24h: { meta: { accepted: 12, rejected: 0, skipped: 0 } },
    last_proven_delivery_at: '2026-08-25T09:00:00Z',
    smoke_expected: true,
    smoke_result: 'pass',
    consent_decisions_7d: 140,
    client_lib_versions_7d: ['1.4.0'],
    offline_legs: [leg({ state: 'ARMED', delivered: 4 })],
    business_last_report_date: '2026-08-25',
    business_ever_reported: true,
    ...over
  };
}

function leg(over: Partial<OfflineLegReport> = {}): OfflineLegReport {
  return {
    site_id: 'painless',
    event_name: 'lead_qualified',
    state: 'ARMED',
    blocked_by: null,
    received: 4,
    expected: 4,
    delivered: 4,
    rejected: 0,
    last_successful_upload: '2026-08-24T10:00:00Z',
    ...over
  };
}

function levelOf(input: FleetSiteInput, dimension: string): HealthLevel {
  const d = assessSite(input, NOW).dimensions.find((x) => x.dimension === dimension);
  if (!d) throw new Error(`nincs ilyen dimenzió: ${dimension}`);
  return d.level;
}

describe('rollup — az UNKNOWN nem tűnhet el', () => {
  it('az UNKNOWN SÚLYOSABB a YELLOW-nál (a méretlen pénzútról nem tudjuk, mekkora a baj)', () => {
    expect(worseOf('UNKNOWN', 'YELLOW')).toBe('UNKNOWN');
    expect(worseOf('YELLOW', 'UNKNOWN')).toBe('UNKNOWN');
    expect(worseOf('RED', 'UNKNOWN')).toBe('RED');
  });

  it('egyetlen UNKNOWN dimenzió mellett a site SOHA nem GREEN', () => {
    const level = rollupSite([
      { dimension: 'ingest', level: 'GREEN', detail: '' },
      { dimension: 'meta', level: 'GREEN', detail: '' },
      { dimension: 'gtm_conformance', level: 'UNKNOWN', detail: '' }
    ]);
    expect(level).toBe('UNKNOWN');
  });

  it('csupa NOT_APPLICABLE → UNKNOWN, nem GREEN (az elvárások hiánya nem egészség)', () => {
    const level = rollupSite([
      { dimension: 'meta', level: 'NOT_APPLICABLE', detail: '', na_source: 'config' },
      { dimension: 'google_offline', level: 'NOT_APPLICABLE', detail: '', na_source: 'config' }
    ]);
    expect(level).toBe('UNKNOWN');
  });

  it('a NOT_APPLICABLE nem húzza le a GREEN-t', () => {
    const level = rollupSite([
      { dimension: 'ingest', level: 'GREEN', detail: '' },
      { dimension: 'meta', level: 'NOT_APPLICABLE', detail: '', na_source: 'config' }
    ]);
    expect(level).toBe('GREEN');
  });
});

describe('assessSite — a két állandó vakfolt', () => {
  it('a gtm_conformance és az inventory MA mindig UNKNOWN, és ettől a site sem lehet GREEN', () => {
    const health = assessSite(healthy(), NOW);
    expect(health.blind_spots).toEqual(['gtm_conformance', 'inventory']);
    expect(health.overall).toBe('UNKNOWN');
    // …de a mérhető lábak zöldek — a vakfolt NEM tünteti el a mért igazságot.
    const measured = health.dimensions.filter(
      (d) => d.dimension !== 'gtm_conformance' && d.dimension !== 'inventory'
    );
    expect(measured.every((d) => d.level === 'GREEN')).toBe(true);
  });

  it('minden dimenzió megjelenik, a P12-listával egyezően', () => {
    const health = assessSite(healthy(), NOW);
    expect(health.dimensions.map((d) => d.dimension)).toEqual([...FLEET_DIMENSIONS]);
  });

  it('MINDEN NOT_APPLICABLE explicit config-elvárásból származik (na_source kötelező)', () => {
    const health = assessSite(
      healthy({
        expected_smoke: ['ga4'],
        meta_configured: false,
        expected_offline: [],
        gads_customer_id: null,
        offline_legs: []
      }),
      NOW
    );
    const nas = health.dimensions.filter((d) => d.level === 'NOT_APPLICABLE');
    expect(nas.length).toBeGreaterThan(0);
    expect(nas.every((d) => d.na_source === 'config')).toBe(true);
  });
});

describe('ingest — a null nem nulla', () => {
  it('lefutott lekérdezés + 0 event 24h, de volt 7 napon belül → RED (elhallgatott)', () => {
    expect(levelOf(healthy({ accepted_events_24h: 0, accepted_events_7d: 90 }), 'ingest')).toBe('RED');
  });

  it('le NEM futott lekérdezés → UNKNOWN, NEM RED és főleg nem GREEN', () => {
    expect(levelOf(healthy({ accepted_events_24h: null, accepted_events_7d: null }), 'ingest')).toBe(
      'UNKNOWN'
    );
  });

  it('7 napja nulla → RED', () => {
    expect(levelOf(healthy({ accepted_events_24h: 0, accepted_events_7d: 0 }), 'ingest')).toBe('RED');
  });
});

describe('meta — a lomtalan-osztály (néma skip egy kiesett KV-blokk fölött)', () => {
  it('elvárt meta + hiányzó config → RED', () => {
    expect(levelOf(healthy({ expected_smoke: ['meta'], meta_configured: false }), 'meta')).toBe('RED');
  });

  it('konfigurált meta, csupa skip, nulla accepted → RED', () => {
    expect(
      levelOf(
        healthy({ platform_deliveries_24h: { meta: { accepted: 0, rejected: 0, skipped: 9 } } }),
        'meta'
      )
    ).toBe('RED');
  });

  it('event érkezett, de EGYETLEN meta-kísérlet sem → RED (a fan-out nem indul)', () => {
    expect(levelOf(healthy({ platform_deliveries_24h: {} }), 'meta')).toBe('RED');
  });

  it('sem config, sem kimondott elvárás → UNKNOWN (nem eldönthető, hogy szándékos-e)', () => {
    expect(levelOf(healthy({ expected_smoke: [], meta_configured: false }), 'meta')).toBe('UNKNOWN');
  });

  it('kimondottan nem várt + nincs config → NOT_APPLICABLE', () => {
    expect(levelOf(healthy({ expected_smoke: ['ga4'], meta_configured: false }), 'meta')).toBe(
      'NOT_APPLICABLE'
    );
  });

  it('részleges elutasítás YELLOW, többségi elutasítás RED', () => {
    expect(
      levelOf(
        healthy({ platform_deliveries_24h: { meta: { accepted: 9, rejected: 1, skipped: 0 } } }),
        'meta'
      )
    ).toBe('YELLOW');
    expect(
      levelOf(
        healthy({ platform_deliveries_24h: { meta: { accepted: 1, rejected: 9, skipped: 0 } } }),
        'meta'
      )
    ).toBe('RED');
  });
});

describe('google offline — a bizonyítás hiánya nem egészség', () => {
  it('elvárt offline, de egyetlen láb sincs → RED', () => {
    expect(levelOf(healthy({ offline_legs: [] }), 'google_offline')).toBe('RED');
  });

  it('nem elvárt offline + nincs láb → NOT_APPLICABLE', () => {
    expect(levelOf(healthy({ expected_offline: [], offline_legs: [] }), 'google_offline')).toBe(
      'NOT_APPLICABLE'
    );
  });

  it('minden láb UNARMED (soha nem szállított) → YELLOW, nem GREEN', () => {
    expect(
      levelOf(
        healthy({
          offline_legs: [leg({ state: 'UNARMED', delivered: 0, received: 0, expected: 0, last_successful_upload: null })]
        }),
        'google_offline'
      )
    ).toBe('YELLOW');
  });

  it('elvárt kézbesítés mellett nulla feltöltés → RED', () => {
    expect(
      levelOf(healthy({ offline_legs: [leg({ expected: 5, delivered: 0 })] }), 'google_offline')
    ).toBe('RED');
  });

  it('blokkolt függőség elvárt lábon → RED, nem elvárt lábon YELLOW', () => {
    const blockedLeg = leg({ state: 'BLOCKED_DEPENDENCY', blocked_by: 'oauth_token_missing' });
    expect(levelOf(healthy({ offline_legs: [blockedLeg] }), 'google_offline')).toBe('RED');
    expect(
      levelOf(healthy({ expected_offline: [], offline_legs: [blockedLeg] }), 'google_offline')
    ).toBe('YELLOW');
  });

  it('le nem futott lekérdezés → UNKNOWN', () => {
    expect(levelOf(healthy({ offline_legs: null }), 'google_offline')).toBe('UNKNOWN');
  });
});

describe('enhanced conversions — INV-009', () => {
  it('customer_id conversion_actions NÉLKÜL → RED (a néma skip forrása)', () => {
    expect(levelOf(healthy({ gads_conversion_action_count: 0 }), 'enhanced_conversions')).toBe('RED');
  });

  it('elvárt offline gads, de nincs customer_id → RED', () => {
    expect(levelOf(healthy({ gads_customer_id: null }), 'enhanced_conversions')).toBe('RED');
  });

  it('nincs customer_id és nincs elvárás → NOT_APPLICABLE (böngésző-tulajdonú EC)', () => {
    expect(
      levelOf(healthy({ gads_customer_id: null, expected_offline: [] }), 'enhanced_conversions')
    ).toBe('NOT_APPLICABLE');
  });
});

describe('cmp', () => {
  it('CookieYes → YELLOW (a legacy CMP nyitott jogi kockázat)', () => {
    expect(levelOf(healthy({ consent_provider: 'cookieyes' }), 'cmp')).toBe('YELLOW');
  });

  it('saját CMP + nulla döntés, miközben konverzió van → RED', () => {
    expect(levelOf(healthy({ consent_decisions_7d: 0, accepted_events_7d: 90 }), 'cmp')).toBe('RED');
  });

  it('saját CMP + nulla döntés + nulla forgalom → UNKNOWN (nincs mihez mérni)', () => {
    expect(
      levelOf(healthy({ consent_decisions_7d: 0, accepted_events_7d: 0, accepted_events_24h: 0 }), 'cmp')
    ).toBe('UNKNOWN');
  });
});

describe('package version — az F9-drift őre', () => {
  it('csupa hiányzó client_lib_version → UNKNOWN (a TRK-910-006 őr vak)', () => {
    expect(levelOf(healthy({ client_lib_versions_7d: [] }), 'package_version')).toBe('UNKNOWN');
    expect(levelOf(healthy({ client_lib_versions_7d: ['(none)'] }), 'package_version')).toBe('UNKNOWN');
  });

  it('több párhuzamos verzió → YELLOW', () => {
    expect(levelOf(healthy({ client_lib_versions_7d: ['1.3.0', '1.4.0'] }), 'package_version')).toBe(
      'YELLOW'
    );
  });
});

describe('browser smoke', () => {
  it('a SMOKE_SITES-ból kimaradt site → UNKNOWN (monitorozási hiány, nem „nem várjuk")', () => {
    expect(levelOf(healthy({ smoke_expected: false, smoke_result: null }), 'browser_smoke')).toBe(
      'UNKNOWN'
    );
  });

  it('hiányzó vagy bukott smoke → RED', () => {
    expect(levelOf(healthy({ smoke_result: 'missing' }), 'browser_smoke')).toBe('RED');
    expect(levelOf(healthy({ smoke_result: 'fail' }), 'browser_smoke')).toBe('RED');
  });
});

describe('business recon', () => {
  it('sosem jelentkezett CRM-forrás → UNKNOWN (nem GREEN, nem RED)', () => {
    expect(
      levelOf(healthy({ business_ever_reported: false, business_last_report_date: null }), 'business_recon')
    ).toBe('UNKNOWN');
  });

  it('friss aggregátum → GREEN, 2-3 nap → YELLOW, régebbi → RED', () => {
    expect(levelOf(healthy({ business_last_report_date: '2026-08-25' }), 'business_recon')).toBe('GREEN');
    expect(levelOf(healthy({ business_last_report_date: '2026-08-23' }), 'business_recon')).toBe(
      'YELLOW'
    );
    expect(levelOf(healthy({ business_last_report_date: '2026-08-15' }), 'business_recon')).toBe('RED');
  });
});

describe('buildFleetReport', () => {
  it('részleges config-felsorolás → a flotta rollupja UNKNOWN, akkor is, ha minden LÁTOTT site zöld', () => {
    const green: FleetSiteInput = healthy();
    const complete = buildFleetReport([green], NOW, true, '2026-08-25T12:00:00Z');
    const partial = buildFleetReport([green], NOW, false, '2026-08-25T12:00:00Z');
    expect(partial.fleet_overall).toBe('UNKNOWN');
    expect(partial.config_enumeration_complete).toBe(false);
    // A kettő azonos site-halmazon fut; a különbség KIZÁRÓLAG a felsorolás teljessége.
    expect(complete.sites[0].dimensions).toEqual(partial.sites[0].dimensions);
  });

  it('üres flotta → UNKNOWN, nem GREEN (a „nincs site" nem egészség)', () => {
    expect(buildFleetReport([], NOW, true, '2026-08-25T12:00:00Z').fleet_overall).toBe('UNKNOWN');
  });

  it('a legrosszabb site szintje viszi a flottát, és a dimenzió-összegzés kiadja a vakfoltokat', () => {
    const report = buildFleetReport(
      [healthy(), healthy({ site_id: 'lomtalan', accepted_events_24h: 0, accepted_events_7d: 40 })],
      NOW,
      true,
      '2026-08-25T12:00:00Z'
    );
    expect(report.fleet_overall).toBe('RED');
    expect(report.dimension_summary.gtm_conformance.UNKNOWN).toBe(2);
    expect(report.dimension_summary.ingest.RED).toBe(1);
    expect(report.dimension_summary.ingest.GREEN).toBe(1);
  });
});
