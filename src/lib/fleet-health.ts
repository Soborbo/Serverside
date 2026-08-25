/**
 * F8 · P12 — Fleet health view (TISZTA MAG).
 *
 * Egy képernyőn, site-onként: CMP · package-verzió · GTM-drift · böngésző-smoke ·
 * ingest · Meta · Google offline · EC · business-reconciliation · inventory.
 *
 * ── A modul EGYETLEN kemény invariánsa ───────────────────────────────────────
 * **UNKNOWN SOHA NEM RENDERELŐDHET GREEN-KÉNT.** Ez nem stílus-kérdés: a projekt
 * eddigi néma hibái (lomtalan 2026-07-14 `accepted|http_status=NULL`, az öt napig
 * zöld füstteszt egy KV-ből kiesett meta-blokk fölött, a bevezetése óta egyetlen
 * napon sem futó cross-check) ugyanabból a mintából jöttek: a MÉRÉS HIÁNYÁT a
 * rendszer EGÉSZSÉGNEK könyvelte. Ezért:
 *
 *   1. A `null` bemenet SOHA nem 0. A „nem futott le a lekérdezés" és a
 *      „lefutott, és nulla jött ki" két KÜLÖN állapot, és csak a második lehet
 *      RED. Az első UNKNOWN.
 *   2. A `NOT_APPLICABLE` KIZÁRÓLAG EXPLICIT config-elvárásból származhat
 *      (`expected_platforms`), sosem abból, hogy egy config-blokk hiányzik. Egy
 *      törölt meta-blokk és egy szándékosan meta-nélküli site a delivery-sorból
 *      nézve azonos — pont ezért kell az elvárást külön kimondani.
 *   3. A rollup-sorrendben az UNKNOWN a YELLOW FÖLÖTT van (RED > UNKNOWN >
 *      YELLOW > GREEN). Egy ismert, kicsi degradáció kevésbé veszélyes, mint egy
 *      MÉRETLEN pénzút: a másodikról nem tudjuk, mekkora. §17 ugyanez a szabály
 *      („a mérés saját hibája nem zöld").
 *
 * A modul SZÁNDÉKOSAN pure: nincs benne D1, KV, fetch, `Date.now()`. Az adatokat
 * a `fleet-collect.ts` gyűjti, az idő a hívótól jön (`nowMs`) — így minden küszöb
 * determinisztikusan tesztelhető.
 */

import type { OfflineLegReport } from './reconciliation';

export type HealthLevel = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN' | 'NOT_APPLICABLE';

/** A P12-ben nevesített dimenziók. A sorrend a riport/UI oszlopsorrendje is. */
export const FLEET_DIMENSIONS = [
  'ingest',
  'meta',
  'google_offline',
  'enhanced_conversions',
  'cmp',
  'package_version',
  'browser_smoke',
  'business_recon',
  'gtm_conformance',
  'inventory'
] as const;

export type FleetDimension = (typeof FLEET_DIMENSIONS)[number];

export interface DimensionResult {
  dimension: FleetDimension;
  level: HealthLevel;
  /** Ember-olvasható indoklás. UNKNOWN-nál KÖTELEZŐEN megmondja, mi hiányzik. */
  detail: string;
  /**
   * Csak `NOT_APPLICABLE`-nél. Egyetlen megengedett érték: `'config'` — vagyis a
   * site EXPLICIT módon kimondta, hogy ezt a lábat nem várja. Ha ez a mező
   * hiányzik egy NOT_APPLICABLE-ről, az hiba (teszt őrzi).
   */
  na_source?: 'config';
}

/** Egy platform-láb 24 órás kézbesítési számai a `deliveries` táblából. */
export interface PlatformDeliveryCounts {
  accepted: number;
  rejected: number;
  skipped: number;
}

/**
 * Egy site MÉRT állapota. **Minden `null` azt jelenti: A MÉRÉS NEM FUTOTT LE.**
 * Nulla értéket sose kódolj `null`-lal, és fordítva.
 */
export interface FleetSiteInput {
  site_id: string;
  hostname: string;
  /** `monitoring:false` → a site kimarad a riasztásból, de a sorát MEGMUTATJUK. */
  monitoring: boolean;

