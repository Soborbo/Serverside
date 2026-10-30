/**
 * Astro client-lib: BROWSER-side tracking dispatch to the Soborbo event-gateway.
 *
 * Usage: copy-paste into the Astro site's src/lib/ (Painless, BeautyFlow, etc.).
 *
 * SCOPE — read this before "improving" anything:
 *
 *  - This module serves the BROWSER ingress path only (`/api/event/conversion`,
 *    tokenless, Origin allow-list + rate limit on the gateway). It may carry ONLY
 *    the low-risk click/engagement events in `BROWSER_GATEWAY_EVENTS`.
 *  - High-value conversions (forms/lead/purchase — `SERVER_INGRESS_ONLY_EVENTS`)
 *    are dispatched by the SITE BACKEND on `/api/event/conversion-server` with the
 *    per-site token (see server/backend/gateway-dispatch.ts). The gateway 403s
 *    them here (TRK-400-017). `sendToWorker` HARD-BLOCKS them client-side too, so
 *    a wiring mistake is a loud diagnostic instead of a silent conversion loss.
 *  - There is NO Turnstile anywhere in this path. The old Turnstile token gate
 *    silently swallowed real click conversions for two weeks in production
 *    (2026-06-28→07-13) while validating against a test secret. Do NOT add a
 *    "bot check" that can block the dispatch — the gateway's Origin allow-list +
 *    rate limit is the browser-path control, server-side.
 */

import { hasAnalyticsConsent, hasMarketingConsent, readCookieYesApiConsentRaw } from './consent';
import { readSboConsent, sboConsentAgeSeconds } from './consent-sbo-state';
import {
  getFbp, getFbcCookie, getExternalId, getStorageReadBlocked, getStoredData, persistTrackingParams, readMarketingLocalStorage, ATTR_STORAGE_KEY, withoutStaleCampaign
} from './persistence';
import { CLIENT_LIB_VERSION, isSboConsentProvider, trackingConfig } from './config';
import { generateUUID } from './uuid';
import { report } from './observability';
import { BROWSER_GATEWAY_EVENTS, SERVER_INGRESS_ONLY_EVENTS } from './event-contract';
import {
  applyGoogleClickId,
  pickGoogleClickId,
  resolveGoogleClickId,
  type ResolvedGoogleClickId
} from './google-click-id';

declare global {
  interface Window {
    dataLayer: Record<string, unknown>[];
    fbq?: (...args: unknown[]) => void;
  }
}

/**
 * A gateway `user_data` szerződésének KÜLDŐ oldala. A fogadó oldal a Worker
 * `PlainUserDataPayload`-ja (`src/types.ts`) — a kettőt a
 * `tests/user-data-fieldset-parity.test.ts` köti össze, mert egy itt hirdetett,
 * ott ismeretlen mező NÉMÁN elveszik: se hiba, se log, se metrika.
 *
 * A `street` 6.6.3-ban került ki: a Worker sosem fogadta. A `city` marad, de
 * CSAK valódi strukturált forrásból tölthető — formázott címből parse-olni
 * tilos (D1).
 */
export interface UserData {
  email?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  // Stable user/cookie identifier (Meta external_id → EMQ improvement). The Worker
  // hashes it; pass the same value to the browser Pixel too for deduplication.
  // 6.16.0: `sendToWorker` fills it from `getExternalId()` (`sb_uid`) when the
  // caller gives none — and STRIPS it (caller value too) without marketing consent.
  external_id?: string;
}

export type ConsentSignal = 'GRANTED' | 'DENIED' | 'UNSPECIFIED';

export interface ConsentState {
  ad_user_data?: ConsentSignal;
  ad_personalization?: ConsentSignal;
  ad_storage?: ConsentSignal;
  analytics_storage?: ConsentSignal;
}

export type AttributionParams = Record<string, string>;

export interface ConversionPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  value?: number;
  currency?: string;
  source?: string;
  service?: string;
  user_data?: UserData;
  event_source_url?: string;
  consent?: ConsentState;
  attribution?: AttributionParams;
}

/**
 * KÉT DEGRADÁCIÓ, MERT KÉT KÜLÖNBÖZŐ KÉRDÉS.
 *
 * Egy hibás percent-szekvencia (`%zz`, csonka `%E0`) `URIError`-t dob. A
 * szerver-lábon ez 2026-08-26-ban lead-vesztést okozott (500 a beküldött
 * űrlapra), és ott már két helper őrzi. A BÖNGÉSZŐ-lábon ugyanez nem 500-at ad,
 * hanem CSENDET: a `getCookie` a konverzió-dispatch útján is fut (`_ga`,
 * `_gcl_aw`), és egy dobás a `sendToWorker` promise-át utasítja el — a
 * konverzió némán nem megy ki.
 *
 * A KAPU (jogalap) fail-closed: inkább ne legyen consent, mint hamis consent.
 * Egy fél-dekódolt stringből kiolvasott „advertisement:yes" hamis jogalap lenne.
 */
