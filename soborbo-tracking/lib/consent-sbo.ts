/**
 * Soborbo CMP · Fázis 2 — a döntés RÖGZÍTÉSE (cookie-írás, purge, POST, retry).
 *
 * A SZINKRON állapot-olvasat a `consent-sbo-state.ts`-ben él (függőség-mentesen,
 * import-kör nélkül); ez a modul a banner/panel felől hívott írási oldal:
 *
 *   applySboDecision()        — cookie + purge + event + POST (pending-gel)
 *   flushPendingSboConsent()  — a 503 után őrzött döntések újraküldése
 *   readCkyParallelWindow()   — a CookieYes sütijének olvasata a 2.4-es
 *                               párhuzamos mérési ablakhoz
 *   postBannerShown()         — ID-MENTES banner-megjelenés ping
 *
 * ŐSZINTE STÁTUSZKEZELÉS (a gateway consent-endpointjának tükre):
 *   204  → tárolva (vagy idempotens duplikátum) → a pending példány törölhető
 *   4xx  → a payload hibás/tiltott — az ismétlés ugyanazt adná → eldobjuk, DE
 *          hangosan (TRK-4002); a süti-állapot lokálisan attól még érvényes
 *   404  → KIVÉTEL: a végpont (még) nincs ott — hiányzó site-proxy vagy
 *          host-config. Ez konfig-lemaradás, nem a döntés hibája → megőrizzük.
 *          (A gateway a saját config-lemaradására 503-at ad, TRK-910-011.)
 *   429 / 5xx / network → a kliens AZ EGYETLEN ŐRZŐ → a pending megmarad, és a
 *          következő oldalletöltés UGYANAZZAL a consent_event_id-vel újraküldi
 *          (az idempotenciát a szerver UNIQUE indexe adja)
 */

import {
  SBO_CONSENT_COOKIE,
  SBO_CONSENT_EVENT,
  SBO_CONSENT_MAX_AGE_S,
  encodeSboConsentCookie,
  readSboConsent,
  type SboConsentState,
  type SboDecisionKind
} from './consent-sbo-state';
import { trackingConfig, CLIENT_LIB_VERSION, type ConsentModeKind } from './config';
import { generateUUID } from './uuid';
import { report } from './observability';
import { purgeMarketingStorage, purgeAnalyticsStorage } from './persistence';

/**
 * A még nem igazolt döntések sora. localStorage, a MŰKÖDÉSHEZ SZÜKSÉGES
 * jogalapon: maga a consent-döntés bizonyítéka, nem mérési adat — pontosan az
 * az eset, amit a szöveg "a te süti-döntésed tárolása"-ként nevez meg.
 */
const PENDING_KEY = 'sbo_consent_pending';
/** Elszabadult kliens-ciklus ne növelhesse korlátlanul. */
const PENDING_MAX = 10;
/**
 * A 6.11–6.12 a lánc-kulcsot itt tartotta. A 6.13 óta a kulcsot a SZERVER adja
 * ki HttpOnly sütiben (`sbo_consent_key`, Path=/api/consent) — a böngésző JS-e
 * nem is látja, és a letiltott localStorage nem hagy védelem nélküli láncot. A
 * régi bejegyzést csak eltakarítjuk.
 */
const LEGACY_CONSENT_KEY_STORAGE = 'sbo_consent_key';

export interface SboDecisionInput {
  analytics: boolean;
  marketing: boolean;
}

export interface SboDecisionContext {
  bannerVersion: string;
  consentTextVersion: string;
  /**
   * Az OLDAL nyelve (`<html lang>`), ahol a döntés született — a banner ezt
   * adja át (6.14.0). Hiányában a build-szintű `trackingConfig.locale`. A wire
   * felé a `normalizeConsentLang` alakja megy.
   */
  lang?: string;
}

/**
 * A gateway `lang` mezője CSAK `xx` vagy `xx-YY` alakot fogad (consent-log
 * `LANG_RE`), és egy rossz alak a TELJES döntés-POST-ot 400-zal utasítja el —
 * a döntés bizonyítéka veszne el egy nyelvi címke miatt. Egy többnyelvű site
 * `<html lang>`-ja viszont lehet `zh-Hant` vagy `sr-Latn-RS` is. Ezért:
 *   `hu` / `en-GB`      → változatlan
 *   `zh-Hant` / `de-DE-x` → az elsődleges altag (`zh` / `de`)
 *   üres / értelmezhetetlen → undefined (a hívó a locale-ra esik vissza)
 */