  // ── Config-eredetű ELVÁRÁSOK ───────────────────────────────────────────────
  /** `expected_platforms.smoke` — üres tömb = NINCS kimondott elvárás (≠ nincs elvárás). */
  expected_smoke: readonly string[];
  /** `expected_platforms.offline`. */
  expected_offline: readonly string[];
  consent_provider: 'cookieyes' | 'sbo';
  meta_configured: boolean;
  gads_customer_id: string | null;
  /** Hány `conversion_actions` bejegyzés van mappelve (0 = egy sem). */
  gads_conversion_action_count: number;

  // ── MÉRT adatok (null = nem futott le a lekérdezés) ────────────────────────
  accepted_events_24h: number | null;
  accepted_events_7d: number | null;
  platform_deliveries_24h: Readonly<Record<string, PlatformDeliveryCounts>> | null;
  /** A legutóbbi BIZONYÍTOTT kézbesítés (accepted + non-NULL vendor http_status). */
  last_proven_delivery_at: string | null;
  /** Benne van-e a site a `SMOKE_SITES` listában (a füstteszt-lefedettség maga). */
  smoke_expected: boolean;
  /** A napi synthetic smoke eredménye; `null` = nem tudtuk lekérdezni. */
  smoke_result: 'pass' | 'fail' | 'missing' | null;
  /** `consent_log` döntések 7 nap alatt (csak a saját CMP ír ide). */
  consent_decisions_7d: number | null;
  /** DISTINCT `client_lib_version` a `consent_receipts`-ből, 7 nap. */
  client_lib_versions_7d: readonly string[] | null;
  /** A site offline (CRM lifecycle → Google Ads) lábai; `null` = nem futott le. */
  offline_legs: readonly OfflineLegReport[] | null;
  /** A legutóbbi CRM business-count aggregátum dátuma (`YYYY-MM-DD`). */
  business_last_report_date: string | null;
  /** Küldött-e VALAHA aggregátumot. `false` → az üzleti forrás nincs bekötve. */
  business_ever_reported: boolean;
}

export interface FleetSiteHealth {
  site_id: string;
  hostname: string;
  monitoring: boolean;
  overall: HealthLevel;
  dimensions: DimensionResult[];
  /** Az UNKNOWN dimenziók nevei — a „mit nem tudunk erről a site-ról" lista. */
  blind_spots: FleetDimension[];
  counts: Record<HealthLevel, number>;
  last_healthy_at: string | null;
}

export interface FleetHealthReport {
  generated_at: string;
  /**
   * A KV site-config felsorolás TELJES volt-e. `false` → a flotta-szintű rollup
   * KÖTELEZŐEN legalább UNKNOWN, akkor is, ha minden LÁTOTT site zöld: részleges
   * listából nem következik, hogy a nem látott site-ok rendben vannak.
   */
  config_enumeration_complete: boolean;
  fleet_overall: HealthLevel;
  sites: FleetSiteHealth[];
  /** Flotta-szintű összegzés dimenziónként — melyik láb hány site-on piros/vak. */
  dimension_summary: Record<FleetDimension, Record<HealthLevel, number>>;
}

// ── Rollup ───────────────────────────────────────────────────────────────────

/**
 * Súlyossági sorrend. **RED > UNKNOWN > YELLOW > GREEN > NOT_APPLICABLE.**
 *
 * Az UNKNOWN azért van a YELLOW FÖLÖTT, mert a méretlen pénzútról nem tudjuk,
 * mekkora a baj — a YELLOW-nál viszont igen. Egy „ismerten enyhén romlott" láb
 * nem takarhatja el, hogy egy másikat egyáltalán nem mérünk.
 */
const SEVERITY: Record<HealthLevel, number> = {
  RED: 4,
  UNKNOWN: 3,
  YELLOW: 2,
  GREEN: 1,
  NOT_APPLICABLE: 0
};