function safeDecodeCookieValue(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * A NEM-JOGALAP olvasás (klikk-ID, GA client-ID) a NYERS értékre esik vissza:
 * ezek azonosítók, nem döntések. Egy `_ga` / `_gcl_aw` érték amúgy sem tartalmaz
 * percent-kódolást, tehát a nyers érték itt a helyes érték — a dobás viszont a
 * teljes konverziót vinné el.
 */
function decodeCookieValueLossy(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rawCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : undefined;
}

/** Azonosító-olvasás (`_ga`, `_gcl_aw`) — lossy, sosem dob. */
function getCookie(name: string): string | undefined {
  const raw = rawCookie(name);
  return raw === undefined ? undefined : decodeCookieValueLossy(raw);
}

/** Jogalap-olvasás (`cookieyes-consent`) — fail-closed, sosem dob. */
function getConsentCookie(name: string): string | undefined {
  const raw = rawCookie(name);
  return raw === undefined ? undefined : safeDecodeCookieValue(raw);
}

function extractGAClientId(gaCookie: string | undefined): string | undefined {
  if (!gaCookie) return undefined;
  const parts = gaCookie.split('.');
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : undefined;
}

// GA4 session id from the `_ga_<STREAM>` cookie. Two formats must be handled:
//   GS1: `GS1.1.<session_id>.<...>`
//   GS2: `GS2.1.s<session_id>$o..$g..`  ← the default for new sessions since 2025-05-06
// In GS2 a literal `s` precedes the session_id. We handle the optional `s` and the
// multi-digit version/slot segments too.
function extractGASessionId(): string | undefined {
  const match = document.cookie.match(/_ga_[A-Z0-9]+=GS\d+\.\d+\.s?(\d+)/);
  return match ? match[1] : undefined;
}

// Consent Mode v2 state. Source order:
//   1) window.__trackingConsent (explicit override, e.g. for testing)
//   2) CookieYes `cookieyes-consent` cookie (CMP loaded from GTM)
// If absent → undefined → the Worker decides based on SiteConfig.require_consent
// (on EEA set require_consent:true → fail-closed when the cookie/decision is missing).
//
// CookieYes cookie format:
//   consentid:..,consent:yes,necessary:yes,functional:yes,analytics:yes,
//   performance:yes,advertisement:yes,other:yes   (:no when rejected)
// Consent Mode v2 mapping (CookieYes official):
//   advertisement → ad_storage + ad_user_data + ad_personalization
//   analytics     → analytics_storage
function getConsentState(): ConsentState | undefined {
  if (typeof window === 'undefined') return undefined;

  const override = (window as unknown as { __trackingConsent?: ConsentState }).__trackingConsent;
  if (override && typeof override === 'object') return override;

  // CMP Fázis 2: provider='sbo' alatt a jelek a SAJÁT sütiből épülnek — ugyanaz
  // az egy forrás, amiből a dispatch-kapuk is olvasnak (nincs második igazság).
  // Nincs döntés → undefined → a Worker a require_consent szabálya szerint dönt,
  // pontosan úgy, mint a hiányzó CookieYes-süti esetén.
  if (isSboConsentProvider()) {
    const s = readSboConsent(trackingConfig.policyVersion);
    if (!s) return undefined;
    const sig = (yes: boolean): ConsentSignal => (yes ? 'GRANTED' : 'DENIED');
    return {
      ad_user_data: sig(s.marketing),
      ad_personalization: sig(s.marketing),
      ad_storage: sig(s.marketing),
      analytics_storage: sig(s.analytics)
    };
  }

  const raw = getConsentCookie('cookieyes-consent');
  if (!raw) return undefined;

  const map: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx > 0) map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  // If there is no category key, it's not a CookieYes cookie → don't guess.
  if (map.advertisement === undefined && map.analytics === undefined) return undefined;

  const sig = (yes: boolean): ConsentSignal => (yes ? 'GRANTED' : 'DENIED');
  const adGranted = map.advertisement === 'yes';
  return {
    ad_user_data: sig(adGranted),
    ad_personalization: sig(adGranted),
    ad_storage: sig(adGranted),
    analytics_storage: sig(map.analytics === 'yes')
  };
}

