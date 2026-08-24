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
