/**
 * Soborbo CMP · Fázis 2 — a banner + panel MARKUP és CSS generátora.
 *
 * Miért nem sima Astro-template: a gombparitás (Elfogadom ↔ Elutasítom pixelre
 * azonos) a flotta legsúlyosabb compliance-hibája (NAIH-3195/2022 osztály), és a
 * brief szerint UNIT TESZT méri, nem szemrevételezés. Egy .astro template-et a
 * vitest nem tud olvasni — ezt a pure modult igen. A ConsentBanner.astro csak
 * injektálja, amit ez generál.
 *
 * A PARITÁS MECHANIKUS GARANCIÁI (a teszt pontosan ezeket ellenőrzi):
 *  1. Az accept és a reject gomb AZONOS tag + AZONOS class-lista, inline style
 *     és egyedi id nélkül, ugyanabban a szülőben, egymás mellett.
 *  2. A CSS-ben NINCS olyan szelektor, ami a kettő közül csak az egyiket éri el
 *     (se data-sb-action-ra, se :nth-*-ra a gombsoron belül).
 *  → Így nem LEHET eltérő a méretük/kontrasztjuk, mert nincs nyelvi eszköz rá.
 *
 * A11y: alsó sáv (nem középre vágó modal), a panel viszont valódi modal
 * fókuszcsapdával; `:focus-visible` gyűrű; `prefers-reduced-motion` alatt nincs
 * animáció.
 */

/** A banner-UI verziója (consent_log.banner_version). A szöveg-verziótól FÜGGETLEN. */
export const SBO_BANNER_VERSION = '2026-08-a-b1';

