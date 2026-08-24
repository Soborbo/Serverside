/**
 * E2E fixture entry — a valódi lib PRODUCTION bundle-ben.
 *
 * Miért production: a package consent-kapuja `getCkyConsent()` hiányában
 * `isDevMode()`-ot ad vissza. Dev-ben ez ENGED (fejlesztői kényelem), prodban
 * DENY-ALL — és épp az utóbbi a mérendő eset: a lassan töltő CookieYes mellett
 * egy BELEEGYEZŐ látogató olvasása is elbukhat (betöltési verseny). A vitest
 * dev-módban fut, tehát azt az ágat CSAK itt lehet valósághűen tesztelni.
 */
import {
  initTracking,
  captureUrlParams,
  persistTrackingParams,
  getGclid,
  getFbclid,
  getStoredData,
  getAttribution,
  getSourceType,
  getAllTrackingData,
  getFbp,
  getFbc,
  getSessionId,
  getStorageReadBlocked,
  sendToWorker,
} from '../../../lib/index';

interface ConsentOpts { analytics: boolean; marketing: boolean }

function setCkyApi(o: ConsentOpts): void {
  (window as unknown as { getCkyConsent: () => unknown }).getCkyConsent = () => ({
    categories: {
      necessary: true,
      functional: true,
      analytics: o.analytics,
      performance: false,
      advertisement: o.marketing,
    },
  });
}

/** Scaffolding — a műszer ne naplózza a teszt saját írásait. */
function offRecord<T>(fn: () => T): T {
  const w = window as unknown as { __recording: boolean };
  const prev = w.__recording;
  w.__recording = false;
  try { return fn(); } finally { w.__recording = prev; }
}

const api = {
  /** CMP „betölt" adott állapottal, és jelez (mint a CookieYes tenné). */
  setConsent(o: ConsentOpts): void {
    offRecord(() => {
      setCkyApi(o);
      document.cookie =
        `cookieyes-consent=consent:yes,necessary:yes,functional:yes,` +
        `analytics:${o.analytics ? 'yes' : 'no'},advertisement:${o.marketing ? 'yes' : 'no'};path=/`;
    });
    document.dispatchEvent(new Event('cookieyes_consent_update'));
  },
  /** A CMP soha nem tölt be (a betöltési verseny szélső esete). */
  noCmp(): void {
    delete (window as unknown as { getCkyConsent?: unknown }).getCkyConsent;
  },
  initTracking,
  captureUrlParams,
  persistTrackingParams,
  /** Amit egy konverzió pillanatában a lib kiolvasna. */
  readAll(): Record<string, unknown> {
    return {
      gclid: getGclid(),
      fbclid: getFbclid(),
      stored: getStoredData(),
      attribution: getAttribution(),
      sourceType: getSourceType(),
      all: getAllTrackingData(),
      fbp: getFbp(),
      fbc: getFbc(),
      blocked: getStorageReadBlocked(),
    };
  },
  session: () => getSessionId(),
  blocked: () => getStorageReadBlocked(),
  send: () =>
    sendToWorker({
      event_name: 'phone_number_clicked',
      event_id: `e2e-${Date.now()}`,
      event_time: Math.floor(Date.now() / 1000),
    }),
  /** Nyers storage-állapot, a műszer megkerülésével (assertekhez). */
  raw: () =>
    offRecord(() => ({
      sb_tracking: localStorage.getItem('sb_tracking'),
      sb_first_touch: localStorage.getItem('sb_first_touch'),
      sb_session: sessionStorage.getItem('sb_session'),
      cookie: document.cookie,
    })),
  /** Meta-süti szimulálása (a Pixel írná). */
  seedMetaCookies: () =>
    offRecord(() => {
      document.cookie = '_fbp=fb.1.100.200;path=/';
      document.cookie = '_fbc=fb.1.100.CLICK;path=/';
    }),
  access: () => (window as unknown as { __access: unknown }).__access,
  resetAccess: (): void => {
    (window as unknown as { __access: Record<string, unknown> }).__access = {
      ls: [], ss: [], cookieGet: 0, cookieSet: [],
    };
  },
};

(window as unknown as { __t: typeof api }).__t = api;
(window as unknown as { __ready: boolean }).__ready = true;
