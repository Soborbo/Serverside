/**
 * Persistence — localStorage, attribution, sessions, normalization
 *
 * Storage rules (WRITE **and** READ):
 *   localStorage / _fbp / _fbc → only with marketing consent
 *   sessionStorage             → only with analytics consent
 *   memory + URL params        → always (lost on reload, that's fine)
 *
 * WHY READS ARE GATED TOO (2026-08): under the UK PECR — and the ICO's April 2026
 * final guidance — it is not only STORING on the terminal equipment that needs
 * consent, but also GAINING ACCESS to what is stored there. Reading `sb_tracking`
 * or the `_fbp` cookie is therefore exactly as consent-bound as writing it. The
 * writes were already gated (`persistTrackingParams`, `getSession`); the reads
 * were not, and every getter below fed the conversion payload.
 *
 * The URL is NOT terminal storage: `captureUrlParams()` and the direct
 * `URLSearchParams` reads stay ungated on purpose. Do not "fix" that.
 *
 * The gate uses the SAME consent resolution as everything else in this package
 * (`hasMarketingConsent` / `hasAnalyticsConsent`) — there is deliberately NO
 * fourth reading path. Which source we believe is the subject of the Phase D
 * measurement and must not change here.
 */

import { hasMarketingConsent, hasAnalyticsConsent } from './consent';
import { trackingConfig, type Market } from './config';

const TRACKING_KEY = 'sb_tracking';
const FIRST_TOUCH_KEY = 'sb_first_touch';
const SESSION_KEY = 'sb_session';
/**
 * A gateway-attribúció localStorage kulcsa (`collectAttribution` írja/olvassa).
 * NEM új kulcs — a `gateway.ts` eddig is ezt használta; itt él, mert a
 * storage-kulcsok gazdája ez a modul, és így a read-gate ÉS a purge ugyanabból
 * az egy definícióból dolgozik (a gateway.ts innen importálja).
 */
export const ATTR_STORAGE_KEY = '__sb_attribution';
const EXPIRY_DAYS = 90;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────

export interface TrackingData {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  /** First-capture timestamp for fbclid (ms). Used to reconstruct
   *  Meta's `_fbc` cookie when the Pixel hasn't run yet. */
  fbclidAt?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  timestamp: number;
  landingPage: string;
}

export interface AttributionData {
  first_utm_source?: string;
  first_utm_medium?: string;
  first_utm_campaign?: string;
  first_gclid?: string;
  last_utm_source?: string;
  last_utm_medium?: string;
  last_utm_campaign?: string;
  last_gclid?: string;
}

interface SessionData { id: string; lastActivity: number; }

// ── Safe storage ───────────────────────────────────────────────────

// ── Blocked-read telemetry (Phase D instrument — do NOT drop) ──────
//
// The read-gate has one real failure mode: `getCkyConsent()` not having loaded
// yet. The package's consent helpers return `isDevMode()` in that case, i.e.
// deny-all in production — so a CONSENTING visitor can have their gclid read
// blocked purely because the CMP script was slow. That would be silent
// attribution loss, and it is the same boot-race the Phase D diagnosis is
// chasing. Every blocked read is therefore recorded and reported in the
// conversion payload (`storage_read_blocked` / `storage_read_blocked_keys`),
// so a high rate UNDER GRANTED CONSENT proves the race independently.
//
// Cumulative per page-load: a block early in the pageview stays reported even if
// consent arrives later — that IS the signal. Keys only (`sb_tracking`, `_fbp`,
// …), never values.
const blockedReads = new Set<string>();
/** Bounded: a runaway loop must not grow the payload without limit. */
const MAX_BLOCKED_KEYS = 12;

function noteBlockedRead(key: string): void {
  if (blockedReads.size >= MAX_BLOCKED_KEYS && !blockedReads.has(key)) return;
  blockedReads.add(key);
}

export interface StorageReadBlockedReport {
  blocked: boolean;
  keys: string[];
}

