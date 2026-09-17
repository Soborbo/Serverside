/**
 * Soborbo CMP — a site-on TÉNYLEGESEN futó eszközök, és belőlük a banner szövege.
 *
 * MIÉRT. A 2026-08-a szöveg flotta-egységes volt: minden site bannere
 * „Google- és Meta-hirdetéseink" mérésére kért engedélyt. A Befilón (az első
 * sbo-site, 2026-09-17) viszont nem futott sem Meta pixel, sem Google Ads
 * fiók, a Microsoft Clarity pedig igen — a látogató tehát egy pontatlan és a
 * valóságnál ijesztőbb szöveget olvasott, a ténylegesen futó eszközt pedig
 * nem nevezte meg senki (Art 13(1)(e)). Egy site-onként kézzel írt szöveg
 * viszont minden bekötésnél újra elcsúszna.
 *
 * MEGOLDÁS. A site EGY build-env sorban felsorolja, mi fut
 * (`PUBLIC_TRACKING_VENDORS=ga4,clarity,google_ec`), a szöveg ebből áll
 * össze, verzió-rögzített, jogilag átnézett töredékekből. Ugyanez a lista
 * szűri a <CookiePolicy /> süti-tábláját — a banner és a tábla nem tud
 * szétcsúszni.
 *
 * BIZONYÍTÉK (GDPR Art. 7(1)). A consent_log.consent_text_version a töredék-
 * verzió ÉS a rendezett vendor-lista: `2026-09-a.clarity_ga4_google_ec`. Ebből
 * a Git-történettel együtt determinisztikusan visszaállítható, MIT olvasott a
 * látogató.
 */

export type VendorCategory = 'analytics' | 'marketing';

export interface VendorDef {
  category: VendorCategory;
  /** A banner listájában megjelenő RÖVID név (a banner rövidsége az elfogadás egyik fő tényezője). */
  label: { hu: string; en: string };
  /** A panel kategória-leírásában megjelenő, magyarázó név (ha eltér a rövidtől). */
  detail?: { hu: string; en: string };
  /** A cég, ami az adatot kapja — a harmadik fél NÉVVEL (ICO, NAIH). */
  org: string;
  /** Kerül-e adat az Egyesült Államokba (a transzfer-mondat ebből jön). */
  usTransfer: boolean;
  /** A <CookiePolicy /> inventory `vendor` kulcsa, ha van saját süti-sora. */
  inventoryVendor?: string;
}

/**
 * A flottán engedett eszközök. Új eszköz = új bejegyzés ITT + (ha sütit ír)
 * inventory-sor; ismeretlen azonosító a buildben hangos hiba, nem néma kihagyás.
 */
export const VENDORS: Readonly<Record<string, VendorDef>> = {
  ga4: {
    category: 'analytics',
    label: { hu: 'Google Analytics', en: 'Google Analytics' },
    org: 'Google',
    usTransfer: true,
  },
  clarity: {
    category: 'analytics',
    label: { hu: 'Microsoft Clarity', en: 'Microsoft Clarity' },
    org: 'Microsoft',
    usTransfer: true,
    inventoryVendor: 'clarity',
  },
  hotjar: {
    category: 'analytics',
    label: { hu: 'Hotjar', en: 'Hotjar' },
    org: 'Hotjar',
    usTransfer: false,
    inventoryVendor: 'hotjar',
  },
  google_ec: {
    category: 'marketing',
    label: { hu: 'Google (bővített konverziók)', en: 'Google (enhanced conversions)' },
    detail: {
      hu: 'Google bővített konverziók (az ajánlatkérés egyeztetése a Google hirdetésméréssel, titkosított – hash-elt – elérhetőséggel)',
      en: 'Google enhanced conversions (matching an enquiry to Google advertising measurement using hashed contact details)',
    },
    org: 'Google',
    usTransfer: true,
  },
  google_ads: {
    category: 'marketing',
    label: { hu: 'Google Ads', en: 'Google Ads' },
    org: 'Google',
    usTransfer: true,
  },
  meta: {
    category: 'marketing',
    label: { hu: 'Meta (Facebook, Instagram)', en: 'Meta (Facebook, Instagram)' },
    org: 'Meta',
    usTransfer: true,
  },
};

/** Ha a site nem ad meg listát: a 2026-08-a szöveg tartalmának megfelelő alapkészlet. */
export const DEFAULT_VENDORS: readonly string[] = ['ga4', 'google_ads', 'meta'];

/**
 * `"ga4, clarity"` → `['clarity', 'ga4']` (rendezett, egyedi). Ismeretlen
 * azonosító → HIBA: egy elgépelt `clarty` különben némán kimaradna a
 * tájékoztatóból, miközben a GTM-ben fut.
 */
