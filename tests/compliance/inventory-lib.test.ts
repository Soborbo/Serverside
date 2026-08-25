import { describe, it, expect } from 'vitest';
import { classifyRequestDetailed } from './lib/classify.mjs';
import { buildInventory, evaluateInventory, evaluateAnalyticsOnly } from './lib/inventory.mjs';
import { scanSource, evaluateStaticScan, compareStaticToRuntime } from './lib/static-scan.mjs';
import { VENDOR_REGISTRY } from './lib/vendor-registry.mjs';

/**
 * F7 · P8 — a runtime-inventory és a statikus scan TISZTA magja.
 *
 * Ezek a tesztek CI-ban is futnak (a Playwright-harness szándékosan nem — az
 * élő oldalakat tölt). A legfontosabb állítás mindenütt ugyanaz: **az ismeretlen
 * nem ártalmatlan.** Ami nincs a regiszterben, azt nem soroljuk be találgatásból,
 * és nem is hallgatjuk el.
 */

const SITE = 'https://painlessremovals.com/';

const req = (url: string) => ({ url, t: 1, method: 'GET' });

describe('classifyRequestDetailed — az ismeretlen vendor nem olvad bele az „other"-be', () => {
  it('a regiszterben lévő vendort névvel és consent-osztállyal adja vissza', () => {
    const meta = classifyRequestDetailed('https://www.facebook.com/tr?id=1', SITE);
    expect(meta.known).toBe(true);
    expect(meta.vendor).toBe('meta');
    expect(meta.consent_class).toBe('marketing');
  });

  it('az ISMERETLEN harmadik fél known:false — nem kap találgatott besorolást', () => {
    const x = classifyRequestDetailed('https://px.some-new-tracker.example/p.gif', SITE);
    expect(x.known).toBe(false);
    expect(x.category).toBe('unknown_vendor');
    expect(x.consent_class).toBeNull();
    expect(x.host).toBe('px.some-new-tracker.example');
  });

  it('a site SAJÁT kérése first_party — nem vendor és nem ismeretlen', () => {
    const own = classifyRequestDetailed('https://painlessremovals.com/assets/app.js', SITE);
    expect(own.category).toBe('first_party');
    expect(own.known).toBe(true);
  });

  it('a PROXYZOTT Google-mérés első fél-en megy, de attól még Google-vendor', () => {
    const proxied = classifyRequestDetailed(
      'https://painlessremovals.com/f807/gs/ccm/collect?tid=AW-123&en=page_view',
      SITE
    );
    expect(proxied.vendor).toBe('google_ads_proxied');
    expect(proxied.consent_class).toBe('marketing');
    expect(proxied.first_party).toBe(true);
  });

  it('a regiszter minden bejegyzése teljes (id, név, kategória, consent-osztály)', () => {
    for (const v of VENDOR_REGISTRY as Array<Record<string, unknown>>) {
      expect(typeof v.id).toBe('string');
      expect(typeof v.name).toBe('string');
      expect(typeof v.category).toBe('string');
      expect(['essential', 'functional', 'analytics', 'marketing', 'conditional']).toContain(v.consent_class);
    }
  });
});

describe('buildInventory', () => {
  const phases = [
    {
      phase: 'A_before_decision',
      capture: {
        requests: [
          req('https://www.googletagmanager.com/gtm.js?id=GTM-X'),
          req('https://px.unknown-thing.example/p.gif'),
          req('https://painlessremovals.com/style.css')
        ]
      }
    },
    {
      phase: 'B_accept_all',
      capture: { requests: [req('https://www.facebook.com/tr?id=1'), req('https://px.unknown-thing.example/p.gif')] }
    }
  ];

  it('fázisonként számol, és a first-party kéréseket kihagyja', () => {
    const inv = buildInventory(phases, SITE);
    expect(inv.rows.some((r: any) => r.category === 'first_party')).toBe(false);
    const unknown = inv.rows.find((r: any) => !r.known);
    expect(unknown.counts.A_before_decision).toBe(1);
    expect(unknown.counts.B_accept_all).toBe(1);
    expect(unknown.first_seen_phase).toBe('A_before_decision');
  });

  it('az ismeretlenek a lista ELEJÉN vannak — azok a triage első tételei', () => {
    const inv = buildInventory(phases, SITE);
    expect(inv.rows[0].known).toBe(false);
    expect(inv.unknown_hosts).toEqual(['px.unknown-thing.example']);
  });

  it('a le NEM futott fázis (null capture) nem kerül be — nem állítjuk, hogy ott semmi nem futott', () => {
    const inv = buildInventory([...phases, { phase: 'C_reject_all', capture: null }], SITE);
    expect(inv.phases).toEqual(['A_before_decision', 'B_accept_all']);
    expect(inv.rows.every((r: any) => r.counts.C_reject_all === undefined)).toBe(true);
  });
});

describe('evaluateInventory — report-only, de NEM néma', () => {
  it('ismeretlen vendor → INFO, névvel a bizonyítékban (nem FAIL: nem tudjuk, mi az)', () => {
    const inv = buildInventory(
      [{ phase: 'A_before_decision', capture: { requests: [req('https://px.unknown-thing.example/p.gif')] } }],
      SITE
    );
    const checks = evaluateInventory(inv);
    const unknown = checks.find((c: any) => c.id === 'INV_unknown_vendors');
    expect(unknown.status).toBe('INFO');
    expect(JSON.stringify(unknown.evidence)).toContain('px.unknown-thing.example');
    // A döntés ELŐTTI előfordulás külön megállapítás — ez viszi a triage sorrendjét.
    expect(checks.some((c: any) => c.id === 'INV_unknown_vendor_pre_consent')).toBe(true);
  });

  it('csupa ismert vendor → PASS, és nincs pre-consent megállapítás', () => {
    const inv = buildInventory(
      [{ phase: 'A_before_decision', capture: { requests: [req('https://fonts.gstatic.com/s/x.woff2')] } }],
      SITE
    );
    const checks = evaluateInventory(inv);
    expect(checks.find((c: any) => c.id === 'INV_unknown_vendors').status).toBe('PASS');
    expect(checks.some((c: any) => c.id === 'INV_unknown_vendor_pre_consent')).toBe(false);
  });
});