/** Telemetry snapshot for the gateway payload (see gateway.ts `sendToWorker`). */
export function getStorageReadBlocked(): StorageReadBlockedReport {
  return { blocked: blockedReads.size > 0, keys: [...blockedReads] };
}

/** Test seam / SPA reset. Production code never needs to call this. */
export function resetStorageReadBlocked(): void {
  blockedReads.clear();
}

/**
 * Marketing-gated read. Returns `fallback` (and records the block) when consent
 * is absent — never throws, never falls through to the storage call.
 */
function marketingRead<T>(key: string, read: () => T, fallback: T): T {
  if (!hasMarketingConsent()) { noteBlockedRead(key); return fallback; }
  return read();
}

/**
 * Marketing-kapuzott localStorage olvasás, EXPORTÁLVA — hogy a gateway.ts
 * attribúció-olvasása ugyanezen az EGY kapun menjen át, ne egy másodikon.
 * Consent nélkül `null` + a blokk rögzítve.
 */
export function readMarketingLocalStorage(key: string): string | null {
  return marketingRead(key, () => lsGet(key), null);
}

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* */ } }
function lsRm(k: string): void { try { localStorage.removeItem(k); } catch { /* */ } }
function ssGet(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k: string, v: string): void { try { sessionStorage.setItem(k, v); } catch { /* */ } }
function ssRm(k: string): void { try { sessionStorage.removeItem(k); } catch { /* */ } }

import { normalizeEmailIdentity } from './email-identity';

// ── Canonical normalizers (ONE source of truth) ────────────────────

/**
 * Az e-mail identitás-alakja. A SZABÁLY nem itt lakik: a `email-identity.ts`
 * egyetlen authorityje adja, amit a Worker `src/lib/hash.ts` is importál — így
 * a böngésző-láb és a CAPI/offline láb BITRE ugyanazt a stringet hasheli.
 *
 * A korábbi `slice(0, 254)` CSONKÍTOTT: 254 oktet fölött egy mesterségesen más
 * címet állított elő, mint a szerver ugyanabból a bemenetből. Most `undefined`
 * — érvénytelen cím nem lesz fél-identitássá.
 */
export function normalizeEmail(email: string | null | undefined): string | undefined {
  return normalizeEmailIdentity(email);
}

/**
 * Normalize phone to E.164-ish format for consistent hashing.
 * Works for both UK and HU sites:
 *  - Unambiguous national prefixes auto-detect regardless of config:
 *      UK `07…` (11 digits) → `+447…` (trunk `0`, 1 char)
 *      HU `06…` (11 digits) → `+36…`  (trunk `06`, 2 chars — matches server hash.ts)
 *  - Already-international (`+…`) is kept.
 *  - Ambiguous numbers (bare national / single-`0` trunk) use the site's
 *    configured `country` (PUBLIC_TRACKING_COUNTRY).
 * Used everywhere: dataLayer, hidden fields, Sheets. (The gateway re-normalizes
 * server-side using the KV `country_code`, so the server path is market-correct too.)
 */
/**
 * Nemzeti trunk-`0`-t használó hívókódok — a szerver `src/lib/hash.ts`
 * TRUNK_PREFIX_COUNTRIES táblájának TÜKÖRKÉPE. A két oldalnak bitre ugyanazt a
 * számot kell előállítania, különben a böngésző-Pixel és a CAPI/EC MÁS hash-t
 * kap ugyanarra az emberre, és a match NÉMÁN elromlik.
 *
 * FIGYELEM: csak az kerülhet ide, aki TÉNYLEGESEN trunk-`0`-t használ. Olaszország,
 * Spanyolország, Csehország, Szlovákia, Lengyelország megtartja a vezető nullát
 * (vagy nincs is trunk-nullája) — őket kivenni a listából KÖTELEZŐ.
 */
const TRUNK_PREFIX_DIAL_CODES = new Set(['44', '36', '49', '33', '31', '32', '43', '41', '40']);