export function normalizeConsentLang(raw: string | undefined | null): string | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  if (/^[A-Za-z]{2}(-[A-Za-z]{2})?$/.test(s)) return s;
  const primary = s.split('-')[0];
  return /^[A-Za-z]{2}$/.test(primary) ? primary : undefined;
}

/** A `POST /api/consent` wire-payloadja (a szerver parseConsentPayload párja). */
export interface SboConsentWirePayload {
  consent_id: string;
  consent_event_id: string;
  revision: number;
  decision: SboDecisionKind;
  cat_analytics: boolean;
  cat_marketing: boolean;
  /** A ténylegesen futó mód (a boot ugyanebből a configból dönt) — bizonyíték. */
  consent_mode: ConsentModeKind;
  policy_version: string;
  banner_version: string;
  consent_text_version: string;
  ruleset: string;
  lang?: string;
  client_lib_version: string;
  cky_cookie_analytics?: boolean;
  cky_cookie_marketing?: boolean;
  client_decided_at: string;
  /**
   * Lánc-forgatásnál az ELŐZŐ lánc (review R7): a szerver utód-kapcsolatként
   * tárolja, és a régi lánc állapotát az új lánc döntéseivel metszi — egy
   * későbbi visszavonás így a régi consent_id-hoz kötött eseményekre is hat.
   */
  previous_consent_id?: string;
}

// ── Consent-végpont (6.14.0) ────────────────────────────────────────────────

/**
 * MINDEN consent-URL egy helyről. Az alap a `PUBLIC_TRACKING_CONSENT_ENDPOINT`
 * (default `/api/consent`); a `path` egy csupasz szegmens (`'shown'`), üresen
 * maga az alap jön vissza.
 *
 * A záró perjel az alapon TISZTELETBEN TARTOTT, és a szegmensre is átöröklődik:
 *   `/api/consent`  → `/api/consent`,  `/api/consent/shown`
 *   `/api/consent/` → `/api/consent/`, `/api/consent/shown/`
 * Erre a `trailingSlash: 'always'` Astro-site-oknak van szüksége (skinlab), ahol
 * a `/api/consent/*` proxy csak perjeles útvonalra illeszkedik. Perjel nélkül a
 * kimenő kérések bájtra a 6.13-asak.
 */
export function consentEndpointUrl(path = ''): string {
  const base = trackingConfig.consentEndpoint || '/api/consent';
  if (!path) return base;
  const trailing = base.endsWith('/');
  const root = trailing ? base.slice(0, -1) : base;
  return `${root}/${path}${trailing ? '/' : ''}`;
}

// ── CookieYes párhuzamos ablak (2.4) ────────────────────────────────────────
//
// A pilot alatt a CookieYes szkript KIKAPCSOLT bannerrel bent marad, hogy a
// sütije olvasható legyen — így ugyanarra a látogatóra közvetlenül összevethető
// a két rendszer (`cky_agreement`-et a SZERVER számolja). A parser a
// gateway.ts `readCookieYesCookieRaw` párja; azért nem onnan importált, mert a
// gateway a persistence→consent láncon át erre a modulra mutatna vissza (kör).
export function readCkyParallelWindow(): {
  cky_cookie_analytics?: boolean;
  cky_cookie_marketing?: boolean;
} {
  try {
    if (typeof document === 'undefined') return {};
    const m = document.cookie.match(/(?:^|;\s*)cookieyes-consent=([^;]*)/);
    if (!m) return {};
    const map: Record<string, string> = {};
    for (const part of decodeURIComponent(m[1]).split(',')) {
      const idx = part.indexOf(':');
      if (idx > 0) map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    // Csak a TÉNYLEGESEN jelen lévő kulcsok — a hiányzó mező undefined marad
    // (a szerveren NULL), nem hamis `false`.
    const out: { cky_cookie_analytics?: boolean; cky_cookie_marketing?: boolean } = {};
    if (map.analytics !== undefined) out.cky_cookie_analytics = map.analytics === 'yes';
    if (map.advertisement !== undefined) out.cky_cookie_marketing = map.advertisement === 'yes';
    return out;
  } catch {
    return {};
  }
}

// ── Cookie-írás ─────────────────────────────────────────────────────────────

function writeSboConsentCookie(state: SboConsentState): void {
  if (typeof document === 'undefined') return;
  try {
    // A Secure attribútum protokoll-függő: http-s dev/preview alatt a böngésző
    // a Secure sütit némán eldobná — a banner működne, a döntés mégsem élne túl
    // egy oldalváltást. Élesben (https) mindig Secure.
    const secure =
      typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    document.cookie =
      `${SBO_CONSENT_COOKIE}=${encodeSboConsentCookie(state)}` +
      `; path=/; max-age=${SBO_CONSENT_MAX_AGE_S}; SameSite=Lax${secure}`;
  } catch {
    /* a memóriában élő state ettől még érvényes az oldalletöltésre */
  }
}

// ── Lánc-kulcs (R7) ─────────────────────────────────────────────────────────

function dropLegacyConsentKey(): void {
  try {
    localStorage.removeItem(LEGACY_CONSENT_KEY_STORAGE);
  } catch {
    /* nincs tárhely — nincs mit takarítani */
  }
}

// ── Pending queue ───────────────────────────────────────────────────────────

function readPending(): SboConsentWirePayload[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as SboConsentWirePayload[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: SboConsentWirePayload[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-PENDING_MAX)));
  } catch {
    /* private mode / kvóta — a döntés a sütiben él tovább, csak a proof-retry vész el */
  }
}

