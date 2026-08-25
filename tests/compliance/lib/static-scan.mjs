/**
 * F7 · P8 — STATIKUS FORRÁS-SCAN.
 *
 * ── Miért kell a futásidejű mérés MELLÉ ──────────────────────────────────────
 * A Playwright-harness azt látja, ami EGY betöltésen ténylegesen elindult. Amit
 * nem lát: a feltételesen betöltő trackert (más útvonal, más eszköz, cookie-tól
 * függő ág), a kikommentelt-de-visszakapcsolható snippetet, és azt a site-kódot,
 * ami CSAK adott interakcióra futna. A statikus scan ezt a rést zárja: a
 * forrásban DEKLARÁLT trackerekről és a tiltott hívási mintákról beszél.
 *
 * A kettő különbsége önmagában információ:
 *   - forrásban van, futásidőben nem látszott → feltételes betöltő (nem hiba,
 *     de tudni kell róla, mert a futásidejű PASS nem fedi le);
 *   - futásidőben látszott, forrásban nincs   → GTM injektálta (a konténer
 *     tartalma a P7 live-GTM conformance dolga).
 *
 * ── Amit ez a modul NEM tud ──────────────────────────────────────────────────
 * Egy bundle-ölt/minifikált fájlból NEM lehet megmondani, hogy egy `fbq(` hívást
 * a SITE szerzője írta-e, vagy a mi tracking-csomagunk hozta be. Az INV-005/006
 * szabály („a site-kódban tilos nyers consent-parse / közvetlen fbq/gtag") ezért
 * itt REPORT-ONLY: nevesítjük a találatot bizonyítékkal, és ember dönt. Ami
 * viszont a szerzőtől függetlenül jogsértés — PII a dataLayerben (CLAUDE.md 15.) —,
 * az FAIL.
 *
 * Tiszta függvények: a hálózati letöltés a hívóé, itt csak a szövegek jönnek be.
 */

const PASS = 'PASS';
const FAIL = 'FAIL';
const INFO = 'INFO';
const NA = 'N-A';

const check = (id, status, detail, evidence = null) => ({ id, status, detail, evidence });

/**
 * Tiltott / figyelendő hívási minták.
 *
 * A `severity: 'fail'` KIZÁRÓLAG azoknál, ahol a minta önmagában jogsértés a
 * szerzőtől függetlenül.
 */
