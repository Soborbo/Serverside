// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initTracking,
  captureUrlParams,
  persistTrackingParams,
  getStoredData,
  getAttribution,
  collectAttribution,
} from '../lib/index';
import { pushLeadConversion } from '../lib/events';

/**
 * The leadgen-template attribution findings (K1–K7, leadgen-template-site
 * docs/kit-handoff.md), pinned in the kit itself from 6.18.0.
 *
 * - plain `it(...)` = the rule, fixed in 6.18.0 or correct before it.
 * - `it.fails(...)` = a finding NOT decided yet (K1 cross-vendor click ids):
 *   the body asserts what the handoff asked for; flip it once decided.
 *
 * Every visit is simulated the way the kit runs on a real page load:
 * set the URL → `captureUrlParams()` → `persistTrackingParams()` (which is what
 * `initTracking()` does when marketing consent is already granted).
 */

type Cky = { necessary: boolean; functional: boolean; analytics: boolean; performance: boolean; advertisement: boolean };

function setConsent(marketing: boolean, analytics = marketing): void {
  (window as unknown as { getCkyConsent: () => { categories: Cky } }).getCkyConsent = () => ({
    categories: { necessary: true, functional: false, analytics, performance: false, advertisement: marketing },
  });
}

function noCmp(): void {
  delete (window as unknown as { getCkyConsent?: unknown }).getCkyConsent;
}

/** One page load at `url` with the kit's load-time sequence. */
function visit(url: string): void {
  window.history.replaceState({}, '', url);
  captureUrlParams();
  persistTrackingParams();
}

function tracking(): Record<string, unknown> | null {
  const raw = localStorage.getItem('sb_tracking');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function firstTouch(): Record<string, unknown> | null {
  const raw = localStorage.getItem('sb_first_touch');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

const UTM_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
] as const;

function utms(o: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of UTM_KEYS) if (o?.[k] !== undefined) out[k] = o[k];
  return out;
}

const VISIT_1 = '/?utm_source=google&utm_medium=cpc&utm_campaign=koltozes&utm_term=bristol&utm_content=A';
const VISIT_2 = '/second-landing/?utm_source=facebook&utm_campaign=uj_kampany';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
  delete (window as unknown as { __trackingConsent?: unknown }).__trackingConsent;
  setConsent(true);
  window.history.replaceState({}, '', '/');
  captureUrlParams(); // reset the kit's in-memory capture between tests
});

// ── K1 — campaign fields from two different clicks are merged ────────────────

describe('K1 — a new campaign replaces the whole UTM group (persistence.ts persistTrackingParams)', () => {
  it('K1: fresh UTMs replace the stored UTM group, missing fields are cleared', () => {
    visit(VISIT_1);
    visit(VISIT_2);
    expect(utms(tracking())).toEqual({ utm_source: 'facebook', utm_campaign: 'uj_kampany' });
  });

  it('K1: getAttribution().last_* reflects only the second click', () => {
    visit(VISIT_1);
    visit(VISIT_2);
    const a = getAttribution();
    expect(a.last_utm_term).toBeUndefined();
    expect(a.last_utm_content).toBeUndefined();
    expect(a.last_utm_medium).toBeUndefined();
  });

  it('K1: the extended UTMs are part of the replaced group', () => {
    visit('/?utm_source=google&utm_campaign=a&utm_id=123&utm_marketing_tactic=prospecting');
    visit('/?utm_source=newsletter&utm_campaign=b');
    expect(utms(tracking())).toEqual({ utm_source: 'newsletter', utm_campaign: 'b' });
  });

  it('documents current behaviour: an old fbclid (+ fbclidAt) survives a fresh Google click', () => {
    visit('/?fbclid=FB_OLD&utm_source=facebook&utm_medium=paid_social');
    visit('/?gclid=G_NEW&utm_source=google&utm_medium=cpc');
    const t = tracking();
    expect(t?.gclid).toBe('G_NEW');
    expect(t?.fbclid).toBe('FB_OLD');
    expect(typeof t?.fbclidAt).toBe('number');
  });

  // Not decided (6.18.0): the gateway takes the Google id from `_gcl_aw` on purpose
  // (6.17.1), so clearing it here alone would split the browser and gateway copies.
  it.fails('K1: a fresh Google click clears the old fbclid', () => {
    visit('/?fbclid=FB_OLD&utm_source=facebook&utm_medium=paid_social');
    visit('/?gclid=G_NEW&utm_source=google&utm_medium=cpc');
    const t = tracking();
    expect(t?.fbclid).toBeUndefined();
    expect(t?.fbclidAt).toBeUndefined();
  });

  it.fails('K1: a fresh Meta click clears the old gclid', () => {
    visit('/?gclid=G_OLD&utm_source=google&utm_medium=cpc');
    visit('/?fbclid=FB_NEW&utm_source=facebook&utm_medium=paid_social');
    expect(tracking()?.gclid).toBeUndefined();
  });

  it('K1: the gateway copy replaces the UTM group as well', () => {
    (window as unknown as { __trackingConsent: Record<string, string> }).__trackingConsent = {
      ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', ad_storage: 'GRANTED', analytics_storage: 'GRANTED',
    };
    window.history.replaceState({}, '', VISIT_1);
    collectAttribution();
    window.history.replaceState({}, '', VISIT_2);
    const a = collectAttribution();
    expect(a.utm_term).toBeUndefined();
    expect(a.utm_content).toBeUndefined();
    expect(a.utm_medium).toBeUndefined();
  });
});

