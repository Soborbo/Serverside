import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeEmail, normalizePhone, sanitizeName,
  captureUrlParams, persistTrackingParams, getAttribution, getSourceType,
  getStoredData, getGclid, getFbclid, getFbc, getFbp, getDevice,
} from '../lib/persistence';
import { setCkyConsent, setUrl, setCookie, resetAll } from './helpers';

beforeEach(() => {
  resetAll();
  setCkyConsent({ analytics: true, marketing: true });
});

describe('normalizeEmail', () => {
  it('lowercases + trims', () => {
    expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com');
  });
  /**
   * VISELKEDÉS-VÁLTOZÁS (6.6.0). Korábban 254 karakternél CSONKÍTOTT — ami egy
   * mesterségesen MÁS címet állított elő, mint amit a Worker `hash.ts`
   * ugyanabból a bemenetből hashelt. 254 oktet fölött a cím érvénytelen
   * (RFC 5321), ezért eldobjuk. A parity-bizonyíték:
   * `tests/email-identity-parity.test.ts`.
   */
  it('254 oktet fölött ELDOB, nem csonkít', () => {
    expect(normalizeEmail('a'.repeat(300) + '@x.com')).toBeUndefined();
  });
  it('nem e-mail (nincs @) → undefined', () => {
    expect(normalizeEmail('not-an-email')).toBeUndefined();
  });
});

describe('normalizePhone — bilingual UK + HU', () => {
  it('UK 07… → +447… (auto-detect, regardless of config)', () => {
    expect(normalizePhone('07123 456789')).toBe('+447123456789');
  });
  it('HU 06… → +36… (auto-detect, regardless of config)', () => {
    expect(normalizePhone('06 20 123 4567')).toBe('+36201234567');
  });
  it('HU 06 landline (10-jegyű) → strip 06, egyezik a szerverrel (nem +36 6…)', () => {
    // Regresszió: a 10-jegyű 06-os vezetékes a `06 && length===11` gyorsútból
    // kiesett, és korábban csak a `0`-t vágta → +36612345678 (plusz 6), eltérve a
    // szerver hash.ts +3612345678-tól → néma EC/CAPI hash-divergencia.
    expect(normalizePhone('06 1 234 5678', 'HU')).toBe('+3612345678');
  });
  it('keeps already-international (+)', () => {
    expect(normalizePhone('+44 7123 456789')).toBe('+447123456789');
    expect(normalizePhone('+36 20 123 4567')).toBe('+36201234567');
  });
  it('ambiguous bare number uses the configured country', () => {
    // HU site
    expect(normalizePhone('20 123 4567', 'HU')).toBe('+36201234567');
    // UK site
    expect(normalizePhone('7123 456789', 'GB')).toBe('+447123456789');
  });
  it('caps length at 20', () => {
    expect(normalizePhone('0'.repeat(40)).length).toBeLessThanOrEqual(20);
  });
});

describe('sanitizeName', () => {
  it('trims and caps at 100', () => {
    expect(sanitizeName('  John  ')).toBe('John');
    expect(sanitizeName('x'.repeat(200)).length).toBe(100);
  });
});

