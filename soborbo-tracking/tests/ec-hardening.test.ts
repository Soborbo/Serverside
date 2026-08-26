import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import {
  setUserDataForEC,
  getUserDataForEC,
  clearUserDataForEC,
  purgeMarketingStorage,
  purgeAnalyticsStorage,
  trackLeadSubmit,
  stageLeadSubmit,
  peekPendingConversions,
  normalizeEmail,
  normalizePhone,
  sanitizeName,
} from '../lib';
// A konstans SZÁNDÉKOSAN nincs a barrel-exportban (minimális API-felület) —
// a teszt a modulból veszi, nem tágítjuk miatta a csomag felületét.
import { USER_DATA_ELEMENT_ID } from '../lib/events';
import { setCkyConsent, resetAll } from './helpers';

/**
 * P6 — Enhanced Conversions hardening.
 *
 * KÉT HIBAOSZTÁLY, amit ez a fájl őriz:
 *
 * 1. A VISSZAVONÁS NEM VITTE EL AZ EPHEMERAL IDENTITYT. A `purgeMarketingStorage`
 *    sütiket és localStorage-kulcsokat törölt, az EC-oldalcsatornát (nyers
 *    e-mail/telefon/név a `window.__sbUserData`-ban és egy rejtett divben)
 *    viszont csak egy 5 másodperces időzítő söpörte. A látogató épp azt kérte,
 *    hogy ne maradjon — és a visszavonás pillanatában mégis ott volt.
 *
 * 2. NYERS GLOBÁLIS VOLT AZ EGYETLEN FELÜLET. Bármelyik third-party szkript
 *    megtalálta egy `Object.keys(window)` sepréssel. A package-owned getter
 *    mögött a tár modul-privát, és EGY helyről üríthető.
 */

const UD = { email: 'jane@test.hu', phone_number: '+36301112233', first_name: 'Jane' };

const hiddenEl = () => document.getElementById(USER_DATA_ELEMENT_ID);
const rawGlobal = () => (window as unknown as { __sbUserData?: unknown }).__sbUserData;

beforeEach(() => {
  resetAll();
  setCkyConsent({ analytics: true, marketing: true });
  clearUserDataForEC();
});

describe('package-owned getter', () => {
  it('a getter adja vissza a beállított EC-adatot', () => {
    setUserDataForEC(UD);
    expect(getUserDataForEC()).toEqual(UD);
  });

  it('a getter MÁSOLATOT ad — a hívó nem tudja mutálni a belső állapotot', () => {
    setUserDataForEC(UD);
    const first = getUserDataForEC()!;
    first.email = 'attacker@evil.example';
    expect(getUserDataForEC()!.email).toBe('jane@test.hu');
  });

  it('a getter a `window.sbTracking`-en keresztül is elérhető (a GTM-változó ezt hívja)', () => {
    setUserDataForEC(UD);
    const api = (window as unknown as { sbTracking?: { getUserDataForEC: () => unknown } }).sbTracking;
    expect(typeof api?.getUserDataForEC).toBe('function');
    expect(api!.getUserDataForEC()).toEqual(UD);
  });

  it('consent nélkül semmi nem íródik — se a getterbe, se a globálisba, se a DOM-ba', () => {
    setCkyConsent({ analytics: true, marketing: false });
    setUserDataForEC(UD);
    expect(getUserDataForEC()).toBeNull();
    expect(rawGlobal()).toBeUndefined();
    expect(hiddenEl()).toBeNull();
  });
});

