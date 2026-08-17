/**
 * Kimenő request-ek osztályozása + a Google-ping tartalmának vizsgálata.
 *
 * Tiszta függvények, hálózat nélkül tesztelhetők (lásd
 * tests/compliance/compliance-lib.test.ts).
 */

/** @typedef {'ga4'|'gtm'|'google_ads'|'meta'|'cmp'|'gateway'|'other'} RequestCategory */

const RULES = [
  // ELSŐ FÉLEN PROXYZOTT Google-mérés (Google Tag Gateway / server-side tagging):
  // a hit a site SAJÁT domainjén megy, egyedi útvonal-prefixszel
  // (`/meres/ga/g/c`, `/f807/gs/ccm/collect`), tehát sem a domain-, sem az
  // útvonal-minta nem fogja meg. A `tid=G-|GT-|AW-` query viszont egyértelmű.
  // Enélkül a legfontosabb ellenőrzés (megy-e mérés consent ELŐTT) pont a
  // proxyzott site-okon adna hamis PASS-t — a flotta felén.
  { category: 'google_ads', re: /[?&]tid=AW-/i },
  { category: 'ga4', re: /[?&]tid=(G|GT)-/i },
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
    // NEM „utolsó két címke": többcímkés public suffixnél (`agykontroll.co.uk`)
    // az `co.uk`-ra redukálna, és MINDEN *.co.uk hostot első félnek venne — a
    // safety-net így idegen harmadik felek kéréseit abortálná, ráadásul
    // first-party írásként jelentené őket. Publiksuffix-lista nélkül a helyes
    // szabály a site SAJÁT hostjához való viszony: azonos, vagy annak aldomainje
    // (a www/apex párt külön kezelve).
    const base = b.replace(/^www\./, '');
    const host = a.replace(/^www\./, '');
    return host === base || host.endsWith(`.${base}`);
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
export function inspectPingForIdentifiers(url, body = null) {
  const found = new Set();
  let hasEmailLike = false;
  let hasClickId = false;

  /**
   * Egy kulcs/érték pár vizsgálata (query-ből VAGY törzsből). A `source` CSAK a
   * jelentésben jelenik meg — az ILLESZTÉS mindig a nyers kulcson fut, különben
   * egy „body:" prefix minden mintát elrontana (és a törzs-vizsgálat csendben
   * semmit nem találna).
   */
  const inspectPair = (key, value, source = null) => {
    const k = key.toLowerCase();
    const label = source ? `${source}:${key}` : key;
    if (k === 'uid' || k === 'user_id' || k.startsWith('up.') || k.startsWith('upn.') || k.startsWith('ep.')) {
      found.add(label);
    }
    if (/^ud\[|^em$|^ph$|^pii$|^cd\[/i.test(key)) found.add(label);
    if (k === 'gclid' || k === 'gbraid' || k === 'wbraid' || k === 'gclaw' || k === 'gcldc') {
      found.add(label);
      hasClickId = true;
    }
    if (/@/.test(value) || /%40/i.test(value)) hasEmailLike = true;
    if ((k === 'dl' || k === 'dr' || k === 'u') && /gclid=|fbclid=|gbraid=|wbraid=/i.test(value)) {
      found.add(`${label}(url-embedded click id)`);
      hasClickId = true;
    }
  };

  // A GA4 POST-törzse soronként `k=v&k=v` (event-batch); a Meta form-encoded.
  // URL nélkül vizsgálva ez a tartalom láthatatlan maradna, és a „reject után
  // nincs azonosító" ellenőrzés hamis PASS-t adna.
  if (typeof body === 'string' && body.length > 0) {
    for (const line of body.split(/\r?\n/)) {
      if (!line) continue;
      try {
        for (const [k, v] of new URLSearchParams(line).entries()) inspectPair(k, v, 'body');
      } catch { /* nem kulcs/érték alakú törzs */ }
    }
    if (/@/.test(body) || /%40/i.test(body)) hasEmailLike = true;
  }

  try {
    const u = new URL(url);
    for (const [key, value] of u.searchParams.entries()) {
      inspectPair(key, value);
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
    full_url_len: entry.url.length,
    // A törzs jelenléte önmagában is információ: egy POST-ping tartalmát az URL
    // nem mutatja meg, tehát a bizonyítékban látszania kell, hogy néztük.
    has_body: Boolean(entry.body),
    body_len: entry.body ? entry.body.length : 0
  };
}