export interface ConsentBannerTexts {
  version: string;
  lang: string;
  banner: { title: string; body: string; accept: string; reject: string; settings: string };
  panel: {
    title: string;
    intro: string;
    save: string;
    accept_all: string;
    reject_all: string;
    categories: {
      necessary: { label: string; always_on: string; body: string };
      analytics: { label: string; body: string };
      marketing: { label: string; body: string };
    };
    policy_link: string;
  };
  footer_link: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A teljes banner + panel markup. Alapból MINDEN rejtett — a megjelenítésről a
 * viselkedés-réteg (ConsentBanner.astro script) dönt, KIZÁRÓLAG akkor, ha nincs
 * érvényes döntés a sütiben.
 */
export function renderConsentBannerHtml(t: ConsentBannerTexts, policyHref: string): string {
  const c = t.panel.categories;
  return `
<div id="sb-consent" data-banner-version="${esc(SBO_BANNER_VERSION)}" data-text-version="${esc(t.version)}" hidden>
  <div class="sb-consent-bar" role="region" aria-label="${esc(t.banner.title)}" data-sb-layer="banner">
    <div class="sb-consent-bar-text">
      <p class="sb-consent-title">${esc(t.banner.title)}</p>
      <p class="sb-consent-body">${esc(t.banner.body)}</p>
    </div>
    <div class="sb-consent-actions">
      <button type="button" class="sb-cbtn sb-cbtn-choice" data-sb-action="accept">${esc(t.banner.accept)}</button>
      <button type="button" class="sb-cbtn sb-cbtn-choice" data-sb-action="reject">${esc(t.banner.reject)}</button>
      <button type="button" class="sb-cbtn sb-cbtn-settings" data-sb-action="settings">${esc(t.banner.settings)}</button>
    </div>
  </div>
  <div class="sb-consent-overlay" data-sb-layer="overlay" hidden></div>
  <div class="sb-consent-panel" role="dialog" aria-modal="true" aria-labelledby="sb-consent-panel-title" data-sb-layer="panel" hidden>
    <h2 id="sb-consent-panel-title">${esc(t.panel.title)}</h2>
    <p class="sb-consent-body">${esc(t.panel.intro)}</p>
    <ul class="sb-consent-cats">
      <li class="sb-consent-cat">
        <div class="sb-consent-cat-head">
          <span class="sb-consent-cat-label">${esc(c.necessary.label)}</span>
          <span class="sb-consent-always">${esc(c.necessary.always_on)}</span>
        </div>
        <p class="sb-consent-cat-body">${esc(c.necessary.body)}</p>
      </li>
      <li class="sb-consent-cat">
        <div class="sb-consent-cat-head">
          <label class="sb-consent-cat-label" for="sb-consent-cat-analytics">${esc(c.analytics.label)}</label>
          <input type="checkbox" id="sb-consent-cat-analytics" data-sb-category="analytics" />
        </div>
        <p class="sb-consent-cat-body">${esc(c.analytics.body)}</p>
      </li>
      <li class="sb-consent-cat">
        <div class="sb-consent-cat-head">
          <label class="sb-consent-cat-label" for="sb-consent-cat-marketing">${esc(c.marketing.label)}</label>
          <input type="checkbox" id="sb-consent-cat-marketing" data-sb-category="marketing" />
        </div>
        <p class="sb-consent-cat-body">${esc(c.marketing.body)}</p>
      </li>
    </ul>
    <div class="sb-consent-actions">
      <button type="button" class="sb-cbtn sb-cbtn-choice" data-sb-action="panel-accept-all">${esc(t.panel.accept_all)}</button>
      <button type="button" class="sb-cbtn sb-cbtn-choice" data-sb-action="panel-reject-all">${esc(t.panel.reject_all)}</button>
      <button type="button" class="sb-cbtn sb-cbtn-choice" data-sb-action="panel-save">${esc(t.panel.save)}</button>
    </div>
    <p class="sb-consent-policy"><a href="${esc(policyHref)}">${esc(t.panel.policy_link)}</a></p>
  </div>
</div>`;
}

/**
 * A banner CSS-e. FIGYELEM (és a teszt ki is kényszeríti): a `.sb-cbtn-choice`
 * az EGYETLEN szelektor-szint, ami a döntés-gombokat formázza — data-sb-action
 * / :nth-* / id alapú megkülönböztetés TILOS, mert az a gombparitás megtörésének
 * nyelvi eszköze lenne.
 */
export function consentBannerCss(): string {
  return `
#sb-consent { font-family: inherit; }
#sb-consent .sb-consent-bar {
  position: fixed; inset-inline: 0; bottom: 0; z-index: 9998;
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  padding: 16px; background: #1c1c1e; color: #fff;
  box-shadow: 0 -2px 12px rgba(0,0,0,.3);
}
#sb-consent .sb-consent-bar-text { flex: 1 1 320px; min-width: 260px; }
#sb-consent .sb-consent-title { margin: 0 0 4px; font-size: 1rem; font-weight: 700; }
#sb-consent .sb-consent-body { margin: 0; font-size: .875rem; line-height: 1.45; }
#sb-consent .sb-consent-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; }
#sb-consent .sb-cbtn {
  appearance: none; border: 0; border-radius: 6px; cursor: pointer;
  font: inherit; font-size: .9375rem; font-weight: 600;
  padding: 10px 18px; min-height: 44px; min-width: 120px;
}
#sb-consent .sb-cbtn-choice { background: #fff; color: #1c1c1e; }
#sb-consent .sb-cbtn-settings { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.6); }
#sb-consent .sb-cbtn:hover { filter: brightness(.92); }
#sb-consent .sb-cbtn:focus-visible { outline: 3px solid #4d90fe; outline-offset: 2px; }
#sb-consent .sb-consent-overlay {
  position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,.5);
}
#sb-consent .sb-consent-panel {
  position: fixed; z-index: 9999; inset-inline: 0; bottom: 0;
  max-height: min(85vh, 640px); overflow-y: auto;
  background: #fff; color: #1c1c1e; padding: 20px 16px;
  border-radius: 12px 12px 0 0; box-shadow: 0 -4px 24px rgba(0,0,0,.35);
}
@media (min-width: 640px) {
  #sb-consent .sb-consent-panel {
    inset-inline: auto; left: 50%; transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px)); bottom: 24px; border-radius: 12px;
  }
}
#sb-consent .sb-consent-panel h2 { margin: 0 0 8px; font-size: 1.125rem; }
#sb-consent .sb-consent-panel .sb-cbtn-choice { background: #1c1c1e; color: #fff; }
#sb-consent .sb-consent-cats { list-style: none; margin: 12px 0; padding: 0; }
#sb-consent .sb-consent-cat { padding: 10px 0; border-top: 1px solid rgba(0,0,0,.12); }
#sb-consent .sb-consent-cat-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
#sb-consent .sb-consent-cat-label { font-weight: 600; }
#sb-consent .sb-consent-always { font-size: .8125rem; opacity: .7; }
#sb-consent .sb-consent-cat input[type="checkbox"] { width: 20px; height: 20px; accent-color: #1c1c1e; }
#sb-consent .sb-consent-cat-body { margin: 6px 0 0; font-size: .8125rem; line-height: 1.4; opacity: .85; }
#sb-consent .sb-consent-policy { margin: 12px 0 0; font-size: .8125rem; }
#sb-consent .sb-consent-policy a { color: inherit; text-decoration: underline; }
@media (prefers-reduced-motion: no-preference) {
  #sb-consent .sb-consent-bar { animation: sb-consent-in .25s ease-out; }
  @keyframes sb-consent-in { from { transform: translateY(100%); } to { transform: translateY(0); } }
}
`;
}
