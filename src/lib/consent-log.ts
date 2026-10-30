/**
 * Soborbo CMP · Fázis 1 — a consent-döntés payload validálása és leképezése
 * (pure; D1 nélkül tesztelhető). A tényleges írás/olvasás a ledger.ts-ben van,
 * az endpoint a routes/consent.ts-ben.
 *
 * FOGALMAK (a három azonosító nem cserélhető fel):
 *  - `consent_id`       — a böngésző/preferencia-lánc STABIL azonosítója. Több
 *                         döntésen át ugyanaz; a sütiben él.
 *  - `consent_event_id` — EGY konkrét döntés UUID-ja. Ez az IDEMPOTENCIA-KULCS.
 *                         A kliens 503 után UGYANEZT küldi újra, ezért nem lehet
 *                         timestamp: két retry azonos kulcsot kell adjon.
 *  - `revision`         — döntésenként nő. Fordított sorrendben beérkező beaconök
 *                         nem cserélhetik fel az állapotot: az olvasó MAX(revision).
 *
 * A modul SEMMIT nem dönt el a kézbesítésről. A `provider='cookieyes'` (minden
 * site alapértéke) mellett ez a kód nem is fut le — a Fázis 1 inert.
 */

/**
 * A konverziós payload `consent_id` mezője → tárolható string, vagy undefined.
 *
 * SOSEM dob és sosem utasít el eventet: rossz forma → „nincs kötés" (NULL a
 * receipten). Ez KÖTÉS a consent-bizonyítékhoz, nem consent-döntés — egy
 * elrontott mező miatt konverziót veszíteni aránytalan lenne.
 */
export function parseConsentId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length >= 8 && t.length <= MAX_ID_LEN && ID_RE.test(t) ? t : undefined;
}

/**
 * Fut-e a SAJÁT CMP ezen a site-on?
 *
 * A hiányzó `consent` blokk és a `provider: 'cookieyes'` UGYANAZ, és jelenleg
 * minden site ilyen — ez az a pont, ahol a Fázis 1 inertsége eldől. EGY helyen
 * definiálva, hogy ne csúszhasson szét a route, a GA4-kapu és a jövőbeli hívók
 * között (három külön `=== 'sbo'` összehasonlításból egy nap kettő maradna).
 */
export function isConsentProviderSbo(site: { consent?: { provider?: string } }): boolean {
  return site.consent?.provider === 'sbo';
}

// A GA4-kapu (régen `isGa4AllowedForSite`) és az offline-/replay-kapu (régen
// `isBlockedByConsentState`, ledger `isOfflineUploadBlocked`) a 2026-10-18-i
// egységesítés óta EGY függvény: `decideAdConsent` (a fájl végén) — kategóriával
// (ads / analytics). Saját CMP-n a GA4 a consent_log AKTUÁLIS analitika-állapotát
// kéri; a DUAA statisztikai kivétel a GA4-et nem menti meg (Google saját célú
// felhasználás), ezért hiányzó jel ott is tiltás.

/** A döntés fajtái. A `withdrawn` is DÖNTÉS: új sor, nem UPDATE. */
export const CONSENT_DECISIONS = ['accept_all', 'reject_all', 'custom', 'withdrawn'] as const;
export type ConsentDecisionKind = (typeof CONSENT_DECISIONS)[number];

/** Google Consent Mode v2 jel-értékek, ahogy a consent_log tárolja. */
export type ConsentSignalValue = 'GRANTED' | 'DENIED';

/** basic | advanced — per-site KV-érték. A default `basic` (v4 terv, 8. függelék). */
export const CONSENT_MODES = ['basic', 'advanced'] as const;
export type ConsentModeKind = (typeof CONSENT_MODES)[number];

/**
 * Hosszkorlátok. Nem esztétika: a `POST /api/consent` NYILVÁNOS (origin-kapuzott,
 * de nem hitelesített) végpont, és minden szabad szöveges mező D1-be íródik.
 */
const MAX_ID_LEN = 64;
const MAX_VERSION_LEN = 64;
const MAX_LANG_LEN = 8;
const MAX_SHORT_LEN = 32;
export const MAX_REVISION = 10_000;