/**
 * `+CC0…` → `+CC…`. A `+44 (0)7123 456 789` írásmód a UK/EU-ban általános, és
 * E.164-ben a hívókód utáni `0` SOHA nem érvényes.
 *
 * EZ VOLT EGY NÉMA HIBA: a kliens korai `return`-nel kilépett minden `+`-szal
 * kezdődő számnál, tehát `+4407123456789`-et adott, míg a szerver `+447123456789`-et.
 * A CLAUDE.md 1. pontja pont ezt a példát írja elő — a kettő eltérése minden
 * `+44 (0)` alakot beíró látogatónál elrontotta az EC/CAPI match-et.
 */
function stripTrunkPrefix(plus: string): string {
  for (const codeLen of [3, 2]) {
    const candidate = plus.slice(1, 1 + codeLen);
    if (
      TRUNK_PREFIX_DIAL_CODES.has(candidate) &&
      plus.length > 1 + codeLen &&
      plus[1 + codeLen] === '0'
    ) {
      return '+' + candidate + plus.slice(2 + codeLen);
    }
  }
  return plus;
}

export function normalizePhone(raw: string, country: Market = trackingConfig.country): string {
  let p = raw.replace(/[\s\-(). ]/g, '');
  if (p.startsWith('+')) return stripTrunkPrefix(p.replace(/[^\d+]/g, '')).slice(0, 20);
  if (p.startsWith('07') && p.length === 11) p = '+44' + p.slice(1);
  else if (p.startsWith('06') && p.length === 11) p = '+36' + p.slice(2);
  else if (country === 'HU') {
    if (p.startsWith('36')) p = '+' + p;
    // 06 → strip trunk `06` (slice(2)) FELTÉTEL NÉLKÜL — a szerver hash.ts:134
    // ugyanígy. A korábbi `06 && length===11` fenti gyorsút miatt egy 10-jegyű HU
    // vezetékes (0612345678) ide esett, és csak a `0`-t vágta le → +36612345678
    // (plusz 6), ami eltért a szerver +3612345678-tól → néma EC/CAPI hash-divergencia.
    else if (p.startsWith('06')) p = '+36' + p.slice(2);
    else if (p.startsWith('0')) p = '+36' + p.slice(1);
    else p = '+36' + p;
  } else {
    if (p.startsWith('44')) p = '+' + p;
    else if (p.startsWith('0')) p = '+44' + p.slice(1);
    else p = '+44' + p;
  }
  return p.replace(/[^\d+]/g, '').slice(0, 20);
}

/** Trim and limit name length. */
export function sanitizeName(name: string): string {
  return name.trim().slice(0, 100);
}

// ── Session ────────────────────────────────────────────────────────

let memorySession: SessionData | null = null;

function newSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `sess_${crypto.randomUUID().slice(0, 12)}`
    : `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getSession(): SessionData {
  const now = Date.now();

  // With analytics consent: use sessionStorage (survives page reload)
  if (hasAnalyticsConsent()) {
    const raw = ssGet(SESSION_KEY);
    if (raw) {
      try {
        const s: SessionData = JSON.parse(raw);
        if (now - s.lastActivity < SESSION_TIMEOUT_MS) {
          s.lastActivity = now;
          ssSet(SESSION_KEY, JSON.stringify(s));
          return s;
        }
      } catch { /* corrupted */ }
    }
    const s: SessionData = { id: newSessionId(), lastActivity: now };
    ssSet(SESSION_KEY, JSON.stringify(s));
    return s;
  }

  // No consent: memory only (lost on reload — intentional)
  if (memorySession && now - memorySession.lastActivity < SESSION_TIMEOUT_MS) {
    memorySession.lastActivity = now;
    return memorySession;
  }
  memorySession = { id: newSessionId(), lastActivity: now };
  return memorySession;
}

export function getSessionId(): string { return getSession().id; }

// ── Attribution ────────────────────────────────────────────────────

function urlTrackingParams(): Partial<TrackingData> | null {
  const u = new URLSearchParams(window.location.search);
  const p: Partial<TrackingData> = {};
  let any = false;
  for (const k of ['gclid','gbraid','wbraid','fbclid','utm_source','utm_medium','utm_campaign','utm_content','utm_term'] as const) {
    const v = u.get(k);
    if (v) { (p as Record<string,string>)[k] = v; any = true; }
  }
  return any ? p : null;
}

/** In-memory capture of URL params on page load (before consent). */
let capturedParams: Partial<TrackingData> | null = null;

export function captureUrlParams(): void {
  capturedParams = urlTrackingParams();
}

function persistFirstTouch(params: Partial<TrackingData>): void {
  if (lsGet(FIRST_TOUCH_KEY)) return;
  lsSet(FIRST_TOUCH_KEY, JSON.stringify({
    utm_source: params.utm_source, utm_medium: params.utm_medium,
    utm_campaign: params.utm_campaign, gclid: params.gclid,
    timestamp: Date.now(),
  }));
}

/** Persist captured params to localStorage. ONLY after marketing consent. */
export function persistTrackingParams(): void {
  if (!hasMarketingConsent()) return;
  const fresh = capturedParams || urlTrackingParams();
  if (!fresh) return;
  persistFirstTouch(fresh);
  const stored = getStoredData();
  // Stamp the fbclid capture time only when fbclid is new — needed to
  // reconstruct Meta's `_fbc` cookie with the original click timestamp.
  // Re-stamping on every persist would drift the timestamp away from the
  // actual click, breaking match quality.
  const fbclidAt = fresh.fbclid && (!stored?.fbclid || stored.fbclid !== fresh.fbclid)
    ? Date.now()
    : stored?.fbclidAt;
  lsSet(TRACKING_KEY, JSON.stringify({
    ...stored, ...fresh,
    fbclidAt,
    timestamp: Date.now(),
    landingPage: stored?.landingPage || window.location.pathname,
  } satisfies TrackingData));
  capturedParams = null;
}

export function getAttribution(): AttributionData {
  const r: AttributionData = {};
  // `sb_first_touch` is a SECOND localStorage key, so it needs its own gate —
  // inheriting getStoredData()'s would leave this read open.
  const fr = marketingRead(FIRST_TOUCH_KEY, () => lsGet(FIRST_TOUCH_KEY), null);
  if (fr) {
    try {
      const f = JSON.parse(fr);
      r.first_utm_source = f.utm_source; r.first_utm_medium = f.utm_medium;
      r.first_utm_campaign = f.utm_campaign; r.first_gclid = f.gclid;
    } catch { /* */ }
  }
  const s = getStoredData();
  if (s) {
    r.last_utm_source = s.utm_source; r.last_utm_medium = s.utm_medium;
    r.last_utm_campaign = s.utm_campaign; r.last_gclid = s.gclid;
  }
  return r;
}

export function getSourceType(): 'paid'|'organic'|'social'|'referral'|'direct' {
  const d = getStoredData();
  if (!d) return 'direct';
  if (d.gclid || d.gbraid || d.wbraid) return 'paid';
  if (d.fbclid) return 'social';
  if (d.utm_medium === 'cpc' || d.utm_medium === 'ppc') return 'paid';
  if (d.utm_medium === 'organic') return 'organic';
  if (d.utm_medium === 'social') return 'social';
  if (d.utm_medium === 'referral') return 'referral';
  if (d.utm_source) return 'referral';
  return 'direct';
}

// ── Data access ────────────────────────────────────────────────────

/**
 * The single localStorage read of `sb_tracking` — and therefore the single
 * marketing gate every derived getter (`getGclid`, `getFbclid`, `getAttribution`,
 * `getSourceType`, `getAllTrackingData`, `getFbc`) inherits. Without consent it
 * returns `null`, exactly as it does for an absent/expired record, so callers
 * need no new branch.
 */
export function getStoredData(): TrackingData | null {
  const raw = marketingRead(TRACKING_KEY, () => lsGet(TRACKING_KEY), null);
  if (!raw) return null;
  try {
    const d: TrackingData = JSON.parse(raw);
    if (Date.now() - d.timestamp > EXPIRY_DAYS * 86_400_000) { lsRm(TRACKING_KEY); return null; }
    return d;
  } catch { lsRm(TRACKING_KEY); return null; }
}

export function getGclid(): string | null {
  return new URLSearchParams(window.location.search).get('gclid') || getStoredData()?.gclid || null;
}
export function getFbclid(): string | null {
  return new URLSearchParams(window.location.search).get('fbclid') || getStoredData()?.fbclid || null;
}

export function getAllTrackingData(): Partial<TrackingData> {
  const s = getStoredData(); const u = new URLSearchParams(window.location.search);
  return {
    gclid: u.get('gclid') || s?.gclid, gbraid: u.get('gbraid') || s?.gbraid,
    wbraid: u.get('wbraid') || s?.wbraid, fbclid: u.get('fbclid') || s?.fbclid,
    utm_source: u.get('utm_source') || s?.utm_source, utm_medium: u.get('utm_medium') || s?.utm_medium,
    utm_campaign: u.get('utm_campaign') || s?.utm_campaign, utm_content: u.get('utm_content') || s?.utm_content,
    utm_term: u.get('utm_term') || s?.utm_term,
  };
}

/**
 * Meta's `_fbp` browser id. READING the cookie is terminal-storage access, so it
 * sits behind the marketing gate too — `document.cookie` is not a free channel
 * just because the Pixel wrote the value.
 */
export function getFbp(): string | null {
  return marketingRead(
    '_fbp',
    () =>
      typeof document !== 'undefined'
        ? document.cookie.match(/(?:^|;\s*)_fbp=([^;]*)/)?.[1] || null
        : null,
    null
  );
}

/**
 * Returns the canonical Pixel-set `_fbc` cookie when present, otherwise
 * reconstructs it from the stored fbclid + first-capture timestamp.
 *
 * Why: Meta's `_fbc` cookie is only set by the Pixel AFTER marketing
 * consent runs, which loses the click ID for any landing → consent →
 * navigate → submit flow. Meta's CAPI EMQ diagnostic flags this as low
 * Click ID coverage and recommends sending fbc on the server. By
 * reconstructing from our own stored fbclid we close the gap without
 * needing Meta's parameter builder SDK.
 *
 * Format: `fb.<subdomain_index>.<click_timestamp_ms>.<fbclid>`
 * subdomain_index = 1 for apex-domain cookies (most common case).
 * Spec: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc/
 */
const FBCLID_RE = /^[A-Za-z0-9_-]{1,500}$/;

/**
 * The RAW Pixel-set `_fbc` cookie, marketing-gated, with NO reconstruction
 * fallback. Exists so the gateway payload builder can read the cookie through
 * the same single gate without inheriting `getFbc()`'s reconstruction — that
 * would change what the browser leg sends under granted consent.
 */
export function getFbcCookie(): string | null {
  return marketingRead(
    '_fbc',
    () =>
      typeof document !== 'undefined'
        ? document.cookie.match(/(?:^|;\s*)_fbc=([^;]*)/)?.[1] || null
        : null,
    null
  );
}

export function getFbc(): string | null {
  const cookie = getFbcCookie();
  if (cookie) return cookie;
  const stored = getStoredData();
  if (!stored?.fbclid || !stored.fbclidAt) return null;
  if (!FBCLID_RE.test(stored.fbclid)) return null;
  return `fb.1.${stored.fbclidAt}.${stored.fbclid}`;
}

export function getPageUrl(): string {
  return window.location.origin + window.location.pathname;
}
export function getDevice(): 'mobile'|'tablet'|'desktop' {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  return w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop';
}

// ── Purge on consent withdrawal ────────────────────────────────────
//
// Withdrawal has to reach the data at rest, not just future writes: leaving
// `sb_tracking` in place after the user revokes marketing consent means we keep
// storing (and, until the read-gate above, kept reading) exactly what they
// withdrew. Two functions, deliberately NOT one — the categories are revoked
// independently, and a visitor who turns marketing off while leaving analytics on
// must keep their session.

/**
 * Best-effort first-party cookie deletion.
 *
 * KNOWN LIMITS (documented, not bugs):
 *  - The Domain attribute is not readable back from `document.cookie`, so we
 *    expire the name under the host, `.host` and the parent domain with `path=/`.
 *    A cookie written on a deeper path survives.
 *  - An HttpOnly cookie (server-set first-party `_fbp` in a CAPI-gateway/Stape
 *    setup) is invisible AND undeletable from JS. Nothing client-side can fix
 *    that; it needs a Set-Cookie from the same origin.
 *  - CHIPS/partitioned cookies need the matching `Partitioned` attribute.
 * The read-gate is what actually enforces the withdrawal in those cases: even if
 * the value survives, we no longer access it.
 */
function expireCookie(name: string): void {
  if (typeof document === 'undefined') return;
  const past = 'Thu, 01 Jan 1970 00:00:00 GMT';
  const host = typeof location !== 'undefined' ? location.hostname : '';

  // MINDEN szülő-utótagot végigpróbálunk (≥2 címke), nem csak az „utolsó kettőt".
  // Az utóbbi a többcímkés public suffixeken hibás: `www.agykontroll.co.uk`
  // esetén `co.uk`-ot adna — az böngésző-oldalon érvénytelen domain-attribútum,
  // a VALÓDI registrable domain (`.agykontroll.co.uk`) pedig sosem kerülne sorra,
  // vagyis az apexre írt _fbp/_fbc túlélné a visszavonást a .co.uk flottán.
  // Publiksuffix-lista nélkül a helyes megoldás a végigpróbálás: az érvénytelen
  // domain-attribútummal küldött Set-Cookie-t a böngésző egyszerűen eldobja.
  const labels = host ? host.split('.') : [];
  const domains: Array<string | undefined> = [undefined, host, `.${host}`];
  for (let i = 1; i <= labels.length - 2; i++) domains.push(`.${labels.slice(i).join('.')}`);

  for (const d of domains) {
    if (d === '' || d === '.') continue;
    try {
      document.cookie = `${name}=; path=/; expires=${past}; SameSite=Lax${d ? `; domain=${d}` : ''}`;
    } catch { /* */ }
  }
}

/**
 * localStorage half of the marketing purge — shared with clearTrackingData.
 *
 * `__sb_attribution` is in the list because `collectAttribution()` keeps a
 * SECOND copy of the withdrawn data there (click IDs + UTMs). Purging only
 * `sb_tracking`/`sb_first_touch` would leave that copy at rest — and
 * `writeStoredAttribution()` refuses to write after revocation, so its own
 * explicit-denial branch can never clean it up either.
 */
function removeMarketingLocalStorage(): void {
  lsRm(TRACKING_KEY); lsRm(FIRST_TOUCH_KEY); lsRm(ATTR_STORAGE_KEY);
}

/**
 * Vendor cookies whose NAME is fixed. The GA4 stream cookie (`_ga_<STREAM>`) and
 * the Google Ads linker family carry a per-property suffix, so those are matched
 * by prefix from `document.cookie` — a hard-coded list would silently miss the
 * actual property's cookie, which is the whole point of the purge.
 */
const VENDOR_COOKIES = {
  /**
   * GA4: a `_ga` client-id süti PONTOS néven, a per-stream session süti
   * (`_ga_<STREAM>`) prefixszel. A prefix szándékosan `_ga_` és nem `_ga`: a
   * puszta `_ga` prefix a Google Ads-hez tartozó `_gac_<ID>`-t, az UA-örökség
   * `_gat*`-ot és a `_gali`-t is elvinné — azok nem analytics-kategóriájúak.
   */
  analytics: { exact: ['_ga'], prefixes: ['_ga_'] },
  /** Google Ads conversion linker (`_gcl_au`, `_gcl_aw`, `_gcl_dc`, `_gcl_gb`). */
  marketing: { exact: [], prefixes: ['_gcl_'] }
} as const;

type VendorCookieMatch = { readonly exact: readonly string[]; readonly prefixes: readonly string[] };

/** Every cookie NAME currently visible to JS that matches exactly or by prefix. */
function matchingCookieNames(match: VendorCookieMatch): string[] {
  if (typeof document === 'undefined') return [];
  const names = new Set<string>();
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (!name) continue;
    if (match.exact.includes(name) || match.prefixes.some((p) => name.startsWith(p))) names.add(name);
  }
  return [...names];
}

/**
 * Marketing consent withdrawn → drop the attribution at rest: `sb_tracking`,
 * `sb_first_touch`, `__sb_attribution`, the Meta `_fbp` / `_fbc` cookies, and the
 * Google Ads linker cookies (`_gcl_*`) where technically possible (see
 * `expireCookie` limits).
 *
 * MIÉRT A GOOGLE-SÜTIK IS: a Consent Mode denied jele megállítja a KÜLDÉST, de a
 * már kiírt azonosítót nem törli — a `_gcl_au` 90 napig a böngészőben maradna a
 * visszavonás után. A látogató épp azt kérte, hogy ne maradjon. (2026-08-25-i
 * jogi átvilágítás megállapítása.)
 */
/**
 * EPHEMERAL identity-horgok (P6.2).
 *
 * A visszavonásnak nem csak a TÁROLT adatot kell elvinnie, hanem a memóriában
 * és a DOM-ban élő Enhanced-Conversions oldalcsatornát is. Ezt eddig semmi nem
 * tette: a `purgeMarketingStorage` sütiket és localStorage-kulcsokat törölt, az
 * EC-adatot viszont csak egy 5 másodperces időzítő söpörte — vagyis a
 * visszavonás pillanatában a nyers e-mail/telefon ott maradt a lapon.
 *
 * MIÉRT HOROG, ÉS NEM KÖZVETLEN HÍVÁS. A `persistence.ts` nem importálhatja az
 * `events.ts`-t: az utóbbi INNEN hozza a normalizálókat, tehát körkörös
 * import lenne. A regisztráció megfordítja a függést, és nyitva hagyja az utat
 * további ephemeral tároknak (pl. a P5 pending-konverziók).
 */
type PurgeHook = () => void;
const marketingPurgeHooks = new Set<PurgeHook>();

/** Egy ephemeral marketing-tár bejelentkezése a visszavonás-takarításra. */
export function registerMarketingPurgeHook(hook: PurgeHook): void {
  marketingPurgeHooks.add(hook);
}

/** Teszt-segéd: a horgok leszedése (a modul-állapot izolálásához). */
export function clearMarketingPurgeHooks(): void {
  marketingPurgeHooks.clear();
}

export function purgeMarketingStorage(): void {
  removeMarketingLocalStorage();
  expireCookie('_fbp');
  expireCookie('_fbc');
  for (const name of matchingCookieNames(VENDOR_COOKIES.marketing)) expireCookie(name);
  // Az ephemeral (memória/DOM) identity ugyanennek a jogalapnak az alapján él.
  // Egy horog hibája NEM akaszthatja meg a többi takarítást: a részleges purge
  // rosszabb, mint a hangos, de teljes.
  for (const hook of marketingPurgeHooks) {
    try { hook(); } catch { /* a purge sosem dobhat */ }
  }
}

/**
 * Analytics consent withdrawn → drop `sb_session`, the in-memory session, and a
 * GA4 sütijeit (`_ga`, `_ga_<STREAM>`). Ugyanaz az indok, mint a marketing ágon:
 * a denied jel a küldést állítja meg, a 2 évre kiírt azonosítót nem.
 */
export function purgeAnalyticsStorage(): void {
  resetSession();
  for (const name of matchingCookieNames(VENDOR_COOKIES.analytics)) expireCookie(name);
}

/** Storage-only half of the analytics purge — shared with clearTrackingData. Never touches cookies. */
function resetSession(): void {
  ssRm(SESSION_KEY);
  memorySession = null;
}

/**
 * Legacy "clear everything" helper. Behaviour UNCHANGED (localStorage keys +
 * `sb_session` + memory session; it does NOT touch ANY cookie — neither the Meta
 * nor the Google ones) — the consent-withdrawal path is the category-split pair
 * above, which does.
 */
export function clearTrackingData(): void {
  removeMarketingLocalStorage();
  resetSession();
}
