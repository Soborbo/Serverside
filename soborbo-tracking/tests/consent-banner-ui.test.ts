/**
 * CMP Fázis 2.2 — a banner-UI gépi garanciái.
 *
 * A lényeg a GOMBPARITÁS: az Elfogadom és az Elutasítom pixelre azonos méret,
 * kontraszt, font és kattintásszám (a compliance harness szerint a kisebb
 * elutasító gomb a flotta legsúlyosabb hibája; a NAIH a TV2-t pontosan ezért
 * bírságolta — NAIH-3195/2022). Ezt nem szemrevételezés, hanem mechanikus
 * ellenőrzés adja: a két gombnak nyelvi eszköze SINCS eltérni (azonos tag +
 * class-lista, és a CSS-ben nem létezik olyan szelektor, ami csak az egyiket
 * érné el).
 */
import { describe, it, expect } from 'vitest';
import {
  renderConsentBannerHtml,
  consentBannerCss,
  SBO_BANNER_VERSION,
  type ConsentBannerTexts
} from '../lib/consent-banner-ui';
import huTexts from '../consent-texts/2026-08-a/hu.json';
import enTexts from '../consent-texts/2026-08-a/en.json';
// A repo-gyökér KANONIKUS szövegei (Git-történet = GDPR Art. 7(1) bizonyíték).
// JSON-importtal (mint a gtm-container teszt), node:fs nélkül — vendorolt
// környezetben ez az útvonal nem létezik, ott a package önmagában áll.
import huCanonical from '../../consent-texts/2026-08-a/hu.json';
import enCanonical from '../../consent-texts/2026-08-a/en.json';

const hu = huTexts as ConsentBannerTexts;

function render(t: ConsentBannerTexts = hu): HTMLElement {
  document.body.innerHTML = renderConsentBannerHtml(t, '/adatkezelesi-tajekoztato');
  return document.getElementById('sb-consent')!;
}

describe('gombparitás — Elfogadom ↔ Elutasítom', () => {
  it.each([['banner'], ['panel']])(
    'a(z) %s rétegben a döntés-gombok tag+class szinten AZONOSAK, style/id nélkül, egy szülőben',
    (layer) => {
      const root = render();
      const scope = root.querySelector(`[data-sb-layer="${layer}"]`)!;
      const accept = scope.querySelector<HTMLElement>(
        `[data-sb-action="${layer === 'banner' ? 'accept' : 'panel-accept-all'}"]`
      )!;
      const reject = scope.querySelector<HTMLElement>(
        `[data-sb-action="${layer === 'banner' ? 'reject' : 'panel-reject-all'}"]`
      )!;

      expect(accept.tagName).toBe('BUTTON');
      expect(reject.tagName).toBe('BUTTON');
      // AZONOS class-lista — minden vizuális szabály ezen keresztül jön.
      expect(accept.className).toBe(reject.className);
      // Nincs per-gomb kiskapu: se inline style, se id.
      for (const el of [accept, reject]) {
        expect(el.getAttribute('style')).toBeNull();
        expect(el.id).toBe('');
      }
      // Ugyanabban a konténerben, közvetlen testvérek → azonos layout-kontextus.
      expect(accept.parentElement).toBe(reject.parentElement);
      expect(accept.nextElementSibling).toBe(reject);
    }
  );

  it('a CSS-ben NINCS szelektor, ami a döntés-gombokat megkülönböztethetné', () => {
    const css = consentBannerCss();
    // data-sb-action alapú formázás = per-gomb eltérítés eszköze → tilos.
    expect(css).not.toMatch(/data-sb-action/);
    // Pozíció-alapú megkülönböztetés a gombsoron → tilos.
    expect(css).not.toMatch(/:nth-|:first-child|:last-child|:only-child/);
    // A döntés-gombok osztálya viszont ténylegesen formázva van.
    expect(css).toMatch(/\.sb-cbtn-choice/);
  });

  it('a Beállítások GOMB (nem apró textlink), de másodlagos stílusa lehet', () => {
    const root = render();
    const settings = root.querySelector<HTMLElement>('[data-sb-action="settings"]')!;
    expect(settings.tagName).toBe('BUTTON');
    // Ugyanaz az alap-osztály (méret/padding/min-width onnan jön) + saját módosító.
    expect(settings.classList.contains('sb-cbtn')).toBe(true);
  });

  it('a min. érintési méret közös szabályból jön (44px, WCAG 2.5.5 osztály)', () => {
    expect(consentBannerCss()).toMatch(/\.sb-cbtn\s*{[^}]*min-height:\s*44px/);
  });
});

describe('panel — defaultok és a11y-horgok', () => {
  it('analytics és marketing kapcsoló alapból KI (nincs checked a markupban)', () => {
    const root = render();
    for (const cat of ['analytics', 'marketing']) {
      const input = root.querySelector<HTMLInputElement>(`[data-sb-category="${cat}"]`)!;
      expect(input.checked).toBe(false);
      expect(input.hasAttribute('checked')).toBe(false);
    }
  });

  it('a panel valódi dialog (role + aria-modal + címke), a banner NEM modal', () => {
    const root = render();
    const panel = root.querySelector('[data-sb-layer="panel"]')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe('sb-consent-panel-title');
    const bar = root.querySelector('[data-sb-layer="banner"]')!;
    expect(bar.getAttribute('aria-modal')).not.toBe('true');
  });

  it('minden réteg rejtve indul; a verziók data-attribútumként utaznak', () => {
    const root = render();
    expect(root.hidden).toBe(true);
    expect(root.dataset.bannerVersion).toBe(SBO_BANNER_VERSION);
    expect(root.dataset.textVersion).toBe('2026-08-a');
  });

  it('reduced-motion alatt nincs animáció (a CSS csak no-preference alatt animál)', () => {
    expect(consentBannerCss()).toMatch(/prefers-reduced-motion:\s*no-preference/);
  });
});

describe('szövegek — copy-szabályok és verzió-szinkron', () => {
  it.each([
    ['hu', hu],
    ['en', enTexts as ConsentBannerTexts],
  ])('%s: harmadik felek NÉVVEL, US-transzfer említve, tiltott ígéretek nélkül', (_l, t) => {
    // CSAK a látogatónak megjelenő szöveg — a _copy_rules meta-mező idézi a
    // tiltott frázisokat, az nem UI-copy.
    const all = JSON.stringify({ banner: t.banner, panel: t.panel, footer: t.footer_link });
    expect(all).toMatch(/Google/);
    expect(all).toMatch(/Meta/);
    // TILOS-lista (consent-texts _copy_rules): hamis „semmi nem megy harmadik
    // félhez" ígéret és nem garantálható hirdetés-ígéret.
    expect(all).not.toMatch(/semmilyen adat nem kerül/i);
    expect(all).not.toMatch(/irreleváns hirdetést/i);
    expect(all).not.toMatch(/no data (is|will be) (shared|passed)/i);
  });

  it('a package szövegmásolata BITRE azonos a repo kanonikus consent-texts-ével', () => {
    // Ha eltérnének, a consent_log.consent_text_version mást állítana, mint amit
    // a látogató ténylegesen olvasott.
    expect(huTexts).toEqual(huCanonical);
    expect(enTexts).toEqual(enCanonical);
  });

  it('a markup escape-eli a szöveget (nincs nyers HTML-injektálás a JSON-ból)', () => {
    const evil = JSON.parse(JSON.stringify(hu)) as ConsentBannerTexts;
    evil.banner.title = '<img src=x onerror=alert(1)>';
    const html = renderConsentBannerHtml(evil, '/x');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