/** Azonosító-formátum: UUID-t várunk, de nem kötjük meg — bármi biztonságos rövid ID jó. */
const ID_RE = /^[A-Za-z0-9_.:-]{8,64}$/;
/** Verzió-címkék (policy/banner/text/ruleset): Git-ben létező könyvtárnevek. */
const VERSION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LANG_RE = /^[A-Za-z]{2}(-[A-Za-z]{2})?$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const DEVICE_CLASSES = new Set(['mobile', 'tablet', 'desktop']);

/**
 * A validált, D1-re írható döntés. Minden mező már normalizált — az író rétegnek
 * (ledger.ts) nem kell tisztítania.
 */
export interface ConsentLogEntry {
  consent_id: string;
  consent_event_id: string;
  revision: number;
  site_id: string;
  decision: ConsentDecisionKind;
  cat_analytics: 0 | 1;
  cat_marketing: 0 | 1;
  ad_user_data: ConsentSignalValue;
  ad_personalization: ConsentSignalValue;
  ad_storage: ConsentSignalValue;
  analytics_storage: ConsentSignalValue;
  consent_mode: ConsentModeKind;
  policy_version: string;
  banner_version: string;
  consent_text_version: string;
  ruleset: string;
  lang?: string;
  country?: string;
  client_lib_version?: string;
  /** Párhuzamos mérési ablak — mit mondott a CookieYes UGYANABBAN a pillanatban. */
  cky_cookie_analytics?: 0 | 1;
  cky_cookie_marketing?: 0 | 1;
  cky_agreement?: 0 | 1;
  client_decided_at: string;
  /**
   * Lánc-forgatásnál az ELŐZŐ lánc azonosítója (review R7): csak az új lánc első
   * (kötő) döntésénél tárolódik, a consent_chain-ben. Lásd 0013 migráció.
   */
  previous_consent_id?: string;
  /**
   * A lánc kulcsa igazolta-e a sort (a route tölti ki; review R7). A kulcs maga
   * NEM a payload része: a szerver adja ki HttpOnly sütiben (routes/consent.ts).
   */
  verified?: boolean;
}

/** Banner-megjelenés (ID-MENTES — lásd a migráció kommentjét). */
export interface ConsentMetricEntry {
  site_id: string;
  banner_version: string;
  lang?: string;
  device_class?: string;
  interaction_ms?: number;
}

/** A validáció eredménye: vagy egy tiszta rekord, vagy egy MEGNEVEZETT ok. */
export type ConsentPayloadResult =
  | { ok: true; entry: ConsentLogEntry }
  | { ok: false; reason: string };

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length === 0 || t.length > max) return undefined;
  return t;
}

/** `true`/`false` → 1/0. Bármi más → undefined (a hívó dönti el, kötelező-e). */
function bit(v: unknown): 0 | 1 | undefined {
  if (v === true) return 1;
  if (v === false) return 0;
  return undefined;
}

/**
 * A kategóriák → a négy Consent Mode v2 jel. EGY leképezés, itt és sehol máshol.
 *
 * Az ad-hármas EGYSÉG: mindhárom a marketing-kategóriából jön. Ha ezt a hívó
 * oldalán engednénk szétcsúszni, pont a TRK-910-005 (`signals_inconsistent`)
 * gyártanánk magunknak — azt a hibát, amit a Fázis D MÁS rendszereken mér.
 */
export function signalsFromCategories(analytics: boolean, marketing: boolean): {
  ad_user_data: ConsentSignalValue;
  ad_personalization: ConsentSignalValue;
  ad_storage: ConsentSignalValue;
  analytics_storage: ConsentSignalValue;
} {
  const ad: ConsentSignalValue = marketing ? 'GRANTED' : 'DENIED';
  return {
    ad_user_data: ad,
    ad_personalization: ad,
    ad_storage: ad,
    analytics_storage: analytics ? 'GRANTED' : 'DENIED'
  };
}

/**
 * A `decision` és a kategóriák egymásból következnek — az ellentmondást ELUTASÍTJUK,
 * nem „javítjuk". Egy `accept_all`, ami mellett `cat_marketing=false`, vagy hibás
 * kliens, vagy hamisítás; mindkét esetben rosszabb csendben eltárolni valamit, mint
 * 400-at adni. (A `withdrawn` definíció szerint mindkét kategóriát lekapcsolja.)
 */
