import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import container from '../gtm/container.json';

// L15 — a Clarity GRANTED-jelzése a GTM-konténerből.
//
// A denied oldalt a kliens-lib küldi visszavonáskor (persistence.ts,
// tests/consent-withdrawal.test.ts). A granted oldal eddig SEHOL nem ment ki:
// a Clarity így EGT/UK/CH látogatónál minden oldalnézetre új azonosítót adott,
// munkamenet-szintű felvétel nélkül — consenttel együtt is.
//
// A teszt a COMMITTOLT container.json tagjét futtatja (azt importálja a site),
// nem a generátor forrását; hogy a kettő egyezik, azt a
// tests/gtm-container-drift.test.mjs őrzi.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cv = (container as any).containerVersion;
const TAG_NAME = 'Clarity - Consent v2 (granted)';

function tagHtml(): string {
  const t = cv.tag.find((x: { name: string }) => x.name === TAG_NAME);
  expect(t, `${TAG_NAME} tag hiányzik a container.json-ból`).toBeTruthy();
  return t.parameter.find((p: { key: string }) => p.key === 'html').value as string;
}

function scriptBody(): string {
  const m = tagHtml().match(/<script>([\s\S]*)<\/script>/);
  expect(m).toBeTruthy();
  return m![1];
}

/** A gtag() az `arguments` objektumot pusholja — pontosan azt utánozzuk. */
function gtagLike(...args: unknown[]): unknown {
  // eslint-disable-next-line prefer-rest-params
  return (function (..._a: unknown[]) { return arguments; }).apply(null, args);
}

interface Harness {
  w: { dataLayer: unknown[]; clarity?: (...a: unknown[]) => void; [k: string]: unknown };
  calls: unknown[][];
  fire: (name: string) => void;
  run: () => void;
}

function harness(withClarity = true): Harness {
  const listeners: Record<string, Array<() => void>> = {};
  const d = {
    addEventListener: (name: string, fn: () => void) => {
      (listeners[name] ??= []).push(fn);
    },
  };
  const calls: unknown[][] = [];
  const w: Harness['w'] = { dataLayer: [] };
  if (withClarity) w.clarity = (...a: unknown[]) => { calls.push(a); };
  const body = scriptBody();
  return {
    w,
    calls,
    fire: (name) => (listeners[name] ?? []).forEach((fn) => fn()),
    run: () => new Function('window', 'document', body)(w, d),
  };
}

const DEFAULT_DENIED = gtagLike('consent', 'default', {
  ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  analytics_storage: 'denied', security_storage: 'granted',
});
const update = (ad: string, an: string) =>
  gtagLike('consent', 'update', { ad_storage: ad, ad_user_data: ad, ad_personalization: ad, analytics_storage: an });

describe('GTM: Clarity consentv2 — granted jelzés (L15)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a tag consent-kapu NÉLKÜL fut (egy blokkolt tag később sem tüzelne újra), All Pages + Window Loaded', () => {
    const t = cv.tag.find((x: { name: string }) => x.name === TAG_NAME);
    expect(t.type).toBe('html');
    expect(t.consentSettings).toEqual({ consentStatus: 'NOT_NEEDED' });
    expect(t.firingTriggerId).toContain('2147479553'); // All Pages
    const wl = cv.trigger.find((x: { type: string }) => x.type === 'WINDOW_LOADED');
    expect(wl).toBeTruthy();
    expect(t.firingTriggerId).toContain(wl.triggerId);
  });

  it('a Microsoft-féle pontos API-t hívja (kis/nagybetű-érzékeny kulcsok)', () => {
    const html = tagHtml();
    expect(html).toContain('"consentv2"');
    expect(html).toContain('ad_Storage');
    expect(html).toContain('analytics_Storage');
    // A régi, kivezetés alatt álló v1 API nem kerülhet vissza.
    expect(html).not.toMatch(/clarity\(\s*["']consent["']/);
  });

  it('accept_all → consentv2 { granted, granted }', () => {
    const h = harness();
    h.w.dataLayer.push(DEFAULT_DENIED, update('granted', 'granted'));
    h.run();
    expect(h.calls).toEqual([['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }]]);
  });

  it('csak analytics → consentv2 { ad denied, analytics granted }', () => {
    const h = harness();
    h.w.dataLayer.push(DEFAULT_DENIED, update('denied', 'granted'));
    h.run();
    expect(h.calls).toEqual([['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }]]);
  });

  it('analytics nélkül (default denied / csak marketing) → NINCS hívás (a denied a kliens-lib dolga)', () => {
    const a = harness();
    a.w.dataLayer.push(DEFAULT_DENIED);
    a.run();
    expect(a.calls).toEqual([]);
    const b = harness();
    b.w.dataLayer.push(DEFAULT_DENIED, update('granted', 'denied'));
    b.run();
    expect(b.calls).toEqual([]);
  });

  it('CookieYes: a döntés gtm.js UTÁN jön → a DOM-eventre szinkronizál', () => {
    const h = harness();
    h.w.dataLayer.push(DEFAULT_DENIED);
    h.run();
    expect(h.calls).toEqual([]);
    h.w.dataLayer.push(update('granted', 'granted'));
    h.fire('cookieyes_consent_update');
    vi.runAllTimers();
    expect(h.calls).toEqual([['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }]]);
  });

  it('sbo: banner-módosítás az oldalon → sbo_consent_update-re szinkronizál', () => {
    const h = harness();
    h.w.dataLayer.push(DEFAULT_DENIED, update('denied', 'granted'));
    h.run();
    h.w.dataLayer.push(update('granted', 'granted'));
    h.fire('sbo_consent_update');
    vi.runAllTimers();
    expect(h.calls).toEqual([
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }],
    ]);
  });

  it('ismételt tüzelés (Window Loaded) változatlan állapotnál NEM küld duplikát', () => {
    const h = harness();
    h.w.dataLayer.push(DEFAULT_DENIED, update('granted', 'granted'));
    h.run();
    h.run(); // a második tüzelés a már bekötött sync-et hívja
    expect(h.calls).toHaveLength(1);
  });

  it('visszavonás után ÚJRA-elfogadás → újra küld granted-et', () => {
    const h = harness();
    h.w.dataLayer.push(DEFAULT_DENIED, update('granted', 'granted'));
    h.run();
    h.w.dataLayer.push(update('denied', 'denied'));
    h.fire('sbo_consent_update');
    vi.runAllTimers();
    h.w.dataLayer.push(update('granted', 'granted'));
    h.fire('sbo_consent_update');
    vi.runAllTimers();
    expect(h.calls).toHaveLength(2);
  });

  it('a Clarity-loader ELŐTT futva a Clarity saját queue-mintájába tesz (sorrendfüggetlen)', () => {
    const h = harness(false);
    h.w.dataLayer.push(DEFAULT_DENIED, update('granted', 'granted'));
    h.run();
    const q = (h.w.clarity as unknown as { q: ArrayLike<unknown>[] }).q;
    expect(q).toHaveLength(1);
    expect(Array.from(q[0])).toEqual(['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }]);
  });
});
