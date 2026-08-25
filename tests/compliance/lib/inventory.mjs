/**
 * F7 · P8 — RUNTIME TRACKER-INVENTORY.
 *
 * A harness eddig ítéletet mondott (PASS/FAIL), de nem vezetett LELTÁRT: nem
 * lehetett megmondani, hogy egy oldalon VÉGÜL kik futnak, és melyikük mikor
 * indul. Az `'other'` kategóriába minden beleolvadt — egy új heatmap-szkript, egy
 * retarget-pixel és egy webfont egyformán nézett ki.
 *
 * Ez a modul a MEGFIGYELT kérésekből épít vendor-leltárt, fázisonként (döntés
 * előtt / elfogadás után / elutasítás után / analytics-only), és nevesíti azt,
 * amit NEM ismerünk.
 *
 * ── Az invariáns ─────────────────────────────────────────────────────────────
 * **Az ismeretlen vendor nem ártalmatlan, hanem ISMERETLEN.** Nem soroljuk be
 * találgatásból („valószínűleg CDN"), és nem is hallgatjuk el. Külön
 * megállapítás lesz belőle — egyelőre REPORT-ONLY (INFO), a terv szerinti
 * report-only → alert → gate sorrend első lépéseként.
 *
 * Tiszta függvények: hálózat nélkül tesztelhetők.
 */

import { classifyRequestDetailed } from './classify.mjs';
import { CONSENT_BOUND_CLASSES } from './vendor-registry.mjs';

const PASS = 'PASS';
const FAIL = 'FAIL';
const NA = 'N-A';
const INFO = 'INFO';

const check = (id, status, detail, evidence = null) => ({ id, status, detail, evidence });

/**
 * Vendor-leltár a fázisonkénti felvételekből.
 *
 * @param {Array<{phase: string, capture: {requests?: Array<{url: string, method?: string, t?: number}>}|null}>} phases
 * @param {string} siteUrl
 * @returns {{rows: Array<object>, unknown_hosts: string[], phases: string[]}}
 */
