/**
 * Consent resolution for GDPR / Google Consent Mode v2 / Meta data use.
 *
 * A kliens egy `consent` objektumot küld (Google Consent Mode v2 jelek):
 *   { ad_user_data, ad_personalization, ad_storage, analytics_storage }
 * minden mező 'GRANTED' | 'DENIED' | 'UNSPECIFIED'.
 *
 * Szabályok (kutatás 2026-06 alapján):
 *  - Meta CAPI + Google Ads: ad-konverzió CSAK akkor mehet, ha `ad_user_data`
 *    nem DENIED. Meta hivatalos álláspont: nem-konszenzuáló EEA-felhasználónak
 *    EGYÁLTALÁN ne tüzelj CAPI-eventet (2026-02 drezdai ítélet: 1500 €/fő).
 *    A Google Ads ebben a kódban kizárólag Enhanced Conversions for Leads-szel
 *    megy (gclid nélkül) → ha PII-t nem küldhetünk, nincs azonosító → skip.
 *  - GA4: a gateway on-site GA4-et NEM küld (Modell 2, 2026-06-28 óta — a
 *    böngésző/GTM birtokolja, és a GA4 MP nem dedup-ol event_id-re, tehát a
 *    szerver-leg dupla konverziót adna). Ezért a consent-feloldásnak NINCS GA4-ága
 *    ezen az úton. A modul régi doksija itt még azt írta, hogy „GA4-et MINDIG
 *    elküldjük" — az a Modell 2 előtti állapot volt, és 2026-08-16-ig bent maradt
 *    félrevezető szövegként. (A GA4 Consent Mode-továbbítás logikája a lib/ga4.ts-ben
 *    ÉL és helyes; azt a modult ma a debug-endpoint és a legacy DLQ-ürítés hívja.)
 *
 * Backward-compat: ha a payloadban nincs `consent` ÉS a SiteConfig nem írja elő
 * (`require_consent !== true`), a régi viselkedést tartjuk → ad-platform engedett.
 */

import { TrackingErrorCode } from './error-codes';

export type ConsentSignal = 'GRANTED' | 'DENIED' | 'UNSPECIFIED';

export interface ConsentState {
  ad_user_data?: ConsentSignal;
  ad_personalization?: ConsentSignal;
  ad_storage?: ConsentSignal;
  analytics_storage?: ConsentSignal;
}

const VALID_SIGNALS: ReadonlySet<string> = new Set(['GRANTED', 'DENIED', 'UNSPECIFIED']);

/** Validál + normalizál egy nyers consent objektumot a payloadból. */
export function parseConsent(raw: unknown): ConsentState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pick = (v: unknown): ConsentSignal | undefined =>
    typeof v === 'string' && VALID_SIGNALS.has(v) ? (v as ConsentSignal) : undefined;
  const state: ConsentState = {
    ad_user_data: pick(r.ad_user_data),
    ad_personalization: pick(r.ad_personalization),
    ad_storage: pick(r.ad_storage),
    analytics_storage: pick(r.analytics_storage)
  };
  // Ha minden mező undefined, ne adjunk vissza üres objektumot.
  if (
    !state.ad_user_data &&
    !state.ad_personalization &&
    !state.ad_storage &&
    !state.analytics_storage
  ) {
    return undefined;
  }
  return state;
}

export interface ConsentDecision {
  /** Mehet-e ad-platform konverzió (Meta CAPI + a click-ID forwarderek). */
  adAllowed: boolean;
  /** A normalizált consent-állapot a platformok felé továbbításhoz. */
  consent?: ConsentState;
  // Az `analyticsAllowed` mező TÖRÖLVE (2026-08-16 audit): konstans `true` volt, és
  // a Modell 2 (2026-06-28) óta SEHOL nem olvasta senki — a gateway nem küld on-site
  // GA4-et, tehát nem volt mit kapuznia. Egy örökre igaz, sosem olvasott „engedély"
  // mező azt sugallja, hogy van egy analytics-kapu, ami valójában nem létezik.
}

