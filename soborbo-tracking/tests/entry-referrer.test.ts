/**
 * K3 (6.16.0) — a `collectAttribution` hivatkozója CSAK KÜLSŐ lehet.
 *
 * A hiba: a first-touch `referrer` nyers `document.referrer` volt, ami a 2.
 * oldaltól a saját előző oldalunk. A skinlab CRM-mérése: 95 sorból 86 belső
 * hivatkozó, 0 külső. Ezek a tesztek a szűrőt, a régi blobok gyógyítását és a
 * site-oldali `setEntryContextProvider` horgot rögzítik.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectAttribution, sendToWorker, setEntryContextProvider } from '../lib/gateway';
import { ATTR_STORAGE_KEY } from '../lib/persistence';
import { resetAll, setCkyConsent, setCookie } from './helpers';

const realLocation = window.location;

function at(url: string): void {
  Object.defineProperty(window, 'location', { configurable: true, value: new URL(url) as unknown as Location });
}
function referrer(value: string): void {
  Object.defineProperty(document, 'referrer', { configurable: true, get: () => value });
}
function stored(): Record<string, string> {
  return JSON.parse(localStorage.getItem(ATTR_STORAGE_KEY) || '{}');
}
function grant(): void {
  setCkyConsent({ analytics: true, marketing: true });
  setCookie('cookieyes-consent', 'consent:yes,analytics:yes,advertisement:yes');
}

beforeEach(() => {
  resetAll();
  grant();
  setEntryContextProvider(null);
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  referrer('');
  setEntryContextProvider(null);
  vi.unstubAllGlobals();
});

describe('belső hivatkozó', () => {
  it('a saját előző oldal se nem tárolódik, se nem megy ki', () => {
    at('https://example.com/kapcsolat/');
    referrer('https://example.com/blog/cikk?x=1');
    const out = collectAttribution();
    expect(out.referrer).toBeUndefined();
    expect(stored().referrer).toBeUndefined();
  });

  it('www ↔ apex ugyanaz a webhely (mindkét irányban belső)', () => {
    at('https://www.example.com/kapcsolat/');
    referrer('https://example.com/blog/');
    expect(collectAttribution().referrer).toBeUndefined();

    localStorage.clear();
    at('https://example.com/kapcsolat/');
    referrer('https://www.example.com/blog/');
    expect(collectAttribution().referrer).toBeUndefined();
  });

  it('a böngésző-payload sem visz belső hivatkozót', async () => {
    at('https://example.com/kapcsolat/');
    referrer('https://example.com/');
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    await sendToWorker({ event_name: 'phone_number_clicked', event_id: 'E1', event_time: 1 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.attribution.referrer).toBeUndefined();
  });
});

describe('külső hivatkozó', () => {
  it('origin + útvonal marad, a query és a hash leesik', () => {
    at('https://example.com/');
    referrer('https://www.google.com/search?q=titok&gclid=X#frag');
    const out = collectAttribution();
    expect(out.referrer).toBe('https://www.google.com/search');
    expect(stored().referrer).toBe('https://www.google.com/search');
  });

  it('legfeljebb 500 karakter', () => {
    at('https://example.com/');
    referrer(`https://partner.hu/${'a'.repeat(900)}`);
    expect(collectAttribution().referrer!.length).toBe(500);
  });

  it('first touch: a már tárolt külső hivatkozót egy későbbi másik külső sem írja felül', () => {
    at('https://example.com/');
    referrer('https://elso.hu/cikk');
    collectAttribution();
    referrer('https://masodik.hu/');
    expect(collectAttribution().referrer).toBe('https://elso.hu/cikk');
  });
});

describe('régi blobok gyógyítása olvasáskor', () => {
  it('a tárolt BELSŐ referrer törlődik (a payloadból és a tárolóból is)', () => {
    at('https://example.com/kapcsolat/');
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({
      referrer: 'https://example.com/arak/', landing_page: 'https://example.com/', utm_source: 'google',
    }));
    const out = collectAttribution();
    expect(out.referrer).toBeUndefined();
    expect(stored().referrer).toBeUndefined();
    expect(out.utm_source).toBe('google');
    expect(out.landing_page).toBe('https://example.com/');
  });

  it('gyógyítás után egy valódi külső hivatkozó beléphet', () => {
    at('https://example.com/');
    referrer('https://facebook.com/');
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ referrer: 'https://www.example.com/x' }));
    expect(collectAttribution().referrer).toBe('https://facebook.com/');
  });

  it('a tárolt külső referrer query-je is leesik', () => {
    at('https://example.com/');
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({ referrer: 'https://partner.hu/p?id=7' }));
    expect(collectAttribution().referrer).toBe('https://partner.hu/p');
  });
});

describe('landing_page first touch', () => {
  it('a későbbi oldal nem írja felül', () => {
    at('https://example.com/blog/belepes');
    collectAttribution();
    at('https://example.com/kapcsolat/');
    expect(collectAttribution().landing_page).toBe('https://example.com/blog/belepes');
    expect(stored().landing_page).toBe('https://example.com/blog/belepes');
  });
});

describe('setEntryContextProvider', () => {
  it('a szolgáltató értékei felülírják a beépített fallbacket', () => {
    at('https://example.com/kapcsolat/');
    referrer('https://example.com/blog/');
    setEntryContextProvider(() => ({ landing_page: '/blog/belepes', referrer: 'https://news.hu/cikk?utm=1' }));
    const out = collectAttribution();
    expect(out.landing_page).toBe('https://example.com/blog/belepes');
    expect(out.referrer).toBe('https://news.hu/cikk');
  });

  it('a szolgáltató BELSŐ hivatkozója is kiesik — és ilyenkor a külső document.referrer sem kerül be belsőként', () => {
    at('https://example.com/kapcsolat/');
    referrer('');
    setEntryContextProvider(() => ({ referrer: 'https://www.example.com/arak/' }));
    expect(collectAttribution().referrer).toBeUndefined();
  });

  it('üres / hiányzó érték → fallback', () => {
    at('https://example.com/landing');
    referrer('https://bing.com/');
    setEntryContextProvider(() => ({ landing_page: '', referrer: undefined }));
    const out = collectAttribution();
    expect(out.landing_page).toBe('https://example.com/landing');
    expect(out.referrer).toBe('https://bing.com/');
  });

  it('idegen originre mutató belépési oldal nem fogadható el', () => {
    at('https://example.com/landing');
    setEntryContextProvider(() => ({ landing_page: 'https://evil.com/x' }));
    expect(collectAttribution().landing_page).toBe('https://example.com/landing');
    localStorage.clear();
    setEntryContextProvider(() => ({ landing_page: '//evil.com/x' }));
    expect(collectAttribution().landing_page).toBe('https://example.com/landing');
  });

  it('a tárolt first touch erősebb a szolgáltatónál', () => {
    at('https://example.com/');
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify({
      landing_page: 'https://example.com/elso', referrer: 'https://elso.hu/',
    }));
    setEntryContextProvider(() => ({ landing_page: '/masik', referrer: 'https://masik.hu/' }));
    const out = collectAttribution();
    expect(out.landing_page).toBe('https://example.com/elso');
    expect(out.referrer).toBe('https://elso.hu/');
  });

  it('a szolgáltató hibája nem buktatja a gyűjtést', () => {
    at('https://example.com/landing');
    setEntryContextProvider(() => { throw new Error('boom'); });
    expect(collectAttribution().landing_page).toBe('https://example.com/landing');
  });
});
