import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureUrlParams, persistTrackingParams,
  getStoredData, getGclid, getFbclid, getAttribution, getSourceType,
  getAllTrackingData, getFbp, getFbc, getFbcCookie, getSession, getSessionId,
  getStorageReadBlocked, resetStorageReadBlocked,
  purgeMarketingStorage, purgeAnalyticsStorage, clearTrackingData,
} from '../lib/persistence';
import { setCkyConsent, clearCkyConsent, setUrl, setCookie, resetAll } from './helpers';

/**
 * PECR read-gate (2. brief · S1).
 *
 * A UK PECR — és az ICO 2026. áprilisi végleges útmutatója — alatt nem csak a
 * terminál-eszközre ÍRÁS, hanem az ott tárolt adathoz való HOZZÁFÉRÉS is
 * engedélyköteles. Az írás eddig is kapuzott volt; az OLVASÁS nem, pedig minden
 * getter a konverziós payloadot táplálja.
 *
 * A tesztek két dolgot őriznek egyszerre:
 *   (a) consent NÉLKÜL egyetlen getter sem nyúl a storage-hoz, ÉS
 *   (b) GRANTED consent mellett minden getter BITRE azt adja, amit eddig —
 *       a regresszió itt csendes attribúcióvesztés lenne.
 */

/** Egy teljes, eltárolt attribúciós rekord marketing-consenttel. */
function seedStoredData(): void {
  setCkyConsent({ analytics: true, marketing: true });
  setUrl('/?gclid=G-123&fbclid=F-456&utm_source=google&utm_medium=cpc&utm_campaign=brand');
  captureUrlParams();
  persistTrackingParams();
}

beforeEach(() => {
  resetAll();
  resetStorageReadBlocked();
});

describe('GRANTED consent — a viselkedés bitre a mai', () => {
  beforeEach(seedStoredData);

  it('getStoredData visszaadja a rekordot', () => {
    expect(getStoredData()).toMatchObject({ gclid: 'G-123', fbclid: 'F-456', utm_source: 'google' });
  });

  it('getGclid / getFbclid a tárolt értékre esik vissza, ha az URL már nem hordozza', () => {
    setUrl('/koszonjuk');
    expect(getGclid()).toBe('G-123');
    expect(getFbclid()).toBe('F-456');
  });

  it('getAttribution first- és last-touch mezői megvannak', () => {
    setUrl('/koszonjuk');
    expect(getAttribution()).toMatchObject({
      first_gclid: 'G-123',
      first_utm_source: 'google',
      last_gclid: 'G-123',
      last_utm_campaign: 'brand',
    });
  });

  it('getSourceType a tárolt gclid alapján paid', () => {
    setUrl('/koszonjuk');
    expect(getSourceType()).toBe('paid');
  });

  it('getAllTrackingData a tárolt mezőket adja', () => {
    setUrl('/koszonjuk');
    expect(getAllTrackingData()).toMatchObject({ gclid: 'G-123', utm_medium: 'cpc' });
  });

  it('getFbp / getFbc olvassa a Meta sütiket', () => {
    setCookie('_fbp', 'fb.1.100.200');
    setCookie('_fbc', 'fb.1.100.CLICK');
    expect(getFbp()).toBe('fb.1.100.200');
    expect(getFbc()).toBe('fb.1.100.CLICK');
    expect(getFbcCookie()).toBe('fb.1.100.CLICK');
  });

  it('getFbc süti nélkül a tárolt fbclid-ből rekonstruál (változatlan viselkedés)', () => {
    setUrl('/koszonjuk');
    expect(getFbc()).toMatch(/^fb\.1\.\d+\.F-456$/);
    // A nyers-süti olvasó NEM rekonstruál — a gateway payload ezt használja.
    expect(getFbcCookie()).toBeNull();
  });

  it('egyetlen olvasás sincs blokkolva', () => {
    setUrl('/koszonjuk');
    getStoredData(); getAttribution(); getFbp(); getFbc(); getAllTrackingData();
    expect(getStorageReadBlocked()).toEqual({ blocked: false, keys: [] });
  });
});