function removePending(consentEventId: string): void {
  writePending(readPending().filter((p) => p.consent_event_id !== consentEventId));
}

// ── POST ────────────────────────────────────────────────────────────────────

type PostOutcome = 'stored' | 'rejected' | 'retryable' | 'key_mismatch';

async function responseText(res: Response): Promise<string> {
  try {
    return typeof res.text === 'function' ? await res.text() : '';
  } catch {
    return '';
  }
}

async function postConsent(payload: SboConsentWirePayload): Promise<PostOutcome> {
  try {
    const res = await fetch(consentEndpointUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      // A szerver kiadta lánc-kulcs (HttpOnly süti) csak így megy vissza.
      credentials: 'same-origin'
    });
    if (res.status === 204) {
      report('CONSENT_STORED', { revision: payload.revision, decision: payload.decision });
      return 'stored';
    }
    if (res.status === 403 && (await responseText(res)) === 'consent_key_mismatch') {
      // Bővítés kulcs nélkül: a lánc kulcsa nálunk nincs meg (elveszett, vagy egy
      // másik lap épp most kapta meg), VAGY régi, kulcs nélküli lánc. Lásd
      // handleKeyMismatch.
      report('CONSENT_POST_REJECTED', { status: res.status, decision: payload.decision, reason: 'key_mismatch' });
      return 'key_mismatch';
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 404) {
      // 400 = hibás payload (megnevezett okkal), 403 = origin/provider-tiltás.
      // Az újraküldés determinisztikusan ugyanezt adná — de a kudarc HANGOS.
      report('CONSENT_POST_REJECTED', { status: res.status, decision: payload.decision });
      return 'rejected';
    }
    report('CONSENT_POST_RETRYABLE', { status: res.status, decision: payload.decision });
    return 'retryable';
  } catch (err) {
    report('CONSENT_POST_RETRYABLE', { error: String(err), decision: payload.decision });
    return 'retryable';
  }
}

async function submitWithPending(payload: SboConsentWirePayload): Promise<void> {
  const outcome = await postConsent(payload);
  if (outcome === 'retryable') return; // marad a pending sorban; a következő oldalletöltés flushol
  removePending(payload.consent_event_id);
  if (outcome === 'key_mismatch') await handleKeyMismatch(payload);
}

