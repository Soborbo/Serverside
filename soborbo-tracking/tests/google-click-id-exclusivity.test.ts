// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { collectAttribution } from '../lib/gateway';
import { ATTR_STORAGE_KEY } from '../lib/persistence';

/**
 * A GOOGLE KLIKK-ID-K KÖLCSÖNÖSEN KIZÁRÓAK.
 *
 * Egy kattintás `gclid`-et VAGY `gbraid`-et VAGY `wbraid`-et ad, sosem többet.
 * A `collectAttribution` viszont kulcsonként merge-ölt a tárolóval, ezért egy
 * VISSZATÉRŐ fizetett látogatónál a RÉGI `gclid` ott maradt az ÚJ `gbraid`
 * mellett — a payload két, egymásnak ellentmondó klikk-azonosítót vitt.
 *
 * Miért néma és miért drága: az offline / Enhanced Conversions feltöltés
 * ezekből köti a konverziót a kattintáshoz. Két ID mellett vagy rossz
 * kattintáshoz köt, vagy a vendor dönt helyettünk — és a riportokban mindkettő
 * egészségesnek látszik.
 *
 * A hibát a painless forkja már javította; a kanonikus csomag nem. Az F9/3.4
 * transzport-migrációja derítette ki: a delegálás enélkül REGRESSZIÓ lett volna
 * a site-on, ahol a védelem már megvolt.
 */

function grantMarketing() {
  (window as unknown as Record<string, unknown>).getCkyConsent = () => ({
    categories: { advertisement: true, analytics: true }
  });
  document.cookie = 'cookieyes-consent=' + encodeURIComponent('analytics:yes,advertisement:yes') + ';path=/';
}

function setUrl(search: string) {
  const url = `https://painlessremovals.com/${search}`;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL(url) as unknown as Location
  });
}

function stored(): Record<string, string> {
  return JSON.parse(localStorage.getItem(ATTR_STORAGE_KEY) || '{}');
}

beforeEach(() => {
  localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    document.cookie = `${c.split('=')[0]!.trim()}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
  grantMarketing();
  vi.restoreAllMocks();
});

describe('friss Google klikk-ID érkezik', () => {
  it('a TÁROLT testvér eltűnik — nem visz két ellentmondó ID-t', () => {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ gclid: 'REGI-GCLID', utm_source: 'google' }));
    setUrl('?gbraid=UJ-GBRAID');

    const out = collectAttribution();
    expect(out.gbraid).toBe('UJ-GBRAID');
    expect(out.gclid, 'a régi gclid ott maradt az új gbraid mellett').toBeUndefined();
    // A nem-Google mezők érintetlenek: ez nem általános takarítás.
    expect(out.utm_source).toBe('google');
    expect(stored().gclid).toBeUndefined();
  });

  it('az URL-ben érkező TÖBB Google-ID-ból is egy marad (gclid > gbraid > wbraid)', () => {
    setUrl('?gclid=A&gbraid=B&wbraid=C');
    const out = collectAttribution();
    expect(out.gclid).toBe('A');
    expect(out.gbraid).toBeUndefined();
    expect(out.wbraid).toBeUndefined();
  });

  it('gclid nélkül a gbraid nyer a wbraid felett', () => {
    setUrl('?gbraid=B&wbraid=C');
    const out = collectAttribution();
    expect(out.gbraid).toBe('B');
    expect(out.wbraid).toBeUndefined();
  });
});

describe('nincs friss Google klikk-ID', () => {
  it('a legacy tároló TÖBB ID-ja gyógyul: a gclid marad', () => {
    localStorage.setItem(
      ATTR_STORAGE_KEY,
      JSON.stringify({ gclid: 'G', gbraid: 'B', wbraid: 'W' })
    );
    setUrl('?utm_source=newsletter');

    const out = collectAttribution();
    expect(out.gclid).toBe('G');
    expect(out.gbraid).toBeUndefined();
    expect(out.wbraid).toBeUndefined();
  });

  it('EGYETLEN tárolt ID érintetlen marad — nincs mit feloldani', () => {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ gbraid: 'B' }));
    setUrl('?utm_source=newsletter');
    expect(collectAttribution().gbraid).toBe('B');
  });

  it('gclid nélküli legacy páros: a gbraid marad (a lista sorrendje dönt)', () => {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ gbraid: 'B', wbraid: 'W' }));
    setUrl('?utm_source=newsletter');
    const out = collectAttribution();
    expect(out.gbraid).toBe('B');
    expect(out.wbraid).toBeUndefined();
  });
});