export function resolveConsent(
  consent: ConsentState | undefined,
  requireConsent: boolean
): ConsentDecision {
  // Fail-closed (require_consent=true): ad-platform CSAK explicit
  //   ad_user_data === 'GRANTED' esetén. Hiányzó/UNSPECIFIED/DENIED → tiltva.
  //   FONTOS: ez akkor is érvényes, ha a kliens részleges consent objektumot
  //   küld (pl. csak analytics_storage) — különben a require_consent kapu
  //   megkerülhető lenne.
  // Fail-open (require_consent=false, backward-compat): csak az explicit
  //   ad_user_data === 'DENIED' tilt; minden más enged.
  if (requireConsent) {
    const adAllowed = consent?.ad_user_data === 'GRANTED';
    return { adAllowed, consent };
  }
  const adAllowed = consent?.ad_user_data !== 'DENIED';
  return { adAllowed, consent };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fázis D — consent-diagnosztika (2026-08). ADDITÍV: a fenti parseConsent /
// resolveConsent viselkedése VÁLTOZATLAN. Az alábbi blokk csak MÉR.
//
// A mérés tárgya: jelenleg HÁROM párhuzamos consent-olvasás fut ugyanarra a
// döntésre — (1) a kliens `consent.ts` getCkyConsent() JS API-ja, (2) a kliens
// `gateway.ts` süti-parse-a, (3) a szerver-oldali HTTP Cookie header parse.
// Három fordítás, potenciálisan két igazság. Ezt SZÁNDÉKOSAN nem egységesítjük:
// az eltérés maga a diagnózis tárgya. 30 nap adatból 9 olyan `skipped` delivery
// van, aminek a receiptje GRANTED — az elsőszámú hipotézis a betöltési verseny
// (az event a CookieYes szkript betöltése ELŐTT sül el).
// ═══════════════════════════════════════════════════════════════════════════

/** Melyik forrás hajtotta a KLIENS consent-döntését. */
export type ConsentSourceName =
  | 'cookieyes_cookie'
  | 'cookieyes_api'
  | 'override'
  | 'server_cookie'
  | 'none';

const CONSENT_SOURCE_NAMES: ReadonlySet<string> = new Set<ConsentSourceName>([
  'cookieyes_cookie',
  'cookieyes_api',
  'override',
  'server_cookie',
  'none'
]);

export type IngressKind = 'browser' | 'server';

/**
 * Egy consent-forrás pillanatfelvétele két kategóriára bontva.
 *
 * `null` = a forrás NEM VOLT ELÉRHETŐ abban a pillanatban (pl. a CookieYes
 * szkript még nem töltött be, vagy nincs Cookie header). Ez NEM hiányzó adat,
 * hanem maga a bizonyíték — SOHA ne töltsd fel default értékkel.
 */
export interface ConsentSourceSnapshot {
  analytics: boolean | null;
  marketing: boolean | null;
}

export const CONSENT_SOURCE_UNAVAILABLE: ConsentSourceSnapshot = {
  analytics: null,
  marketing: null
};

/** A kliens (böngésző-lib VAGY site-backend) által jelentett forrásblokk. */
export interface ConsentSources {
  /** CookieYes `cookieyes-consent` süti parse-a. */
  cookie: ConsentSourceSnapshot;
  /** CookieYes `getCkyConsent()` JS API (a böngészőben; szerver-ágon mindig null). */
  api: ConsentSourceSnapshot;
  /** Melyiket használta a KLIENS a döntéshez. */
  source_used: ConsentSourceName;
  client_lib_version?: string;
  /**
   * A consent-döntés kora másodpercben. CookieYes alatt MINDIG undefined: a
   * `cookieyes-consent` süti nem hordoz timestampet, és heurisztikát nem
   * találunk ki rá (a receipten NULL marad). Csak sbo_consent alatt lesz értéke.
   */
  consent_age_s?: number;
  /** Nyers string — KIZÁRÓLAG a consent_debug táblába, mismatch esetén. */
  raw_cookie?: string;
  /** Nyers API-válasz (kompakt JSON) — KIZÁRÓLAG a consent_debug táblába. */
  raw_api?: string;
}

/** A nyers stringek felső határa; a debug-tábla nem naplóarchívum. */
const RAW_MAX_LEN = 512;
const CLIENT_LIB_VERSION_MAX_LEN = 32;

function pickBoolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function pickSnapshot(raw: unknown): ConsentSourceSnapshot {
  if (typeof raw !== 'object' || raw === null) return { ...CONSENT_SOURCE_UNAVAILABLE };
  const r = raw as Record<string, unknown>;
  return {
    analytics: pickBoolOrNull(r.analytics),
    marketing: pickBoolOrNull(r.marketing)
  };
}

function pickRaw(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  // Vezérlőkarakterek ki (log/HTML-injektálás ellen), hossz-cap.
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, RAW_MAX_LEN);
}