// ── Google click-id rule — must NOT regress with the K1 fix ──────────────────

describe('Google click-id mutual exclusion (google-click-id.ts applyGoogleClickId) — regression guard', () => {
  it('a fresh gbraid replaces an old gclid (no sibling left behind)', () => {
    visit('/?gclid=G_OLD&utm_source=google');
    visit('/?gbraid=GB_NEW&utm_source=google');
    const t = tracking();
    expect(t?.gbraid).toBe('GB_NEW');
    expect(t?.gclid).toBeUndefined();
    expect(t?.wbraid).toBeUndefined();
  });

  it('a fresh gclid replaces an old wbraid', () => {
    visit('/?wbraid=WB_OLD');
    visit('/?gclid=G_NEW');
    const t = tracking();
    expect(t?.gclid).toBe('G_NEW');
    expect(t?.wbraid).toBeUndefined();
  });

  it('a UTM-only revisit keeps the stored Google click id', () => {
    visit('/?gclid=G_OLD&utm_source=google');
    visit('/?utm_source=newsletter&utm_medium=email');
    expect(tracking()?.gclid).toBe('G_OLD');
  });
});

// ── K2 — click-id-only arrival ───────────────────────────────────────────────

describe('K2 — a click-id-only arrival (?gclid=… without UTMs)', () => {
  it('K2: a new ad click clears the old UTM group', () => {
    visit('/?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring');
    visit('/?gclid=G_NEW');
    expect(utms(tracking())).toEqual({});
  });
});

// ── K3 — internal navigation keeps attribution ──────────────────────────────

describe('K3 — parameter-less internal navigation does not touch attribution', () => {
  it('a page view without tracking params leaves sb_tracking byte-identical', () => {
    visit('/?gclid=G1&utm_source=google&utm_medium=cpc&utm_campaign=koltozes');
    const before = localStorage.getItem('sb_tracking');
    visit('/quote/');
    visit('/services/house-removals/?foo=bar'); // non-tracking query string
    expect(localStorage.getItem('sb_tracking')).toBe(before);
  });

  it('initTracking() on an internal page (view-transition style) keeps the stored record', () => {
    visit('/?gclid=G1&utm_source=google');
    const before = localStorage.getItem('sb_tracking');
    window.history.replaceState({}, '', '/contact/');
    initTracking();
    expect(localStorage.getItem('sb_tracking')).toBe(before);
    expect(getStoredData()?.gclid).toBe('G1');
  });
});

// ── K4 — first touch vs last touch ───────────────────────────────────────────

describe('K4 — sb_first_touch is written once; sb_tracking is last touch', () => {
  it('first touch keeps visit 1 while the tracking blob moves on', () => {
    visit(VISIT_1);
    const ft = firstTouch();
    visit(VISIT_2);
    visit('/?gclid=G3');
    expect(firstTouch()).toEqual(ft);
    expect(utms(firstTouch())).toEqual({
      utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'koltozes', utm_term: 'bristol', utm_content: 'A',
    });
    const a = getAttribution();
    expect(a.first_utm_source).toBe('google');
    expect(a.first_utm_term).toBe('bristol');
    expect(a.last_utm_source).toBeUndefined(); // the gclid-only visit 3 is a new touch (K2)
  });

  it('first touch is the first PARAMETERISED visit after consent, not the first visit', () => {
    visit('/'); // direct visit — nothing written
    expect(firstTouch()).toBeNull();
    visit('/?utm_source=google');
    expect(firstTouch()?.utm_source).toBe('google');
  });
});