export function decisionMatchesCategories(
  decision: ConsentDecisionKind,
  analytics: boolean,
  marketing: boolean
): boolean {
  switch (decision) {
    case 'accept_all':
      return analytics && marketing;
    case 'reject_all':
    case 'withdrawn':
      return !analytics && !marketing;
    case 'custom':
      // A `custom` az összes maradék kombináció — beleértve a csak-analytics és a
      // csak-marketing esetet. A mindkettő-be/mindkettő-ki a saját nevén megy.
      return analytics !== marketing;
  }
}

/**
 * A nyers `POST /api/consent` body → validált rekord.
 *
 * SOSEM dob. A hibaokok MEGNEVEZETTEK, mert a 400-as választ a kliens naplózza,
 * és egy „invalid payload" üzenetből egy hónap múlva senki nem tudja megmondani,
 * melyik mező romlott el a bannerben.
 */
/**
 * A Cloudflare IP-geolokációs országkódja (`request.cf.country`) a consent_log
 * `country` oszlopához, vagy undefined. Az `XX` (ismeretlen) és a `T1` (Tor) nem
 * ország — azokat nem írjuk be. Pure, a hívó adja át a nyers értéket.
 */
export function serverObservedCountry(cfCountry: unknown): string | undefined {
  if (typeof cfCountry !== 'string') return undefined;
  const c = cfCountry.toUpperCase();
  return COUNTRY_RE.test(c) && c !== 'XX' ? c : undefined;
}

/**
 * @param serverCountry a SZERVER által megfigyelt ország (serverObservedCountry).
 *   Ha van, ez nyer a kliens által küldött `country` fölött: a kliens-lib
 *   (6.9.0–6.17.x) egyáltalán nem küld országot, és egy mért érték a consent-
 *   proofban többet ér egy bevallottnál (2026-10 pilot-review A5: 100% NULL).
 */