/**
 * A payload `consent_sources` blokkjának validálása. Sosem dob és sosem utasít
 * el eventet: ismeretlen/rossz forma → a forrás egyszerűen „nem elérhető".
 * Egy telemetria-mező NEM buktathat konverziót.
 */
export function parseConsentSources(raw: unknown): ConsentSources | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const sourceUsed =
    typeof r.source_used === 'string' && CONSENT_SOURCE_NAMES.has(r.source_used)
      ? (r.source_used as ConsentSourceName)
      : 'none';
  const version =
    typeof r.client_lib_version === 'string' && r.client_lib_version.length > 0
      ? r.client_lib_version.slice(0, CLIENT_LIB_VERSION_MAX_LEN)
      : undefined;
  const age =
    typeof r.consent_age_s === 'number' && Number.isFinite(r.consent_age_s) && r.consent_age_s >= 0
      ? Math.floor(r.consent_age_s)
      : undefined;
  return {
    cookie: pickSnapshot(r.cookie),
    api: pickSnapshot(r.api),
    source_used: sourceUsed,
    client_lib_version: version,
    consent_age_s: age,
    raw_cookie: pickRaw(r.raw_cookie),
    raw_api: pickRaw(r.raw_api)
  };
}

/**
 * A worker SAJÁT olvasata: CookieYes consent a HTTP Cookie headerből.
 *
 * Ugyanaz a formátum és ugyanaz a leképezés, amit a kliens-lib és a
 * site-backend használ (advertisement → marketing, analytics → analytics) —
 * DE külön implementáció, mert épp az a kérdés, hogy a három olvasat egyezik-e.
 * Böngésző-ingressen a Cookie header jellemzően jelen van; szerver-ingressen
 * (service binding) nincs → a snapshot NULL marad, ami maga is adat.
 */
export function parseConsentCookieHeader(cookieHeader: string | null | undefined): {
  snapshot: ConsentSourceSnapshot;
  raw?: string;
} {
  if (!cookieHeader) return { snapshot: { ...CONSENT_SOURCE_UNAVAILABLE } };

  let raw: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== 'cookieyes-consent') continue;
    try {
      raw = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      raw = part.slice(idx + 1).trim();
    }
    break;
  }
  if (!raw) return { snapshot: { ...CONSENT_SOURCE_UNAVAILABLE } };

  const map: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx > 0) map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  // Nincs kategória-kulcs → nem CookieYes süti; nem találgatunk.
  if (map.advertisement === undefined && map.analytics === undefined) {
    return { snapshot: { ...CONSENT_SOURCE_UNAVAILABLE }, raw: pickRaw(raw) };
  }
  return {
    snapshot: {
      analytics: map.analytics === undefined ? null : map.analytics === 'yes',
      marketing: map.advertisement === undefined ? null : map.advertisement === 'yes'
    },
    raw: pickRaw(raw)
  };
}

/**
 * Minden NEM-NULL forrás egyezik-e.
 *
 *  1    = igen (vagy csak egyetlen forrás volt elérhető — nincs mivel ütköznie)
 *  0    = legalább két forrás ELTÉR ugyanarra a kategóriára
 *  null = EGYETLEN forrás sem volt elérhető → nincs mit összevetni
 *
 * A két kategóriát (analytics / marketing) külön hasonlítjuk: elég az egyikben
 * eltérni. Pure, D1 nélkül tesztelhető.
 */
export function computeSourceConsistency(
  sources: readonly ConsentSourceSnapshot[]
): 1 | 0 | null {
  let seenAny = false;
  let consistent = true;
  for (const key of ['analytics', 'marketing'] as const) {
    const values = sources.map((s) => s[key]).filter((v): v is boolean => v !== null);
    if (values.length > 0) seenAny = true;
    if (values.some((v) => v !== values[0])) consistent = false;
  }
  if (!seenAny) return null;
  return consistent ? 1 : 0;
}