/**
 * A MARKETING-CONSENT HÁROMÁLLAPOTÚ — és ez az egyetlen hely, ahol eldől.
 *
 * `GRANTED` / `DENIED` / `UNKNOWN`. A kétállapotú (`boolean`) olvasat az F9
 * egyik visszatérő hibaforrása: az UNKNOWN-t tagadásnak véve TÖRÖLTÜNK egy
 * korábbi grant alatt tárolt gclid-et (a CMP boot-versenye MINDEN korai
 * oldalbetöltésen fennáll), tagadásnak NEM véve pedig consent nélkül írtunk
 * hirdetési azonosítót az eszközre. Egyik sem elfogadható, ezért a harmadik
 * állapot NEVESÍTVE van.
 *
 * A helyes kezelés állapotonként:
 *   GRANTED → gyűjthet, tárolhat, küldhet
 *   DENIED  → a visszavonás NYUGALMI ÁLLAPOTBAN is érvényes: purge
 *   UNKNOWN → NEM ír eszközre és NEM küld drótra, de NEM IS töröl
 *
 * Forrás-sorrend: `getConsentState()` (override → saját süti → CookieYes-süti),
 * és ha az nem tud dönteni, a CookieYes JS API (`hasMarketingConsent`). A JS
 * API csak GRANTED-et tud állítani; a hiánya UNKNOWN, nem DENIED.
 */
export type MarketingConsentState = 'GRANTED' | 'DENIED' | 'UNKNOWN';

export function getMarketingConsentState(): MarketingConsentState {
  const consent = getConsentState();
  if (!consent) return hasMarketingConsent() ? 'GRANTED' : 'UNKNOWN';
  if (consent.ad_user_data === 'GRANTED' || consent.ad_storage === 'GRANTED') return 'GRANTED';
  if (consent.ad_user_data === 'DENIED' && consent.ad_storage === 'DENIED') return 'DENIED';
  return 'UNKNOWN';
}

// ── Fázis D · consent-forrás telemetria (2026-08) ───────────────────────────
//
// MÉR, NEM DÖNT. A `getConsentState()` fenti logikája és a lib consent-kapui
// (hasMarketingConsent / hasAnalyticsConsent) VÁLTOZATLANOK — ez a blokk csak
// JELENTI, mit látott az egyes forrásokból abban a pillanatban.
//
// Miért kell: ma HÁROM olvasat fut ugyanarra a döntésre, és nem tudjuk, hogy
// eltérnek-e. (1) A dispatch-kapuk a CookieYes JS API-t nézik
// (`getCkyConsent()`), ami betöltés ELŐTT prod-ban deny-all-t ad. (2) A payload
// `consent` blokkja a `cookieyes-consent` SÜTIBŐL épül. (3) A gateway harmadszor
// olvas, a HTTP Cookie headerből. 30 nap adatból 9 olyan `skipped` delivery van,
// aminek a receiptje GRANTED — a legvalószínűbb magyarázat épp ez a verseny.
//
// `null` = a forrás nem volt elérhető abban a pillanatban. NE pótold semmivel:
// a NULL-mintázat maga a bizonyíték.

export interface ConsentSourceSnapshot {
  analytics: boolean | null;
  marketing: boolean | null;
}

export interface ConsentSourcesPayload {
  cookie: ConsentSourceSnapshot;
  api: ConsentSourceSnapshot;
  source_used: 'cookieyes_cookie' | 'cookieyes_api' | 'override' | 'sbo_cookie' | 'none';
  client_lib_version: string;
  /**
   * A döntés kora másodpercben. CSAK provider='sbo' alatt létezik (a saját süti
   * timestampet hordoz; a CookieYes-é nem) — a szerver TRK-910-004 (lejárt
   * consent) kódja erre vár.
   */
  consent_age_s?: number;
  /** Nyers stringek — a gateway CSAK mismatch esetén tárolja (consent_debug). */
  raw_cookie?: string;
  raw_api?: string;
}

const UNAVAILABLE_SOURCE: ConsentSourceSnapshot = { analytics: null, marketing: null };

/** A `cookieyes-consent` süti nyers kategória-térképe (null, ha nincs süti). */
function readCookieYesCookieRaw(): { raw: string; map: Record<string, string> } | null {
  if (typeof document === 'undefined') return null;
  const raw = getConsentCookie('cookieyes-consent');
  if (!raw) return null;
  const map: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx > 0) map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return { raw, map };
}

/**
 * A consent-források pillanatfelvétele. SOHA nem dob: bármelyik forrás hibája
 * csak annyit jelent, hogy az a forrás „nem elérhető". Egy telemetria-mező nem
 * buktathat konverziót.
 */
