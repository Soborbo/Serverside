/**
 * Advanced Consent Mode — süti nélküli Google-pingek (konverzió- és viselkedés-
 * modellezés). Csak sbo + PUBLIC_TRACKING_CONSENT_MODE=advanced mellett:
 *  - hozzájárulás NÉLKÜL is kerül esemény a dataLayerbe, de AZONOSÍTÓK nélkül;
 *  - a lead/kapcsolat konverzió PII- és azonosító-mentesen megy, a visszatérés
 *    továbbra is consentBlocked (a teljes konverzió blokkolt);
 *  - basic módban és CookieYes alatt a viselkedés bitre a régi (semmi nem megy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setCkyConsent, clearCkyConsent } from './helpers';

type DL = Array<Record<string, unknown>>;
const dl = () => (window as unknown as { dataLayer: DL }).dataLayer ?? [];

function clearCookies(): void {
  document.cookie.split(';').forEach((c) => {
    const n = c.split('=')[0]!.trim();
    if (n) document.cookie = `${n}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
}

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  (window as unknown as { dataLayer: DL }).dataLayer = [];
  return await import('../lib/index');
}

const IDENTIFIER_KEYS = ['session_id', 'gclid', 'first_gclid', 'last_gclid', 'first_utm_source', 'last_utm_source'];

beforeEach(() => {
  clearCookies();
  localStorage.clear();
  sessionStorage.clear();
  // Egy klikk-azonosítós landolás: hozzájárulás nélkül ez SEM juthat a dataLayerbe.
  window.history.replaceState({}, '', '/?gclid=TEST-GCLID&utm_source=google&utm_medium=cpc');
});
afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
});

describe('sbo + advanced, hozzájárulás NÉLKÜL', () => {
  const ENV = { PUBLIC_TRACKING_CONSENT_PROVIDER: 'sbo', PUBLIC_TRACKING_CONSENT_MODE: 'advanced' };

  it('a kalkulátor-események kimennek, azonosító nélkül', async () => {
    const t = await load(ENV);
    expect(t.isCookielessPingAllowed()).toBe(true);
    expect(t.hasAnalyticsConsent()).toBe(false);
    t.trackCalculatorStart('quote');
    const ev = dl().find((e) => e.event === 'quote_calculator_opened');
    expect(ev).toBeDefined();
    for (const k of IDENTIFIER_KEYS) expect(ev, k).not.toHaveProperty(k);
    expect(ev).toHaveProperty('device');
  });

  it('a lead-konverzió kimegy (event_id + érték), PII és azonosító nélkül; a visszatérés blokkolt', async () => {
    const t = await load(ENV);
    const r = t.trackLeadSubmit({ email: 'a@b.hu', phone: '+36301234567', firstName: 'Anna', value: 50000, currency: 'HUF' });
    expect(r.consentBlocked).toBe(true);
    expect(r.success).toBe(false);
    const ev = dl().find((e) => e.event === 'quote_calculator_submitted')!;
    expect(ev).toBeDefined();
    expect(ev.event_id).toBe(r.eventId);
    expect(ev.value).toBe(50000);
    expect(ev.currency).toBe('HUF');
    for (const k of IDENTIFIER_KEYS) expect(ev, k).not.toHaveProperty(k);
    const json = JSON.stringify(dl());
    expect(json).not.toContain('a@b.hu');
    expect(json).not.toContain('301234567');
    expect(json).not.toContain('Anna');
    expect(json).not.toContain('TEST-GCLID');
    // Az Enhanced Conversions rejtett csatornája is üres marad.
    expect(t.getUserDataForEC()).toBeNull();
  });

  it('a kapcsolati konverzió és a telefon-klikk is kimegy, azonosító nélkül', async () => {
    const t = await load(ENV);
    t.trackContactSubmit({ email: 'a@b.hu' });
    t.trackPhoneConversion();
    const contact = dl().find((e) => e.event === 'contact_form_submitted');
    const phone = dl().find((e) => e.event === 'phone_number_clicked');
    expect(contact).toBeDefined();
    expect(phone).toBeDefined();
    for (const ev of [contact!, phone!]) for (const k of IDENTIFIER_KEYS) expect(ev, k).not.toHaveProperty(k);
    expect(JSON.stringify(dl())).not.toContain('a@b.hu');
  });

  it('semmilyen tracking-tárolás nem íródik', async () => {
    const t = await load(ENV);
    t.trackCalculatorStart('quote');
    t.trackLeadSubmit({ email: 'a@b.hu', value: 1 });
    t.trackPhoneConversion();
    const ls = Object.keys(localStorage).filter((k) => k !== 'sbo_consent_pending');
    expect(ls).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});

describe('a régi viselkedés marad', () => {
  it('sbo + basic: hozzájárulás nélkül SEMMI nem megy a dataLayerbe', async () => {
    const t = await load({ PUBLIC_TRACKING_CONSENT_PROVIDER: 'sbo', PUBLIC_TRACKING_CONSENT_MODE: 'basic' });
    expect(t.isCookielessPingAllowed()).toBe(false);
    t.trackCalculatorStart('quote');
    t.trackLeadSubmit({ email: 'a@b.hu', value: 1 });
    t.trackPhoneConversion();
    expect(dl().filter((e) => typeof e.event === 'string')).toEqual([]);
  });

  it('CookieYes + (tévesen) advanced env: a CookieYes-ág érintetlen, SEMMI nem megy', async () => {
    const t = await load({ PUBLIC_TRACKING_CONSENT_MODE: 'advanced' });
    expect(t.isCookielessPingAllowed()).toBe(false);
    t.trackCalculatorStart('quote');
    t.trackLeadSubmit({ email: 'a@b.hu', value: 1 });
    expect(dl().filter((e) => typeof e.event === 'string')).toEqual([]);
  });

  it('sbo + advanced, analytics-hozzájárulással: az azonosítók MEGMARADNAK', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_TRACKING_CONSENT_PROVIDER', 'sbo');
    vi.stubEnv('PUBLIC_TRACKING_CONSENT_MODE', 'advanced');
    vi.stubEnv('PUBLIC_TRACKING_POLICY_VERSION', 'p-test');
    const state = await import('../lib/consent-sbo-state');
    document.cookie = `sbo_consent=${state.encodeSboConsentCookie({
      analytics: true, marketing: false, revision: 1, decision: 'custom',
      consentId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      decidedAtSec: Math.floor(Date.now() / 1000), policyVersion: 'p-test',
    })}; path=/`;
    (window as unknown as { dataLayer: DL }).dataLayer = [];
    const t = await import('../lib/index');
    expect(t.hasAnalyticsConsent()).toBe(true);
    t.trackCalculatorStart('quote');
    const ev = dl().find((e) => e.event === 'quote_calculator_opened')!;
    expect(typeof ev.session_id).toBe('string');
  });
});

// 6.16.1 (Codex #140): a marketing-hozzájárulással engedett konverzió NEM a süti
// nélküli kivételen megy, ezért megtartja a gclid-et és az attribúciót — akkor
// is, ha az analytics megtagadott. A süti nélküli kivétellel engedett push-ok
// (klikk, kalkulátor) ugyanilyenkor csupaszok maradnak.
describe('marketing-hozzájárulás analytics NÉLKÜL', () => {
  async function loadSboMarketingOnly() {
    vi.resetModules();
    vi.stubEnv('PUBLIC_TRACKING_CONSENT_PROVIDER', 'sbo');
    vi.stubEnv('PUBLIC_TRACKING_CONSENT_MODE', 'advanced');
    vi.stubEnv('PUBLIC_TRACKING_POLICY_VERSION', 'p-test');
    const state = await import('../lib/consent-sbo-state');
    document.cookie = `sbo_consent=${state.encodeSboConsentCookie({
      analytics: false, marketing: true, revision: 1, decision: 'custom',
      consentId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      decidedAtSec: Math.floor(Date.now() / 1000), policyVersion: 'p-test',
    })}; path=/`;
    (window as unknown as { dataLayer: DL }).dataLayer = [];
    return await import('../lib/index');
  }

  it('sbo + advanced: a lead- és kapcsolati konverzió megtartja a gclid-et és az attribúciót', async () => {
    const t = await loadSboMarketingOnly();
    t.initTracking();
    expect(t.hasAnalyticsConsent()).toBe(false);
    expect(t.hasMarketingConsent()).toBe(true);
    const r = t.trackLeadSubmit({ email: 'a@b.hu', value: 1 });
    expect(r.success).toBe(true);
    t.trackContactSubmit({ email: 'a@b.hu' });
    for (const name of ['quote_calculator_submitted', 'contact_form_submitted']) {
      const ev = dl().find((e) => e.event === name)!;
      expect(ev, name).toBeDefined();
      expect(ev.gclid, name).toBe('TEST-GCLID');
      expect(typeof ev.session_id, name).toBe('string');
      expect(ev, name).toHaveProperty('first_utm_source');
    }
  });

  it('sbo + advanced: a süti nélküli kivétellel engedett klikk és kalkulátor-esemény csupasz marad', async () => {
    const t = await loadSboMarketingOnly();
    t.initTracking();
    t.trackCalculatorStart('quote');
    t.trackPhoneConversion();
    for (const name of ['quote_calculator_opened', 'phone_number_clicked']) {
      const ev = dl().find((e) => e.event === name)!;
      expect(ev, name).toBeDefined();
      for (const k of IDENTIFIER_KEYS) expect(ev, `${name}.${k}`).not.toHaveProperty(k);
    }
  });

  it('CookieYes: a marketing-only lead-konverzió megtartja a gclid-et', async () => {
    vi.resetModules();
    (window as unknown as { dataLayer: DL }).dataLayer = [];
    setCkyConsent({ analytics: false, marketing: true });
    try {
      const t = await import('../lib/index');
      t.initTracking();
      t.trackLeadSubmit({ email: 'a@b.hu', value: 1 });
      const ev = dl().find((e) => e.event === 'quote_calculator_submitted')!;
      expect(ev).toBeDefined();
      expect(ev.gclid).toBe('TEST-GCLID');
      expect(typeof ev.session_id).toBe('string');
    } finally {
      clearCkyConsent();
    }
  });
});
