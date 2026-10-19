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

/**
 * A `_gcl_aw` COOKIE-FALLBACK NEM ELŐZHETI MEG A FRISS URL-JELET.
 *
 * A fallback azért van, hogy a belső oldalon konvertáló látogatónál is legyen
 * klikk-ID, amikor az URL-ből már kikopott. A cookie viszont a KORÁBBI
 * kattintásé — ha az URL MOST hozott egy `gbraid`/`wbraid`-et, a cookie gclid-je
 * elavult, és a `keepSingleGoogleClickId` prioritása (gclid > gbraid) pont a
 * RÉGI-t választaná a FRISS helyett. Ezért a sorrend kötött:
 *   1. URL → 2. egy ID kiválasztása → 3. cookie CSAK ha egyik sincs.
 *
 * A painless forkja ezt már javította (#39); a kanonikus mag a fordított
 * sorrendet vitte, így az F9/3.4 delegálása visszahozta a hibát.
 */
describe('`_gcl_aw` cookie-fallback', () => {
  function setGclAw(gclid: string) {
    document.cookie = `_gcl_aw=GCL.1690000000.${gclid};path=/`;
  }

  it('friss URL-gbraid mellett a RÉGI cookie-gclid nem futhat be', () => {
    setGclAw('REGI-GCLID');
    setUrl('?gbraid=UJ-GBRAID');

    const out = collectAttribution();
    expect(out.gbraid).toBe('UJ-GBRAID');
    expect(out.gclid, 'az elavult cookie-gclid legyőzte a friss gbraid-et').toBeUndefined();
  });

  it('friss URL-wbraid mellett sem', () => {
    setGclAw('REGI-GCLID');
    setUrl('?wbraid=UJ-WBRAID');

    const out = collectAttribution();
    expect(out.wbraid).toBe('UJ-WBRAID');
    expect(out.gclid).toBeUndefined();
  });

  it('friss URL-gclid mindig veri a cookie-t', () => {
    setGclAw('REGI-GCLID');
    setUrl('?gclid=UJ-GCLID');
    expect(collectAttribution().gclid).toBe('UJ-GCLID');
  });

  it('URL-jel HÍJÁN viszont a cookie a mentőöv — ez a fallback célja', () => {
    setGclAw('COOKIE-GCLID');
    setUrl('/koszonjuk');

    const out = collectAttribution();
    expect(out.gclid).toBe('COOKIE-GCLID');
  });

  it('tárolt gclid + cookie-gclid + friss gbraid → CSAK a friss gbraid marad', () => {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ gclid: 'TAROLT-REGI' }));
    setGclAw('COOKIE-REGI');
    setUrl('?gbraid=UJ-GBRAID');

    const out = collectAttribution();
    expect(out.gbraid).toBe('UJ-GBRAID');
    expect(out.gclid).toBeUndefined();
    expect(stored().gclid, 'a tárolóban is csak egy klikk-ID maradhat').toBeUndefined();
  });
});

/**
 * K7 (6.16.0) — a first touch és a rejtett mezők is egy kattintás = egy ID.
 *
 * A `persistTrackingParams` a last touch-ot már összecsukta, a `sb_first_touch`
 * viszont a NYERS URL-paramétereket kapta: `?gclid=A&gbraid=B` mindkettőt
 * beírta, és a first touch soha többé nem íródik felül. A rejtett mezők pedig
 * gbraid/wbraid-et egyáltalán nem vittek — az iOS-forgalom kimaradt.
 */
describe('K7 — first touch és rejtett mezők', () => {
  function realUrl(search: string) {
    // A persistence.ts a `window.location.search`-öt olvassa; a jsdom history-n
    // keresztül állítjuk (a fenti `setUrl` egy URL-objektumot tesz a helyére).
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL(`https://painlessremovals.com/${search}`) as unknown as Location
    });
  }

  it('URL gclid+gbraid → a sb_first_touch CSAK a gclid-et őrzi', async () => {
    const { persistTrackingParams, captureUrlParams } = await import('../lib/persistence');
    realUrl('?gclid=A-GCLID&gbraid=B-GBRAID&utm_source=google');
    captureUrlParams();
    persistTrackingParams();
    const ft = JSON.parse(localStorage.getItem('sb_first_touch') || '{}');
    expect(ft.gclid).toBe('A-GCLID');
    expect(ft.gbraid, 'a first touch két Google klikk-ID-t őriz').toBeUndefined();
    expect(ft.wbraid).toBeUndefined();
    expect(ft.utm_source).toBe('google');
    const last = JSON.parse(localStorage.getItem('sb_tracking') || '{}');
    expect(last.gclid).toBe('A-GCLID');
    expect(last.gbraid).toBeUndefined();
  });

  it('URL gbraid+wbraid → a first touch a gbraid-et őrzi', async () => {
    const { persistTrackingParams, captureUrlParams } = await import('../lib/persistence');
    realUrl('?gbraid=B&wbraid=W');
    captureUrlParams();
    persistTrackingParams();
    const ft = JSON.parse(localStorage.getItem('sb_first_touch') || '{}');
    expect(ft.gbraid).toBe('B');
    expect(ft.wbraid).toBeUndefined();
  });

  function formWith(...names: string[]): HTMLFormElement {
    const f = document.createElement('form');
    f.innerHTML = names.map((n) => `<input type="hidden" name="${n}" />`).join('');
    document.body.appendChild(f);
    return f;
  }
  const val = (f: HTMLFormElement, n: string) => f.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.value;

  it('populateHiddenFields: csak gbraid → a gbraid mező kitöltve, gclid/wbraid üres', async () => {
    const { populateHiddenFields, getGclid, getFbclid } = await import('../lib/index');
    realUrl('?gbraid=IOS-GBRAID');
    const f = formWith('gclid', 'gbraid', 'wbraid');
    populateHiddenFields(f, { success: true, consentBlocked: false, eventId: 'E1', gclid: getGclid(), fbclid: getFbclid() });
    expect(val(f, 'gbraid')).toBe('IOS-GBRAID');
    expect(val(f, 'gclid')).toBe('');
    expect(val(f, 'wbraid')).toBe('');
  });

  it('attachEventIdToForm: friss URL-gbraid mellett a TÁROLT gclid nem kerül a mezőbe', async () => {
    const { attachEventIdToForm, persistTrackingParams, captureUrlParams } = await import('../lib/index');
    realUrl('?gclid=REGI-GCLID');
    captureUrlParams();
    persistTrackingParams();
    realUrl('?gbraid=UJ-GBRAID');
    const f = formWith('gclid', 'gbraid', 'wbraid');
    attachEventIdToForm(f, 'E2');
    expect(val(f, 'gbraid')).toBe('UJ-GBRAID');
    expect(val(f, 'gclid')).toBe('');
  });

  it('gbraid/wbraid inputot NEM hoz létre, ha az űrlapon nincs', async () => {
    const { attachEventIdToForm } = await import('../lib/index');
    realUrl('?wbraid=W');
    const f = formWith('gclid');
    attachEventIdToForm(f, 'E3');
    expect(f.querySelector('input[name="wbraid"]')).toBeNull();
    expect(f.querySelector('input[name="gbraid"]')).toBeNull();
  });
});