/**
 * A 403 consent_key_mismatch kezelése (2026-10-18 review R7). A szerver kulcs
 * nélkül csak SZIGORÍTÁST fogad el, tehát ez mindig egy engedély-BŐVÍTÉS volt:
 *
 *  1. Elavult döntés (közben újabb született a sütiben, vagy a süti már másik
 *     láncon áll) → nincs teendő: a későbbi döntés a saját útján megy.
 *  2. Egy párhuzamos lap épp most kötötte a lánc kulcsát → a kulcs-süti azóta
 *     megérkezhetett: EGYSZER újrapróbáljuk ugyanazt a döntést.
 *  3. Továbbra is elutasítva (kulcsvesztés, vagy régi, kulcs nélküli lánc) → a
 *     döntés ÚJ láncon megy (lásd rotateChain). A régi lánc a szigorúbb (vagy
 *     azonos) állapotában marad — a régi eseményekre ez a biztonságos irány; egy
 *     VISSZAVONÁS sosem jut ide, mert az kulcs nélkül is eljut a régi lánchoz.
 */
async function handleKeyMismatch(rejected: SboConsentWirePayload): Promise<void> {
  const isCurrent = () => {
    const c = readSboConsent();
    return c !== null && c.consentId === rejected.consent_id && c.revision === rejected.revision;
  };
  if (!isCurrent()) return;
  // UGYANAZ a döntés (ugyanazzal a consent_event_id-vel — el sem tárolódott).
  const outcome = await postConsent(rejected);
  if (outcome === 'stored') return;
  if (outcome === 'retryable') {
    writePending([...readPending(), rejected]);
    return;
  }
  if (outcome === 'key_mismatch' && isCurrent()) await rotateChain(rejected);
}

/**
 * Új lánc a böngésző AKTUÁLIS döntésével: új `consent_id`, revision=1. A szerver
 * az új lánchoz a böngésző (meglévő vagy most kiadott) kulcsát köti — a döntés
 * így nem vész el, és az új konverziók már az új lánchoz kötődnek.
 */
async function rotateChain(rejected: SboConsentWirePayload): Promise<void> {
  const current = readSboConsent();
  if (!current) return;
  const fresh: SboConsentState = {
    ...current,
    consentId: generateUUID(),
    revision: 1,
    decision: decisionKind({ analytics: current.analytics, marketing: current.marketing }, null),
    decidedAtSec: Math.floor(Date.now() / 1000)
  };
  writeSboConsentCookie(fresh);
  const payload: SboConsentWirePayload = {
    ...rejected,
    consent_id: fresh.consentId,
    consent_event_id: generateUUID(),
    revision: 1,
    decision: fresh.decision,
    cat_analytics: fresh.analytics,
    cat_marketing: fresh.marketing,
    client_decided_at: new Date(fresh.decidedAtSec * 1000).toISOString(),
    previous_consent_id: rejected.consent_id
  };
  writePending([...readPending(), payload]);
  const outcome = await postConsent(payload);
  if (outcome !== 'retryable') removePending(payload.consent_event_id);
}

/**
 * A 503/network után őrzött döntések újraküldése — hívd minden oldalletöltésen
 * (a banner-init része). Sorrendben megy (a revision-monotonitás miatt kényelmes,
 * bár a szerver a fordított beérkezést is jól kezeli: az olvasó MAX(revision));
 * az első retryable kudarcnál megáll, a többi példány marad.
 */
export async function flushPendingSboConsent(): Promise<void> {
  for (const payload of readPending()) {
    const outcome = await postConsent(payload);
    if (outcome === 'retryable') return;
    removePending(payload.consent_event_id);
    if (outcome === 'key_mismatch') await handleKeyMismatch(payload);
  }
}

// ── A döntés maga ───────────────────────────────────────────────────────────

function decisionKind(input: SboDecisionInput, prev: SboConsentState | null): SboDecisionKind {
  if (input.analytics && input.marketing) return 'accept_all';
  if (input.analytics !== input.marketing) return 'custom';
  // Mindkettő ki: az ELSŐ ilyen döntés elutasítás; egy korábban engedett
  // kategória lekapcsolása VISSZAVONÁS — a kettő jogilag nem ugyanaz, és a
  // consent_log a különbséget méri.
  return prev && (prev.analytics || prev.marketing) ? 'withdrawn' : 'reject_all';
}

/**
 * Egy banner/panel-döntés teljes lefutása:
 *  1. új state (revision+1, stabil consent_id) → sütibe (a LOKÁLIS igazság első)
 *  2. purge a VISSZAVONT kategóriák tárolt adataira (#61 függvényei — data at rest)
 *  3. `sbo_consent_update` CustomEvent (a consent.ts onConsentChange erre is figyel)
 *  4. wire-payload → pending queue → POST (a queue-ból 204 után kerül ki)
 *
 * A visszatérő state-tel a hívó (banner) frissíti a Consent Mode jeleket és
 * indítja a GTM-et, ha kell — az a DOM-oldal dolga, nem ezé a modulé.
 */
