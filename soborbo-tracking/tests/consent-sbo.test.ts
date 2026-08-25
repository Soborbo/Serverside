/**
 * CMP Fázis 2 — a saját consent-modul kliens-tesztjei.
 *
 * Amit a brief elfogadási kritériumként nevesít, itt bizonyítjuk:
 *  - provider='cookieyes' (default) mellett a viselkedés bitre a mai
 *  - a döntés a sütiben él, SZINKRON olvasható, revision monoton nő
 *  - 503/network után a pending receipt a TELJES döntést őrzi, és UGYANAZZAL a
 *    consent_event_id-vel megy újra
 *  - visszavonáskor a purge kategóriánként fut (#61 függvényei)
 *  - a párhuzamos ablak (2.4) a CookieYes sütijét jelenti, nem találja ki
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSboConsentCookie,
  encodeSboConsentCookie,
  readSboConsent,
  sboConsentAgeSeconds,
  SBO_CONSENT_EVENT,
  type SboConsentState
} from '../lib/consent-sbo-state';
import {
  applySboDecision,
  flushPendingSboConsent,
  readCkyParallelWindow
} from '../lib/consent-sbo';
import { hasMarketingConsent, hasAnalyticsConsent } from '../lib/consent';
import { trackingConfig } from '../lib/config';
import { resetAll, setCkyConsent, setCookie } from './helpers';

const CTX = { bannerVersion: '2026-08-a', consentTextVersion: '2026-08-a' };

function mockFetch(status: number): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ status, ok: status < 400 }) as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A void POST-ok microtask-jainak leengedése. */
const flushAsync = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetAll();
  trackingConfig.consentProvider = 'sbo';
});