describe('attribution — first/last touch + source type', () => {
  it('captures and persists URL params after marketing consent', () => {
    setUrl('/lp?gclid=ABC123&utm_source=google&utm_medium=cpc&utm_campaign=brand');
    captureUrlParams();
    persistTrackingParams();
    const s = getStoredData();
    expect(s?.gclid).toBe('ABC123');
    expect(s?.utm_source).toBe('google');
    expect(getSourceType()).toBe('paid');
  });

  it('first touch is NOT overwritten, last touch IS updated', () => {
    setUrl('/?utm_source=google&gclid=G1');
    captureUrlParams(); persistTrackingParams();
    setUrl('/?utm_source=bing');
    captureUrlParams(); persistTrackingParams();
    const a = getAttribution();
    expect(a.first_utm_source).toBe('google');
    expect(a.first_gclid).toBe('G1');
    expect(a.last_utm_source).toBe('bing');
  });

  it('does NOT persist without marketing consent', () => {
    setCkyConsent({ analytics: true, marketing: false });
    setUrl('/?gclid=NOPE');
    captureUrlParams(); persistTrackingParams();
    expect(getStoredData()).toBeNull();
  });

  it('source type: fbclid → social, organic medium → organic, bare utm_source → referral, none → direct', () => {
    setUrl('/?fbclid=FB1'); captureUrlParams(); persistTrackingParams();
    expect(getSourceType()).toBe('social');
    resetAll(); setCkyConsent({ marketing: true, analytics: true });
    setUrl('/?utm_source=newsletter&utm_medium=organic'); captureUrlParams(); persistTrackingParams();
    expect(getSourceType()).toBe('organic');
    resetAll(); setCkyConsent({ marketing: true, analytics: true });
    // A cim eddig igerte a catch-all-t, de a teszt SOSEM allitotta — ez a sor
    // koti le a szandekos viselkedest: megcimkezett, be nem sorolhato latogato
    // `referral`, nem `direct`.
    setUrl('/?utm_source=partnersite'); captureUrlParams(); persistTrackingParams();
    expect(getSourceType()).toBe('referral');
    resetAll(); setCkyConsent({ marketing: true, analytics: true });
    expect(getSourceType()).toBe('direct');
  });

  it('a medium-tabla a valos irasmodokat is felismeri — nem esnek a catch-all-ba', () => {
    const cases: Array<[string, string]> = [
      ['cpm', 'paid'],
      ['display', 'paid'],
      ['Paid_Social', 'paid'],
      ['e-mail', 'email'],
      ['newsletter', 'email'],
      ['social_media', 'social'],
      ['affiliate', 'referral'],
    ];
    for (const [medium, expected] of cases) {
      resetAll(); setCkyConsent({ marketing: true, analytics: true });
      setUrl(`/?utm_source=x&utm_medium=${medium}`);
      captureUrlParams(); persistTrackingParams();
      expect(getSourceType(), `utm_medium=${medium}`).toBe(expected);
    }
  });

  it('first touch a kulcsszot es a kreativot is megorzi', () => {
    setUrl('/?utm_source=google&utm_medium=cpc&utm_term=bristol+removals&utm_content=ad_v2');
    captureUrlParams(); persistTrackingParams();
    setUrl('/?utm_source=bing&utm_term=later&utm_content=later_ad');
    captureUrlParams(); persistTrackingParams();
    const a = getAttribution();
    expect(a.first_utm_term).toBe('bristol removals');
    expect(a.first_utm_content).toBe('ad_v2');
    expect(a.last_utm_term).toBe('later');
    expect(a.last_utm_content).toBe('later_ad');
  });
});

describe('getGclid / getFbclid — URL wins over storage', () => {
  it('reads from URL', () => {
    setUrl('/?gclid=URLG&fbclid=URLF');
    expect(getGclid()).toBe('URLG');
    expect(getFbclid()).toBe('URLF');
  });
});

describe('getFbc — cookie wins, else reconstruct', () => {
  it('returns the Pixel _fbc cookie when present', () => {
    setCookie('_fbc', 'fb.1.123.COOKIEVAL');
    expect(getFbc()).toBe('fb.1.123.COOKIEVAL');
  });
  it('reconstructs fb.1.<ts>.<fbclid> from stored fbclid', () => {
    setUrl('/?fbclid=XYZ789'); captureUrlParams(); persistTrackingParams();
    const fbc = getFbc();
    expect(fbc).toMatch(/^fb\.1\.\d+\.XYZ789$/);
  });
  it('returns null for an illegal fbclid charset', () => {
    setUrl('/?fbclid=' + encodeURIComponent('bad value!')); captureUrlParams(); persistTrackingParams();
    expect(getFbc()).toBeNull();
  });
});

describe('getFbp', () => {
  it('reads _fbp cookie', () => {
    setCookie('_fbp', 'fb.1.1.2');
    expect(getFbp()).toBe('fb.1.1.2');
  });
  it('null when absent', () => {
    expect(getFbp()).toBeNull();
  });
});

describe('getStoredData — 90-day expiry', () => {
  it('drops expired records', () => {
    const old = { gclid: 'OLD', timestamp: Date.now() - 91 * 86_400_000, landingPage: '/' };
    localStorage.setItem('sb_tracking', JSON.stringify(old));
    expect(getStoredData()).toBeNull();
  });
});

describe('getDevice', () => {
  it('classifies by width', () => {
    expect(['mobile', 'tablet', 'desktop']).toContain(getDevice());
  });
});