export function parseConsentPayload(
  body: unknown,
  siteId: string,
  serverCountry?: string
): ConsentPayloadResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body_not_object' };
  }
  const p = body as Record<string, unknown>;

  const consentId = str(p.consent_id, MAX_ID_LEN);
  if (!consentId || !ID_RE.test(consentId)) return { ok: false, reason: 'invalid_consent_id' };

  const eventId = str(p.consent_event_id, MAX_ID_LEN);
  if (!eventId || !ID_RE.test(eventId)) return { ok: false, reason: 'invalid_consent_event_id' };

  // A revision egész és pozitív. Felső korlát: egy elszabadult kliens-ciklus ne
  // tudjon a végtelenségig sorokat gyártani ugyanarra a consent_id-re.
  const revision = p.revision;
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > MAX_REVISION
  ) {
    return { ok: false, reason: 'invalid_revision' };
  }

  const decision = str(p.decision, MAX_SHORT_LEN);
  if (!decision || !(CONSENT_DECISIONS as readonly string[]).includes(decision)) {
    return { ok: false, reason: 'invalid_decision' };
  }

  const analytics = bit(p.cat_analytics);
  const marketing = bit(p.cat_marketing);
  if (analytics === undefined || marketing === undefined) {
    return { ok: false, reason: 'invalid_categories' };
  }
  if (!decisionMatchesCategories(decision as ConsentDecisionKind, analytics === 1, marketing === 1)) {
    return { ok: false, reason: 'decision_categories_mismatch' };
  }

  const mode = str(p.consent_mode, MAX_SHORT_LEN) ?? 'basic';
  if (!(CONSENT_MODES as readonly string[]).includes(mode)) {
    return { ok: false, reason: 'invalid_consent_mode' };
  }

  const policyVersion = str(p.policy_version, MAX_VERSION_LEN);
  const bannerVersion = str(p.banner_version, MAX_VERSION_LEN);
  const textVersion = str(p.consent_text_version, MAX_VERSION_LEN);
  const ruleset = str(p.ruleset, MAX_VERSION_LEN);
  // MIND A NÉGY KÖTELEZŐ. Verzió nélkül a sor nem consent-proof: nem tudnánk
  // megmondani, MIT olvasott a látogató, amikor igent mondott (GDPR Art. 7(1)).
  if (!policyVersion || !VERSION_RE.test(policyVersion)) {
    return { ok: false, reason: 'invalid_policy_version' };
  }
  if (!bannerVersion || !VERSION_RE.test(bannerVersion)) {
    return { ok: false, reason: 'invalid_banner_version' };
  }
  if (!textVersion || !VERSION_RE.test(textVersion)) {
    return { ok: false, reason: 'invalid_consent_text_version' };
  }
  if (!ruleset || !VERSION_RE.test(ruleset)) return { ok: false, reason: 'invalid_ruleset' };

  const decidedAt = str(p.client_decided_at, 40);
  if (!decidedAt || Number.isNaN(Date.parse(decidedAt))) {
    return { ok: false, reason: 'invalid_client_decided_at' };
  }

  const previousId = str(p.previous_consent_id, MAX_ID_LEN);
  if (
    p.previous_consent_id !== undefined &&
    (!previousId || !ID_RE.test(previousId) || previousId === consentId)
  ) {
    return { ok: false, reason: 'invalid_previous_consent_id' };
  }

  const lang = str(p.lang, MAX_LANG_LEN);
  if (p.lang !== undefined && (!lang || !LANG_RE.test(lang))) {
    return { ok: false, reason: 'invalid_lang' };
  }
  const country = str(p.country, MAX_SHORT_LEN);
  if (p.country !== undefined && (!country || !COUNTRY_RE.test(country))) {
    return { ok: false, reason: 'invalid_country' };
  }

  const libVersion = str(p.client_lib_version, MAX_VERSION_LEN);
  if (p.client_lib_version !== undefined && (!libVersion || !VERSION_RE.test(libVersion))) {
    return { ok: false, reason: 'invalid_client_lib_version' };
  }

  // ── Párhuzamos ablak: a CookieYes olvasata. Hiánya NEM hiba (a szkript már
  // lekerült, vagy nem töltött be) — a mezők ilyenkor NULL-ok maradnak.
  const ckyAnalytics = bit(p.cky_cookie_analytics);
  const ckyMarketing = bit(p.cky_cookie_marketing);
  // Az egyezést a SZERVER számolja, nem a kliens: a kliens-oldali `cky_agreement`
  // ugyanabból a hibás fordításból jöhetne, amit mérni akarunk vele.
  const ckyAgreement =
    ckyAnalytics !== undefined && ckyMarketing !== undefined
      ? ckyAnalytics === analytics && ckyMarketing === marketing
        ? 1
        : 0
      : undefined;

  const signals = signalsFromCategories(analytics === 1, marketing === 1);

  return {
    ok: true,
    entry: {
      consent_id: consentId,
      consent_event_id: eventId,
      revision,
      site_id: siteId,
      decision: decision as ConsentDecisionKind,
      cat_analytics: analytics,
      cat_marketing: marketing,
      ...signals,
      consent_mode: mode as ConsentModeKind,
      policy_version: policyVersion,
      banner_version: bannerVersion,
      consent_text_version: textVersion,
      ruleset,
      lang,
      country: serverCountry ?? (country ? country.toUpperCase() : undefined),
      client_lib_version: libVersion,
      cky_cookie_analytics: ckyAnalytics,
      cky_cookie_marketing: ckyMarketing,
      cky_agreement: ckyAgreement,
      client_decided_at: new Date(decidedAt).toISOString(),
      previous_consent_id: previousId
    }
  };
}

export type ConsentMetricResult =
  | { ok: true; entry: ConsentMetricEntry }
  | { ok: false; reason: string };

/**
 * Banner-megjelenés payload. SZIGORÚAN ID-MENTES: ha a body bármelyik
 * azonosító-mezőt hordozza, ELUTASÍTJUK — nem csendben eldobjuk. Egy kliens-bug,
 * ami consent_id-t tesz a megjelenés-pingbe, azonosítót gyűjtene döntés ELŐTT;
 * a néma eldobás mellett ez hónapokig észrevétlen maradna.
 */
