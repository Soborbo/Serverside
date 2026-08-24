import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs modul típusdeklaráció nélkül
import { SBO_SELECTORS, selectorsForCmp, SELECTORS } from './lib/banner.mjs';
import {
  renderConsentBannerHtml,
  type ConsentBannerTexts
} from '../../soborbo-tracking/lib/consent-banner-ui';
import huTexts from '../../consent-texts/2026-08-a/hu.json';

/**
 * CMP Fázis 2.7 — a harness SBO-szelektorai és a TÉNYLEGES banner-markup közti
 * kontraktus. Ha a ConsentBanner átnevez egy data-sb-action-t, ez a teszt törik
 * el, nem a pilot élő mérése (ami hamis N/A-t adna, optimista irányban — pont
 * azt a hibamódot, amit a #62 tanulsága tilt).
 */
describe('compliance harness ↔ ConsentBanner szelektor-kontraktus', () => {
  const html = renderConsentBannerHtml(huTexts as ConsentBannerTexts, '/adatkezelesi-tajekoztato');

  it.each([
    ['accept', 'data-sb-action="accept"'],
    ['accept (panel)', 'data-sb-action="panel-accept-all"'],
    ['reject', 'data-sb-action="reject"'],
    ['reject (panel)', 'data-sb-action="panel-reject-all"'],
    ['settings', 'data-sb-action="settings"'],
  ])('a(z) %s gomb attribútuma létezik a markupban', (_label, attr) => {
    expect(html).toContain(attr);
  });

  it('a container-szelektorok célzott osztályai léteznek', () => {
    expect(html).toContain('sb-consent-bar');
    expect(html).toContain('sb-consent-panel');
    expect(html).toContain('id="sb-consent"');
  });

  it("selectorsForCmp: 'sbo' → SBO-készlet, minden más → CookieYes (mai viselkedés)", () => {
    expect(selectorsForCmp('sbo')).toBe(SBO_SELECTORS);
    expect(selectorsForCmp('cookieyes')).toBe(SELECTORS);
    expect(selectorsForCmp(undefined)).toBe(SELECTORS);
  });

  it('a revisit-szelektor a dokumentált visszavonási horog (data-sb-consent-open)', () => {
    // A footer-link a SITE markupja (pilot-integráció), nem a banneré — a
    // szelektor a soborbo-tracking ConsentBanner.astro-ban dokumentált horog.
    expect(SBO_SELECTORS.revisit).toContain('[data-sb-consent-open]');
  });
});