export function applySboDecision(
  input: SboDecisionInput,
  ctx: SboDecisionContext
): SboConsentState {
  // A `prev` olvasása SZÁNDÉKOSAN policy-verzió-kapu NÉLKÜL történik. A kapu
  // arra való, hogy egy RÉGI szöveghez adott döntés ne kapuzza a trackinget —
  // de az AUDIT-LÁNCOT nem szabad elvágnia: a `consent_id` a preferencia-lánc
  // stabil azonosítója, a `revision` pedig monoton. Ha itt is kapuznánk, egy
  // szövegváltozás után minden látogató új consent_id-t és revision=1-et kapna,
  // és a „mit döntött korábban" bizonyíték-lánc elszakadna.
  const prev = readSboConsent();

  const state: SboConsentState = {
    analytics: input.analytics,
    marketing: input.marketing,
    revision: (prev?.revision ?? 0) + 1,
    decision: decisionKind(input, prev),
    consentId: prev?.consentId ?? generateUUID(),
    decidedAtSec: Math.floor(Date.now() / 1000),
    // A döntés AHHOZ a szöveghez kötődik, amit a látogató ÉPP most olvasott.
    policyVersion: trackingConfig.policyVersion
  };

  writeSboConsentCookie(state);

  // Purge a lefokozott kategóriákra — a visszavonásnak a NYUGVÓ adatot is el
  // kell érnie (sb_tracking, sb_first_touch, __sb_attribution, _fbp/_fbc, ill.
  // sb_session), nem csak a jövőbeli írásokat.
  if (prev?.marketing && !input.marketing) purgeMarketingStorage();
  if (prev?.analytics && !input.analytics) purgeAnalyticsStorage();

  try {
    document.dispatchEvent(new CustomEvent(SBO_CONSENT_EVENT, { detail: state }));
  } catch {
    /* nem-DOM környezet */
  }

  const payload: SboConsentWirePayload = {
    consent_id: state.consentId,
    consent_event_id: generateUUID(),
    revision: state.revision,
    decision: state.decision,
    cat_analytics: state.analytics,
    cat_marketing: state.marketing,
    consent_mode: trackingConfig.consentMode,
    policy_version: trackingConfig.policyVersion,
    banner_version: ctx.bannerVersion,
    consent_text_version: ctx.consentTextVersion,
    ruleset: trackingConfig.ruleset,
    lang: normalizeConsentLang(ctx.lang) ?? trackingConfig.locale,
    client_lib_version: CLIENT_LIB_VERSION,
    ...readCkyParallelWindow(),
    client_decided_at: new Date(state.decidedAtSec * 1000).toISOString()
  };
  dropLegacyConsentKey();

  // ELŐBB a pending, AZTÁN a POST: ha a Worker/tab a kettő között hal meg, a
  // döntés proof-ja megmarad, és a következő betöltés újraküldi. Fordítva a
  // proof pont a kritikus ablakban veszne el.
  writePending([...readPending(), payload]);
  void submitWithPending(payload);

  return state;
}

/**
 * A banner-megjelenés ID-MENTES pingje (consent_metrics). sendBeacon: a válasz
 * nem érdekes (a szerver a metrika-hibát lenyeli), a lap elhagyását viszont túl
 * kell élnie. TILOS bármilyen azonosítót tenni bele — a szerver az ilyen
 * payloadot ELUTASÍTJA (identifier_not_allowed), és ez így helyes.
 */
export function postBannerShown(m: {
  banner_version: string;
  lang?: string;
  device_class?: 'mobile' | 'tablet' | 'desktop';
  interaction_ms?: number;
}): void {
  try {
    // A `lang` itt is a gateway alakjára szűkül; alak nélkül kimarad (a
    // metrika-sor nyelv nélkül is érvényes, egy 400 viszont az egészet elvinné).
    const lang = normalizeConsentLang(m.lang);
    const body = JSON.stringify({ ...m, lang });
    const url = consentEndpointUrl('shown');
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {});
  } catch {
    /* UX-metrika — sosem hibáztatjuk érte a látogatót */
  }
}
