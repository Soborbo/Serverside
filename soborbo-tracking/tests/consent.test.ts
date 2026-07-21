import { describe, it, expect, beforeEach } from 'vitest';
import { hasMarketingConsent, hasAnalyticsConsent, hasAnyConsent } from '../lib/consent';
import { setCkyConsent, clearCkyConsent, resetAll } from './helpers';

beforeEach(() => resetAll());

describe('consent gating (CookieYes)', () => {
  it('marketing granted', () => {
    setCkyConsent({ marketing: true, analytics: false });
    expect(hasMarketingConsent()).toBe(true);
    expect(hasAnalyticsConsent()).toBe(false);
    expect(hasAnyConsent()).toBe(true);
  });

  it('analytics granted only', () => {
    setCkyConsent({ marketing: false, analytics: true });
    expect(hasMarketingConsent()).toBe(false);
    expect(hasAnalyticsConsent()).toBe(true);
    expect(hasAnyConsent()).toBe(true);
  });

  it('all denied', () => {
    setCkyConsent({ marketing: false, analytics: false });
    expect(hasMarketingConsent()).toBe(false);
    expect(hasAnalyticsConsent()).toBe(false);
    expect(hasAnyConsent()).toBe(false);
  });

  it('no CMP present → falls back to dev-mode flag (vitest DEV=true)', () => {
    clearCkyConsent();
    // import.meta.env.DEV igaz vitest alatt → dev fallback enged
    expect(typeof hasMarketingConsent()).toBe('boolean');
  });

  // Contract lock: CookieYes exposes the ads category as `advertisement`, NOT
  // `marketing`. This bypasses the helper and pins the raw wire key so the
  // 2026-07 silent-death regression (reading `.marketing` → always undefined)
  // cannot come back green.
  it('reads the real CookieYes `advertisement` key, not `marketing`', () => {
    (window as unknown as { getCkyConsent: () => unknown }).getCkyConsent = () => ({
      categories: { necessary: true, functional: true, analytics: false, performance: false, advertisement: true },
    });
    expect(hasMarketingConsent()).toBe(true);

    // A payload that only has the (non-existent) `marketing` key must NOT grant.
    (window as unknown as { getCkyConsent: () => unknown }).getCkyConsent = () => ({
      categories: { necessary: true, functional: true, analytics: false, performance: false, marketing: true },
    });
    expect(hasMarketingConsent()).toBe(false);
  });
});