afterEach(() => {
  trackingConfig.consentProvider = 'cookieyes';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A döntés-időbélyeg SZÁNDÉKOSAN friss: a v2-es süti-parse élesített LEJÁRAT-
 * ellenőrzést tartalmaz (180 nap), tehát egy fix, régi konstans időbélyeg
 * MINDEN ilyen fixture-t érvénytelenné tenne — és a teszt nem azt mérné, amit
 * hisz róla. A `POLICY` a tesztkörnyezet tényleges policy-verziója.
 */
const freshSec = () => Math.floor(Date.now() / 1000) - 60;
const POLICY = trackingConfig.policyVersion;

describe('sbo_consent süti-codec', () => {
  const state: SboConsentState = {
    analytics: true,
    marketing: false,
    revision: 3,
    decision: 'custom',
    consentId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    decidedAtSec: freshSec(),
    policyVersion: POLICY
  };

  it('roundtrip: encode → parse azonos állapotot ad', () => {
    expect(parseSboConsentCookie(encodeSboConsentCookie(state))).toEqual(state);
  });

  const ts = () => String(freshSec());
  it.each([
    ['ismeretlen verzió (v3)', () => `v3.1.0.3.custom.a1b2c3d4-e5f6.${ts()}.${POLICY}`],
    ['RÉGI v1-es süti — a formátumváltás után nincs döntés', () => `v1.1.0.3.custom.a1b2c3d4-e5f6.${ts()}`],
    ['hiányzó mező', () => `v2.1.0.3.custom.a1b2c3d4-e5f6.${ts()}`],
    ['ismeretlen decision', () => `v2.1.0.3.maybe.a1b2c3d4-e5f6.${ts()}.${POLICY}`],
    ['decision↔kategória ellentmondás (accept_all, de marketing=0)', () => `v2.1.0.3.accept_all.a1b2c3d4-e5f6.${ts()}.${POLICY}`],
    ['revision=0', () => `v2.1.0.0.custom.a1b2c3d4-e5f6.${ts()}.${POLICY}`],
    ['nem-numerikus revision', () => `v2.1.0.x.custom.a1b2c3d4-e5f6.${ts()}.${POLICY}`],
    ['rövid consent_id', () => `v2.1.0.3.custom.abc.${ts()}.${POLICY}`],
    ['üres policy-verzió', () => `v2.1.0.3.custom.a1b2c3d4-e5f6.${ts()}.`],
    ['üres', () => ''],
  ])('szigorú parse: %s → null (banner újra)', (_label, raw) => {
    expect(parseSboConsentCookie(raw())).toBeNull();
  });

  it('readSboConsent a document.cookie-ból olvas, szinkron', () => {
    expect(readSboConsent()).toBeNull();
    setCookie('sbo_consent', encodeSboConsentCookie(state));
    expect(readSboConsent()).toEqual(state);
  });

  it('sboConsentAgeSeconds a döntés korát adja', () => {
    const s = { ...state, decidedAtSec: Math.floor(Date.now() / 1000) - 120 };
    const age = sboConsentAgeSeconds(s);
    expect(age).toBeGreaterThanOrEqual(119);
    expect(age).toBeLessThanOrEqual(122);
    expect(sboConsentAgeSeconds(null)).toBeUndefined();
  });
});

describe('provider-elágazás — a cookieyes-út bitre változatlan', () => {
  it("provider='cookieyes': a kapuk a CookieYes API-ból döntenek, az sbo süti nem számít", () => {
    trackingConfig.consentProvider = 'cookieyes';
    setCookie(
      'sbo_consent',
      encodeSboConsentCookie({
        analytics: true, marketing: true, revision: 1,
        decision: 'accept_all', consentId: 'a1b2c3d4-e5f6', decidedAtSec: freshSec(), policyVersion: POLICY
      })
    );
    setCkyConsent({ analytics: false, marketing: false });
    expect(hasAnalyticsConsent()).toBe(false);
    expect(hasMarketingConsent()).toBe(false);
  });

  it("provider='sbo': a kapuk a saját sütiből döntenek, a CookieYes olvasata nem számít", () => {
    // A CookieYes mindent engedne — de sbo alatt már nem ő a forrás: a saját
    // süti reject_all-ja dönt. (A döntés-NÉLKÜLI eset dev-módban allow-all —
    // ugyanaz a dev-kényelem, mint a hiányzó CookieYes API-nál; prodban deny.)
    setCkyConsent({ analytics: true, marketing: true });
    setCookie(
      'sbo_consent',
      encodeSboConsentCookie({
        analytics: false, marketing: false, revision: 1,
        decision: 'reject_all', consentId: 'a1b2c3d4-e5f6', decidedAtSec: freshSec(), policyVersion: POLICY
      })
    );
    expect(hasAnalyticsConsent()).toBe(false);
    expect(hasMarketingConsent()).toBe(false);

    // És fordítva: sbo custom (csak analytics) a CookieYes deny-a mellett.
    setCookie(
      'sbo_consent',
      encodeSboConsentCookie({
        analytics: true, marketing: false, revision: 2,
        decision: 'custom', consentId: 'a1b2c3d4-e5f6', decidedAtSec: freshSec(), policyVersion: POLICY
      })
    );
    setCkyConsent({ analytics: false, marketing: false });
    expect(hasAnalyticsConsent()).toBe(true);
    expect(hasMarketingConsent()).toBe(false);
  });
});

describe('applySboDecision — döntés, revision, purge, POST', () => {
  it('első döntés: revision=1, stabil consent_id, süti írva, POST elmegy', async () => {
    const fetchMock = mockFetch(204);
    const s1 = applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();

    expect(s1.revision).toBe(1);
    expect(s1.decision).toBe('accept_all');
    expect(readSboConsent()).toEqual(s1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/consent');
    const body = JSON.parse(String(init.body));
    expect(body.consent_id).toBe(s1.consentId);
    expect(body.revision).toBe(1);
    expect(body.decision).toBe('accept_all');
    expect(body.cat_analytics).toBe(true);
    expect(body.cat_marketing).toBe(true);
    // A négy verziómező KÖTELEZŐ (a szerver 400-at adna nélkülük).
    expect(body.policy_version).toBeTruthy();
    expect(body.banner_version).toBe('2026-08-a');
    expect(body.consent_text_version).toBe('2026-08-a');
    expect(body.ruleset).toBeTruthy();
    expect(Date.parse(body.client_decided_at)).not.toBeNaN();
    // 204 → a pending sor kiürült.
    expect(localStorage.getItem('sbo_consent_pending')).toBeNull();
  });

  it('a döntés-lánc: accept → withdraw ugyanazon consent_id-n, monoton revision, withdrawn decision', async () => {
    mockFetch(204);
    const s1 = applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    const s2 = applySboDecision({ analytics: false, marketing: false }, CTX);
    await flushAsync();

    expect(s2.consentId).toBe(s1.consentId);
    expect(s2.revision).toBe(2);
    expect(s2.decision).toBe('withdrawn');
  });

  it('első "mindent ki" döntés reject_all, NEM withdrawn', async () => {
    mockFetch(204);
    const s = applySboDecision({ analytics: false, marketing: false }, CTX);
    expect(s.decision).toBe('reject_all');
    await flushAsync();
  });

  it('marketing-visszavonás purge-öli a marketing-storage-ot, az analytics-ot békén hagyja', async () => {
    mockFetch(204);
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    localStorage.setItem('sb_tracking', JSON.stringify({ gclid: 'x', timestamp: Date.now(), landingPage: '/' }));
    localStorage.setItem('sb_first_touch', '{"gclid":"x"}');
    sessionStorage.setItem('sb_session', '{"id":"s","lastActivity":1}');

    applySboDecision({ analytics: true, marketing: false }, CTX);
    await flushAsync();

    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
    // Analytics maradt engedve → a session él.
    expect(sessionStorage.getItem('sb_session')).not.toBeNull();
  });

  it('sbo_consent_update esemény tüzel a döntéskor', async () => {
    mockFetch(204);
    const seen: unknown[] = [];
    document.addEventListener(SBO_CONSENT_EVENT, (e) => seen.push((e as CustomEvent).detail));
    applySboDecision({ analytics: true, marketing: false }, CTX);
    await flushAsync();
    expect(seen).toHaveLength(1);
    expect((seen[0] as SboConsentState).decision).toBe('custom');
  });
});

describe('pending receipt — 503 után a kliens az egyetlen őrző', () => {
  it('503 → a TELJES payload pendingben marad, és flush UGYANAZZAL a consent_event_id-vel küldi újra', async () => {
    const failing = mockFetch(503);
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    expect(failing).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(String((failing.mock.calls[0] as [string, RequestInit])[1].body));

    // A pending a teljes újraküldhető döntést őrzi.
    const pending = JSON.parse(localStorage.getItem('sbo_consent_pending')!);
    expect(pending).toHaveLength(1);
    expect(pending[0].consent_event_id).toBe(firstBody.consent_event_id);
    expect(pending[0].decision).toBe('accept_all');
    expect(pending[0].revision).toBe(1);
    expect(pending[0].banner_version).toBe('2026-08-a');
    expect(pending[0].client_decided_at).toBe(firstBody.client_decided_at);

    // Következő oldalletöltés: flush — most 204.
    const ok = mockFetch(204);
    await flushPendingSboConsent();
    expect(ok).toHaveBeenCalledTimes(1);
    const retryBody = JSON.parse(String((ok.mock.calls[0] as [string, RequestInit])[1].body));
    expect(retryBody.consent_event_id).toBe(firstBody.consent_event_id);
    expect(localStorage.getItem('sbo_consent_pending')).toBeNull();
  });

  it('4xx (nem 429) → a példány kikerül a sorból (a determinisztikus hibát nem ismételjük vakon)', async () => {
    mockFetch(400);
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    expect(localStorage.getItem('sbo_consent_pending')).toBeNull();
  });

  it('network-hiba → retryable, a pending marad', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    expect(JSON.parse(localStorage.getItem('sbo_consent_pending')!)).toHaveLength(1);
  });
});

describe('párhuzamos mérési ablak (2.4)', () => {
  it('a CookieYes sütijét jelenti; hiányzó kulcs undefined marad (nem hamis false)', () => {
    setCookie('cookieyes-consent', 'consentid:abc,consent:yes,analytics:yes,advertisement:no');
    expect(readCkyParallelWindow()).toEqual({
      cky_cookie_analytics: true,
      cky_cookie_marketing: false
    });
  });

  it('nincs CookieYes süti → üres objektum (a mezők ki sem mennek)', () => {
    expect(readCkyParallelWindow()).toEqual({});
  });

  it('a döntés-payload hordozza a cky mezőket, ha a süti jelen van', async () => {
    const fetchMock = mockFetch(204);
    setCookie('cookieyes-consent', 'consentid:abc,analytics:no,advertisement:no');
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.cky_cookie_analytics).toBe(false);
    expect(body.cky_cookie_marketing).toBe(false);
  });
});
