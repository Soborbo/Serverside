/**
 * URL-passthrough (opt-in) — döntés előtt a klikk-ID-k/UTM-ek a belső
 * navigáción utaznak, tárolás nélkül; döntés után és külső linken soha.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trackingConfig } from '../lib/config';
import { encodeSboConsentCookie } from '../lib/consent-sbo-state';
import { installUrlPassthrough } from '../lib/url-passthrough';
import { captureUrlParams, persistTrackingParams } from '../lib/persistence';
import { resetAll, setUrl, setCookie } from './helpers';

const POLICY = trackingConfig.policyVersion;

function decide(analytics: boolean, marketing: boolean): void {
  const decision = analytics && marketing ? 'accept_all' : !analytics && !marketing ? 'reject_all' : 'custom';
  setCookie('sbo_consent', encodeURIComponent(encodeSboConsentCookie({
    analytics, marketing, revision: 1, decision,
    consentId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    decidedAtSec: Math.floor(Date.now() / 1000) - 60,
    policyVersion: POLICY,
  })));
}

/** Kattintás egy linkre; a navigációt jsdom nem hajtja végre, a href-et olvassuk vissza. */
function clickLink(href: string, attrs: Record<string, string> = {}): string {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  const span = document.createElement('span');
  a.appendChild(span);
  document.body.appendChild(a);
  a.addEventListener('click', (e) => e.preventDefault());
  span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const out = a.href;
  a.remove();
  return out;
}

function submitForm(method: string, action: string): HTMLFormElement {
  const f = document.createElement('form');
  f.method = method;
  f.action = action;
  document.body.appendChild(f);
  f.addEventListener('submit', (e) => e.preventDefault());
  f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return f;
}

beforeEach(() => {
  resetAll();
  document.body.innerHTML = '';
  trackingConfig.consentProvider = 'sbo';
  trackingConfig.urlPassthrough = true;
  installUrlPassthrough();
  setUrl('/landing/?gclid=G1&utm_source=google&utm_campaign=spring&foo=bar');
});

afterEach(() => {
  trackingConfig.consentProvider = 'cookieyes';
  trackingConfig.urlPassthrough = false;
});

describe('URL-passthrough — döntés előtt', () => {
  it('belső linkre a klikk-ID és az UTM-ek kerülnek, más paraméter nem', () => {
    const u = new URL(clickLink('/prices/'));
    expect(u.pathname).toBe('/prices/');
    expect(u.searchParams.get('gclid')).toBe('G1');
    expect(u.searchParams.get('utm_source')).toBe('google');
    expect(u.searchParams.get('utm_campaign')).toBe('spring');
    expect(u.searchParams.has('foo')).toBe(false);
  });

  it('a link meglévő paraméterét nem írja felül', () => {
    const u = new URL(clickLink('/quote/?utm_source=own&step=1'));
    expect(u.searchParams.get('utm_source')).toBe('own');
    expect(u.searchParams.get('step')).toBe('1');
    expect(u.searchParams.get('gclid')).toBe('G1');
  });

  it('külső, tel:, mailto: és download linket NEM dekorál', () => {
    expect(clickLink('https://example.org/x/')).toBe('https://example.org/x/');
    expect(clickLink('tel:+441234567890')).toBe('tel:+441234567890');
    expect(clickLink('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(clickLink('/file.pdf', { download: '' })).not.toContain('gclid');
  });

  it('oldalon belüli horgonyt NEM dekorál (különben újratöltene)', () => {
    expect(clickLink('/landing/#faq')).not.toContain('gclid');
  });

  it('jel nélküli oldalon nem dekorál', () => {
    setUrl('/plain/');
    expect(clickLink('/prices/')).not.toContain('?');
  });

  it('belső GET-formra rejtett mezőt tesz, POST-ra és külsőre nem', () => {
    const get = submitForm('get', '/search/');
    expect((get.elements.namedItem('gclid') as HTMLInputElement).value).toBe('G1');
    expect(submitForm('post', '/api/lead/').elements.namedItem('gclid')).toBeNull();
    expect(submitForm('get', 'https://example.org/s/').elements.namedItem('gclid')).toBeNull();
  });

  it('a dekorálás nem ír tárolót', () => {
    clickLink('/prices/');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('a következő oldalon az elfogadás a dekorált URL-ből perzisztál', () => {
    setUrl(clickLink('/prices/').replace(window.location.origin, ''));
    captureUrlParams();
    decide(true, true);
    persistTrackingParams();
    const stored = JSON.parse(localStorage.getItem('sb_tracking')!);
    expect(stored.gclid).toBe('G1');
    expect(stored.utm_campaign).toBe('spring');
  });
});

describe('URL-passthrough — döntés után és kikapcsolva', () => {
  it('elutasítás után nem dekorál', () => {
    decide(false, false);
    expect(clickLink('/prices/')).not.toContain('gclid');
  });

  it('elfogadás után sem dekorál (a tároló viszi)', () => {
    decide(true, true);
    expect(clickLink('/prices/')).not.toContain('gclid');
  });

  it('opció nélkül (default) nem dekorál', () => {
    trackingConfig.urlPassthrough = false;
    expect(clickLink('/prices/')).not.toContain('gclid');
  });

  it('CookieYes provider alatt nem dekorál', () => {
    trackingConfig.consentProvider = 'cookieyes';
    expect(clickLink('/prices/')).not.toContain('gclid');
  });
});
