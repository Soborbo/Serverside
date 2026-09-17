/**
 * A site-onkénti banner-szöveg (2026-09-a) gépi garanciái.
 *
 * A kockázat kétirányú, ugyanúgy, mint a süti-táblánál: a banner NE nevezzen
 * meg olyan eszközt, ami a site-on nem fut (pontatlan, ijesztőbb szöveg), és
 * MINDEN futó eszközt nevezzen meg (Art 13(1)(e), ICO/NAIH: harmadik fél
 * NÉVVEL). A 2026-09-17-i Befilo-bannert pont ez a hiba érte: Meta-hirdetésekre
 * kért engedélyt Meta pixel nélkül, a futó Clarity-t pedig nem nevezte meg.
 */
import { describe, it, expect } from 'vitest';
import {
  VENDORS,
  DEFAULT_VENDORS,
  parseVendors,
  composedTextVersion,
  composeBannerTexts,
  inventoryVendorsFor,
  type VendorTextTemplate,
} from '../lib/consent-vendors';
import { renderConsentBannerHtml } from '../lib/consent-banner-ui';
import hu from '../consent-texts/2026-09-a/hu.json';
import en from '../consent-texts/2026-09-a/en.json';
import huCanonical from '../../consent-texts/2026-09-a/hu.json';
import enCanonical from '../../consent-texts/2026-09-a/en.json';
import inventory from '../consent-texts/cookie-inventory.json';

const TEMPLATES: Array<[string, VendorTextTemplate]> = [
  ['hu', hu as VendorTextTemplate],
  ['en', en as VendorTextTemplate],
];

/** Csak a látogatónak megjelenő szöveg (a _comment/_copy_rules meta nem UI). */
function visible(t: ReturnType<typeof composeBannerTexts>): string {
  return JSON.stringify({ banner: t.banner, panel: t.panel, footer: t.footer_link });
}

describe('parseVendors', () => {
  it('rendez, egyedít, szóközt tűr', () => {
    expect(parseVendors(' clarity, ga4 ,ga4')).toEqual(['clarity', 'ga4']);
  });
  it('üres env = a 2026-08-a tartalmának megfelelő alapkészlet', () => {
    expect(parseVendors(undefined)).toEqual([...DEFAULT_VENDORS].sort());
    expect(parseVendors('')).toEqual([...DEFAULT_VENDORS].sort());
  });
  it('build-időben (strict) az ismeretlen azonosító HANGOS hiba', () => {
    expect(() => parseVendors('ga4,clarty', { strict: true })).toThrow(/clarty/);
  });
  it('böngészőben (nem strict) az ismeretlen kimarad, de a mérés nem dől le', () => {
    expect(parseVendors('ga4,clarty')).toEqual(['ga4']);
  });
});

describe('verzió-azonosító (consent_log.consent_text_version)', () => {
  it('determinisztikus a sorrendtől függetlenül, és átmegy a gateway VERSION_RE-jén', () => {
    const a = composedTextVersion('2026-09-a', ['google_ec', 'ga4', 'clarity']);
    const b = composedTextVersion('2026-09-a', ['clarity', 'google_ec', 'ga4']);
    expect(a).toBe(b);
    expect(a).toBe('2026-09-a.clarity_ga4_google_ec');
    expect(a).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  });
  it('a leghosszabb lehetséges lista is belefér a 64 karakterbe', () => {
    expect(composedTextVersion('2026-09-a', Object.keys(VENDORS)).length).toBeLessThanOrEqual(64);
  });
});

describe.each(TEMPLATES)('%s: összeállított szöveg', (_lang, tpl) => {
  it('minden listázott eszközt MEGNEVEZ, és csak azokat', () => {
    const vendors = parseVendors('ga4,clarity,google_ec', { strict: true });
    const text = visible(composeBannerTexts(tpl, vendors));
    expect(text).toContain('Google Analytics');
    expect(text).toContain('Microsoft Clarity');
    expect(text).not.toMatch(/Meta|Facebook|Hotjar|Google Ads/);
  });

  it('Befilo-eset: Meta nélkül a banner nem kér Meta-engedélyt', () => {
    const t = composeBannerTexts(tpl, ['ga4', 'google_ec']);
    expect(t.banner.body).not.toMatch(/Meta/);
  });

  it('USA-transzfer mondat a cégnévvel, ha van ilyen eszköz; nincs, ha nincs', () => {
    expect(composeBannerTexts(tpl, ['ga4']).banner.body).toMatch(/Google/);
    const noUs = composeBannerTexts(tpl, ['hotjar']).banner.body;
    expect(noUs).not.toMatch(/United States|Egyesült Államok/);
  });

  it('nincs kitöltetlen helyőrző és nincs tiltott ígéret', () => {
    for (const v of [[], ['ga4'], Object.keys(VENDORS)]) {
      const text = visible(composeBannerTexts(tpl, v));
      expect(text).not.toMatch(/\{\w+\}/);
      expect(text).not.toMatch(/semmilyen adat nem kerül/i);
      expect(text).not.toMatch(/irreleváns hirdetést/i);
      expect(text).not.toMatch(/no data (is|will be) (shared|passed)/i);
    }
  });

  it('marketing-eszköz nélkül a marketing kategória kimondja, hogy nincs', () => {
    const t = composeBannerTexts(tpl, ['ga4']);
    expect(t.panel.categories.marketing.body).toBe(tpl.panel.categories.marketing.none);
  });

  it('a banner rövid marad (a legteljesebb listával is)', () => {
    // A rövidség az elfogadás egyik fő tényezője; a részletes magyarázat a panelé.
    const t = composeBannerTexts(tpl, ['ga4', 'clarity', 'google_ec']);
    expect(t.banner.body.length).toBeLessThan(400);
  });

  it('a gombparitás a b2 markupban is áll: azonos tag és class-lista', () => {
    document.body.innerHTML = renderConsentBannerHtml(composeBannerTexts(tpl, ['ga4']), '/p');
    const accept = document.querySelector('[data-sb-action="accept"]')!;
    const reject = document.querySelector('[data-sb-action="reject"]')!;
    expect(accept.tagName).toBe(reject.tagName);
    expect(accept.className).toBe(reject.className);
    expect(document.getElementById('sb-consent')!.dataset.textVersion).toBe('2026-09-a.ga4');
  });
});

describe('forrás-szinkron', () => {
  it('a package töredékei BITRE azonosak a repo kanonikus consent-texts-ével', () => {
    expect(hu).toEqual(huCanonical);
    expect(en).toEqual(enCanonical);
  });

  it('minden inventoryVendor-kulcshoz van süti-sor a táblában', () => {
    const tableVendors = new Set(
      inventory.entries.map((e) => (e as { vendor?: string }).vendor).filter(Boolean)
    );
    for (const v of inventoryVendorsFor(Object.keys(VENDORS))) {
      expect(tableVendors.has(v), `${v}: nincs süti-sor a cookie-inventory.json-ban`).toBe(true);
    }
  });
});
