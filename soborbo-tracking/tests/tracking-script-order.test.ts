import { describe, it, expect } from 'vitest';

/**
 * A `<Tracking />` szkript-SORRENDJE — regressziós őr.
 *
 * Helyes sorrend a cookieyes-ágon: consent default (mind denied) → CMP
 * (CookieYes) → GTM. 6.9.0-ig a CookieYes-szkript a default ELŐTT állt: egy
 * visszatérő látogató tárolt döntéséből kiadott `consent update` így a default
 * ELÉ kerülhetett, a később érkező `default` (mind denied) pedig felülírta. A
 * GTM UTÁN sem állhat: az async GTM a CookieYes letöltése közben elindíthatja a
 * 2 s-os `wait_for_update` ablakot, és lassú hálón a tárolt döntés kicsúszik.
 * sbo-ágon: consent-boot (default + GTM-loader) → CookieYes (csak a sütije miatt).
 *
 * Mellette: `ads_data_redaction` a default mellett mindkét ágon — ad_storage=
 * denied esetén a Google a klikk-azonosítókat is kitakarja a pingekből.
 */
const RAW = (import.meta as unknown as {
  glob: (p: string, o: unknown) => Record<string, string>;
}).glob('../components/Tracking.astro', { query: '?raw', eager: true, import: 'default' });
const SRC = Object.values(RAW)[0]!;
/** A template rész (a frontmatter `---` blokk után) — a fejléc-komment ne zavarjon. */
const TEMPLATE = SRC.slice(SRC.indexOf('---', 3) + 3);

function pos(needle: string): number {
  const i = TEMPLATE.indexOf(needle);
  expect(i, `nem található: ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('Tracking.astro — consent default → CMP → GTM', () => {
  const cookieYes = () => pos('cdn-cookieyes.com');

  it('cookieyes-ág: consent default → CookieYes → GTM-loader', () => {
    const consentDefault = pos("gtag('consent', 'default'");
    const gtm = pos("'https://www.googletagmanager.com/gtm.js?id='+i+dl");
    expect(consentDefault).toBeLessThan(cookieYes());
    expect(cookieYes()).toBeLessThan(gtm);
  });

  it('sbo-ág: a consent-boot (default + GTM-loader) is a CookieYes ELŐTT áll', () => {
    const sboBoot = pos('{isSbo && (');
    expect(sboBoot).toBeLessThan(cookieYes());
  });

  it('a CookieYes-szkript egyetlen példányban szerepel', () => {
    expect(TEMPLATE.split('cdn-cookieyes.com').length - 1).toBe(1);
  });

  it('ads_data_redaction mindkét ágon a consent default után, a GTM előtt', () => {
    const defaults = [...TEMPLATE.matchAll(/gtag\('consent', 'default'/g)].map((m) => m.index!);
    const redactions = [...TEMPLATE.matchAll(/gtag\('set', 'ads_data_redaction', true\)/g)].map((m) => m.index!);
    expect(defaults).toHaveLength(2);
    expect(redactions).toHaveLength(2);
    // cookieyes-ág: default → redaction → GTM-snippet
    const gtm = pos("'https://www.googletagmanager.com/gtm.js?id='+i+dl");
    expect(defaults[0]!).toBeLessThan(redactions[0]!);
    expect(redactions[0]!).toBeLessThan(gtm);
    // sbo-ág: default → redaction → (döntés esetén) loader-hívás
    expect(defaults[1]!).toBeLessThan(redactions[1]!);
    expect(redactions[1]!).toBeLessThan(TEMPLATE.indexOf('w.__sboLoadGtm();'));
  });

  it('a basic/advanced logika változatlan: wait_for_update CSAK a cookieyes-ágon', () => {
    expect(TEMPLATE.split("'wait_for_update'").length - 1).toBe(1);
    expect(TEMPLATE.indexOf("'wait_for_update'")).toBeLessThan(pos('{isSbo && ('));
  });
});