export function collectConsentSources(): ConsentSourcesPayload {
  let cookie: ConsentSourceSnapshot = { ...UNAVAILABLE_SOURCE };
  let rawCookie: string | undefined;
  let cookiePresent = false;
  try {
    const c = readCookieYesCookieRaw();
    if (c) {
      rawCookie = c.raw;
      // Csak a TÉNYLEGESEN jelen lévő kulcsokat fordítjuk le; a hiányzó
      // kategória null marad (nem `false` — az hazugság lenne).
      cookie = {
        analytics: c.map.analytics === undefined ? null : c.map.analytics === 'yes',
        marketing: c.map.advertisement === undefined ? null : c.map.advertisement === 'yes'
      };
      cookiePresent = cookie.analytics !== null || cookie.marketing !== null;
    }
  } catch {
    // marad UNAVAILABLE
  }

  let api: ConsentSourceSnapshot = { ...UNAVAILABLE_SOURCE };
  let rawApi: string | undefined;
  let apiPresent = false;
  try {
    const categories = readCookieYesApiConsentRaw();
    if (categories) {
      api = { analytics: categories.analytics === true, marketing: categories.advertisement === true };
      apiPresent = true;
      rawApi = JSON.stringify(categories);
    }
  } catch {
    // marad UNAVAILABLE
  }

  // MELYIK forrásból épült a payload `consent` blokkja — ez a `getConsentState()`
  // precedenciája (override → süti → semmi). FIGYELEM: ez SZÁNDÉKOSAN nem
  // ugyanaz, mint amin a dispatch-kapu dönt (az a JS API) — a kettő eltérése a
  // mérés tárgya, nem hiba a jelentésben.
  const hasOverride =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __trackingConsent?: ConsentState }).__trackingConsent);

  // CMP Fázis 2: provider='sbo' alatt a döntést a saját süti hajtja, és a
  // döntés kora is ismert (a CookieYes sütije timestamp nélküli — ott a mező
  // továbbra sincs). A cookie/api snapshotok NEM váltanak jelentést: alattuk
  // változatlanul a CookieYes olvasata megy — a párhuzamos mérési ablak (2.4)
  // receipt-oldali evidenciája pont ez.
  const sboState = !hasOverride && isSboConsentProvider() ? readSboConsent(trackingConfig.policyVersion) : null;
  const sourceUsed: ConsentSourcesPayload['source_used'] = hasOverride
    ? 'override'
    : sboState
      ? 'sbo_cookie'
      : isSboConsentProvider()
        ? 'none'
        : cookiePresent
          ? 'cookieyes_cookie'
          : apiPresent
            ? 'cookieyes_api'
            : 'none';

  return {
    cookie,
    api,
    source_used: sourceUsed,
    client_lib_version: CLIENT_LIB_VERSION,
    consent_age_s: sboConsentAgeSeconds(sboState),
    raw_cookie: rawCookie,
    raw_api: rawApi
    // CookieYes alatt a `consent_age_s` SZÁNDÉKOSAN hiányzik: a
    // `cookieyes-consent` süti nem hordoz timestampet, és heurisztikát nem
    // találunk ki rá — a gateway receiptjén NULL marad.
  };
}

// ── Universal attribution collection ────────────────────────────────────────
// All common click IDs + UTMs, from the URL + a `_gcl_aw` cookie fallback,
// persisted in localStorage (the conversion often happens on a different page
// than the landing). Last-touch wins for click IDs/UTMs; the landing context
// (landing_page, referrer) is first-touch.
const ATTR_CLICK_PARAMS = [
  'gclid',
  'gbraid',
  'wbraid',
  'gclsrc',
  'gad_source',
  'dclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
  'twclid'
];
/** Non-Google click IDs that `sb_tracking` (persistence.ts) also keeps per page view. */
const TRACKED_CLICK_PARAMS = ['fbclid', 'msclkid'] as const;
const ATTR_UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic'
];

function readStoredAttribution(): AttributionParams {
  // PECR: az OLVASÁS is engedélyköteles. Ez a kulcs marketing-scope (click ID-k +
  // UTM-ek), ezért ugyanazon az EGY read-gate-en megy át, mint a persistence.ts
  // getterei — nem egy másodikon. Consent nélkül üres objektum, és a blokk
  // bekerül a `storage_read_blocked_keys` telemetriába.
  try {
    const raw = readMarketingLocalStorage(ATTR_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AttributionParams) : {};
  } catch {
    return {};
  }
}

function writeStoredAttribution(a: AttributionParams): void {
  // GDPR: attribúció (gclid/fbclid/UTM/landing/referrer) localStorage-be írása
  // marketing-storage — consent nélkül TILOS. A `collectAttribution` publikus
  // export, közvetlen hívása enélkül consent nélkül perzisztálna (a persistence.ts
  // minden írása is így gate-el). A READ/in-memory használat gate nélkül mehet; itt
  // csak a PERSIST lépést zárjuk.
  if (!hasMarketingConsent()) return;
  try {
    localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify(a));
  } catch {
    // localStorage blocked (privacy mode) — best-effort, silently skip.
  }
}

/**
 * A TÁROLT klikk-ID-k tisztítása, ha a megoldott ID nem a tárolóból jött.
 *
 * A `resolveGoogleClickId` megmondja, MELYIK az egy érvényes Google klikk-ID; ez
 * a függvény gondoskodik róla, hogy a rekordban ne maradjon mellette testvér.
 * A nem-Google mezők (utm, fbclid, landing) érintetlenek — ez nem általános
 * takarítás.
 */