describe('marketing consent NÉLKÜL — nincs storage-hozzáférés', () => {
  beforeEach(() => {
    seedStoredData();              // az adat OTT van a storage-ban…
    setCkyConsent({ analytics: true, marketing: false }); // …de a consent visszavonva
    resetStorageReadBlocked();
    setUrl('/koszonjuk');          // az URL már nem hordozza a click ID-t
  });

  it('getStoredData null — nem olvassa a localStorage-ot', () => {
    expect(getStoredData()).toBeNull();
  });

  it('getGclid / getFbclid nem esik vissza a tárolt értékre', () => {
    expect(getGclid()).toBeNull();
    expect(getFbclid()).toBeNull();
  });

  it('getAttribution üres — a sb_first_touch SAJÁT kaput kapott', () => {
    expect(getAttribution()).toEqual({});
  });

  it('getSourceType direct', () => {
    expect(getSourceType()).toBe('direct');
  });

  it('getAllTrackingData nem hoz tárolt mezőt', () => {
    expect(getAllTrackingData()).toEqual({
      gclid: undefined, gbraid: undefined, wbraid: undefined, fbclid: undefined,
      utm_source: undefined, utm_medium: undefined, utm_campaign: undefined,
      utm_content: undefined, utm_term: undefined,
    });
  });

  it('getFbp / getFbc nem olvassa a _fbp / _fbc sütit', () => {
    setCookie('_fbp', 'fb.1.100.200');
    setCookie('_fbc', 'fb.1.100.CLICK');
    expect(getFbp()).toBeNull();
    expect(getFbc()).toBeNull();
    expect(getFbcCookie()).toBeNull();
  });

  it('az URL-paraméterek olvasása MEGENGEDETT (nem terminál-storage)', () => {
    setUrl('/?gclid=FRESH-1&fbclid=FRESH-2&utm_source=google');
    expect(getGclid()).toBe('FRESH-1');
    expect(getFbclid()).toBe('FRESH-2');
    expect(getAllTrackingData().utm_source).toBe('google');
  });
});

describe('blokkolt-olvasás telemetria (a betöltési verseny 2. mérése)', () => {
  beforeEach(() => {
    seedStoredData();
    setCkyConsent({ analytics: true, marketing: false });
    resetStorageReadBlocked();
  });

  it('rögzíti a blokkolt kulcsokat', () => {
    getStoredData();
    getAttribution();
    getFbp();
    getFbc();
    const r = getStorageReadBlocked();
    expect(r.blocked).toBe(true);
    expect(r.keys.sort()).toEqual(['_fbc', '_fbp', 'sb_first_touch', 'sb_tracking'].sort());
  });

  it('DEV-ben az API hiánya NEM blokkol (a fejlesztői kényelem változatlan)', () => {
    // A lib consent-kapuja API nélkül `isDevMode()`-ot ad: dev-ben enged,
    // PRODBAN deny-all. A prod-ág itt NEM tesztelhető: a Vite az
    // `import.meta.env.DEV`-et fordítási időben literálra cseréli, tehát
    // futásidőben nem állítható át. Azt az ágat — a lassan töltő CookieYes
    // mellett is BELEEGYEZŐ látogatót, vagyis a betöltési versenyt — a
    // Playwright-suite fedi, ami PRODUCTION bundle-t tölt be
    // (tests/e2e/storage-access.spec.ts, „CMP never loads" eset).
    clearCkyConsent();
    resetStorageReadBlocked();
    expect(getStoredData()).not.toBeNull();
    expect(getStorageReadBlocked().blocked).toBe(false);
  });

  it('kulcsokat jelent, sosem értékeket', () => {
    getStoredData();
    for (const k of getStorageReadBlocked().keys) {
      expect(k).not.toContain('G-123');
      expect(k).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });

  it('kumulatív az oldalletöltésen: a késői grant nem törli a korábbi blokkot', () => {
    getStoredData();
    setCkyConsent({ analytics: true, marketing: true });
    getStoredData();
    expect(getStorageReadBlocked().blocked).toBe(true);
  });
});

describe('purge visszavonáskor', () => {
  it('purgeMarketingStorage törli a marketing kulcsokat és a Meta sütiket', () => {
    seedStoredData();
    setCookie('_fbp', 'fb.1.100.200');
    setCookie('_fbc', 'fb.1.100.CLICK');
    expect(localStorage.getItem('sb_tracking')).not.toBeNull();

    purgeMarketingStorage();

    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
    expect(document.cookie).not.toContain('_fbp=fb.1.100.200');
    expect(document.cookie).not.toContain('_fbc=fb.1.100.CLICK');
  });

  it('purgeMarketingStorage NEM bántja az analytics session-t', () => {
    setCkyConsent({ analytics: true, marketing: true });
    const id = getSessionId();
    purgeMarketingStorage();
    expect(sessionStorage.getItem('sb_session')).not.toBeNull();
    expect(getSessionId()).toBe(id);
  });

  it('purgeAnalyticsStorage törli a session-t (storage + memória)', () => {
    setCkyConsent({ analytics: true, marketing: true });
    const first = getSession().id;
    purgeAnalyticsStorage();
    expect(sessionStorage.getItem('sb_session')).toBeNull();
    // Új session indul — a memória-példány sem élte túl.
    expect(getSession().id).not.toBe(first);
  });

  it('purgeAnalyticsStorage NEM bántja a marketing kulcsokat', () => {
    seedStoredData();
    purgeAnalyticsStorage();
    expect(localStorage.getItem('sb_tracking')).not.toBeNull();
  });

  it('clearTrackingData viselkedése változatlan (localStorage + session, sütik NEM)', () => {
    seedStoredData();
    setCookie('_fbp', 'fb.1.100.200');
    getSessionId();
    clearTrackingData();
    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
    expect(sessionStorage.getItem('sb_session')).toBeNull();
    // A legacy helper SOHA nem törölt sütit — a consent-visszavonás útja a
    // purgeMarketingStorage, ami igen.
    expect(document.cookie).toContain('_fbp=fb.1.100.200');
  });
});