// ── TRK-9xx consent-diagnosztika ────────────────────────────────────────────

/**
 * `client_lib_version` minimum (TRK-910-006). Az a verzió, amelyik ELŐSZÖR
 * küldi a `consent_sources` blokkot — enélkül a Fázis D vak marad az adott
 * site-on. A HIÁNYZÓ verzió NEM tüzeli a kódot: a régi libek egyáltalán nem
 * küldenek verziót, és minden eventjükre riasztani napi több száz zajsort
 * jelentene. Az ő esetüket a NULL-forrás mintázat mutatja meg (S3/4. pont).
 */
export const MIN_CLIENT_LIB_VERSION = '6.1.0';

/** Egyszerű semver-összevetés (major.minor.patch, numerikus). */
export function isClientLibVersionBelow(version: string, minimum: string): boolean {
  const parse = (v: string) =>
    v
      .split('.')
      .slice(0, 3)
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv;
  }
  return false;
}

/**
 * TRK-910-004 (consent lejárt) küszöbe. **DEFINIÁLVA, DE NEM ÉLESÍTVE.**
 * CookieYes alatt a `consent_age_s` mindig NULL (a süti nem hordoz timestampet),
 * tehát a feltétel SOHA nem teljesül — a kód csak az sbo_consent korszakban
 * aktiválható, amikor a saját CMP timestampet is ír. Fail-closed viselkedést
 * ez a kód akkor sem kap: a `consent_strict` kizárólag a 002/003/005 okokra hat.
 */
export const CONSENT_MAX_AGE_S = 180 * 24 * 60 * 60; // 180 nap (ICO-ajánlás)

/** Consent-diagnosztikai megállapítás. A kódok a lib/error-codes.ts-ben élnek. */
export type ConsentFindingKind =
  | 'missing'
  | 'unparseable'
  | 'source_mismatch'
  | 'expired'
  | 'signals_inconsistent'
  | 'client_lib_outdated';

export interface ConsentDiagnostics {
  findings: ConsentFindingKind[];
  /**
   * Bizonytalan-e a consent (unparseable / source_mismatch /
   * signals_inconsistent). `consent_strict: true` mellett ez fail-closed.
   * A `missing` SZÁNDÉKOSAN nincs benne: arra a jelenlegi require_consent
   * szabály vonatkozik (v4 terv 2.3), nem a strict kapcsoló.
   */
  uncertain: boolean;
  source_consistent: 1 | 0 | null;
}

export interface ConsentDiagnosticsInput {
  /** A payload NYERS `consent` mezője (a jelenlét ≠ parse-olhatóság). */
  rawConsent: unknown;
  /** A parseConsent eredménye. */
  consent: ConsentState | undefined;
  /** Minden elérhető forrás-pillanatfelvétel (kliens süti / API / szerver). */
  sources: readonly ConsentSourceSnapshot[];
  client_lib_version?: string;
  consent_age_s?: number;
}

/**
 * Consent-diagnosztika (pure). NEM dönt kézbesítésről — a döntés a hívóé
 * (`consent_strict`). Sorrend-független, a megállapítások halmozódhatnak.
 */
