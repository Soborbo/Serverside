/**
 * Consent Management — CookieYes
 *
 * ┌─────────────────────┬────────────────────────────────────────────┐
 * │ Consent state       │ What is allowed                           │
 * ├─────────────────────┼────────────────────────────────────────────┤
 * │ No consent          │ NOTHING. No storage, no events, no beacon │
 * │ Analytics           │ GA4 events (scroll, steps, abandon)       │
 * │ Marketing           │ Meta, Google Ads, localStorage, PII       │
 * └─────────────────────┴────────────────────────────────────────────┘
 *
 * Every tracking function checks consent before doing anything.
 * If no CMP is detected in production → deny all (safe default).
 * Dev mode → allow all for testing convenience.
 */

// CookieYes `getCkyConsent().categories` real key set — verified against the
// official API docs (https://www.cookieyes.com/documentation/retrieving-consent-data-using-api-getckyconsent/).
// There is NO `marketing` category: the ads/marketing category is `advertisement`
// (same key the cookie parser in gateway.ts uses). Do NOT rename `advertisement`
// back to `marketing` — that reads `undefined` and silently kills every
// marketing-gated leg in production.
declare global {
  interface Window {
    getCkyConsent?: () => {
      categories: {
        necessary: boolean;
        functional: boolean;
        analytics: boolean;
        performance: boolean;
        advertisement: boolean;
      };
    };
  }
}

import { isSboConsentProvider, trackingConfig } from './config';
import { readSboConsent, SBO_CONSENT_EVENT } from './consent-sbo-state';
import { report } from './observability';

export type ConsentCategory = 'necessary' | 'functional' | 'analytics' | 'performance' | 'advertisement';

function getCookieYesConsent(): Record<ConsentCategory, boolean> | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.getCkyConsent !== 'function') return null;
  try { return window.getCkyConsent().categories; }
  catch { return null; }
}

/**
 * CMP Fázis 2 — provider-elágazás. `provider='sbo'` alatt a consent-kapuk a
 * SAJÁT `sbo_consent` sütiből olvasnak, SZINKRONBAN (consent-sbo-state.ts) —
 * betöltési verseny nincs, mert nincs mire várni. A CookieYes-út (minden mai
 * site defaultja) BITRE változatlan. A sbo-állapot ugyanabba a kategória-alakba
 * fordul, amit a CookieYes-hívók ismernek: analytics → analytics,
 * marketing → advertisement (a functional/performance nálunk nem létező
 * kategória → false).
 */
function getSboConsentAsCategories(): Record<ConsentCategory, boolean> | null {
  // KAPUZÓ olvasás: a policy-verzió eltérése = nincs érvényes döntés.
  const s = readSboConsent(trackingConfig.policyVersion);
  if (!s) return null;
  return {
    necessary: true,
    functional: false,
    analytics: s.analytics,
    performance: false,
    advertisement: s.marketing
  };
}

function getProviderConsent(): Record<ConsentCategory, boolean> | null {
  return isSboConsentProvider() ? getSboConsentAsCategories() : getCookieYesConsent();
}

/**
 * A CookieYes JS API NYERS olvasata — `null`, ha az API még nem elérhető
 * (a szkript nem töltött be, vagy dobott).
 *
 * TELEMETRIA-CÉLÚ, additív export (Fázis D). A `hasMarketingConsent()` /
 * `hasAnalyticsConsent()` viselkedése VÁLTOZATLAN: azok az API hiányában
 * `isDevMode()`-ot adnak (prod-ban deny-all) — épp ez a fedés az, ami a
 * betöltési verseny hipotézisét megkülönböztethetetlenné teszi egy valódi
 * elutasítástól. Ez a függvény ezért NEM helyettesíti a hiányzó API-t semmivel:
 * a `null` maga a mérendő jel.
 */
export function readCookieYesApiConsentRaw(): Record<ConsentCategory, boolean> | null {
  return getCookieYesConsent();
}

function isDevMode(): boolean {
  try { return typeof import.meta !== 'undefined' && !!import.meta.env?.DEV; }
  catch { return false; }
}

/**
 * INV-008 — ISMERETLEN consent esetén mit teszünk.
 *
 * A válasz: FAIL-CLOSED (deny), hacsak a site EXPLICIT nem kérte a
 * dev-kényelmet (`PUBLIC_TRACKING_DEV_CONSENT_ALLOW=1`) ÉS tényleg dev-buildben
 * vagyunk. Korábban a puszta `import.meta.env.DEV` elég volt — prodban az is
 * deny-t adott, de az implicit „ismeretlen → engedd" szemantika pont az a
 * hibaosztály, amit a Fázis D vizsgált: egy elrontott build-flag mellett
 * csendben éles is lehetne.
 *
 * Az engedés SOHA nem néma: minden ilyen döntés TRK-4003-at jelent.
 */
function allowOnUnknownConsent(category: 'analytics' | 'marketing'): boolean {
  const allow = isDevMode() && trackingConfig.devConsentAllow;
  if (allow) report('CONSENT_DEV_FALLBACK_ALLOW', { category });
  return allow;
}

export function hasMarketingConsent(): boolean {
  const c = getProviderConsent();
  if (!c) return allowOnUnknownConsent('marketing');
  // Ads/marketing category in CookieYes is `advertisement`, NOT `marketing`.
  return c.advertisement === true;
}

export function hasAnalyticsConsent(): boolean {
  const c = getProviderConsent();
  if (!c) return allowOnUnknownConsent('analytics');
  return c.analytics === true;
}

/** Any non-essential tracking allowed? */
export function hasAnyConsent(): boolean {
  return hasAnalyticsConsent() || hasMarketingConsent();
}

/** A provider-helyes change-event neve. */
function consentUpdateEventName(): string {
  return isSboConsentProvider() ? SBO_CONSENT_EVENT : 'cookieyes_consent_update';
}

export function onConsentChange(
  callback: (consent: Record<ConsentCategory, boolean>) => void,
): void {
  document.addEventListener(consentUpdateEventName(), () => {
    const c = getProviderConsent();
    if (c) callback(c);
  });
}

export function waitForConsent(
  category: ConsentCategory,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const eventName = consentUpdateEventName();
    const c = getProviderConsent();
    if (c?.[category]) { resolve(true); return; }
    const handler = () => {
      if (getProviderConsent()?.[category]) {
        document.removeEventListener(eventName, handler);
        resolve(true);
      }
    };
    document.addEventListener(eventName, handler);
    setTimeout(() => {
      document.removeEventListener(eventName, handler);
      resolve(false);
    }, timeoutMs);
  });
}