export function parseConsentMetricPayload(body: unknown, siteId: string): ConsentMetricResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body_not_object' };
  }
  const p = body as Record<string, unknown>;

  for (const forbidden of ['consent_id', 'consent_event_id', 'user_id', 'client_id', 'email']) {
    if (p[forbidden] !== undefined) return { ok: false, reason: `identifier_not_allowed:${forbidden}` };
  }

  const bannerVersion = str(p.banner_version, MAX_VERSION_LEN);
  if (!bannerVersion || !VERSION_RE.test(bannerVersion)) {
    return { ok: false, reason: 'invalid_banner_version' };
  }

  const lang = str(p.lang, MAX_LANG_LEN);
  if (p.lang !== undefined && (!lang || !LANG_RE.test(lang))) {
    return { ok: false, reason: 'invalid_lang' };
  }

  const deviceClass = str(p.device_class, MAX_SHORT_LEN);
  if (p.device_class !== undefined && (!deviceClass || !DEVICE_CLASSES.has(deviceClass))) {
    return { ok: false, reason: 'invalid_device_class' };
  }

  let interactionMs: number | undefined;
  if (p.interaction_ms !== undefined) {
    const n = p.interaction_ms;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 24 * 60 * 60 * 1000) {
      return { ok: false, reason: 'invalid_interaction_ms' };
    }
    interactionMs = Math.round(n);
  }

  return {
    ok: true,
    entry: {
      site_id: siteId,
      banner_version: bannerVersion,
      lang,
      device_class: deviceClass,
      interaction_ms: interactionMs
    }
  };
}

/**
 * A `GET /api/consent/:consent_id` válasza — az AKTUÁLIS állapot (a legmagasabb
 * revision). Ezt hívja minden offline upload / retry / replay ELŐTT az ág, ami
 * ma még a capture-kori receiptre támaszkodik.
 */