export function diagnoseConsent(input: ConsentDiagnosticsInput): ConsentDiagnostics {
  const findings: ConsentFindingKind[] = [];
  const present = input.rawConsent !== undefined && input.rawConsent !== null;

  // TRK-910-001: a consent objektum teljesen hiányzik.
  if (!present) findings.push('missing');
  // TRK-910-002: jelen van, de nem sikerült egyetlen érvényes jelet sem kiolvasni.
  if (present && input.consent === undefined) findings.push('unparseable');

  // TRK-910-003: két forrás ellentmond egymásnak.
  const sourceConsistent = computeSourceConsistency(input.sources);
  if (sourceConsistent === 0) findings.push('source_mismatch');

  // TRK-910-004: lejárt consent — CookieYes alatt nem tüzelhet (age mindig null).
  if (typeof input.consent_age_s === 'number' && input.consent_age_s > CONSENT_MAX_AGE_S) {
    findings.push('expired');
  }

  // TRK-910-005: a jelek belül inkonzisztensek. Az ad-hármas (ad_user_data,
  // ad_personalization, ad_storage) a CookieYes-leképezésben EGYSÉG — ha az
  // egyik GRANTED, a másik meg hiányzik vagy DENIED, azt valami rosszul fordítja.
  const c = input.consent;
  if (c) {
    const adSignals = [c.ad_user_data, c.ad_personalization, c.ad_storage];
    const declared = adSignals.filter((s): s is ConsentSignal => s !== undefined);
    const hasGranted = declared.includes('GRANTED');
    const hasDenied = declared.includes('DENIED');
    const partial = hasGranted && declared.length < adSignals.length;
    if ((hasGranted && hasDenied) || partial) findings.push('signals_inconsistent');
  }

  // TRK-910-006: elavult kliens-lib. Csak JELENTETT verzióra (lásd a konstans doc-ját).
  if (
    input.client_lib_version !== undefined &&
    isClientLibVersionBelow(input.client_lib_version, MIN_CLIENT_LIB_VERSION)
  ) {
    findings.push('client_lib_outdated');
  }

  const uncertain =
    findings.includes('unparseable') ||
    findings.includes('source_mismatch') ||
    findings.includes('signals_inconsistent');

  return { findings, uncertain, source_consistent: sourceConsistent };
}

/**
 * Az ad-platform skip MEGNEVEZÉSE (csak akkor hívandó, ha a fan-out tényleg
 * kihagyja az ad-platformokat). A `consent_denied` mostantól KIZÁRÓLAG a
 * kimondott elutasítás — a hiányzó/bizonytalan eset saját nevet kap, különben a
 * Fázis D pont azokat az ágakat mosná össze, amiket meg akar különböztetni.
 */
export function classifyAdSkipReason(
  consent: ConsentState | undefined,
  requireConsent: boolean,
  uncertainBlocked: boolean
): 'consent_denied' | 'consent_missing_failclosed' | 'consent_uncertain_failclosed' {
  if (uncertainBlocked) return 'consent_uncertain_failclosed';
  if (consent?.ad_user_data === 'DENIED') return 'consent_denied';
  // require_consent=true + nincs GRANTED jel (hiányzó objektum, hiányzó mező,
  // vagy UNSPECIFIED). Az UNSPECIFIED szándékosan IDE tartozik: az „még nincs
  // döntés" pontosan a betöltési verseny aláírása, nem elutasítás.
  if (requireConsent) return 'consent_missing_failclosed';
  // Fail-open site-on ide csak explicit DENIED mellett jutnánk (azt fentebb
  // elkaptuk) — de a teljesség kedvéért ez a legszűkebb helyes válasz.
  return 'consent_denied';
}

/** A finding-fajták → TRK-kódok. A 910-es sáv indoklása: lib/error-codes.ts. */
export const CONSENT_FINDING_CODES: Record<ConsentFindingKind, TrackingErrorCode> = {
  missing: TrackingErrorCode.CONSENT_MISSING,
  unparseable: TrackingErrorCode.CONSENT_UNPARSEABLE,
  source_mismatch: TrackingErrorCode.CONSENT_SOURCE_MISMATCH,
  expired: TrackingErrorCode.CONSENT_EXPIRED,
  signals_inconsistent: TrackingErrorCode.CONSENT_SIGNALS_INCONSISTENT,
  client_lib_outdated: TrackingErrorCode.CONSENT_CLIENT_LIB_OUTDATED
};

/** Azok a megállapítások, amikre a `consent_debug` nyers sort ír (brief S2.3). */
const DEBUG_WORTHY: ReadonlySet<ConsentFindingKind> = new Set<ConsentFindingKind>([
  'unparseable',
  'source_mismatch'
]);

export interface ConsentTelemetryInput {
  /** A payload nyers `consent` mezője. */
  rawConsent: unknown;
  /** A payload nyers `consent_sources` blokkja (kliens-lib / site-backend). */
  rawSources: unknown;
  /** A parseConsent eredménye (VÁLTOZATLAN feloldás). */
  consent: ConsentState | undefined;
  /** A resolveConsent MAI döntése — ezt a telemetria csak strict módban írja felül. */
  baseAdAllowed: boolean;
  requireConsent: boolean;
  /** `consent_strict` a site-configból (default false). */
  strict: boolean;
  ingressKind: IngressKind;
  /** A worker SAJÁT Cookie-header olvasata. */
  serverCookie: { snapshot: ConsentSourceSnapshot; raw?: string };
}

