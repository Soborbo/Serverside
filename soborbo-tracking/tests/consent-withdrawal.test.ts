import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import { initTracking } from '../lib/index';
import { captureUrlParams, persistTrackingParams, getSessionId } from '../lib/persistence';
import { setCkyConsent, setUrl, setCookie, resetAll } from './helpers';

/**
 * Consent-visszavonás → purge huzalozás (2. brief · S3).
 *
 * A hiba, amit ez zár: az `initTracking()` consent-change callbackje CSAK a
 * grant-ágat kezelte (`advertisement=true` → persistTrackingParams). DENIED
 * esetén nem hívott semmit — a `clearTrackingData()` létezett, de sehol nem volt
 * bekötve, tehát a visszavonás után a korábban eltárolt marketing-adat a helyén
 * maradt. A visszavonásnak a NYUGVÓ adatig kell érnie, nem csak a jövőbeli
 * írásokig.
 */

/** A CookieYes `cookieyes_consent_update` esemény kiváltása adott kategóriákkal. */
function emitConsentUpdate(opts: { analytics: boolean; marketing: boolean }): void {
  setCkyConsent(opts);
  document.dispatchEvent(new Event('cookieyes_consent_update'));
}

function seedMarketingStorage(): void {
  setCkyConsent({ analytics: true, marketing: true });
  setUrl('/?gclid=G-999&utm_source=google');
  captureUrlParams();
  persistTrackingParams();
  setCookie('_fbp', 'fb.1.100.200');
  setCookie('_fbc', 'fb.1.100.CLICK');
}

beforeEach(() => {
  resetAll();
  setCkyConsent({ analytics: true, marketing: true });
});

describe('initTracking — consent-change purge huzalozás', () => {
  it('marketing visszavonása törli a marketing storage-ot ÉS a Meta sütiket', () => {
    initTracking();
    seedMarketingStorage();
    expect(localStorage.getItem('sb_tracking')).not.toBeNull();

    emitConsentUpdate({ analytics: true, marketing: false });

    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
    expect(document.cookie).not.toContain('_fbp=fb.1.100.200');
    expect(document.cookie).not.toContain('_fbc=fb.1.100.CLICK');
  });

  it('a marketing visszavonása NEM viszi el a session-t, ha az analytics marad', () => {
    initTracking();
    setCkyConsent({ analytics: true, marketing: true });
    const sessionId = getSessionId();
    expect(sessionStorage.getItem('sb_session')).not.toBeNull();

    emitConsentUpdate({ analytics: true, marketing: false });

    expect(sessionStorage.getItem('sb_session')).not.toBeNull();
    expect(getSessionId()).toBe(sessionId);
  });

  it('az analytics visszavonása törli a session-t, a marketing storage-ot NEM', () => {
    initTracking();
    seedMarketingStorage();
    getSessionId();
    expect(sessionStorage.getItem('sb_session')).not.toBeNull();

    emitConsentUpdate({ analytics: false, marketing: true });

    expect(sessionStorage.getItem('sb_session')).toBeNull();
    expect(localStorage.getItem('sb_tracking')).not.toBeNull();
  });

  it('mindkettő visszavonása mindent töröl', () => {
    initTracking();
    seedMarketingStorage();
    getSessionId();

    emitConsentUpdate({ analytics: false, marketing: false });

    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
    expect(sessionStorage.getItem('sb_session')).toBeNull();
  });

  it('a grant-ág változatlan: marketing bekapcsolása perzisztál', () => {
    initTracking();
    setUrl('/?gclid=G-GRANT');
    captureUrlParams();
    // A grant előtt nincs mit tárolni…
    setCkyConsent({ analytics: true, marketing: false });
    persistTrackingParams();
    expect(localStorage.getItem('sb_tracking')).toBeNull();

    // …a grant pillanatában viszont igen (a régi viselkedés).
    emitConsentUpdate({ analytics: true, marketing: true });
    expect(localStorage.getItem('sb_tracking')).toContain('G-GRANT');
  });
});

/**
 * A visszavonásnak a HARMADIK FÉL sütijeit is el kell érnie (2026-08-25-i jogi
 * átvilágítás). A Consent Mode denied jele a KÜLDÉST állítja meg — a már kiírt
 * azonosítót nem: a `_ga` két évig, a `_gcl_au` 90 napig a böngészőben maradna
 * azután is, hogy a látogató épp ennek a megszűnését kérte.
 *
 * A `_ga_<STREAM>` és a `_gcl_*` nevében per-property utótag van, ezért a purge
 * a `document.cookie`-ból prefix szerint gyűjt — egy beégetett névlista némán
 * kihagyná a valódi property sütijét.
 */
describe('visszavonás — a Google saját sütijei', () => {
  function seedVendorCookies(): void {
    setCookie('_ga', 'GA1.1.111.222');
    setCookie('_ga_ABC123XYZ', 'GS1.1.1700000000.1.0.1700000000.0.0.0');
    setCookie('_gcl_au', '1.1.987654321.1700000000');
    setCookie('_gcl_aw', 'GCL.1700000000.CjwKCAjw');
  }

  it('az analytics visszavonása törli a GA4 sütiket (a stream-utótagosat is)', () => {
    initTracking();
    seedVendorCookies();
    emitConsentUpdate({ analytics: false, marketing: true });

    expect(document.cookie).not.toContain('_ga=');
    expect(document.cookie).not.toContain('_ga_ABC123XYZ=');
  });

  it('az analytics visszavonása NEM viszi el a Google Ads sütiket (az marketing)', () => {
    initTracking();
    seedVendorCookies();
    emitConsentUpdate({ analytics: false, marketing: true });

    expect(document.cookie).toContain('_gcl_au=');
  });

  it('a marketing visszavonása törli a Google Ads linker sütiket', () => {
    initTracking();
    seedVendorCookies();
    emitConsentUpdate({ analytics: true, marketing: false });

    expect(document.cookie).not.toContain('_gcl_au=');
    expect(document.cookie).not.toContain('_gcl_aw=');
  });

  it('a marketing visszavonása NEM viszi el a GA4 sütiket (az analytics)', () => {
    initTracking();
    seedVendorCookies();
    emitConsentUpdate({ analytics: true, marketing: false });

    expect(document.cookie).toContain('_ga=');
  });

  it('mindkettő visszavonása mindent elvisz, a Meta sütikkel együtt', () => {
    initTracking();
    seedVendorCookies();
    setCookie('_fbp', 'fb.1.100.200');
    emitConsentUpdate({ analytics: false, marketing: false });

    for (const name of ['_ga=', '_ga_ABC123XYZ=', '_gcl_au=', '_gcl_aw=', '_fbp=']) {
      expect(document.cookie, `${name} túlélte a visszavonást`).not.toContain(name);
    }
  });
});
