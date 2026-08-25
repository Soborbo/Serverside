/**
 * Kimenő request-ek osztályozása + a Google-ping tartalmának vizsgálata.
 *
 * Tiszta függvények, hálózat nélkül tesztelhetők (lásd
 * tests/compliance/compliance-lib.test.ts).
 */

import { VENDOR_REGISTRY, classifyVendor } from './vendor-registry.mjs';

/** @typedef {'ga4'|'gtm'|'google_ads'|'meta'|'cmp'|'gateway'|'other'} RequestCategory */

/**
 * A LEGACY hét kategória. A szabályok MAGA a `vendor-registry.mjs` — egyetlen
 * forrás, hogy a riport vendor-oszlopa és a megfelelőségi ítélet ne tudjon
 * széttartani (két lista előbb-utóbb két igazságot mond).
 */
const LEGACY_CATEGORIES = new Set(['ga4', 'gtm', 'google_ads', 'meta', 'cmp', 'gateway']);

/** A marketing/analitika kategóriák, amiknek consent ELŐTT nem szabadna futniuk. */
export const CONSENT_BOUND_CATEGORIES = ['ga4', 'google_ads', 'meta', 'gateway'];

/**
 * A GTM SZÁNDÉKOSAN külön kategória: a konténer betöltése önmagában nem
 * jogsértés (Basic Consent Mode-ban viszont nem szabadna betöltenie döntés
 * előtt) — ezt külön ellenőrzés értékeli, nem ez a lista.
 */
export function classifyRequest(url) {
  for (const v of VENDOR_REGISTRY) {
    if (v.re.test(url)) return LEGACY_CATEGORIES.has(v.category) ? v.category : 'other';
  }
  return 'other';
}

/**
 * F7 — RÉSZLETES besorolás: melyik NEVESÍTETT vendor, milyen consent-osztályban.
 *
 * A különbség a `classifyRequest`-hez képest nem kozmetikai: az ISMERETLEN
 * harmadik fél itt `known: false`-szal jön vissza, tehát a hívó nevesített
 * megállapítást tud belőle csinálni. A legacy függvény ugyanezt `'other'`-ként
 * adja — abból viszont a riportban semmi nem látszik, és pont ez volt a baj:
 * egy új heatmap-szkript és egy webfont megkülönböztethetetlen volt.
 */
export function classifyRequestDetailed(url, siteUrl) {
  return classifyVendor(url, siteUrl, isFirstParty);
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
