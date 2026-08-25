/**
 * F7 · P8 — VENDOR-REGISZTER.
 *
 * ── Miért létezik ────────────────────────────────────────────────────────────
 * A `classifyRequest` eddig `'other'`-t adott mindenre, amit nem ismert fel. Az
 * `'other'` viszont a riportban ártalmatlanul nézett ki: egy sose látott
 * heatmap-szkript, egy új chat-widget vagy egy hirdetési retarget-pixel pontosan
 * ugyanúgy jelent meg, mint egy webfont. Vagyis a MÉRÉS HIÁNYA jóváhagyásnak
 * látszott — ugyanaz a hibaosztály, ami ellen a fleet-health (F8) UNKNOWN-ja is
 * épült.
 *
 * Ez a regiszter KIMONDJA, mit ismerünk. Amit nem, az `unknown_vendor` lesz, és
 * a riportban nevesített megállapítás — nem néma `'other'`.
 *
 * ── Miért REPORT-ONLY (egyelőre) ─────────────────────────────────────────────
 * A harness élő oldalakat tölt, tehát hálózatfüggő, és szándékosan NINCS CI-ban.
 * Egy azonnali „ismeretlen vendor → DEPLOY FAIL" kapu első dolga az lenne, hogy
 * egy CDN-átnevezés miatt hamis pirosat adjon, és két hét alatt megtanulnánk
 * figyelmen kívül hagyni. A terv sorrendje: **report-only → alert → gate**. Ez a
 * commit a report-only lépés.
 *
 * ── consent_class ────────────────────────────────────────────────────────────
 *   essential   — a működéshez kell (CMP maga, fizetés, bot-védelem). Consent
 *                 nélkül is futhat.
 *   functional  — kényelmi/megjelenítési (webfont, statikus CDN, chat).
 *                 Vitatható, de nem mérés és nem hirdetés.
 *   analytics   — mérés. Consent-kötött.
 *   marketing   — hirdetés/remarketing. Consent-kötött.
 *   conditional — önmagában nem jogsértés, de a viselkedése az (GTM konténer:
 *                 Basic Consent Mode-ban döntés előtt nem szabadna betöltenie).
 */

/** @typedef {'essential'|'functional'|'analytics'|'marketing'|'conditional'} ConsentClass */

/**
 * A regiszter. A SORREND SZÁMÍT: az első illeszkedő nyer, mert a specifikusabb
 * mintát tesszük előre (pl. a `stats.g.doubleclick.net` hirdetési végpont a
 * general Google-minták ELŐTT).
 *
 * @type {ReadonlyArray<{id: string, name: string, category: string, consent_class: ConsentClass, re: RegExp, note?: string}>}
 */