export interface ConsentTelemetry {
  /** A TÉNYLEGES ad-kapu. strict=false mellett bitre a baseAdAllowed. */
  adAllowed: boolean;
  /** Miért maradnak ki az ad-platformok (csak ha adAllowed=false). */
  skipReason?: 'consent_denied' | 'consent_missing_failclosed' | 'consent_uncertain_failclosed';
  /** A receiptre írandó forrás-oszlopok. */
  sources: {
    cookie: ConsentSourceSnapshot;
    api: ConsentSourceSnapshot;
    server: ConsentSourceSnapshot;
    source_used: ConsentSourceName;
    source_consistent: 1 | 0 | null;
    ingress_kind: IngressKind;
    client_lib_version?: string;
    consent_age_s?: number;
  };
  diagnostics: ConsentDiagnostics;
  /** A naplózandó TRK-910 kódok (a findings sorrendjében). */
  errorCodes: TrackingErrorCode[];
  /** Ha nem undefined: ezzel a kóddal `consent_debug` sort kell írni. */
  debug?: {
    error_code: TrackingErrorCode;
    raw_cookie?: string;
    raw_api?: string;
    raw_server?: string;
  };
  /** Igaz, ha a strict kapcsoló TÉNYLEGESEN felülírta a mai döntést. */
  strictBlocked: boolean;
}

/**
 * A teljes per-event consent-telemetria egy pure hívásban. NEM ír D1-be, nem
 * logol — a hívó (routes/conversion.ts) dolga. Így a viselkedés (különösen a
 * „strict=false → nulla változás" invariáns) teszttel bizonyítható.
 */
export function buildConsentTelemetry(input: ConsentTelemetryInput): ConsentTelemetry {
  const client = parseConsentSources(input.rawSources);
  const cookie = client?.cookie ?? { ...CONSENT_SOURCE_UNAVAILABLE };
  const api = client?.api ?? { ...CONSENT_SOURCE_UNAVAILABLE };
  const server = input.serverCookie.snapshot;

  const diagnostics = diagnoseConsent({
    rawConsent: input.rawConsent,
    consent: input.consent,
    sources: [cookie, api, server],
    client_lib_version: client?.client_lib_version,
    consent_age_s: client?.consent_age_s
  });

  // FAIL-CLOSED, FLAG MÖGÖTT. strict=false mellett `strictBlocked` MINDIG false,
  // tehát az adAllowed pontosan a mai resolveConsent-döntés marad.
  const strictBlocked = input.strict && diagnostics.uncertain && input.baseAdAllowed;
  const adAllowed = input.baseAdAllowed && !strictBlocked;

  const debugFinding = diagnostics.findings.find((f) => DEBUG_WORTHY.has(f));

  return {
    adAllowed,
    skipReason: adAllowed
      ? undefined
      : classifyAdSkipReason(input.consent, input.requireConsent, strictBlocked),
    sources: {
      cookie,
      api,
      server,
      // A kliens mondja meg, MELYIK forrásból döntött. Ha nem jelentette (régi
      // lib), a szerver-olvasat a legjobb ismert forrás; ha az sincs, 'none'.
      source_used:
        client?.source_used ??
        (server.analytics !== null || server.marketing !== null ? 'server_cookie' : 'none'),
      source_consistent: diagnostics.source_consistent,
      ingress_kind: input.ingressKind,
      client_lib_version: client?.client_lib_version,
      consent_age_s: client?.consent_age_s
    },
    diagnostics,
    errorCodes: diagnostics.findings.map((f) => CONSENT_FINDING_CODES[f]),
    debug: debugFinding
      ? {
          error_code: CONSENT_FINDING_CODES[debugFinding],
          raw_cookie: client?.raw_cookie,
          raw_api: client?.raw_api,
          raw_server: input.serverCookie.raw
        }
      : undefined,
    strictBlocked
  };
}
