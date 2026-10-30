// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { collectAttribution } from '../lib/gateway';
import { ATTR_STORAGE_KEY, captureUrlParams, getStoredData, persistTrackingParams } from '../lib/persistence';
import { resolveGoogleClickId } from '../lib/google-click-id';

/**
 * A FRISS LANDING KATTINTÁSA TÚLÉLI A TOVÁBBLÉPÉST (6.17.1).
 *
 * Codex, paywalled_boilerplate #92 + #94: régi `_gcl_aw` süti → új gbraid-es
 * landing → árlap → vásárlás. A gateway tárolója (`__sb_attribution`) csak a
 * vásárláskor íródik, a `_gcl_aw` pedig a gbraid-es kattintástól nem frissül —
 * így az árlapon a cookie régi gclid-je nyert, és a konverzió a RÉGI kattintáshoz
 * ment. Az msclkid-et pedig a landing után semmi sem őrizte.
 */

function grantMarketing() {
  (window as unknown as Record<string, unknown>).getCkyConsent = () => ({
    categories: { advertisement: true, analytics: true }
  });
  document.cookie = 'cookieyes-consent=' + encodeURIComponent('analytics:yes,advertisement:yes') + ';path=/';
}

function setUrl(pathAndSearch: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL(`https://painlessremovals.com${pathAndSearch}`) as unknown as Location
  });
}

/** One consented page view, as the site boot runs it. */
function page(pathAndSearch: string) {
  setUrl(pathAndSearch);
  captureUrlParams();
  persistTrackingParams();
}

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    document.cookie = `${c.split('=')[0]!.trim()}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
  grantMarketing();
  vi.restoreAllMocks();
});

describe('Google: az újabb kattintás nyer, nem a forrás rangja', () => {
  it('régi _gcl_aw gclid + friss gbraid-es landing → az árlapon is a gbraid megy', () => {
    document.cookie = `_gcl_aw=GCL.${nowSec() - 3600}.OLD-GCLID; path=/`;
    page('/landing?gbraid=NEW-BRAID');
    page('/pricing');
    const out = collectAttribution();
    expect(out.gbraid).toBe('NEW-BRAID');
    expect(out.gclid).toBeUndefined();
  });

  it('egy korábbi vásárlás tárolt gclid-je sem árnyékolja az új landing gbraid-jét', () => {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ gclid: 'PREV-CHECKOUT-GCLID' }));
    page('/landing?gbraid=NEW-BRAID');
    page('/pricing');
    expect(collectAttribution()).toMatchObject({ gbraid: 'NEW-BRAID' });
    expect(collectAttribution().gclid).toBeUndefined();
  });

  it('ha a _gcl_aw az ÚJABB (gclid-es kattintás a landing után), a cookie nyer', () => {
    page('/landing?gbraid=OLD-BRAID');
    document.cookie = `_gcl_aw=GCL.${nowSec() + 60}.NEWER-GCLID; path=/`;
    page('/pricing');
    const out = collectAttribution();
    expect(out.gclid).toBe('NEWER-GCLID');
    expect(out.gbraid).toBeUndefined();
  });

  it('a tárolt blob rögzíti a Google-kattintás idejét, és nélküle nem marad bélyeg', () => {
    page('/landing?gbraid=B');
    expect(getStoredData()?.googleClickAt).toBeTypeOf('number');
    page('/other?utm_source=newsletter');
    expect(getStoredData()?.googleClickAt, 'utm-only landing nem frissíti a kattintás idejét').toBeTypeOf('number');
  });

  it('ugyanaz a kattintás újra-perzisztálva nem kap új bélyeget, így egy közben jött újabb _gcl_aw nyer', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    page('/landing?gbraid=OLD-BRAID');
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_600_000);
    document.cookie = `_gcl_aw=GCL.${1_000_000_300}.NEWER-GCLID; path=/`;
    persistTrackingParams(); // pl. consent-callback ugyanazon az URL-en
    expect(getStoredData()?.googleClickAt).toBe(1_000_000_000_000);
    setUrl('/pricing');
    expect(collectAttribution().gclid).toBe('NEWER-GCLID');
  });

  it('új Google klikk-ID-vel a bélyeg frissül', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    page('/landing?gbraid=A');
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_600_000);
    page('/landing?gbraid=B');
    expect(getStoredData()).toMatchObject({ gbraid: 'B', googleClickAt: 1_000_000_600_000 });
  });
});

describe('a gateway-tároló és az sb_tracking szinkronban marad', () => {
  it('ha az init a consent-API előtt futott, a collectAttribution maga menti a kattintást', () => {
    page('/old?msclkid=MS-OLD&gbraid=OLD-BRAID');
    // Új landing, de a persist kimaradt (a CookieYes API még nem állt fel):
    setUrl('/landing?msclkid=MS-NEW&gbraid=NEW-BRAID');
    expect(collectAttribution()).toMatchObject({ msclkid: 'MS-NEW', gbraid: 'NEW-BRAID' });
    setUrl('/pricing');
    expect(collectAttribution()).toMatchObject({ msclkid: 'MS-NEW', gbraid: 'NEW-BRAID' });
  });
});

describe('a döntő primitív (resolveGoogleClickId, 4. szabály)', () => {
  const cookie = (sec: number) => `GCL.${sec}.COOKIE-GCLID`;

  it('időbélyeg nélküli (régi) tárolónál a cookie marad előrébb', () => {
    expect(resolveGoogleClickId({ gclAw: cookie(1000), stored: { gbraid: 'S' } })?.source).toBe('gcl_aw_cookie');
  });

  it('az újabb tárolt kattintás leveri a régebbi cookie-t, a régebbi nem', () => {
    expect(resolveGoogleClickId({ gclAw: cookie(1000), stored: { gbraid: 'S' }, storedAt: 1_001_000 })).toMatchObject({ key: 'gbraid', source: 'stored' });
    expect(resolveGoogleClickId({ gclAw: cookie(1000), stored: { gbraid: 'S' }, storedAt: 999_000 })?.source).toBe('gcl_aw_cookie');
  });

  it('az URL mindent visz', () => {
    expect(resolveGoogleClickId({ url: { wbraid: 'U' }, gclAw: cookie(1000), stored: { gbraid: 'S' }, storedAt: 9e12 })?.source).toBe('url');
  });
});

describe('Microsoft és Meta klikk-ID a landing után', () => {
  it('msclkid-es landing → árlap → az msclkid megmarad', () => {
    page('/landing?msclkid=MS-NEW');
    page('/pricing');
    expect(collectAttribution().msclkid).toBe('MS-NEW');
  });

  it('a friss landing fbclid-je leveri egy korábbi vásárlás tárolt fbclid-jét', () => {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ fbclid: 'OLD-FB' }));
    page('/landing?fbclid=NEW-FB');
    page('/pricing');
    expect(collectAttribution().fbclid).toBe('NEW-FB');
  });

  it('marketing-hozzájárulás nélkül a tárolt klikk-ID nem kerül a payloadba', () => {
    page('/landing?msclkid=MS-NEW');
    (window as unknown as Record<string, unknown>).getCkyConsent = () => ({ categories: { advertisement: false, analytics: true } });
    document.cookie = 'cookieyes-consent=' + encodeURIComponent('analytics:yes,advertisement:no') + ';path=/';
    page('/pricing');
    expect(collectAttribution().msclkid).toBeUndefined();
  });
});
