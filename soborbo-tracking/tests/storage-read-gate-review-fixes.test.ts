import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/gateway', async (orig) => {
  // A gateway VALÓDI (a collectAttribution a tesztek tárgya), csak a hálózat nem.
  const real = await orig<typeof import('../lib/gateway')>();
  return real;
});

import { collectAttribution } from '../lib/gateway';
import {
  purgeMarketingStorage,
  getStorageReadBlocked,
  resetStorageReadBlocked,
  ATTR_STORAGE_KEY,
} from '../lib/persistence';
import { initTracking } from '../lib/index';
import { setCkyConsent, setUrl, resetAll } from './helpers';

/**
 * Codex code-review (PR #61) négy megállapításának regressziós őrei.
 * Mind a négy VALÓS volt; ez a fájl azt rögzíti, hogy vissza ne csússzanak.
 */

beforeEach(() => {
  resetAll();
  resetStorageReadBlocked();
});

describe('P1 · a __sb_attribution olvasása is a kapun megy át', () => {
  it('consent nélkül nem olvassa a gateway attribúció-kulcsát, és JELENTI a blokkot', () => {
    // Előzetes grant → van mit olvasni a storage-ban.
    setCkyConsent({ analytics: true, marketing: true });
    setUrl('/?gclid=G-OLD&utm_source=google');
    collectAttribution();
    expect(localStorage.getItem(ATTR_STORAGE_KEY)).toContain('G-OLD');

    // Visszavonás után az olvasásnak meg kell szűnnie.
    setCkyConsent({ analytics: true, marketing: false });
    resetStorageReadBlocked();
    setUrl('/koszonjuk');

    const a = collectAttribution();
    expect(a.gclid).toBeUndefined();
    expect(a.utm_source).toBeUndefined(); // a TÁROLT UTM sem szivárog ki
    expect(getStorageReadBlocked().keys).toContain(ATTR_STORAGE_KEY);
  });

  it('GRANTED consent mellett változatlanul olvas és összefésül', () => {
    setCkyConsent({ analytics: true, marketing: true });
    setUrl('/?gclid=G-1&utm_source=google');
    collectAttribution();

    setUrl('/koszonjuk');
    const a = collectAttribution();
    expect(a.gclid).toBe('G-1');
    expect(a.utm_source).toBe('google');
    expect(getStorageReadBlocked().blocked).toBe(false);
  });
});

describe('P1 · a purge a __sb_attribution-t is elviszi', () => {
  it('a visszavonás nem hagy MÁSODIK példányt a nyugvó attribúcióból', () => {
    setCkyConsent({ analytics: true, marketing: true });
    setUrl('/?gclid=G-2&utm_source=google');
    collectAttribution();
    expect(localStorage.getItem(ATTR_STORAGE_KEY)).not.toBeNull();

    purgeMarketingStorage();

    expect(localStorage.getItem(ATTR_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('sb_tracking')).toBeNull();
    expect(localStorage.getItem('sb_first_touch')).toBeNull();
  });

  it('a consent-change callbackből is (a teljes lánc)', () => {
    initTracking();
    setCkyConsent({ analytics: true, marketing: true });
    setUrl('/?gclid=G-3');
    collectAttribution();
    expect(localStorage.getItem(ATTR_STORAGE_KEY)).not.toBeNull();

    setCkyConsent({ analytics: true, marketing: false });
    document.dispatchEvent(new Event('cookieyes_consent_update'));

    expect(localStorage.getItem(ATTR_STORAGE_KEY)).toBeNull();
  });
});

describe('P2 · a süti-lejáratás többcímkés domainen is a VALÓDI apexet célozza', () => {
  it('minden ≥2 címkés szülő-utótagot megpróbál (.co.uk flotta)', () => {
    const written: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => desc.get!.call(document),
      set: (v: string) => { written.push(v); desc.set!.call(document, v); },
    });
    const loc = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...loc, hostname: 'www.agykontroll.co.uk' },
    });

    try {
      purgeMarketingStorage();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: loc });
      Object.defineProperty(document, 'cookie', desc);
    }

    const fbp = written.filter((w) => w.startsWith('_fbp='));
    // A VALÓDI registrable domain — ezt a régi „utolsó két címke" logika kihagyta
    // (az `.co.uk`-ot célozta, amit a böngésző public suffixként eldob).
    expect(fbp.some((w) => w.includes('domain=.agykontroll.co.uk'))).toBe(true);
    // A host és a host-only variáns is megvan.
    expect(fbp.some((w) => w.includes('domain=www.agykontroll.co.uk'))).toBe(true);
    expect(fbp.some((w) => !w.includes('domain='))).toBe(true);
  });
});

describe('P2 · a blokk-számláló navigációnként nullázódik', () => {
  it('az initTracking (astro:page-load) resetel — a jel per oldalletöltés értendő', () => {
    // 1. oldal: consent még nincs → blokk.
    setCkyConsent({ analytics: true, marketing: false });
    initTracking();
    collectAttribution();
    expect(getStorageReadBlocked().blocked).toBe(true);

    // 2. oldal (view transition) MÁR megadott consenttel: nem örökölheti a blokkot.
    setCkyConsent({ analytics: true, marketing: true });
    initTracking();
    collectAttribution();
    expect(getStorageReadBlocked()).toEqual({ blocked: false, keys: [] });
  });
});