const PATTERNS = [
  {
    id: 'pii_in_datalayer',
    severity: 'fail',
    // CLAUDE.md 15.: a kliensoldali dataLayer.push SOHA nem tartalmazhat PII-t.
    // Az F12-es bámészkodó látja — GDPR Article 32 kockázat.
    re: /dataLayer\s*\.\s*push\s*\(\s*\{[^}]{0,400}?\b(user_data|email|phone|phone_number|first_name|last_name)\b\s*:/i,
    label: 'PII a dataLayer.push-ban (CLAUDE.md 15.)'
  },
  {
    id: 'raw_consent_parse',
    severity: 'report',
    // INV-005: a site-kód ne parse-oljon nyers consent-sütit — a csomag dolga.
    re: /getCkyConsent\s*\(|document\.cookie[^;\n]{0,120}cookieyes-consent|cookieyes-consent['"]?\s*\)/i,
    label: 'nyers consent-parse a forrásban (INV-005)'
  },
  {
    id: 'direct_pixel_call',
    severity: 'report',
    // INV-006: közvetlen fbq/gtag hívás. A bundle-ből nem eldönthető, ki írta.
    re: /\bfbq\s*\(\s*['"](init|track)['"]|\bgtag\s*\(\s*['"](config|event)['"]/i,
    label: 'közvetlen fbq/gtag hívás (INV-006)'
  }
];

/** Forrásban DEKLARÁLT tracker-azonosítók. */
const DECLARED = [
  { id: 'gtm_container', re: /\bGTM-[A-Z0-9]{4,10}\b/g, label: 'GTM konténer' },
  { id: 'ga4_measurement', re: /\b(G|GT)-[A-Z0-9]{6,12}\b/g, label: 'GA4 measurement ID' },
  { id: 'google_ads_conversion', re: /\bAW-\d{6,12}\b/g, label: 'Google Ads conversion ID' },
  { id: 'meta_pixel', re: /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/g, label: 'Meta pixel ID' }
];

/**
 * @param {Array<{url: string, text: string}>} sources HTML + a letöltött szkriptek.
 * @returns {{findings: Array<object>, declared: Array<object>, scanned: Array<{url: string, bytes: number}>}}
 */
export function scanSource(sources) {
  const findings = [];
  /** @type {Map<string, {id: string, label: string, values: Set<string>, sources: Set<string>}>} */
  const declared = new Map();
  const scanned = [];

  for (const src of sources) {
    const text = typeof src.text === 'string' ? src.text : '';
    scanned.push({ url: src.url, bytes: text.length });
    if (!text) continue;

    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (m) {
        findings.push({
          id: p.id,
          severity: p.severity,
          label: p.label,
          source: src.url,
          // A találatot RÖVIDÍTVE tesszük a riportba: a nyers környezet PII-t is
          // tartalmazhat, márpedig egy megfelelőségi riport nem szivárogtathat.
          excerpt: m[0].slice(0, 120)
        });
      }
    }

    for (const d of DECLARED) {
      const re = new RegExp(d.re.source, d.re.flags);
      let hit;
      while ((hit = re.exec(text)) !== null) {
        const value = hit[1] && /^\d+$/.test(hit[1]) ? hit[1] : hit[0];
        const entry = declared.get(d.id) ?? { id: d.id, label: d.label, values: new Set(), sources: new Set() };
        entry.values.add(value);
        entry.sources.add(src.url);
        declared.set(d.id, entry);
      }
    }
  }

  return {
    findings,
    declared: [...declared.values()].map((e) => ({
      id: e.id,
      label: e.label,
      values: [...e.values],
      sources: [...e.sources]
    })),
    scanned
  };
}

/**
 * A statikus scan megállapításai.
 *
 * A `scan === null` (nem sikerült letölteni a forrást) SOHA nem PASS: N-A,
 * indoklással. A „nem néztük" és a „néztük, tiszta" nem mosható össze.
 */
export function evaluateStaticScan(scan) {
  if (!scan) {
    return [check('STATIC_scan_ran', NA, 'A forrás-scan nem futott le (a HTML/szkriptek letöltése nem sikerült).')];
  }

  const out = [];
  out.push(
    check(
      'STATIC_scan_ran',
      PASS,
      `${scan.scanned.length} forrás átvizsgálva (${scan.scanned.reduce((n, s) => n + s.bytes, 0)} bájt).`,
      scan.scanned.slice(0, 20)
    )
  );

  const fails = scan.findings.filter((f) => f.severity === 'fail');
  out.push(
    fails.length === 0
      ? check('STATIC_no_pii_in_source', PASS, 'A forrásban nincs PII-t tartalmazó dataLayer.push minta.')
      : check(
          'STATIC_no_pii_in_source',
          FAIL,
          `${fails.length} helyen PII kerülhet a kliensoldali dataLayerbe (CLAUDE.md 15.) — ezt az F12-es bámészkodó is látja.`,
          fails
        )
  );

  const reported = scan.findings.filter((f) => f.severity === 'report');
  out.push(
    reported.length === 0
      ? check('STATIC_no_forbidden_calls', PASS, 'Nincs nyers consent-parse vagy közvetlen fbq/gtag hívás a letöltött forrásban.')
      : check(
          'STATIC_no_forbidden_calls',
          INFO,
          `${reported.length} találat az INV-005/006 mintákra. FIGYELEM: bundle-ölt forrásból NEM eldönthető, ` +
            'hogy a hívást a site szerzője írta-e vagy a tracking-csomagunk hozta be — ezért report-only, ember dönt.',
          reported
        )
  );

  out.push(
    scan.declared.length === 0
      ? check('STATIC_declared_trackers', INFO, 'A forrásban nincs beégetett tracker-azonosító — minden tag a GTM-konténerből jöhet.')
      : check(
          'STATIC_declared_trackers',
          INFO,
          `${scan.declared.length} féle tracker-azonosító van beégetve a forrásba.`,
          scan.declared
        )
  );

  return out;
}

/**
 * A statikus és a futásidejű kép ÖSSZEVETÉSE — a rés, amit egyik oldal sem lát.
 *
 * @param {{declared: Array<{id: string, values: string[]}>}} scan
 * @param {{rows: Array<{vendor: string|null}>}} inventory
 */
export function compareStaticToRuntime(scan, inventory) {
  if (!scan || !inventory) {
    return [check('STATIC_runtime_gap', NA, 'Az összevetéshez mindkét oldal kell (statikus scan + futásidejű leltár).')];
  }

  const runtimeVendors = new Set(inventory.rows.map((r) => r.vendor).filter(Boolean));
  const DECLARED_TO_VENDOR = {
    gtm_container: 'gtm',
    ga4_measurement: 'ga4',
    google_ads_conversion: 'google_ads',
    meta_pixel: 'meta'
  };

  const declaredButSilent = scan.declared
    .filter((d) => DECLARED_TO_VENDOR[d.id])
    .filter((d) => {
      const vendor = DECLARED_TO_VENDOR[d.id];
      // A proxyzott változat is számít futásidejű jelenlétnek.
      return !runtimeVendors.has(vendor) && !runtimeVendors.has(`${vendor}_proxied`);
    });

  if (declaredButSilent.length === 0) {
    return [
      check(
        'STATIC_runtime_gap',
        PASS,
        'Minden forrásban deklarált tracker futásidőben is megjelent — nincs olyan láb, amit csak a forrás ismer.'
      )
    ];
  }

  return [
    check(
      'STATIC_runtime_gap',
      INFO,
      `${declaredButSilent.length} tracker DEKLARÁLVA van a forrásban, de a mért betöltésen egyszer sem indult el. ` +
        'Ez feltételes betöltő (más útvonal / eszköz / consent-ág) — a futásidejű PASS tehát NEM fedi le ezt a lábat.',
      declaredButSilent
    )
  ];
}