export const VENDOR_REGISTRY = [
  // ── Google mérés/hirdetés ─────────────────────────────────────────────────
  // Első fél-en PROXYZOTT Google-mérés (Tag Gateway / server-side tagging): a hit
  // a site SAJÁT domainjén megy, tehát sem domain, sem útvonal nem fogja meg — a
  // `tid=` query viszont egyértelmű. Enélkül a flotta felén hamis PASS lenne.
  { id: 'google_ads_proxied', name: 'Google Ads (proxied)', category: 'google_ads', consent_class: 'marketing', re: /[?&]tid=AW-/i },
  { id: 'ga4_proxied', name: 'GA4 (proxied)', category: 'ga4', consent_class: 'analytics', re: /[?&]tid=(G|GT)-/i },
  {
    id: 'google_ads',
    name: 'Google Ads / DoubleClick',
    category: 'google_ads',
    consent_class: 'marketing',
    re: /(^|\.)googleadservices\.com|(^|\.)doubleclick\.net|(^|\.)googlesyndication\.com|google\.[a-z.]+\/(pagead|ads|ccm)\//i
  },
  { id: 'ga4', name: 'Google Analytics', category: 'ga4', consent_class: 'analytics', re: /(^|\.)google-analytics\.com|(^|\.)analytics\.google\.com|\/(g|j|mp)\/collect/i },
  {
    id: 'gtm',
    name: 'Google Tag Manager',
    category: 'gtm',
    consent_class: 'conditional',
    re: /(^|\.)googletagmanager\.com/i,
    note: 'a konténer betöltése önmagában nem jogsértés; a Basic Consent Mode-os időzítést külön ellenőrzés értékeli'
  },

  // ── Meta ──────────────────────────────────────────────────────────────────
  { id: 'meta', name: 'Meta Pixel', category: 'meta', consent_class: 'marketing', re: /(^|\.)facebook\.(com|net)|(^|\.)fbcdn\.net/i },

  // ── Consent-kezelők (esszenciális: a bannernek be KELL töltenie) ───────────
  {
    id: 'cookieyes',
    name: 'CookieYes',
    category: 'cmp',
    consent_class: 'essential',
    // A `-` is határ: a VALÓDI CDN `cdn-cookieyes.com`, nem aldomain.
    re: /(^|\.|-)cookieyes\.com/i
  },
  { id: 'onetrust', name: 'OneTrust', category: 'cmp', consent_class: 'essential', re: /(^|\.)cookielaw\.org|(^|\.)onetrust\.com/i },
  { id: 'cookiebot', name: 'Cookiebot', category: 'cmp', consent_class: 'essential', re: /(^|\.)cookiebot\.com/i },

  // ── Saját infrastruktúra ───────────────────────────────────────────────────
  {
    id: 'soborbo_gateway',
    name: 'Soborbo Tracking Gateway',
    category: 'gateway',
    consent_class: 'analytics',
    re: /\/api\/event\/|tracking\.soborbo\.co\.uk/i,
    note: 'a saját szerveroldali gateway-ünk — consent-kötött, mert konverziót továbbít'
  },

  // ── Egyéb hirdetési platformok (a flottán előfordulhatnak) ────────────────
  { id: 'tiktok', name: 'TikTok', category: 'tiktok', consent_class: 'marketing', re: /(^|\.)tiktok\.com|(^|\.)tiktokcdn\.com|analytics\.tiktok\.com/i },
  { id: 'linkedin', name: 'LinkedIn', category: 'linkedin', consent_class: 'marketing', re: /(^|\.)linkedin\.com|(^|\.)licdn\.com/i },
  { id: 'microsoft_ads', name: 'Microsoft Advertising (Bing)', category: 'microsoft_ads', consent_class: 'marketing', re: /(^|\.)bat\.bing\.com|(^|\.)ads\.microsoft\.com/i },
  { id: 'pinterest', name: 'Pinterest', category: 'pinterest', consent_class: 'marketing', re: /(^|\.)pinterest\.com|(^|\.)pinimg\.com/i },
  { id: 'hotjar', name: 'Hotjar', category: 'analytics_other', consent_class: 'analytics', re: /(^|\.)hotjar\.(com|io)/i },
  { id: 'clarity', name: 'Microsoft Clarity', category: 'analytics_other', consent_class: 'analytics', re: /(^|\.)clarity\.ms/i },

  // ── Funkcionális / esszenciális harmadik felek ────────────────────────────
  { id: 'google_fonts', name: 'Google Fonts', category: 'fonts', consent_class: 'functional', re: /(^|\.)fonts\.googleapis\.com|(^|\.)fonts\.gstatic\.com/i },
  { id: 'recaptcha', name: 'Google reCAPTCHA', category: 'bot_protection', consent_class: 'essential', re: /google\.[a-z.]+\/recaptcha\/|(^|\.)recaptcha\.net/i },
  { id: 'turnstile', name: 'Cloudflare Turnstile', category: 'bot_protection', consent_class: 'essential', re: /challenges\.cloudflare\.com/i },
  { id: 'cloudflare_insights', name: 'Cloudflare Web Analytics', category: 'analytics_other', consent_class: 'analytics', re: /(^|\.)cloudflareinsights\.com/i },
  { id: 'stripe', name: 'Stripe', category: 'payment', consent_class: 'essential', re: /(^|\.)stripe\.(com|network)/i },
  { id: 'youtube', name: 'YouTube embed', category: 'video', consent_class: 'marketing', re: /(^|\.)youtube(-nocookie)?\.com|(^|\.)ytimg\.com/i, note: 'a sima youtube.com embed hirdetési sütiket tesz — a -nocookie változat nem' },
  { id: 'vimeo', name: 'Vimeo embed', category: 'video', consent_class: 'functional', re: /(^|\.)vimeo\.com|(^|\.)vimeocdn\.com/i },
  { id: 'google_maps', name: 'Google Maps', category: 'maps', consent_class: 'functional', re: /maps\.google\.[a-z.]+|maps\.googleapis\.com|maps\.gstatic\.com/i },
  { id: 'gstatic', name: 'Google static assets', category: 'cdn', consent_class: 'functional', re: /(^|\.)gstatic\.com/i },
  { id: 'jsdelivr', name: 'jsDelivr CDN', category: 'cdn', consent_class: 'functional', re: /(^|\.)jsdelivr\.net/i },
  { id: 'unpkg', name: 'unpkg CDN', category: 'cdn', consent_class: 'functional', re: /(^|\.)unpkg\.com/i },
  { id: 'cdnjs', name: 'cdnjs (Cloudflare)', category: 'cdn', consent_class: 'functional', re: /(^|\.)cdnjs\.cloudflare\.com/i },
  { id: 'tawk', name: 'Tawk.to chat', category: 'chat', consent_class: 'functional', re: /(^|\.)tawk\.to/i },
  { id: 'crisp', name: 'Crisp chat', category: 'chat', consent_class: 'functional', re: /(^|\.)crisp\.chat/i },
  { id: 'sentry', name: 'Sentry', category: 'error_tracking', consent_class: 'functional', re: /(^|\.)sentry\.io|(^|\.)ingest\.sentry\.io/i },
  { id: 'unas', name: 'UNAS webshop platform', category: 'platform', consent_class: 'essential', re: /(^|\.)unas\.hu|(^|\.)unas\.eu/i }
];