// ── K5 — landingPage is first-ever, never refreshed ─────────────────────────

describe('K5 — landingPage (persistence.ts persistTrackingParams)', () => {
  it('K5: a new campaign arrival refreshes landingPage (last-touch landing)', () => {
    visit(VISIT_1);
    visit(VISIT_2);
    expect(tracking()?.landingPage).toBe('/second-landing/');
  });

  it('K5: landingPage is where the visitor landed, even when consent comes after the URL changed', () => {
    // Land with UTMs, no CMP answer yet → in-memory capture only.
    noCmp();
    window.history.replaceState({}, '', '/landing/?utm_source=google&utm_campaign=x');
    captureUrlParams();
    persistTrackingParams();
    expect(tracking()).toBeNull();
    // Same document, visitor scrolls and the URL changes (anchor / pushState),
    // then accepts — the consent-change handler calls persistTrackingParams().
    window.history.replaceState({}, '', '/landing/other-section/');
    setConsent(true);
    persistTrackingParams();
    expect(tracking()?.utm_source).toBe('google');
    expect(tracking()?.landingPage).toBe('/landing/');
  });

  // Consent-policy call, not decided in 6.18.0 (the URL is not terminal storage).
  it('documents current behaviour: pre-consent UTMs are dropped if the visitor navigates (view transition) before accepting', () => {
    noCmp();
    window.history.replaceState({}, '', '/landing/?utm_source=google&utm_campaign=x');
    initTracking(); // captures in memory, cannot persist
    window.history.replaceState({}, '', '/quote/');
    initTracking(); // astro:page-load on the next page re-captures → null
    setConsent(true);
    persistTrackingParams(); // what the consent-change handler does
    expect(tracking()).toBeNull();
  });
});

// ── Consent gates ────────────────────────────────────────────────────────────

describe('consent: accepted / declined / withdrawn', () => {
  it('declined: nothing is written to localStorage', () => {
    setConsent(false, true);
    visit(VISIT_1);
    expect(tracking()).toBeNull();
    expect(firstTouch()).toBeNull();
  });

  it('no CMP answer (fail-closed): nothing is written', () => {
    noCmp();
    visit(VISIT_1);
    expect(tracking()).toBeNull();
  });

  it('accepted after landing on the same page: the in-memory capture is persisted', () => {
    noCmp();
    visit(VISIT_1);
    expect(tracking()).toBeNull();
    setConsent(true);
    persistTrackingParams();
    expect(utms(tracking())).toMatchObject({ utm_source: 'google', utm_term: 'bristol' });
  });

  it('accepted: getters read the stored record; declined: getters read nothing', () => {
    visit(VISIT_1);
    expect(getStoredData()?.utm_source).toBe('google');
    setConsent(false);
    expect(getStoredData()).toBeNull();
    expect(getAttribution()).toEqual({});
  });

  it('withdrawn: the consent-change handler purges sb_tracking, sb_first_touch and __sb_attribution', () => {
    initTracking(); // binds the kit's single consent listener
    visit(VISIT_1);
    localStorage.setItem('__sb_attribution', '{"utm_source":"google"}');
    expect(tracking()).not.toBeNull();
    setConsent(false);
    document.dispatchEvent(new Event('cookieyes_consent_update'));
    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
    expect(localStorage.getItem('__sb_attribution')).toBeNull();
  });
});

// ── K7 — no value, no currency ──────────────────────────────────────────────

describe('K7 — a conversion without a real value carries no currency (events.ts buildConversionPayload)', () => {
  const lastPush = () => (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer.at(-1)!;

  it.each([
    ['no value', {}],
    ['a zero value', { value: 0, currency: 'GBP' }],
  ])('%s → neither value nor currency', (_label, extra) => {
    pushLeadConversion({ email: '', eventId: 'evt-k7', ...extra });
    expect('value' in lastPush()).toBe(false);
    expect('currency' in lastPush()).toBe(false);
  });

  it('a real value keeps both', () => {
    pushLeadConversion({ email: '', eventId: 'evt-k7', value: 660, currency: 'GBP' });
    expect(lastPush()).toMatchObject({ value: 660, currency: 'GBP' });
  });
});