export function parseVendors(raw: string | undefined | null, opts: { strict?: boolean } = {}): string[] {
  if (raw === undefined || raw === null || raw.trim() === '') return [...DEFAULT_VENDORS].sort();
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !(id in VENDORS));
  // A böngészőben (config.ts) nem dobhatunk: egy elgépelés nem döntheti le a
  // mérést. A BUILD viszont strict — a <ConsentBanner /> ott hangosan bukik.
  if (unknown.length && !opts.strict) return ids.filter((id) => id in VENDORS).sort();
  if (unknown.length) {
    throw new Error(
      `PUBLIC_TRACKING_VENDORS: ismeretlen eszköz(ök): ${unknown.join(', ')}. Engedett: ${Object.keys(VENDORS).join(', ')}.`
    );
  }
  return ids.sort();
}

/** consent_log.consent_text_version — a gateway VERSION_RE-jének megfelel (`[A-Za-z0-9_.-]`). */
export function composedTextVersion(baseVersion: string, vendors: readonly string[]): string {
  return `${baseVersion}.${[...vendors].sort().join('_') || 'none'}`;
}

/** Az inventory `vendor` kulcsai, amelyeket a süti-tábla megjeleníthet. */
export function inventoryVendorsFor(vendors: readonly string[]): string[] {
  return vendors.map((v) => VENDORS[v]?.inventoryVendor).filter((v): v is string => Boolean(v));
}

function joinList(items: string[], lang: 'hu' | 'en'): string {
  if (items.length <= 1) return items.join('');
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')} ${lang === 'hu' ? 'és' : 'and'} ${last}`;
}

/** A 2026-09-a töredékfájl alakja (consent-texts/<v>/<lang>.json). */
export interface VendorTextTemplate {
  version: string;
  lang: 'hu' | 'en';
  banner: {
    title: string;
    lead: string;
    analytics: string;
    marketing: string;
    none: string;
    transfer: string;
    accept: string;
    reject: string;
    settings: string;
  };
  panel: {
    title: string;
    intro: string;
    save: string;
    accept_all: string;
    reject_all: string;
    categories: {
      necessary: { label: string; always_on: string; body: string };
      analytics: { label: string; body: string; none: string };
      marketing: { label: string; body: string; none: string };
    };
    policy_link: string;
  };
  footer_link: string;
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`consent-szöveg: ismeretlen helyőrző {${k}}`);
    return vars[k];
  });
}

/**
 * A töredékekből a ConsentBannerTexts alakú, KÉSZ szöveg. Csak azt nevezi
 * meg, ami a listában van — és a listában lévőt mindig megnevezi.
 */
export function composeBannerTexts(tpl: VendorTextTemplate, vendors: readonly string[]) {
  const lang = tpl.lang;
  // Megjelenítési sorrend = a VENDORS nyilvántartás sorrendje (a fő eszköz elöl);
  // a verzió-azonosító ettől függetlenül rendezett.
  const of = (cat: VendorCategory) =>
    Object.keys(VENDORS).filter((v) => vendors.includes(v) && VENDORS[v].category === cat);
  const labels = (ids: string[]) => ids.map((v) => VENDORS[v].label[lang]);
  const details = (ids: string[]) => ids.map((v) => (VENDORS[v].detail ?? VENDORS[v].label)[lang]);
  const analytics = of('analytics');
  const marketing = of('marketing');
  const orgs = [
    ...new Set(Object.keys(VENDORS).filter((v) => vendors.includes(v) && VENDORS[v].usTransfer).map((v) => VENDORS[v].org)),
  ];

  const parts = [tpl.banner.lead];
  if (analytics.length) parts.push(fill(tpl.banner.analytics, { list: joinList(labels(analytics), lang) }));
  if (marketing.length) parts.push(fill(tpl.banner.marketing, { list: joinList(labels(marketing), lang) }));
  if (!analytics.length && !marketing.length) parts.push(tpl.banner.none);
  if (orgs.length) parts.push(fill(tpl.banner.transfer, { orgs: joinList(orgs, lang) }));

  const c = tpl.panel.categories;
  return {
    version: composedTextVersion(tpl.version, vendors),
    lang,
    banner: {
      title: tpl.banner.title,
      body: parts.join(' '),
      accept: tpl.banner.accept,
      reject: tpl.banner.reject,
      settings: tpl.banner.settings,
    },
    panel: {
      title: tpl.panel.title,
      intro: tpl.panel.intro,
      save: tpl.panel.save,
      accept_all: tpl.panel.accept_all,
      reject_all: tpl.panel.reject_all,
      categories: {
        necessary: c.necessary,
        analytics: {
          label: c.analytics.label,
          body: analytics.length ? fill(c.analytics.body, { list: joinList(details(analytics), lang) }) : c.analytics.none,
        },
        marketing: {
          label: c.marketing.label,
          body: marketing.length ? fill(c.marketing.body, { list: joinList(details(marketing), lang) }) : c.marketing.none,
        },
      },
      policy_link: tpl.panel.policy_link,
    },
    footer_link: tpl.footer_link,
  };
}
