/**
 * Kimenő request-ek osztályozása + a Google-ping tartalmának vizsgálata.
 *
 * Tiszta függvények, hálózat nélkül tesztelhetők (lásd
 * tests/compliance/compliance-lib.test.ts).
 */

/** @typedef {'ga4'|'gtm'|'google_ads'|'meta'|'cmp'|'gateway'|'other'} RequestCategory */

const RULES = [
  // SORREND SZÁMÍT: a DOMAIN-találat erősebb, mint az útvonal-minta. A
  // `stats.g.doubleclick.net/j/collect` a GA4→Ads híd (Google Signals /
  // remarketing) — mindkét minta illik rá, de HIRDETÉSI végpont, és a riportban
  // az a hasznos besorolás (a „megy-e Ads-ping elutasítás után" kérdés miatt).
  // A megfelelőségi ítéletet ez nem érinti: mindkét kategória consent-kötött.
  { category: 'google_ads', re: /(^|\.)googleadservices\.com|(^|\.)doubleclick\.net|(^|\.)googlesyndication\.com|google\.[a-z.]+\/(pagead|ads|ccm)\//i },
  // GA4 / Universal Analytics mérés
  { category: 'ga4', re: /(^|\.)google-analytics\.com|(^|\.)analytics\.google\.com|\/(g|j|mp)\/collect/i },
  // A GTM konténer maga (és a gtag.js loader)
  { category: 'gtm', re: /(^|\.)googletagmanager\.com/i },
  // Meta Pixel
  { category: 'meta', re: /(^|\.)facebook\.(com|net)|(^|\.)fbcdn\.net/i },
  // A CMP maga (esszenciális — a bannernek be KELL töltenie)
  // A `-` is határ: a CookieYes VALÓDI CDN-je `cdn-cookieyes.com` (nem aldomain).
  // Enélkül a CMP saját szkriptje `other`-nek látszana — a riport pedig azt
  // sugallná, hogy az oldal ismeretlen harmadik felet tölt.
  { category: 'cmp', re: /(^|\.|-)cookieyes\.com|(^|\.)cookielaw\.org|(^|\.)cookiebot\.com/i },
  // A saját gateway-ünk
  { category: 'gateway', re: /\/api\/event\/|tracking\.soborbo\.co\.uk/i }
];

/** A marketing/analitika kategóriák, amiknek consent ELŐTT nem szabadna futniuk. */
export const CONSENT_BOUND_CATEGORIES = ['ga4', 'google_ads', 'meta', 'gateway'];

/**
 * A GTM SZÁNDÉKOSAN külön kategória: a konténer betöltése önmagában nem
 * jogsértés (Basic Consent Mode-ban viszont nem szabadna betöltenie döntés
 * előtt) — ezt külön ellenőrzés értékeli, nem ez a lista.
 */
export function classifyRequest(url) {
  for (const rule of RULES) if (rule.re.test(url)) return rule.category;
  return 'other';
}

/** Első fél-e a kérés (a mért site saját registrable domainje). */
export function isFirstParty(url, siteUrl) {
  try {
    const a = new URL(url).hostname.toLowerCase();
    const b = new URL(siteUrl).hostname.toLowerCase();
    const reg = (h) => h.split('.').slice(-2).join('.');
    return a === b || reg(a) === reg(b);
  } catch {
    return false;
  }
}

/**
 * Azonosító-szivárgás egy Google/Meta pingben. A denied-állapotú
 * (cookieless) pingbe SOHA nem kerülhet saját user_id, custom dimenzió vagy PII
 * — ez a mód-független kód-invariáns a v4 terv 8. függelékéből.
 *
 * @returns {{ params: string[], hasEmailLike: boolean, hasClickId: boolean }}
 */
export function inspectPingForIdentifiers(url) {
  const found = new Set();
  let hasEmailLike = false;
  let hasClickId = false;
  try {
    const u = new URL(url);
    for (const [key, value] of u.searchParams.entries()) {
      const k = key.toLowerCase();
      // GA4: `uid` = user_id, `up.*`/`upn.*` = user property, `ep.*` = event param.
      if (k === 'uid' || k === 'user_id' || k.startsWith('up.') || k.startsWith('upn.') || k.startsWith('ep.')) {
        found.add(key);
      }
      // Meta: `ud[em]`, `ud[ph]`; Ads: `em`, `pii`.
      if (/^ud\[|^em$|^ph$|^pii$|^cd\[/i.test(key)) found.add(key);
      if (k === 'gclid' || k === 'gbraid' || k === 'wbraid' || k === 'gclaw' || k === 'gcldc') {
        found.add(key);
        hasClickId = true;
      }
      if (/@/.test(value) || /%40/i.test(value)) hasEmailLike = true;
      // A `dl` (document location) tartalmazhat továbbadott click ID-t.
      if ((k === 'dl' || k === 'dr' || k === 'u') && /gclid=|fbclid=|gbraid=|wbraid=/i.test(value)) {
        found.add(`${key}(url-embedded click id)`);
        hasClickId = true;
      }
    }
    if (/@/.test(decodeURIComponent(u.hash || ''))) hasEmailLike = true;
  } catch {
    /* nem parse-olható URL — nincs mit állítani */
  }
  return { params: [...found], hasEmailLike, hasClickId };
}

/** Rövidített, riportba tehető request-alak (a query-t levágjuk). */
export function summarizeRequest(entry) {
  let short = entry.url;
  try {
    const u = new URL(entry.url);
    short = `${u.hostname}${u.pathname}`;
  } catch { /* */ }
  return {
    t: entry.t,
    category: entry.category,
    method: entry.method,
    url: short,
    full_url_len: entry.url.length
  };
}