/** A consent ELŐTT tilos osztályok. A `functional` szándékosan NINCS itt. */
export const CONSENT_BOUND_CLASSES = ['analytics', 'marketing'];

/**
 * Egy kimenő kérés vendor-besorolása.
 *
 * A `known: false` eset a lényeg: az ISMERETLEN harmadik fél NEM olvad bele egy
 * gyűjtő `'other'` kategóriába. A hívó ebből csinál nevesített megállapítást.
 *
 * @param {string} url
 * @param {string|null} siteUrl A mért site URL-je (első fél eldöntéséhez).
 * @param {(url: string, siteUrl: string) => boolean} isFirstPartyFn
 * @returns {{vendor: string|null, name: string|null, category: string, consent_class: ConsentClass|null, known: boolean, first_party: boolean, host: string|null}}
 */
export function classifyVendor(url, siteUrl, isFirstPartyFn) {
  let host = null;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* nem parse-olható URL — a mintaillesztés még futhat rajta */
  }

  for (const v of VENDOR_REGISTRY) {
    if (v.re.test(url)) {
      return {
        vendor: v.id,
        name: v.name,
        category: v.category,
        consent_class: v.consent_class,
        known: true,
        // A PROXYZOTT Google-mérés első fél-en megy, de attól még Google-vendor.
        first_party: Boolean(siteUrl && isFirstPartyFn(url, siteUrl)),
        host
      };
    }
  }

  const firstParty = Boolean(siteUrl && isFirstPartyFn(url, siteUrl));
  if (firstParty) {
    // A site SAJÁT kérése (kép, CSS, saját API). Nem vendor, nem ismeretlen —
    // ezt NEM soroljuk a megállapítások közé, különben a zaj elnyomná a jelet.
    return {
      vendor: null,
      name: null,
      category: 'first_party',
      consent_class: null,
      known: true,
      first_party: true,
      host
    };
  }

  return {
    vendor: null,
    name: null,
    category: 'unknown_vendor',
    consent_class: null,
    known: false,
    first_party: false,
    host
  };
}