describe('evaluateAnalyticsOnly — a részleges consent próbája', () => {
  it('marketing-kérés analytics-only döntés mellett → FAIL', () => {
    const checks = evaluateAnalyticsOnly({
      skipped: false,
      site_url: SITE,
      requests: [req('https://www.facebook.com/tr?id=1'), req('https://www.google-analytics.com/g/collect')]
    });
    expect(checks.find((c: any) => c.id === 'E_analytics_only_no_marketing').status).toBe('FAIL');
    expect(checks.find((c: any) => c.id === 'E_analytics_only_analytics_runs').status).toBe('PASS');
  });

  it('csak analitika fut → PASS', () => {
    const checks = evaluateAnalyticsOnly({
      skipped: false,
      site_url: SITE,
      requests: [req('https://www.google-analytics.com/g/collect')]
    });
    expect(checks.find((c: any) => c.id === 'E_analytics_only_no_marketing').status).toBe('PASS');
  });

  it('SEMMI nem fut → a „nincs marketing" ÜRESEN igaz, ezt ki is mondjuk', () => {
    const checks = evaluateAnalyticsOnly({ skipped: false, site_url: SITE, requests: [] });
    expect(checks.find((c: any) => c.id === 'E_analytics_only_no_marketing').status).toBe('PASS');
    expect(checks.find((c: any) => c.id === 'E_analytics_only_analytics_runs').status).toBe('INFO');
  });

  it('le nem futott szcenárió → N-A, indoklással; SOHA nem PASS', () => {
    const checks = evaluateAnalyticsOnly({ skipped: true, reason: 'a CMP nem fogadta el a magvetett döntést' });
    expect(checks.every((c: any) => c.status === 'N-A')).toBe(true);
    expect(checks[0].detail).toContain('magvetett');
  });
});

describe('scanSource + evaluateStaticScan', () => {
  const HTML = `<!doctype html><script>
    window.dataLayer.push({ event: 'lead', user_data: { email: 'a@b.com' } });
    var id = 'AW-1234567890';
    // fbq('init', '1234567890123456');
    var gtm = 'GTM-ABCD123';
  </script>`;

  it('PII a dataLayerben → FAIL (a szerzőtől függetlenül jogsértés)', () => {
    const scan = scanSource([{ url: 'https://x.test/', text: HTML }]);
    const checks = evaluateStaticScan(scan);
    expect(checks.find((c: any) => c.id === 'STATIC_no_pii_in_source').status).toBe('FAIL');
  });

  it('fbq/gtag hívás → INFO, mert bundle-ből nem eldönthető, ki írta', () => {
    const scan = scanSource([{ url: 'https://x.test/', text: HTML }]);
    const checks = evaluateStaticScan(scan);
    const forbidden = checks.find((c: any) => c.id === 'STATIC_no_forbidden_calls');
    expect(forbidden.status).toBe('INFO');
    expect(forbidden.detail).toContain('NEM eldönthető');
  });

  it('a deklarált tracker-azonosítókat összegyűjti', () => {
    const scan = scanSource([{ url: 'https://x.test/', text: HTML }]);
    const ids = Object.fromEntries(scan.declared.map((d: any) => [d.id, d.values]));
    expect(ids.google_ads_conversion).toEqual(['AW-1234567890']);
    expect(ids.gtm_container).toEqual(['GTM-ABCD123']);
    expect(ids.meta_pixel).toEqual(['1234567890123456']);
  });

  it('a le NEM futott scan N-A, nem PASS — a „nem néztük" nem „tiszta"', () => {
    const checks = evaluateStaticScan(null);
    expect(checks[0].status).toBe('N-A');
  });
});

describe('compareStaticToRuntime — a rés, amit egyik oldal sem lát', () => {
  it('forrásban deklarált, futásidőben néma tracker → INFO (a PASS nem fedi le)', () => {
    const scan = scanSource([{ url: 'https://x.test/', text: "var a='AW-1234567890';" }]);
    const inv = buildInventory(
      [{ phase: 'A_before_decision', capture: { requests: [req('https://www.googletagmanager.com/gtm.js')] } }],
      SITE
    );
    const checks = compareStaticToRuntime(scan, inv);
    expect(checks[0].status).toBe('INFO');
    expect(JSON.stringify(checks[0].evidence)).toContain('google_ads_conversion');
  });

  it('a proxyzott futásidejű megjelenés is számít jelenlétnek', () => {
    const scan = scanSource([{ url: 'https://x.test/', text: "var a='AW-1234567890';" }]);
    const inv = buildInventory(
      [
        {
          phase: 'A_before_decision',
          capture: { requests: [req('https://painlessremovals.com/f807/gs/ccm/collect?tid=AW-1234567890')] }
        }
      ],
      SITE
    );
    expect(compareStaticToRuntime(scan, inv)[0].status).toBe('PASS');
  });
});
