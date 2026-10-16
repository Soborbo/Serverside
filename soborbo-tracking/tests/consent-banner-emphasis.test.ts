/**
 * Kiemelt Elfogadom (PUBLIC_TRACKING_CONSENT_ACCEPT_EMPHASIS=1) — a gombparitás
 * TUDATOS, opt-in kivétele. Ez a fájl azt őrzi, hogy:
 *  1. kikapcsolva (default) a markup és a CSS BITRE a paritásos banneré;
 *  2. bekapcsolva az Elutasítom továbbra is első szintű, ugyanabban a sorban
 *     lévő gomb, és CSAK a szín/szélesség/betűméret tér el;
 *  3. a banner-verzió `-e` utótagot kap, hogy a consent_log szétválassza.
 */
import { describe, it, expect } from 'vitest';
import {
  renderConsentBannerHtml,
  consentBannerCss,
  SBO_BANNER_VERSION,
  SBO_BANNER_VERSION_B,
  SBO_BANNER_EMPHASIS_SUFFIX,
  type ConsentBannerTexts
} from '../lib/consent-banner-ui';
import huTexts from '../consent-texts/2026-08-a/hu.json';

const hu = huTexts as ConsentBannerTexts;

function render(acceptEmphasis: boolean, withB = false): HTMLElement {
  document.body.innerHTML = renderConsentBannerHtml(
    hu,
    '/adatkezelesi-tajekoztato',
    withB ? { title: 'B cím', textVersion: '2026-08-a.t00000000' } : undefined,
    { acceptEmphasis }
  );
  return document.getElementById('sb-consent')!;
}

describe('kiemelt Elfogadom — kikapcsolva (default)', () => {
  it('a markup azonos az opció nélküli renderrel', () => {
    const a = renderConsentBannerHtml(hu, '/p');
    const b = renderConsentBannerHtml(hu, '/p', undefined, { acceptEmphasis: false });
    expect(b).toBe(a);
  });

  it('a CSS azonos az opció nélkülivel, és nincs benne accept-szabály', () => {
    expect(consentBannerCss({ acceptEmphasis: false })).toBe(consentBannerCss());
    expect(consentBannerCss()).not.toMatch(/sb-cbtn-accept/);
  });
});

describe('kiemelt Elfogadom — bekapcsolva', () => {
  it.each([
    ['banner', 'accept', 'reject'],
    ['panel', 'panel-accept-all', 'panel-reject-all'],
  ])('%s: csak az Elfogadom kapja a kiemelést, az Elutasítom látható testvér marad', (layer, acc, rej) => {
    const root = render(true);
    const scope = root.querySelector(`[data-sb-layer="${layer}"]`)!;
    const accept = scope.querySelector<HTMLElement>(`[data-sb-action="${acc}"]`)!;
    const reject = scope.querySelector<HTMLElement>(`[data-sb-action="${rej}"]`)!;
    expect(accept.classList.contains('sb-cbtn-accept')).toBe(true);
    expect(reject.classList.contains('sb-cbtn-accept')).toBe(false);
    // Az Elutasítom ugyanaz a első szintű döntés-gomb maradt.
    expect(reject.className).toBe('sb-cbtn sb-cbtn-choice');
    expect(reject.tagName).toBe('BUTTON');
    expect(reject.hasAttribute('hidden')).toBe(false);
    expect(accept.parentElement).toBe(reject.parentElement);
    expect(accept.nextElementSibling).toBe(reject);
  });

  it('a CSS csak színt, szélességet és betűt ad — magasságot/elrejtést nem', () => {
    const css = consentBannerCss({ acceptEmphasis: true });
    const rule = css.match(/\.sb-cbtn-accept\s*{([^}]*)}/)![1]!;
    expect(rule).toMatch(/background/);
    expect(rule).not.toMatch(/min-height|height|display|visibility|opacity/);
    // Az Elutasítomot semmi nem halványítja / kicsinyíti.
    expect(css).not.toMatch(/data-sb-action/);
    expect(css).toMatch(/\.sb-cbtn\s*{[^}]*min-height:\s*44px/);
  });

  it('CookieYes-minta: a többi döntés-gomb üres hátterű és keretes, csak az Elfogadom kitöltött', () => {
    const css = consentBannerCss({ acceptEmphasis: true });
    const choiceRules = [...css.matchAll(/#sb-consent \.sb-cbtn-choice\s*{([^}]*)}/g)].map((m) => m[1]!);
    // Az UTOLSÓ .sb-cbtn-choice szabály nyer (azonos specificitás) — az az üres hátterű.
    const last = choiceRules[choiceRules.length - 1]!;
    expect(last).toMatch(/background:\s*transparent/);
    expect(last).toMatch(/border:\s*1px solid currentColor/);
    // Az accept-szabály a choice UTÁN jön, így a kitöltött háttér nyer.
    expect(css.lastIndexOf('.sb-cbtn-accept {')).toBeGreaterThan(css.lastIndexOf('.sb-cbtn-choice {'));
  });

  it('a banner-verziók `-e` utótagot kapnak (A és B ág is)', () => {
    const root = render(true, true);
    expect(root.dataset.bannerVersion).toBe(SBO_BANNER_VERSION + SBO_BANNER_EMPHASIS_SUFFIX);
    expect(root.dataset.bannerVersionB).toBe(SBO_BANNER_VERSION_B + SBO_BANNER_EMPHASIS_SUFFIX);
    // A gateway VERSION_RE-je ([A-Za-z0-9_.-]) elfogadja.
    expect(root.dataset.bannerVersion).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
});