export function buildInventory(phases, siteUrl) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  const seenPhases = [];

  for (const { phase, capture } of phases) {
    // A `null` felvétel NEM üres felvétel: az a fázis le sem futott. Ha
    // beleszámolnánk „nulla kérés"-ként, a leltár azt állítaná, hogy ott semmi
    // nem futott — holott nem néztük.
    if (!capture) continue;
    seenPhases.push(phase);
    for (const req of capture.requests || []) {
      const c = classifyRequestDetailed(req.url, siteUrl);
      // Az első fél saját kérései (kép, CSS, saját API) nem vendorok — a leltárba
      // beszórva elnyomnák a jelet.
      if (c.category === 'first_party') continue;
      const key = c.vendor ?? `host:${c.host ?? req.url}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          vendor: c.vendor,
          name: c.name ?? c.host ?? '(nem parse-olható URL)',
          category: c.category,
          consent_class: c.consent_class,
          known: c.known,
          host: c.host,
          first_seen_phase: phase,
          counts: {},
          sample_url: shortUrl(req.url)
        };
        byKey.set(key, row);
      }
      row.counts[phase] = (row.counts[phase] ?? 0) + 1;
    }
  }

  const rows = [...byKey.values()].sort((a, b) => {
    // Az ismeretlenek előre: a leltár legfontosabb sorai azok, amikről nem
    // tudunk semmit.
    if (a.known !== b.known) return a.known ? 1 : -1;
    return String(a.name).localeCompare(String(b.name));
  });

  return {
    rows,
    unknown_hosts: rows.filter((r) => !r.known).map((r) => r.host ?? r.key),
    phases: seenPhases
  };
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 160);
  } catch {
    return String(url).slice(0, 160);
  }
}

/**
 * A leltár megállapításai.
 *
 * `INV_unknown_vendors` — REPORT-ONLY (INFO). Ismeretlen harmadik fél önmagában
 * nem bizonyít jogsértést: lehet egy legitim, de a regiszterből hiányzó CDN. A
 * teendő ilyenkor a REGISZTER bővítése (vagy a szkript eltávolítása) — de a
 * döntést ember hozza, nem egy heurisztika.
 *
 * `INV_unknown_vendor_pre_consent` — az ismeretlen vendor a DÖNTÉS ELŐTTI
 * fázisban futott. Ez már súlyos: ha kiderül, hogy mérés vagy hirdetés, akkor
 * consent nélkül futott. FAIL-t mégsem adunk, mert nem tudjuk, MI az — a
 * besorolás hiánya nem bizonyíték egyik irányba sem. INFO, de külön nevesítve,
 * mert a triage sorrendjét ez határozza meg.
 */
export function evaluateInventory(inventory, beforeDecisionPhase = 'A_before_decision') {
  const out = [];
  const unknown = inventory.rows.filter((r) => !r.known);

  out.push(
    unknown.length === 0
      ? check('INV_unknown_vendors', PASS, 'Minden megfigyelt harmadik fél szerepel a vendor-regiszterben.')
      : check(
          'INV_unknown_vendors',
          INFO,
          `${unknown.length} ISMERETLEN harmadik fél fut az oldalon — nem soroltuk be találgatásból. ` +
            'Teendő: vagy vedd fel a vendor-regiszterbe (lib/vendor-registry.mjs) a helyes consent-osztállyal, vagy távolítsd el a szkriptet. ' +
            'Report-only: ez a megállapítás ma nem buktat.',
          unknown.map((r) => ({ host: r.host, first_seen_phase: r.first_seen_phase, sample: r.sample_url }))
        )
  );

  const unknownPre = unknown.filter((r) => r.counts[beforeDecisionPhase] > 0);
  if (unknownPre.length > 0) {
    out.push(
      check(
        'INV_unknown_vendor_pre_consent',
        INFO,
        `${unknownPre.length} ismeretlen harmadik fél MÁR A DÖNTÉS ELŐTT futott. ` +
          'Amíg nincs besorolva, nem tudjuk, mérés-e — épp ezért ez a triage első tétele.',
        unknownPre.map((r) => ({ host: r.host, requests: r.counts[beforeDecisionPhase], sample: r.sample_url }))
      )
    );
  }

  return out;
}

/**
 * ANALYTICS-ONLY forgatókönyv értékelése.
 *
 * A kérdés: ha a látogató CSAK analitikát engedélyez, marketinget NEM, akkor a
 * marketing-lábak (Meta, Google Ads, TikTok, LinkedIn…) tényleg némák maradnak-e.
 *
 * MIÉRT EZ A LEGÁRULKODÓBB SZCENÁRIÓ: az „elfogad mindent" és az „elutasít
 * mindent" két SZÉLSŐ eset, és a legtöbb CMP-integráció ezekre van bekötve. A
 * részleges consent az, ahol a Consent Mode granularitása (`ad_storage` vs
 * `analytics_storage`) ténylegesen próbára van téve — és ahol egy „minden vagy
 * semmi" bekötés némán átcsúszik a másik két szcenárión.
 *
 * A `capture === null` (a szcenárió nem futott le) SOHA nem PASS: N-A, indoklással.
 */
export function evaluateAnalyticsOnly(scenario) {
  if (!scenario || scenario.skipped) {
    const reason = scenario?.reason || 'Az analytics-only forgatókönyv nem futott le.';
    return [
      check('E_analytics_only_no_marketing', NA, reason),
      check('E_analytics_only_analytics_runs', NA, reason)
    ];
  }

  const requests = scenario.requests || [];
  const classified = requests.map((r) => ({ req: r, c: classifyRequestDetailed(r.url, scenario.site_url ?? null) }));

  const marketing = classified.filter((x) => x.c.consent_class === 'marketing');
  const analytics = classified.filter((x) => x.c.consent_class === 'analytics');

  const out = [];
  out.push(
    marketing.length === 0
      ? check('E_analytics_only_no_marketing', PASS, 'Csak analitikát engedélyezve EGYETLEN marketing-kérés sem indult.')
      : check(
          'E_analytics_only_no_marketing',
          FAIL,
          `${marketing.length} MARKETING kérés indult, pedig a látogató csak analitikát engedélyezett — ` +
            'a consent granularitása nem érvényesül (a bekötés „minden vagy semmi").',
          marketing.slice(0, 20).map((x) => ({ vendor: x.c.vendor ?? x.c.host, url: shortUrl(x.req.url) }))
        )
  );

  // A második állítás fordított irányú, és szándékosan NEM FAIL: ha az analitika
  // SEM fut, az lehet legitim (nincs GA4 ezen a site-on — „Modell 2"-ben a
  // böngésző-GA4 site-onként eltér). Viszont ha csendben semmi nem fut, a
  // szcenárió első állítása („nincs marketing") ÜRESEN IGAZ lenne — ezt a
  // riportnak ki kell mondania, különben a PASS többet ígér, mint amit mért.
  out.push(
    analytics.length > 0
      ? check('E_analytics_only_analytics_runs', PASS, `${analytics.length} analitikai kérés futott — a szcenárió tényleg mért valamit.`)
      : check(
          'E_analytics_only_analytics_runs',
          INFO,
          'Analitikai kérés SEM futott. A „nincs marketing" megállapítás így üresen igaz — ' +
            'vagy nincs analitika bekötve ezen a site-on, vagy a részleges consent mindent letiltott.'
        )
  );

  return out;
}

export { CONSENT_BOUND_CLASSES };
