/**
 * Banner-felderítés és UI-mérés — DOM-alapú, NEM szubjektív.
 *
 * Miért mérjük: a NAIH TV2-bírság tárgya a NEHEZÍTETT ELUTASÍTÁS volt (nincs
 * egyenrangú „Elutasítom" az első rétegen). Ez tehát nem kozmetika, hanem a
 * legsúlyosabb megállapítás-osztály. Számot adunk: van-e reject gomb, mekkora,
 * milyen kontraszttal, és hány kattintás a leggyorsabb elutasítás.
 */

/** CookieYes-specifikus és általános szelektorok, prioritási sorrendben. */
export const SELECTORS = {
  container: ['.cky-consent-container', '.cky-consent-bar', '#cookieyes', '[class*="cky-modal"]'],
  accept: ['.cky-btn-accept', '[data-cky-tag="accept-button"]'],
  reject: ['.cky-btn-reject', '[data-cky-tag="reject-button"]'],
  settings: ['.cky-btn-customize', '[data-cky-tag="settings-button"]'],
  revisit: ['.cky-btn-revisit-wrapper', '.cky-revisit-bottom-left', '[data-cky-tag="revisit-consent"]']
};

/** Szöveges fallback, ha a CMP nem CookieYes (HU + EN). */
export const TEXT_PATTERNS = {
  accept: /^(elfogad|összes elfogad|mindet elfogad|accept|allow all|agree|got it|ok)/i,
  reject: /^(elutasít|összes elutasít|mindet elutasít|reject|decline|deny|refuse|only necessary|csak a szükséges)/i,
  settings: /^(beállítás|testreszab|preferenci|settings|customi[sz]e|manage|preferences)/i
};

/**
 * A böngészőben futtatandó szonda. Visszaadja a banner + gombok MÉRT adatait.
 * Csak olvas: semmit nem kattint, semmit nem módosít.
 */
export function bannerProbeScript() {
  // eslint-disable-next-line func-names
  return function (cfg) {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };

    const measure = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        tag: el.tagName.toLowerCase(),
        width: Math.round(r.width),
        height: Math.round(r.height),
        area: Math.round(r.width * r.height),
        font_size_px: parseFloat(s.fontSize),
        font_weight: s.fontWeight,
        color: s.color,
        background_color: s.backgroundColor,
        // A vizuális elsőbbség jele: a nagyobb, telítettebb gomb dominál.
        border: s.borderStyle === 'none' ? null : `${s.borderWidth} ${s.borderStyle}`,
        opacity: Number(s.opacity),
        selector_source: el.__complianceSource || 'text-match'
      };
    };

    const bySelectors = (list) => {
      for (const sel of list) {
        const el = document.querySelector(sel);
        if (visible(el)) {
          try { el.__complianceSource = sel; } catch (e) { /* */ }
          return el;
        }
      }
      return null;
    };

    const clickables = () =>
      [...document.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]')].filter(
        visible
      );

    const byText = (patternSource, flags) => {
      const re = new RegExp(patternSource, flags);
      for (const el of clickables()) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && re.test(t)) return el;
      }
      return null;
    };

    const container = bySelectors(cfg.container);
    const accept = bySelectors(cfg.accept) || byText(cfg.acceptText.source, cfg.acceptText.flags);
    const reject = bySelectors(cfg.reject) || byText(cfg.rejectText.source, cfg.rejectText.flags);
    const settings = bySelectors(cfg.settings) || byText(cfg.settingsText.source, cfg.settingsText.flags);
    const revisit = bySelectors(cfg.revisit);

    return {
      banner_visible: Boolean(container) || Boolean(accept && (reject || settings)),
      container: measure(container),
      accept: measure(accept),
      reject: measure(reject),
      settings: measure(settings),
      revisit_present: Boolean(revisit),
      // Diagnosztika: mennyi kattintható elem van egyáltalán az oldalon.
      clickable_count: clickables().length
    };
  };
}

// ── Kontraszt (WCAG 2.1) — tiszta, Node-ban tesztelhető ─────────────────────

/** `rgb(r, g, b)` / `rgba(...)` → [r,g,b] 0-255, vagy null. */
export function parseRgb(color) {
  if (typeof color !== 'string') return null;
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function channelLuminance(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relatív luminancia. */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb;
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * WCAG kontraszt-arány (1..21). Bármelyik szín parse-olhatatlan → null (a
 * „nem tudjuk" NEM ugyanaz, mint a „rossz").
 */
export function contrastRatio(foreground, background) {
  const f = parseRgb(foreground);
  const b = parseRgb(background);
  if (!f || !b) return null;
  const lf = relativeLuminance(f);
  const lb = relativeLuminance(b);
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * Az elfogad/elutasít gombpár EGYENRANGÚSÁGA — a NAIH/EDPB elvárás gépi
 * közelítése. Nem jogi ítélet: mért arányokat ad, és a küszöböket dokumentáltan
 * alkalmazza.
 *
 * `equal_prominence` akkor false, ha a reject gomb érdemben kisebb (terület
 * < 70%), kisebb betűs (< 90%), vagy jóval kisebb kontrasztú (arány < 60%).
 */
export function compareButtonProminence(accept, reject) {
  if (!accept || !reject) {
    return { comparable: false, equal_prominence: false, reason: !reject ? 'no_reject_button' : 'no_accept_button' };
  }
  const areaRatio = accept.area > 0 ? Math.round((reject.area / accept.area) * 100) / 100 : null;
  const fontRatio =
    accept.font_size_px > 0 ? Math.round((reject.font_size_px / accept.font_size_px) * 100) / 100 : null;
  const acceptContrast = contrastRatio(accept.color, accept.background_color);
  const rejectContrast = contrastRatio(reject.color, reject.background_color);
  const contrastRatioOfRatios =
    acceptContrast && rejectContrast ? Math.round((rejectContrast / acceptContrast) * 100) / 100 : null;

  const failures = [];
  if (areaRatio !== null && areaRatio < 0.7) failures.push(`reject/accept terület = ${areaRatio}`);
  if (fontRatio !== null && fontRatio < 0.9) failures.push(`reject/accept betűméret = ${fontRatio}`);
  if (contrastRatioOfRatios !== null && contrastRatioOfRatios < 0.6) {
    failures.push(`reject/accept kontraszt = ${contrastRatioOfRatios} (${rejectContrast} vs ${acceptContrast})`);
  }

  return {
    comparable: true,
    area_ratio: areaRatio,
    font_size_ratio: fontRatio,
    accept_contrast: acceptContrast,
    reject_contrast: rejectContrast,
    contrast_ratio_of_ratios: contrastRatioOfRatios,
    equal_prominence: failures.length === 0,
    failures
  };
}