describe('P6.2 — a visszavonás elviszi az EPHEMERAL identityt is', () => {
  it('purgeMarketingStorage → a getter, a globális ÉS a rejtett div is üres', () => {
    setUserDataForEC(UD);
    // Előfeltétel: tényleg ott van mind a három felületen.
    expect(getUserDataForEC()).not.toBeNull();
    expect(rawGlobal()).toBeDefined();
    expect(hiddenEl()).not.toBeNull();

    purgeMarketingStorage();

    expect(getUserDataForEC()).toBeNull();
    expect(rawGlobal()).toBeUndefined();
    expect(hiddenEl()).toBeNull();
  });

  it('a purge után a DOM-ban SEMMILYEN formában nem marad az e-mail', () => {
    setUserDataForEC(UD);
    purgeMarketingStorage();
    expect(document.body.innerHTML).not.toContain('jane@test.hu');
    expect(document.documentElement.innerHTML).not.toContain('jane@test.hu');
  });

  it('a purge a LETETT (P5) konverzió identityjét is elviszi', () => {
    stageLeadSubmit({ email: 'jane@test.hu', phone: '+36301112233', value: 100 });
    expect(peekPendingConversions()).toHaveLength(1);
    purgeMarketingStorage();
    expect(peekPendingConversions()).toHaveLength(0);
  });

  it('az ANALYTICS-visszavonás NEM viszi el a marketing EC-adatot (a két kategória független)', () => {
    setUserDataForEC(UD);
    purgeAnalyticsStorage();
    expect(getUserDataForEC()).not.toBeNull();
  });

  it('egy hibás horog nem akaszthatja meg a többi takarítást', async () => {
    const { registerMarketingPurgeHook } = await import('../lib');
    registerMarketingPurgeHook(() => { throw new Error('a horog elszállt'); });
    setUserDataForEC(UD);
    expect(() => purgeMarketingStorage()).not.toThrow();
    expect(getUserDataForEC()).toBeNull();
  });
});

describe('PII nem szivárog a dataLayerbe, sem a tárba', () => {
  const dataLayer = () => (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];

  it('a konverziós push NEM tartalmaz PII-t, az EC-adat az oldalcsatornán megy', () => {
    trackLeadSubmit({ email: 'jane@test.hu', phone: '+36301112233', firstName: 'Jane', lastName: 'Doe' });
    const serialized = JSON.stringify(dataLayer());
    expect(serialized).not.toContain('jane@test.hu');
    expect(serialized).not.toContain('+36301112233');
    expect(getUserDataForEC()!.email).toBe('jane@test.hu');
  });

  it('SEM a localStorage, SEM a sessionStorage nem tartalmaz e-mailt a konverzió után', () => {
    trackLeadSubmit({ email: 'jane@test.hu', phone: '+36301112233' });
    const dump = [
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ''),
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k) ?? ''),
    ].join('|');
    expect(dump).not.toContain('jane@test.hu');
    expect(dump).not.toContain('+36301112233');
  });
});

describe('P6.1 — normalizálás unicode és ékezet mellett', () => {
  it('az ékezetes e-mail-cím kisbetűsödik, de az ékezet MEGMARAD', () => {
    // A Meta a literal stringet hash-eli: ha „okoskodunk" az ékezet
    // levételével, nem fog egyezni a vendor belső rekordjával (CLAUDE.md 1.).
    expect(normalizeEmail('  Ágnes.Kovács@Példa.hu ')).toBe('ágnes.kovács@példa.hu');
  });

  it('a gmail pont és plus-suffix MEGMARAD a Meta-normalizálóban', () => {
    expect(normalizeEmail('john.smith+promo@gmail.com')).toBe('john.smith+promo@gmail.com');
  });

  it('az ékezetes név kisbetűsítés nélkül, trimmelve marad', () => {
    expect(sanitizeName('  Kovács Ágnes  ')).toBe('Kovács Ágnes');
    expect(sanitizeName('Đorđević')).toBe('Đorđević');
  });

  it('a magyar és a brit telefonszám is E.164-be megy', () => {
    expect(normalizePhone('06 20 123 4567', 'HU')).toBe('+36201234567');
    expect(normalizePhone('07123 456789', 'GB')).toBe('+447123456789');
  });

  it('a zárójeles/pontos/kötőjeles alak is tisztul', () => {
    expect(normalizePhone('+44 (0)7123-456.789', 'GB')).toBe('+447123456789');
  });

  it('üres/hiányos bemenetre nem gyárt hamis azonosítót', () => {
    // 6.6.0: az üres bemenet `undefined`, nem üres string. A cél ugyanaz —
    // „ne gyárts hamis azonosítót" —, de most a hiány EXPLICIT, és a Worker
    // `hash.ts` is pontosan ezt adja ugyanerre a bemenetre.
    expect(normalizeEmail('')).toBeUndefined();
    expect(sanitizeName('   ')).toBe('');
  });
});