export interface ConsentLogState {
  consent_id: string;
  revision: number;
  decision: ConsentDecisionKind;
  cat_analytics: boolean;
  cat_marketing: boolean;
  ad_user_data: ConsentSignalValue;
  ad_personalization: ConsentSignalValue;
  ad_storage: ConsentSignalValue;
  analytics_storage: ConsentSignalValue;
  client_decided_at: string;
  server_received_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// A hirdetési KÉZBESÍTÉS consent-döntése — EGY szabály minden szerveroldali
// útra (2026-10-18 review, egységesítés): CRM-esemény (routes/lead-status.ts) és
// minden újraküldés (scheduled/retry.ts retrySingle → cron, Queue-consumer,
// admin single/bulk). A hívó olvas (D1), ez a függvény CSAK dönt (pure).
//
// A capture-kori böngésző-/szerver-ingress kapu (lib/consent.ts resolveConsent)
// SZÁNDÉKOSAN külön marad: ott a döntés pillanatában a payload jele a friss
// bizonyíték, a consent_log sora ilyenkor még úton lehet. Ami azonos: ott sem
// válik a hiányzó jel engedéllyé `require_consent` alatt.
// ═══════════════════════════════════════════════════════════════════════════

/** Háromállapotú D1-olvasat — PONTOSAN a ledger readConsentState / readLatestConsentForLead alakja. */
type Read<K extends string, T> = ({ kind: 'found' } & { [k in K]: T }) | { kind: 'missing' } | { kind: 'error' };

export interface AdConsentInput {
  /** A site a saját CMP-n fut-e (isConsentProviderSbo). */
  sbo: boolean;
  /** A site `require_consent` kapcsolója (CookieYes fail-closed). */
  requireConsent: boolean;
  /** Melyik kategória kell: hirdetés (ad_user_data) vagy analitika (analytics_storage). */
  category: 'ads' | 'analytics';
  /** A consent_log aktuális állapota; `null` = nincs ismert consent_id. */
  consentLog: Read<'state', ConsentLogState> | null;
  /** A lead capture-kori receiptje (CookieYes-evidencia); `null` = nincs lead-kötés. */
  receipt: Read<'record', { ad_allowed: boolean; ad_user_data: string | null; ad_personalization: string | null }> | null;
  /** A CRM `ad_allowed` jele (csak CookieYes-site-on evidencia). */
  crmAdAllowed?: boolean;
  /**
   * Az esemény a capture-kor MÁR átment egy consent-kapun (DLQ-replay). CookieYes-
   * site-on ez a döntés áll (ott nincs visszavonás-forrás); saját CMP-n NEM elég —
   * ott a consent_log AKTUÁLIS állapota dönt.
   */
  passedCaptureGate?: boolean;
}

export type AdConsentVerdict =
  | {
      kind: 'allowed';
      source: 'consent_log' | 'receipt' | 'crm' | 'fallback' | 'capture_gate';
      /** A platform felé jelenthető, BIZONYÍTOTT jelek (kitalált GRANTED nincs). */
      signals: { ad_user_data?: 'GRANTED'; ad_personalization?: ConsentSignalValue };
    }
  | { kind: 'denied'; source: 'consent_log' | 'receipt' | 'crm' | 'fallback'; skip_reason: 'consent_withdrawn' | 'consent_denied' }
  /** Nincs érvényes döntés a site szabálya szerint (saját CMP: nincs consent_log-sor). */
  | { kind: 'needs_decision'; skip_reason: 'consent_missing_failclosed' }
  /** Átmenetileg nem ellenőrizhető (D1-hiba) — se küldés, se végleges kihagyás. */
  | { kind: 'unavailable' };

const isSignal = (v: string | null | undefined): v is ConsentSignalValue => v === 'GRANTED' || v === 'DENIED';

/**
 * A kézbesítés consent-döntése (pure). Sorrend:
 *  1. D1-hiba bármelyik SZÜKSÉGES olvasásnál → `unavailable` (sosem engedély).
 *  2. consent_log-állapot → az dönt (a kategória szerint); tiltás `consent_withdrawn`.
 *  3. Saját CMP-n ennél nincs tovább: hiányzó consent_id / sor → `needs_decision`.
 *     A capture-kori receipt, a CRM-jel és a CookieYes-süti itt NEM evidencia — a
 *     régi CookieYes-engedélyre nem lehet visszaesni.
 *  4. CookieYes-site: receipt explicit jele → CRM-jel → capture-kapu (replay) →
 *     `require_consent` fail-closed / fail-open alapszabály.
 */
export function decideAdConsent(input: AdConsentInput): AdConsentVerdict {
  if (input.consentLog?.kind === 'error') return { kind: 'unavailable' };
  if (input.receipt?.kind === 'error' && input.sbo) return { kind: 'unavailable' };

  if (input.consentLog?.kind === 'found') {
    const st = input.consentLog.state;
    const granted =
      st.decision !== 'withdrawn' &&
      (input.category === 'ads' ? st.ad_user_data === 'GRANTED' : st.analytics_storage === 'GRANTED');
    return granted
      ? {
          kind: 'allowed',
          source: 'consent_log',
          signals: { ad_user_data: 'GRANTED', ad_personalization: st.ad_personalization }
        }
      : { kind: 'denied', source: 'consent_log', skip_reason: 'consent_withdrawn' };
  }
  if (input.sbo) return { kind: 'needs_decision', skip_reason: 'consent_missing_failclosed' };

  const rec = input.receipt?.kind === 'found' ? input.receipt.record : null;
  if (rec && isSignal(rec.ad_user_data)) {
    if (rec.ad_user_data === 'DENIED') return { kind: 'denied', source: 'receipt', skip_reason: 'consent_denied' };
    return {
      kind: 'allowed',
      source: 'receipt',
      signals: {
        ad_user_data: 'GRANTED',
        ...(isSignal(rec.ad_personalization) ? { ad_personalization: rec.ad_personalization } : {})
      }
    };
  }
  if (input.crmAdAllowed !== undefined) {
    if (!input.crmAdAllowed) return { kind: 'denied', source: 'crm', skip_reason: 'consent_denied' };
    // A CookieYes `advertisement` az ads-consentet egységként adja → ad_personalization
    // csak akkor GRANTED, ha nincs granular receipt-jel, ami ellentmondana.
    return {
      kind: 'allowed',
      source: 'crm',
      signals: {
        ad_user_data: 'GRANTED',
        ...(rec && isSignal(rec.ad_personalization)
          ? { ad_personalization: rec.ad_personalization }
          : { ad_personalization: 'GRANTED' as const })
      }
    };
  }
  if (input.passedCaptureGate) return { kind: 'allowed', source: 'capture_gate', signals: {} };
  const explicitNo = rec !== null && rec.ad_allowed === false;
  if (explicitNo || (input.requireConsent && rec === null)) {
    return { kind: 'denied', source: 'fallback', skip_reason: 'consent_denied' };
  }
  return {
    kind: 'allowed',
    source: 'fallback',
    signals: rec && isSignal(rec.ad_personalization) ? { ad_personalization: rec.ad_personalization } : {}
  };
}
