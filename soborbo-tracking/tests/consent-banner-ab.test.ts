/**
 * Banner A/B (b3) — a mérés csak akkor őszinte, ha:
 *  - B-cím nélkül a markup és a viselkedés BITRE a b2 (nincs néma változás),
 *  - a kiválasztott ág verziói kerülnek a DOM-ba MIELŐTT bármi kiolvasná őket,
 *  - a B-ág sem töri a gombparitást, és semmit nem tárol a látogatónál.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderConsentBannerHtml,
  consentBannerCss,
  pickBannerVariant,
  variantTextVersion,
  SBO_BANNER_VERSION,
  SBO_BANNER_VERSION_B,
} from '../lib/consent-banner-ui';
import { composeBannerTexts, type VendorTextTemplate } from '../lib/consent-vendors';
import en from '../consent-texts/2026-09-a/en.json';

const texts = composeBannerTexts(en as VendorTextTemplate, ['clarity', 'ga4', 'google_ec']);
const TITLE_B = 'Measure twice, cut once';
const variantB = { title: TITLE_B, textVersion: variantTextVersion(texts.version, TITLE_B) };

function mount(withB: boolean): HTMLElement {
  document.body.innerHTML = renderConsentBannerHtml(texts, '/privacy-policy/', withB ? variantB : undefined);
  return document.getElementById('sb-consent')!;
}

beforeEach(() => {
  document.cookie.split(';').forEach((c) => {
    document.cookie = `${c.split('=')[0].trim()}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  localStorage.clear();
  sessionStorage.clear();
});

describe('B-ág nélkül', () => {
  it('nincs B-attribútum és nincs második cím', () => {
    const root = mount(false);
    expect(root.dataset.bannerVersionB).toBeUndefined();
    expect(root.querySelectorAll('.sb-consent-title')).toHaveLength(1);
  });

  it('a választás mindig A, a verziók változatlanok', () => {
    const root = mount(false);
    expect(pickBannerVariant(root, 0)).toBe('a');
    expect(root.dataset.bannerVersion).toBe(SBO_BANNER_VERSION);
    expect(root.dataset.textVersion).toBe(texts.version);
  });
});

describe('B-ággal', () => {
  it('rand < 0.5 → B: verziók, látható cím, aria-label, animáció-horog', () => {
    const root = mount(true);
    expect(pickBannerVariant(root, 0.1)).toBe('b');
    expect(root.dataset.bannerVersion).toBe(SBO_BANNER_VERSION_B);
    expect(root.dataset.textVersion).toBe(variantB.textVersion);
    expect(root.querySelector('[data-sb-title="a"]')!.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('[data-sb-title="b"]')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-sb-layer="banner"]')!.getAttribute('aria-label')).toBe(TITLE_B);
    expect(root.dataset.sbActiveVariant).toBe('b');
  });

  it('rand ≥ 0.5 → A marad, a B-cím rejtve', () => {
    const root = mount(true);
    expect(pickBannerVariant(root, 0.5)).toBe('a');
    expect(root.dataset.bannerVersion).toBe(SBO_BANNER_VERSION);
    expect(root.querySelector('[data-sb-title="b"]')!.hasAttribute('hidden')).toBe(true);
  });

  it('a választás semmit nem tárol (sem süti, sem storage) — döntés előtt tilos lenne', () => {
    const root = mount(true);
    pickBannerVariant(root, 0.1);
    expect(document.cookie).toBe('');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('a gombparitás a B-ágban is áll', () => {
    const root = mount(true);
    pickBannerVariant(root, 0.1);
    const accept = root.querySelector('[data-sb-action="accept"]')!;
    const reject = root.querySelector('[data-sb-action="reject"]')!;
    expect(accept.className).toBe(reject.className);
    // A B-ág CSS-e csak a kártyát mozgatja, gombot nem ér el.
    const bRules = consentBannerCss().split('\n').filter((l) => l.includes('data-sb-active-variant'));
    expect(bRules.length).toBeGreaterThan(0);
    for (const rule of bRules) expect(rule).not.toMatch(/sb-cbtn/);
  });

  it('a B-cím escape-elve kerül a markupba', () => {
    document.body.innerHTML = renderConsentBannerHtml(texts, '/p', {
      title: '<img src=x onerror=alert(1)>',
      textVersion: 'x',
    });
    expect(document.body.innerHTML).not.toContain('<img');
  });
});

describe('variantTextVersion', () => {
  it('determinisztikus, címenként eltér, és átmegy a gateway VERSION_RE-jén (≤64)', () => {
    const a = variantTextVersion(texts.version, TITLE_B);
    expect(a).toBe(variantTextVersion(texts.version, TITLE_B));
    expect(a).not.toBe(variantTextVersion(texts.version, 'Other title'));
    expect(a).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  });
});