export function worseOf(a: HealthLevel, b: HealthLevel): HealthLevel {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * Dimenzió-eredmények → egy site összesített szintje.
 *
 * Csupa NOT_APPLICABLE → UNKNOWN, NEM GREEN: a „semmit nem várunk ettől a
 * site-tól" nem egészség, hanem az elvárások hiánya.
 */
export function rollupSite(dimensions: readonly DimensionResult[]): HealthLevel {
  let worst: HealthLevel = 'NOT_APPLICABLE';
  let sawJudgeable = false;
  for (const d of dimensions) {
    if (d.level !== 'NOT_APPLICABLE') sawJudgeable = true;
    worst = worseOf(worst, d.level);
  }
  if (!sawJudgeable) return 'UNKNOWN';
  return worst;
}

function emptyCounts(): Record<HealthLevel, number> {
  return { GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 };
}

// ── Dimenzió-szabályok ───────────────────────────────────────────────────────

const dim = (
  dimension: FleetDimension,
  level: HealthLevel,
  detail: string,
  na_source?: 'config'
): DimensionResult =>
  na_source ? { dimension, level, detail, na_source } : { dimension, level, detail };

/** Ingest — érkezik-e egyáltalán elfogadott konverzió. */
function assessIngest(s: FleetSiteInput): DimensionResult {
  if (s.accepted_events_24h === null || s.accepted_events_7d === null) {
    return dim(
      'ingest',
      'UNKNOWN',
      'a ledger event-count lekérdezés nem futott le (LEDGER binding vagy query-hiba) — ez NEM nulla konverzió'
    );
  }
  if (s.accepted_events_24h > 0) {
    return dim(
      'ingest',
      'GREEN',
      `${s.accepted_events_24h} elfogadott event 24 óra alatt (7 nap: ${s.accepted_events_7d})`
    );
  }
  if (s.accepted_events_7d > 0) {
    return dim(
      'ingest',
      'RED',
      `0 elfogadott event 24 óra alatt, miközben 7 nap alatt ${s.accepted_events_7d} volt — a leg 24 órán belül ELHALLGATOTT`
    );
  }
  return dim(
    'ingest',
    'RED',
    '0 elfogadott event 7 napja — a site vagy nem küld, vagy a teljes ingest-lánc áll'
  );
}

/**
 * Meta CAPI. A `skipped` KÜLÖN ág: a 2026-07-15-i lomtalan-eset pont az volt,
 * hogy a fan-out némán skip-re váltott egy KV-ből kiesett meta-blokk miatt.
 */
function assessMeta(s: FleetSiteInput): DimensionResult {
  const declaredExpected = s.expected_smoke.includes('meta');
  const declaredNotExpected = s.expected_smoke.length > 0 && !declaredExpected;

  if (declaredNotExpected && !s.meta_configured) {
    return dim(
      'meta',
      'NOT_APPLICABLE',
      'az expected_platforms.smoke NEM tartalmaz meta-t, és nincs meta config — kimondottan nem várt láb',
      'config'
    );
  }
  if (!declaredExpected && !s.meta_configured) {
    return dim(
      'meta',
      'UNKNOWN',
      'nincs meta config ÉS nincs kimondott elvárás (expected_platforms.smoke üres) — nem eldönthető, hogy szándékos-e vagy kiesett a KV-ből'
    );
  }
  if (declaredExpected && !s.meta_configured) {
    return dim(
      'meta',
      'RED',
      'az expected_platforms.smoke META-t vár, de a KV configban NINCS meta blokk — a láb némán skip-re vált'
    );
  }
  if (s.platform_deliveries_24h === null) {
    return dim('meta', 'UNKNOWN', 'a delivery-lekérdezés nem futott le — a Meta láb állapota méretlen');
  }
  const c = s.platform_deliveries_24h.meta ?? { accepted: 0, rejected: 0, skipped: 0 };
  const attempted = c.accepted + c.rejected;
  if (c.accepted === 0 && c.skipped > 0) {
    return dim(
      'meta',
      'RED',
      `24 órában ${c.skipped} skip és NULLA accepted — a láb konfigurálva van, mégsem szállít`
    );
  }
  if (attempted === 0) {
    if (s.accepted_events_24h !== null && s.accepted_events_24h > 0) {
      return dim(
        'meta',
        'RED',
        `${s.accepted_events_24h} event érkezett, de EGYETLEN Meta-kézbesítési kísérlet sem — a fan-out nem indul el`
      );
    }
    return dim(
      'meta',
      'UNKNOWN',
      'nem volt event 24 órában, amin a Meta láb mérhető lenne (lásd az ingest dimenziót)'
    );
  }
  const failRate = c.rejected / attempted;
  if (failRate === 0) return dim('meta', 'GREEN', `${c.accepted} accepted, 0 rejected 24 órában`);
  if (failRate >= 0.5) {
    return dim(
      'meta',
      'RED',
      `${c.rejected}/${attempted} kézbesítés elutasítva (${(failRate * 100).toFixed(0)}%)`
    );
  }
  return dim(
    'meta',
    'YELLOW',
    `${c.rejected}/${attempted} kézbesítés elutasítva (${(failRate * 100).toFixed(0)}%)`
  );
}

/** Google offline (CRM lifecycle → Data Manager). */
function assessGoogleOffline(s: FleetSiteInput): DimensionResult {
  const expected = s.expected_offline.includes('gads');
  if (s.offline_legs === null) {
    return dim(
      'google_offline',
      'UNKNOWN',
      'az offline-láb lekérdezés nem futott le — az offline pénzút méretlen'
    );
  }
  if (s.offline_legs.length === 0) {
    if (!expected) {
      return dim(
        'google_offline',
        'NOT_APPLICABLE',
        'az expected_platforms.offline nem tartalmaz gads-t — nincs elvárt offline láb',
        'config'
      );
    }
    return dim(
      'google_offline',
      'RED',
      'az expected_platforms.offline GADS-t vár, de EGYETLEN offline láb sem létezik — a CRM lifecycle-átmenet soha nem ért ide'
    );
  }
  const blocked = s.offline_legs.filter((l) => l.state === 'BLOCKED_DEPENDENCY');
  if (blocked.length > 0) {
    const reasons = [...new Set(blocked.map((l) => l.blocked_by ?? 'unknown'))].join(', ');
    return dim(
      'google_offline',
      expected ? 'RED' : 'YELLOW',
      `${blocked.length} láb BLOCKED_DEPENDENCY (${reasons})`
    );
  }
  const lost = s.offline_legs.filter((l) => l.expected > 0 && l.delivered === 0);
  if (lost.length > 0) {
    return dim(
      'google_offline',
      'RED',
      `${lost.length} lábon van elvárt kézbesítés, de NULLA feltöltés ért célba`
    );
  }
  const unarmed = s.offline_legs.filter((l) => l.state === 'UNARMED');
  if (unarmed.length === s.offline_legs.length) {
    return dim(
      'google_offline',
      'YELLOW',
      'minden láb UNARMED — a lánc még SOHA nem szállított bizonyított feltöltést (nem hiba, de nem is bizonyíték)'
    );
  }
  const rejected = s.offline_legs.reduce((n, l) => n + l.rejected, 0);
  const delivered = s.offline_legs.reduce((n, l) => n + l.delivered, 0);
  if (rejected > 0 && rejected >= delivered) {
    return dim('google_offline', 'RED', `${rejected} elutasított vs ${delivered} elfogadott feltöltés`);
  }
  if (rejected > 0) {
    return dim(
      'google_offline',
      'YELLOW',
      `${rejected} elutasított feltöltés ${delivered} elfogadott mellett`
    );
  }
  return dim('google_offline', 'GREEN', `${delivered} bizonyított offline feltöltés`);
}

/**
 * Enhanced Conversions — KONFIGURÁCIÓS szint (INV-009 / TRK-CFG-002). A `gads`
 * customer_id megléte `conversion_actions` NÉLKÜL pontosan a néma hiba: a site
 * „be van kötve", az eventek beérkeznek, a Google felé egy konverzió sem megy.
 */
function assessEnhancedConversions(s: FleetSiteInput): DimensionResult {
  const expected = s.expected_offline.includes('gads');
  if (!s.gads_customer_id) {
    if (expected) {
      return dim(
        'enhanced_conversions',
        'RED',
        'az expected_platforms.offline GADS-t vár, de nincs gads.customer_id a configban'
      );
    }
    return dim(
      'enhanced_conversions',
      'NOT_APPLICABLE',
      'nincs gads.customer_id és az offline gads nincs elvárva — a Google-konverziók böngésző-tulajdonúak (AWCT/EC)',
      'config'
    );
  }
  if (s.gads_conversion_action_count === 0) {
    return dim(
      'enhanced_conversions',
      'RED',
      'van gads.customer_id, de NULLA conversion_actions van mappelve (TRK-CFG-002 / INV-009) — minden offline konverzió némán skip-re megy'
    );
  }
  return dim(
    'enhanced_conversions',
    'GREEN',
    `${s.gads_conversion_action_count} conversion action mappelve`
  );
}

/** CMP — melyik consent-rendszer fut, és ír-e egyáltalán döntést. */
function assessCmp(s: FleetSiteInput): DimensionResult {
  if (s.consent_provider === 'cookieyes') {
    return dim(
      'cmp',
      'YELLOW',
      'CookieYes (legacy) — a saját CMP-re átállás nyitott; a pre-consent GTM-betöltés jogi kockázata ezen a site-on él'
    );
  }
  if (s.consent_decisions_7d === null) {
    return dim('cmp', 'UNKNOWN', 'a consent_log lekérdezés nem futott le — nem tudjuk, ír-e a saját CMP');
  }
  if (s.consent_decisions_7d > 0) {
    return dim('cmp', 'GREEN', `saját CMP, ${s.consent_decisions_7d} rögzített döntés 7 nap alatt`);
  }
  if (s.accepted_events_7d !== null && s.accepted_events_7d > 0) {
    return dim(
      'cmp',
      'RED',
      `saját CMP van beállítva, de 7 nap alatt NULLA consent-döntés íródott, miközben ${s.accepted_events_7d} konverzió érkezett — a banner nem naplóz`
    );
  }
  return dim(
    'cmp',
    'UNKNOWN',
    'saját CMP, de sem consent-döntés, sem konverzió nem érkezett 7 napban — nincs mihez mérni'
  );
}

/** Package-verzió — a bizonyított F9-drift őre. */
function assessPackageVersion(s: FleetSiteInput): DimensionResult {
  if (s.client_lib_versions_7d === null) {
    return dim('package_version', 'UNKNOWN', 'a client_lib_version lekérdezés nem futott le');
  }
  const versions = s.client_lib_versions_7d.filter((v) => v && v !== '(none)');
  if (versions.length === 0) {
    return dim(
      'package_version',
      'UNKNOWN',
      'egyetlen consent-receipt sem hordoz client_lib_version-t — a TRK-910-006 (elavult kliens) őr ezen a site-on VAK (F9)'
    );
  }
  if (versions.length === 1) {
    return dim('package_version', 'GREEN', `egységes kliens-verzió: ${versions[0]}`);
  }
  return dim(
    'package_version',
    'YELLOW',
    `${versions.length} különböző kliens-verzió fut egyszerre: ${versions.join(', ')}`
  );
}

/** Böngésző-smoke — a napi synthetic lead. */
function assessBrowserSmoke(s: FleetSiteInput): DimensionResult {
  if (!s.smoke_expected) {
    return dim(
      'browser_smoke',
      'UNKNOWN',
      'a site NINCS a SMOKE_SITES listában — nincs napi füstteszt-lefedettsége (monitorozási hiány, nem kimondott „nem várjuk")'
    );
  }
  if (s.smoke_result === null) {
    return dim('browser_smoke', 'UNKNOWN', 'a smoke-lekérdezés nem futott le');
  }
  if (s.smoke_result === 'pass') {
    return dim('browser_smoke', 'GREEN', 'a napi synthetic lead minden elvárt lábon accepted');
  }
  if (s.smoke_result === 'missing') {
    return dim(
      'browser_smoke',
      'RED',
      'a mai synthetic lead EGYÁLTALÁN nem érkezett meg — a site-oldali smoke-driver áll'
    );
  }
  return dim('browser_smoke', 'RED', 'a napi synthetic lead legalább egy elvárt platform-lábon elbukott');
}

/** Business-reconciliation — él-e a CRM aggregátum-heartbeat. */
function assessBusinessRecon(s: FleetSiteInput, nowMs: number): DimensionResult {
  if (!s.business_ever_reported) {
    return dim(
      'business_recon',
      'UNKNOWN',
      'ez a site SOHA nem küldött CRM business-count aggregátumot — az üzleti forrás nincs bekötve, tehát a lifecycle-veszteség mérhetetlen'
    );
  }
  if (s.business_last_report_date === null) {
    return dim('business_recon', 'UNKNOWN', 'a business-count lekérdezés nem futott le');
  }
  const parsed = Date.parse(`${s.business_last_report_date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    return dim(
      'business_recon',
      'UNKNOWN',
      `értelmezhetetlen business-count dátum: ${s.business_last_report_date}`
    );
  }
  const ageDays = Math.floor((nowMs - parsed) / 86_400_000);
  if (ageDays <= 1) {
    return dim('business_recon', 'GREEN', `friss CRM aggregátum (${s.business_last_report_date})`);
  }
  if (ageDays <= 3) {
    return dim(
      'business_recon',
      'YELLOW',
      `${ageDays} napja nem jött CRM aggregátum (utolsó: ${s.business_last_report_date})`
    );
  }
  return dim(
    'business_recon',
    'RED',
    `${ageDays} napja NINCS CRM aggregátum (utolsó: ${s.business_last_report_date}) — a CRM-cron állhatott le`
  );
}

/**
 * GTM-drift és runtime-inventory: MA NINCS futásidejű forrásuk a gateway-ben.
 *
 * Ezek szándékosan ÁLLANDÓ UNKNOWN-ok, nem elhagyott dimenziók. A P12 kimondottan
 * kéri őket, és pont ez a lényeg: a flotta-nézet MEGMUTATJA, hogy két dimenziót
 * egyáltalán nem mérünk éles futásból — ahelyett, hogy a hiányuktól minden site
 * zöldnek látszana. A UI ezért a `blind_spots` listát a szint MELLETT rendereli.
 */
function assessGtmConformance(): DimensionResult {
  return dim(
    'gtm_conformance',
    'UNKNOWN',
    'a live GTM-conformance offline konténer-exportot igényel (npm run check:live-gtm) — a gateway futásidőben nem látja; állandó vakfolt, amíg az eredmény nem kerül tárolásra'
  );
}

function assessInventory(): DimensionResult {
  return dim(
    'inventory',
    'UNKNOWN',
    'a runtime tracker-inventory (F7 / tests/compliance) nincs a gateway-be kötve — a ténylegesen betöltő third-party tracker-készlet futásidőben méretlen'
  );
}

// ── Publikus belépési pontok ─────────────────────────────────────────────────

export function assessSite(input: FleetSiteInput, nowMs: number): FleetSiteHealth {
  const dimensions: DimensionResult[] = [
    assessIngest(input),
    assessMeta(input),
    assessGoogleOffline(input),
    assessEnhancedConversions(input),
    assessCmp(input),
    assessPackageVersion(input),
    assessBrowserSmoke(input),
    assessBusinessRecon(input, nowMs),
    assessGtmConformance(),
    assessInventory()
  ];

  const counts = emptyCounts();
  for (const d of dimensions) counts[d.level] += 1;

  return {
    site_id: input.site_id,
    hostname: input.hostname,
    monitoring: input.monitoring,
    overall: rollupSite(dimensions),
    dimensions,
    blind_spots: dimensions.filter((d) => d.level === 'UNKNOWN').map((d) => d.dimension),
    counts,
    last_healthy_at: input.last_proven_delivery_at
  };
}

/**
 * Flotta-rollup. A `configEnumerationComplete=false` KEMÉNY felülírás: részleges
 * KV-listából a flotta EGÉSZÉRE nem mondható ki egészség (ugyanaz a szabály, mint
 * a business-recon `resolveBusinessMonitoringScope`-jában — negatív következtetés
 * részlistából tilos).
 */
export function buildFleetReport(
  inputs: readonly FleetSiteInput[],
  nowMs: number,
  configEnumerationComplete: boolean,
  generatedAt: string
): FleetHealthReport {
  const sites = inputs.map((i) => assessSite(i, nowMs));

  const dimension_summary = Object.fromEntries(
    FLEET_DIMENSIONS.map((d) => [d, emptyCounts()])
  ) as Record<FleetDimension, Record<HealthLevel, number>>;
  for (const s of sites) {
    for (const d of s.dimensions) dimension_summary[d.dimension][d.level] += 1;
  }

  let fleet_overall: HealthLevel = 'NOT_APPLICABLE';
  for (const s of sites) fleet_overall = worseOf(fleet_overall, s.overall);
  if (fleet_overall === 'NOT_APPLICABLE') fleet_overall = 'UNKNOWN';
  if (!configEnumerationComplete) fleet_overall = worseOf(fleet_overall, 'UNKNOWN');

  return {
    generated_at: generatedAt,
    config_enumeration_complete: configEnumerationComplete,
    fleet_overall,
    sites,
    dimension_summary
  };
}