function healGoogleClickIds(
  merged: AttributionParams,
  resolved: ResolvedGoogleClickId | undefined
): void {
  applyGoogleClickId(merged as Record<string, unknown>, resolved);
}

// ── Belépési kontextus (landing_page / referrer) ────────────────────────────

/** A CRM `referrer` oszlopa max 500 karakter. */
const MAX_REFERRER_LEN = 500;

/** `www.` és az apex ugyanaz a webhely — a hivatkozó-szűrés szempontjából. */
function siteHostKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Egy hivatkozó-érték KÜLSŐ hivatkozóként: `origin + pathname`, query és hash
 * nélkül (a hivatkozó URL paraméterei a hivatkozó dolga, hordozhatják az ő
 * azonosítóikat), max 500 karakter. Belső (saját host, `www.`/apex lazán
 * egyezően), nem-http(s) vagy értelmezhetetlen értékre `undefined`. Sosem dob.
 */
function sanitizeExternalReferrer(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  if (typeof window === 'undefined' || !window.location?.href) return undefined;
  try {
    const u = new URL(raw, window.location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (siteHostKey(u.host) === siteHostKey(window.location.host)) return undefined;
    return `${u.origin}${u.pathname}`.slice(0, MAX_REFERRER_LEN);
  } catch {
    return undefined;
  }
}

/**
 * A szolgáltatótól kapott belépési oldal: csak SAJÁT webhelyre mutató abszolút
 * URL vagy `/`-rel (nem `//`-rel) kezdődő útvonal fogadható el — egy idegen
 * origin a CRM lead-kartonjára kerülne. Az útvonalat abszolút URL-lé egészítjük.
 */
function sanitizeEntryLanding(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  if (typeof window === 'undefined' || !window.location?.href) return undefined;
  if (raw[0] === '/' && raw[1] !== '/') return `${window.location.origin}${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (siteHostKey(u.host) !== siteHostKey(window.location.host)) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** A site által adott belépési kontextus (lásd `setEntryContextProvider`). */
export interface EntryContext {
  landing_page?: string;
  referrer?: string;
}

let entryContextProvider: (() => EntryContext | null | undefined) | null = null;

/**
 * Opcionális horog: a site saját belépési-attribúció modulja (pl. a skinlab
 * `entry-attribution.ts`-e, ami a first touch-ot oldalak között URL-ben is
 * átviszi) adhatja a first-touch `landing_page` / `referrer` értékét.
 *
 * Elsőbbség: tárolt first touch > a szolgáltató NEM ÜRES értéke > beépített
 * fallback (`location.href` / `document.referrer`). A szolgáltató hivatkozója is
 * ugyanazon a külső-only + query-vágó szűrőn megy át; a belépési oldalnak saját
 * webhelyre kell mutatnia. `null` leveszi a horgot. A szolgáltató hibája sosem
 * buktatja a dispatch-et (→ fallback).
 */
export function setEntryContextProvider(fn: (() => EntryContext | null | undefined) | null): void {
  entryContextProvider = typeof fn === 'function' ? fn : null;
}

function readEntryContext(): EntryContext {
  if (!entryContextProvider) return {};
  try {
    return entryContextProvider() || {};
  } catch {
    return {};
  }
}

export function collectAttribution(): AttributionParams {
  const stored = readStoredAttribution();
  const fresh: AttributionParams = {};

  // Ad-consent gate: click IDs are ad identifiers → we ONLY collect/store/send
  // them with ad consent (ePrivacy/TCF). UTM/landing is analytics metadata.
  //
  // Consent-source consistency: getConsentState() reads the CookieYes COOKIE, while
  // the rest of the lib gates on the CookieYes JS API (hasMarketingConsent). If the
  // cookie isn't present yet but the JS API already says marketing is granted, the
  // old code stripped all click IDs from the server-side payload even though the
  // user consented. Fall back to the JS API when the cookie/override is absent so
  // the two channels agree. (When the cookie IS present we respect its signals,
  // including an explicit DENIED.) Fail-closed when neither source grants.
  const consentState = getMarketingConsentState();
  const adGranted = consentState === 'GRANTED';

  let urlParams: URLSearchParams | undefined;
  try {
    urlParams = new URLSearchParams(window.location.search);
    if (adGranted) {
      for (const k of ATTR_CLICK_PARAMS) {
        const v = urlParams.get(k);
        if (v) fresh[k] = v;
      }
    }
    for (const k of ATTR_UTM_PARAMS) {
      const v = urlParams.get(k);
      if (v) fresh[k] = v;
    }
  } catch {
    // no-op
  }

  // A Google klikk-ID döntése NEM ITT lakik: a szabály (kölcsönös kizárás +
  // URL > `_gcl_aw` cookie > tároló) a `lib/google-click-id.ts` egyetlen
  // authorityjében van, hogy a site-adapterek ugyanazt használhassák.
  //
  // Consent nélkül az URL-t és a sütit KI IS ZÁRJUK a jelöltek közül (nem adjuk
  // át) — így a tárolt érték marad az egyetlen jelölt. Ez szándékos: az
  // UNKNOWN-állapot nem törölhet egy korábbi grant alatt eltárolt ID-t, csak a
  // drótra nem engedi (lentebb).
  //
  // A LEGFRISSEBB LANDING (6.17.1). Ez a tároló (`__sb_attribution`) csak akkor
  // íródik, amikor valaki ezt a függvényt hívja — jellemzően a konverziós oldalon.
  // A landing kattintását az oldalmegtekintésenként írt `sb_tracking` őrzi. Ha azt
  // nem nézzük, egy landing → árlap → vásárlás úton az árlapon már nincs URL-jel,
  // és a régi `_gcl_aw` gclid (vagy egy korábbi vásárlás tárolt ID-je) leverte a
  // friss landing gbraid-jét; az msclkid/fbclid pedig elveszett vagy elavult
  // (Codex, paywalled_boilerplate #92 + #94). Az `sb_tracking` ugyanazon a
  // marketing read-gate-en jön, és ad-grant nélkül nem is olvassuk.
  //
  // Előbb SZINKRONIZÁLJUK: ha az `initTracking` a CookieYes API elkészülte előtt
  // futott, az `sb_tracking` nem kapta meg ennek az oldalnak a kattintását, és a
  // következő URL-jel nélküli oldalon a régebbi tárolt ID visszaírta volna az
  // újabbat (Codex Astra, Serverside #156). Itt a grant már eldőlt.
  if (adGranted) persistTrackingParams({ granted: true });
  const tracked = adGranted ? getStoredData() : null;
  const trackedGoogle = tracked ? pickGoogleClickId(tracked as unknown as Record<string, string>) : undefined;
  const resolved = resolveGoogleClickId({
    url: adGranted ? urlParams : undefined,
    gclAw: adGranted ? getCookie('_gcl_aw') : undefined,
    ...(trackedGoogle ? { stored: tracked as unknown as Record<string, string>, storedAt: tracked?.googleClickAt } : { stored })
  });

  // Last-touch: the fresh URL signals override the stored ones.
  // A kampány egy kattintásé: friss UTM mellett a tárolt UTM-csoport kiesik.
  const base: AttributionParams = withoutStaleCampaign(stored, fresh) ?? {};
  // A kampány a kattintással jár (6.17.3). Ha a klikk-ID az `sb_tracking`-ből jön, a
  // UTM-csoportnak is onnan kell jönnie: a gateway-tároló egy KORÁBBI konverzió
  // kampányát őrzi, és a friss landing klikk-ID-je mellé az került volna (Codex,
  // Serverside #156). Az `sb_tracking` minden grant alatti címkézett oldalon íródik,
  // így a kampánya legalább olyan friss, mint a tárolóé. Friss URL-UTM mellett az nyer;
  // kampány nélküli `sb_tracking` (csak klikk-ID-s landing) a tárolóét nem törli —
  // ugyanígy viselkedik maga a `persistTrackingParams` is.
  const t = (tracked ?? {}) as unknown as Record<string, string | undefined>;
  if (!ATTR_UTM_PARAMS.some((k) => fresh[k]) && ATTR_UTM_PARAMS.some((k) => t[k])) {
    for (const k of ATTR_UTM_PARAMS) {
      const v = t[k];
      if (v) base[k] = v;
      else delete base[k];
    }
  }
  const merged: AttributionParams = { ...base, ...fresh };
  // A nem-Google klikk-ID-ket a landing óta frissebb `sb_tracking` adja, ha az URL
  // most nem hozott sajátot.
  for (const k of TRACKED_CLICK_PARAMS) {
    const v = tracked?.[k];
    if (!fresh[k] && v) merged[k] = v;
  }
  healGoogleClickIds(merged, resolved);

  // First-touch landing context (don't overwrite if already present).
  //
  // A HIVATKOZÓ CSAK KÜLSŐ LEHET (6.16.0). A korábbi kód nyers
  // `document.referrer`-t írt ide, ami a 2. oldaltól a SAJÁT előző oldalunk: egy
  // GRANTED látogató, akinek a blobjában még nem volt referrer, a belső oldalt
  // kapta first-touch hivatkozónak. A skinlab CRM-mérése: 95 sorból 86 belső.
  // Egy tele oszlop, ami nem hordoz információt, rosszabb a bevallott üresnél.
  //
  // Olvasáskor GYÓGYÍTUNK is: egy régi blob belső `referrer`-e törlődik, a
  // külső pedig origin+útvonal alakra áll (query/hash nélkül).
  if (merged.referrer !== undefined) {
    const healed = sanitizeExternalReferrer(merged.referrer);
    if (healed) merged.referrer = healed;
    else delete merged.referrer;
  }
  const entry = !merged.landing_page || !merged.referrer ? readEntryContext() : {};
  if (!merged.landing_page) {
    merged.landing_page = sanitizeEntryLanding(entry.landing_page) || window.location.href;
  }
  if (!merged.referrer) {
    const referrer =
      sanitizeExternalReferrer(entry.referrer) ||
      (typeof document !== 'undefined' ? sanitizeExternalReferrer(document.referrer) : undefined);
    if (referrer) merged.referrer = referrer;
  }

  if (adGranted) {
    writeStoredAttribution(merged);
    return merged;
  }

  // Click-ID handling without a grant is THREE-state, not two:
  //  - explicit DENIED → honor the revocation at rest too: purge stored
  //    click IDs and send none.
  //  - UNKNOWN (no CookieYes cookie yet, JS API not loaded — the boot
  //    race on every early page-load) → fail-closed on the WIRE (no click
  //    IDs leave the browser), but do NOT purge IDs stored under a prior
  //    grant. Treating "unknown" as a denial deleted a consented user's
  //    gclid before the CMP initialised, orphaning the conversion from
  //    its ad click.
  if (consentState === 'DENIED') {
    for (const k of ATTR_CLICK_PARAMS) delete merged[k];
    writeStoredAttribution(merged);
    return merged;
  }

  // Unknown: persist untouched (fresh contains no click IDs — collection
  // above is grant-gated), strip click IDs from the outgoing copy only.
  writeStoredAttribution(merged);
  const outgoing: AttributionParams = { ...merged };
  for (const k of ATTR_CLICK_PARAMS) delete outgoing[k];
  return outgoing;
}

/**
 * A böngésző-láb `user_data`-ja a Meta `external_id`-vel kiegészítve.
 *
 *  - marketing-hozzájárulás nélkül az `external_id` KIESIK (a hívóé is), és
 *    `getExternalId()` sem hoz létre semmit (a read-gate a blokkot rögzíti);
 *  - hozzájárulással: hívó értéke > tárolt/újonnan létrehozott `sb_uid`.
 *
 * A többi mező érintetlen. Üres eredmény → `undefined` (a mező ki sem megy).
 */
function withExternalId(userData: UserData | undefined): UserData | undefined {
  const callerId = typeof userData?.external_id === 'string' ? userData.external_id.trim() : '';
  // Hívói érték mellett nem verünk saját azonosítót: minek tárolnánk, ha nem megy ki.
  const ownId = callerId ? null : getExternalId();
  const granted = hasMarketingConsent();
  const externalId = granted ? callerId || ownId || undefined : undefined;

  const out: UserData = { ...(userData || {}) };
  if (externalId) out.external_id = externalId;
  else delete out.external_id;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Browser dispatch to the gateway (`/api/event/conversion`).
 *
 * GUARDRAIL: only `BROWSER_GATEWAY_EVENTS` pass. A `server_ingress_only` event
 * (or any name outside the browser allow-list) is refused HERE, with a loud
 * TRK-1005 diagnostic — the gateway would 403/drop it anyway, but a client-side
 * block turns "silently lost conversion" into "visible wiring bug". Send those
 * events from the site backend instead (server/backend/gateway-dispatch.ts).
 *
 * Transport: `sendBeacon` first (survives page unload — tel:/mailto: clicks
 * navigate away), `fetch keepalive` fallback. The fetch fallback DOES inspect the
 * HTTP status: a 4xx/5xx reports TRK-1006 (GATEWAY_REJECTED) instead of lying
 * "sent". (A queued beacon cannot be inspected — that's inherent to beacons and
 * acceptable for low-risk click events; the gateway's D1 ledger is the ground
 * truth either way.)
 */
export async function sendToWorker(payload: ConversionPayload): Promise<boolean> {
  if (SERVER_INGRESS_ONLY_EVENTS.has(payload.event_name) || !BROWSER_GATEWAY_EVENTS.has(payload.event_name)) {
    report('GATEWAY_SERVER_ONLY_EVENT', { event_name: payload.event_name });
    return false;
  }

  // Meta browser ids. Cookie READ is terminal-storage access under PECR, so it
  // goes through the same marketing gate as the rest of the package
  // (persistence.ts getFbp/getFbc) — not a second, ungated `getCookie` path.
  // `_ga` / `_ga_<stream>` stay here: GA4's own cookies are analytics-scoped and
  // the browser GA4 leg owns them (Model 2); the gateway sends no GA4.
  const fbp = getFbp() || undefined;
  const fbc = getFbcCookie() || undefined;
  const clientId = extractGAClientId(getCookie('_ga'));
  const sessionId = extractGASessionId();
  // Meta `external_id` (6.16.0). A hívó értéke nyer; ha nincs, a saját `sb_uid`
  // (marketing read-gate mögött, és CSAK hozzájárulás mellett jön létre).
  // Hozzájárulás nélkül SEMMILYEN external_id nem hagyja el a böngészőt — a
  // hívóé sem: ez hirdetési azonosító, a jogalapja ugyanaz, mint az fbp-é.
  // A Worker hash-eli; itt NINCS hash (CLAUDE.md §1).
  const userData = withExternalId(payload.user_data);
  // Az attribúció-gyűjtés IS olvas storage-ot (`__sb_attribution`) — ezért előbb
  // fut le, és CSAK utána készül a telemetria-pillanatkép. Fordítva a saját
  // blokkja kimaradna a jelentésből, vagyis a mérőműszer pont azt a hozzáférést
  // nem látná, amiért készült.
  const attribution = payload.attribution || collectAttribution();
  const readBlocked = getStorageReadBlocked();

  const body = JSON.stringify({
    ...payload,
    user_data: userData,
    fbp,
    fbc,
    client_id: clientId,
    session_id: sessionId,
    consent: payload.consent || getConsentState(),
    // CMP Fázis 2 (1.3): a döntés-lánc azonosítója a konverzió receiptjére —
    // ezen keresztül oldja fel az offline/replay ág a consent_log AKTUÁLIS
    // állapotát. CookieYes-provider alatt undefined (a mező ki sem megy), a
    // szerveren NULL — nem hiba.
    consent_id: isSboConsentProvider() ? readSboConsent(trackingConfig.policyVersion)?.consentId : undefined,
    // Fázis D telemetria — a döntést NEM befolyásolja, csak jelenti, mit láttak
    // a párhuzamos consent-források ebben a pillanatban.
    consent_sources: collectConsentSources(),
    // PECR read-gate telemetria: blokkolt-e a consent-kapu storage-OLVASÁST ezen
    // az oldalletöltésen. GRANTED consent melletti magas arány = betöltési
    // verseny (a CookieYes API még nem töltött be, amikor olvastunk volna).
    storage_read_blocked: readBlocked.blocked,
    storage_read_blocked_keys: readBlocked.keys,
    attribution,
    event_source_url: payload.event_source_url || location.href
  });

  if (typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      const queued = navigator.sendBeacon('/api/event/conversion', blob);
      if (queued) { report('GATEWAY_OK', { event_name: payload.event_name, transport: 'beacon' }); return true; }
      report('GATEWAY_BEACON_FALLBACK', { event_name: payload.event_name });
    } catch {
      report('GATEWAY_BEACON_FALLBACK', { event_name: payload.event_name });
    }
  }

  try {
    const res = await fetch('/api/event/conversion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    });
    if (!res.ok) {
      // 403 = Origin not allow-listed OR a server-ingress-only event slipped
      // through (TRK-400-017 on the gateway); 429 = rate limit; 404 = hostname
      // missing from SITE_CONFIG KV. All of them mean the conversion did NOT land.
      report('GATEWAY_REJECTED', { event_name: payload.event_name, status: res.status });
      return false;
    }
    report('GATEWAY_OK', { event_name: payload.event_name, transport: 'fetch' });
    return true;
  } catch (err) {
    report('GATEWAY_NETWORK_FAIL', { event_name: payload.event_name, error: String(err) });
    return false;
  }
}

/**
 * @deprecated Prefer the consent-safe entry points in `index.ts`
 * (`trackServerEvent` / `trackPhoneConversion` …). This low-level helper is kept
 * for direct/advanced use. It is CONSENT-GATED to match the skill's consent
 * matrix: the dataLayer push needs analytics consent, the gateway dispatch needs
 * marketing consent. Without either it is a no-op. The gateway leg only accepts
 * browser-path events (see `sendToWorker`).
 */
export async function trackConversion(
  eventName: string,
  params: {
    event_id?: string;
    value?: number;
    currency?: string;
    source?: string;
    service?: string;
    user_data?: UserData;
    consent?: ConsentState;
  } = {}
): Promise<void> {
  const analytics = hasAnalyticsConsent();
  const marketing = hasMarketingConsent();
  if (!analytics && !marketing) return; // no consent → don't push or dispatch

  const eventId = params.event_id || generateUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // 1. Client GTM dataLayer push (for Meta Pixel browser-side dedup) — analytics consent.
  // PII does NOT go into the dataLayer.
  if (analytics && typeof window !== 'undefined') {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: eventName,
      event_id: eventId,
      ...(params.value !== undefined && { value: params.value }),
      ...(params.currency && { currency: params.currency }),
      ...(params.source && { source: params.source }),
      ...(params.service && { service: params.service })
    });
  }

  // 2. Server-side Worker dispatch (PII in the body, hashed in the Worker) — marketing consent.
  if (marketing) {
    await sendToWorker({
      event_name: eventName,
      event_id: eventId,
      event_time: eventTime,
      value: params.value,
      currency: params.currency,
      source: params.source,
      service: params.service,
      user_data: params.user_data,
      consent: params.consent
    });
  }
}
