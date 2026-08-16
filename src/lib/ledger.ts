import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import type {
  ConsentState,
  ConsentSourceSnapshot,
  ConsentSourceName,
  IngressKind
} from './consent';
import type { Platform } from './deadletter';
import type { SkipReason } from './skip-reason';
import { sanitizeErrorMessage, VENDOR_DETAIL_MAX_LEN } from './log-sanitize';

/**
 * D1 ledger — append-only bizonyíték a beérkező konverziókról, a vendor-
 * kézbesítésekről, a consent-döntésekről és a CRM offline-loop lead-státuszokról.
 *
 * Adatvédelmi szabály: a ledger SOHA nem tárol nyers/hash-elt PII-t (CLAUDE.md
 * 13. + 15.). Csak meta-adat: event_id, lead_id (UUID, NEM PII), event_name,
 * value, consent-jelek, vendor-válaszok.
 *
 * Hibatűrés: minden függvény try/catch-elt és SOHA nem dob a request-path felé.
 * Ha az `env.LEDGER` binding nincs bekötve, no-op (a Worker D1 nélkül is fut).
 * Az idempotencia fail-open: D1-hiba esetén inkább kézbesítünk, mint hogy egy
 * valódi konverziót csendben eldobjunk.
 */

// ── Pure helperek (D1 nélkül tesztelhetők) ──────────────────────────────────

/**
 * Gateway-ingress idempotencia-kulcs. FONTOS: ez a beérkezés-dedup (ugyanaz a
 * submit 5×), NEM a vendor-dedup. A vendorok az event_id-vel dedup-olnak
 * (CLAUDE.md 16.) — egy event_id meg van osztva a 3 platformon, ezért a
 * `delivery_status` platformonként külön tárolódik (deliveries tábla), nem itt.
 */
export function buildIdempotencyKey(
  siteId: string,
  eventName: string,
  eventId: string
): string {
  return `${siteId}:${eventName}:${eventId}`;
}

export type DeliveryStatus = 'accepted' | 'rejected' | 'skipped';

interface DeliveryRecordBase {
  platform: Platform;
  error_code?: string;
  vendor_message?: string;
  /**
   * Fázis D: MIÉRT maradt ki a hívás (`deliveries.skip_reason`). Csak `skipped`
   * soron értelmes. E nélkül a ledger csak annyit tudott, hogy „skipped", és a
   * 30 napos adatban 9 GRANTED-consent melletti skip oka visszakereshetetlen
   * maradt — nem lehetett eldönteni, melyik ágon keletkeztek.
   */
  skip_reason?: SkipReason;
  /**
   * Strukturált vendor-hibarészlet (Data Manager `error.details[]`,
   * benne a `fieldViolations` tömbbel). Külön oszlop, hogy a rövid
   * `vendor_message` olvasható maradjon, a diagnózishoz kellő rész meg
   * ne csonkolódjon le. Sanitizált — PII nem kerülhet bele.
   */
  error_detail?: string;
}

/**
 * INVARIÁNS A TÍPUSBAN: 'accepted' CSAK vendor HTTP-státusszal létezik.
 *
 * Diszkriminált unió, nem egy közös `http_status?: number` — utóbbi mellett egy
 * kézzel összerakott `{ status: 'accepted' }` rekord LEFORDULT volna, és csak
 * futásidőben (vagy sehol) derült volna ki. A ledger épp azt hivatott mérni,
 * hogy egy platform-láb él-e; egy HTTP-státusz nélküli 'accepted' pont azt a
 * kérdést hazudja meg, amiért a tábla létezik (lomtalan, 2026-07-14).
 */
export type DeliveryRecord =
  | (DeliveryRecordBase & { status: 'accepted'; http_status: number })
  | (DeliveryRecordBase & { status: 'rejected' | 'skipped'; http_status?: number });

/** Egységes alak, amit mind a Meta/GA4/GAds + extra platform eredmény kielégít. */
export interface VendorResult {
  success: boolean;
  status?: number;
  error_code?: TrackingErrorCode;
  error?: string;
  partial_failure_error?: string;
  /**
   * A vendor gépi olvasású hibarészlete (pl. Data Manager `error.details[]`
   * JSON-ként). A hívó adja meg; a ledger sanitizálja és a `error_detail`
   * oszlopba írja. Az `error` marad a rövid, ember-olvasható összefoglaló.
   */
  error_detail?: string;
  // true → a hívás szándékosan kimaradt (nem konfigurált platform / scaffold-only
  // transport). 'skipped'-ként kerül a ledgerbe, hogy ne torzítsa a reconciliation
  // coverage-számítását valódi kézbesítésként.
  skipped?: boolean;
  // MIÉRT maradt ki. A `skipped` flag önmagában nem különbözteti meg a jogos
  // kihagyást a konfigurációs blokktól — lásd lib/skip-reason.ts. A fan-out ez
  // alapján dönt DLQ-ról és riasztásról; a ledger-státusz mindhárom esetben
  // 'skipped'. Hiányzó érték = a régi, meg nem különböztetett viselkedés.
  skip_reason?: SkipReason;
}

/**
 * Vendor-hibakód → skip-ok, azoknak a skip-ágaknak, amik `skip_reason` NÉLKÜL,
 * csak `error_code`-dal jeleznek (a Data Manager offline lába ilyen). Pure.
 *
 * Ami NEM szerepel benne, az szándékos: a DATAMANAGER_VALIDATE_ONLY nem a
 * SkipReason-taxonómia egyik ága (nem „miért maradt ki", hanem „a Google csak
 * validált"), az `error_code` oszlop ott az igazságforrás. Inkább maradjon NULL
 * a skip_reason, mint hogy egy odaerőltetett ok félrevigye a Fázis D bontását.
 */
export function skipReasonFromErrorCode(code: string | undefined): SkipReason | undefined {
  switch (code) {
    case TrackingErrorCode.PLATFORM_NOT_CONFIGURED:
    case TrackingErrorCode.MISSING_CONVERSION_ACTION:
      return 'not_configured';
    case TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS:
      return 'no_identifiers';
    default:
      return undefined;
  }
}

/**
 * Vendor-válasz normalizálás (#9). A platformok különbözőképp válaszolnak; ez egy
 * közös DeliveryRecord-ba fordít. A skip EGYETLEN igazságforrása a vendor-eredmény
 * `skipped` flagje (consent-tiltás és nem-konfigurált platform egyaránt ezt hozza)
 * — nincs második, hívó-oldali skip-mechanizmus, ami elcsúszhatna tőle.
 */
export function normalizeDelivery(
  platform: Platform,
  settled: PromiseSettledResult<VendorResult>
): DeliveryRecord {
  if (settled.status === 'fulfilled' && settled.value.skipped === true) {
    // A státusz mindhárom skip-oknál 'skipped' (vendorhívás nem történt), de a
    // KONFIGURÁCIÓS BLOKK hibakódot is kap: enélkül a ledgerben semmi nem
    // különböztetné meg egy jogos consent-kihagyástól, és a napi digest újra
    // csak annyit látna, hogy „skipped" — pontosan ez rejtette el a lomtalan
    // Meta-kiesést 2026-07-15 és 07-20 között.
    if (settled.value.skip_reason === 'not_configured') {
      return {
        platform,
        status: 'skipped',
        error_code: TrackingErrorCode.PLATFORM_NOT_CONFIGURED,
        skip_reason: 'not_configured'
      };
    }
    // A vendor SAJÁT hibakódja is átjut, ha adott (a Data Manager offline lába
    // `skip_reason` nélkül, csak `error_code`-dal jelez: PLATFORM_NOT_CONFIGURED /
    // MISSING_CONVERSION_ACTION / DATAMANAGER_NO_IDENTIFIERS). Enélkül minden
    // offline skip csupasz 'skipped' sorként landolt, megkülönböztethetetlenül a
    // jogos consent-kihagyástól — pontosan az a vakfolt, ami a lomtalan Meta-
    // kiesését elrejtette, csak az offline lábon.
    if (settled.value.error_code) {
      return {
        platform,
        status: 'skipped',
        error_code: settled.value.error_code,
        // A `skip_reason` a vendor-eredményből elsődleges; ha nincs (a Data
        // Manager offline lába csak error_code-dal jelez), a kódból vezetjük le.
        skip_reason: settled.value.skip_reason ?? skipReasonFromErrorCode(settled.value.error_code)
      };
    }
    return { platform, status: 'skipped', skip_reason: settled.value.skip_reason };
  }
  if (settled.status === 'rejected') {
    return {
      platform,
      status: 'rejected',
      // §13: a vendor a beküldött PII-t visszhangozhatja — a ledger SOHA nem tárolhat
      // user_data-t. sanitizeErrorMessage a perzisztencia-határon strippel (email/
      // telefon/hash → placeholder), nem csak truncál.
      vendor_message: sanitizeErrorMessage(String(settled.reason))
    };
  }
  const v = settled.value;
  if (v.success) {
    // INVARIÁNS: 'accepted' CSAK valós vendor HTTP-státusszal íródhat. Egy
    // success-eredmény státusz nélkül azt jelenti, hogy hívás nem történt (skip-ág,
    // ami elfelejtette a skipped flaget) — ha ezt accepted-ként könyvelnénk, a
    // ledger örökre egészségesnek mutatna egy nem-élő platform-lábat (lomtalan
    // 2026-07-14). Ilyenkor 'skipped'-et írunk és CRITICAL kódot hagyunk a soron.
    if (typeof v.status !== 'number') {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS],
        platform
      });
      return {
        platform,
        status: 'skipped',
        error_code: TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS
      };
    }
    return { platform, status: 'accepted', http_status: v.status };
  }
  return {
    platform,
    status: 'rejected',
    http_status: v.status,
    error_code: v.error_code,
    vendor_message: sanitizeErrorMessage(v.partial_failure_error || v.error),
    error_detail: v.error_detail
      ? sanitizeErrorMessage(v.error_detail, VENDOR_DETAIL_MAX_LEN)
      : undefined
  };
}

/**
 * CRM lead-státusz → belső event_name. A jobb oldali nevek a SiteConfig
 * `gads.conversion_actions` kulcsai kell legyenek (Enhanced Conversions for
 * Leads offline conversion action-ök). Ismeretlen státusz → null (elutasítás).
 */
const LEAD_STATUS_EVENT_MAP: Record<string, string> = {
  lead_validated: 'lead_validated',
  lead_qualified: 'lead_qualified',
  quote_sent: 'quote_sent',
  booking_confirmed: 'booking_confirmed',
  job_completed: 'job_completed',
  revenue_confirmed: 'revenue_confirmed',
  lead_disqualified: 'lead_disqualified'
};

export function mapLeadStatusToEventName(status: string): string | null {
  return LEAD_STATUS_EVENT_MAP[status] ?? null;
}

export const VALID_LEAD_STATUSES: readonly string[] = Object.keys(LEAD_STATUS_EVENT_MAP);

/**
 * lead_id formátum: UUID v4-szerű VAGY általános opaque token (NEM email/telefon).
 * Védelem: korlátozott charset + hossz, hogy ne lehessen PII-t belecsempészni.
 */
export function isValidLeadId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 8 && v.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(v);
}


// ── D1 műveletek (mind hibatűrő, no-op ha nincs binding) ─────────────────────

function id(): string {
  // crypto.randomUUID elérhető a Workers runtime-ban.
  return crypto.randomUUID();
}

interface IdempotencyDecision {
  /** Elinduljon-e a fan-out. */
  shouldDispatch: boolean;
  /** Hányadszor láttuk ezt a kulcsot (1 = első). */
  seenCount: number;
}

// A `suppressGa4` mező + a hozzá tartozó in-flight ablak-számítás TÖRÖLVE
// (2026-08-16 audit). A GA4-leg 2026-06-28 óta nincs a fan-outban (Modell 2: a
// böngésző birtokolja az on-site GA4-et — lásd routes/conversion.ts), tehát a
// flaget SENKI nem olvasta: minden egyes idempotencia-hívásnál feleslegesen
// számoltuk. Ha az on-site GA4-leg valaha visszakerül, a dupla-submit elleni
// suppress-logika a git-történetből (1e5fd1e előtti állapot) visszaemelhető.

/**
 * Atomic-style upsert. A kapu a `dispatched` flag-en dől el, NEM a seen_count-on:
 *  - első látás → beszúr dispatched=0 → dispatch.
 *  - ismételt látás, de a korábbi fan-out MÉG nem fejeződött be (dispatched=0,
 *    pl. a Worker meghalt kézbesítés előtt VAGY épp folyamatban) → ÚJRA dispatch.
 *    Ez biztonságos: a vendorok event_id-vel dedup-olnak (CLAUDE.md 16.), tehát
 *    legrosszabb esetben dupla hívás, NEM dupla konverzió.
 *  - ismételt látás, és a korábbi már sikeresen kézbesült (dispatched=1) → skip.
 *
 * Így soha nem nyomunk el egy SOHA-le-nem-kézbesített konverziót (a korábbi
 * seen_count===1 kapu épp ezt a hibát okozta: crash után a 2. látás véglegesen
 * elnyelte a valós konverziót). A `markDispatched` állítja 1-re a fan-out után.
 *
 * D1-hiba VAGY hiányzó binding → fail-open (shouldDispatch=true).
 */
export async function checkIdempotency(
  env: Env,
  siteId: string,
  eventName: string,
  eventId: string
): Promise<IdempotencyDecision> {
  if (!env.LEDGER) return { shouldDispatch: true, seenCount: 1 };
  const key = buildIdempotencyKey(siteId, eventName, eventId);
  const now = new Date().toISOString();
  try {
    const row = await env.LEDGER.prepare(
      `INSERT INTO idempotency
         (idempotency_key, site_id, event_name, event_id, first_seen_at, last_seen_at, seen_count, dispatched, do_not_replay)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         seen_count = seen_count + 1
       RETURNING seen_count, dispatched, do_not_replay`
    )
      .bind(key, siteId, eventName, eventId, now, now)
      .first<{ seen_count: number; dispatched: number; do_not_replay: number }>();

    const seenCount = row?.seen_count ?? 1;
    const blocked = (row?.do_not_replay ?? 0) === 1;
    const alreadyDispatched = (row?.dispatched ?? 0) === 1;
    return { shouldDispatch: !blocked && !alreadyDispatched, seenCount };
  } catch (err) {
    ledgerError('checkIdempotency', err, { site_id: siteId, event_name: eventName });
    return { shouldDispatch: true, seenCount: 1 };
  }
}

/**
 * A fan-out sikeres lefutása után jelöli az idempotency-rekordot kézbesítettnek
 * (dispatched=1). Innentől egy ismételt submit skip-elődik. Best-effort: ha ez
 * elbukik (vagy a Worker előbb meghal), a flag 0 marad → egy későbbi duplikátum
 * újraküld (vendor-dedup véd) — ami biztonságosabb, mint a konverzió-vesztés.
 */
export async function markDispatched(
  env: Env,
  siteId: string,
  eventName: string,
  eventId: string
): Promise<void> {
  if (!env.LEDGER) return;
  try {
    await env.LEDGER.prepare(
      `UPDATE idempotency SET dispatched = 1 WHERE idempotency_key = ?`
    )
      .bind(buildIdempotencyKey(siteId, eventName, eventId))
      .run();
  } catch (err) {
    ledgerError('markDispatched', err, { site_id: siteId, event_name: eventName });
  }
}

/**
 * Admin "discard" támogatás: az event (site, name, id) hármasát véglegesen
 * do_not_replay=1-re jelöli az idempotency táblában — így egy később beérkező
 * duplikátum vagy replay sem fan-outol újra. Upsert: akkor is működik, ha az
 * event még nem járt az idempotency táblában (pl. D1 épp nem élt az ingestkor).
 */
export async function markDoNotReplay(
  env: Env,
  siteId: string,
  eventName: string,
  eventId: string
): Promise<boolean> {
  if (!env.LEDGER) return false;
  const now = new Date().toISOString();
  try {
    await env.LEDGER.prepare(
      `INSERT INTO idempotency
         (idempotency_key, site_id, event_name, event_id, first_seen_at, last_seen_at, seen_count, dispatched, do_not_replay)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         do_not_replay = 1,
         last_seen_at = excluded.last_seen_at`
    )
      .bind(buildIdempotencyKey(siteId, eventName, eventId), siteId, eventName, eventId, now, now)
      .run();
    return true;
  } catch (err) {
    ledgerError('markDoNotReplay', err, { site_id: siteId, event_name: eventName });
    return false;
  }
}

export interface EventRawInput {
  event_id: string;
  lead_id?: string;
  site_id: string;
  hostname: string;
  event_name: string;
  event_time: number;
  value?: number;
  currency?: string;
  ad_allowed: boolean;
  em_present: boolean;
  ph_present: boolean;
  // Meta click-ID / browser-ID JELENLÉT (nem az érték!) — az EMQ-proxy metrika
  // alapja a daily digestben. Egy csendben eltört fbc/fbp-forwarding itt látszik
  // meg először (a kézbesítés-smoke zöld marad, csak a match-minőség esik).
  fbc_present: boolean;
  fbp_present: boolean;
}

export async function recordEventRaw(env: Env, e: EventRawInput): Promise<void> {
  if (!env.LEDGER) return;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO events_raw
         (id, event_id, lead_id, site_id, hostname, event_name, event_time, value, currency, ad_allowed, em_present, ph_present, fbc_present, fbp_present, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id(),
        e.event_id,
        e.lead_id ?? null,
        e.site_id,
        e.hostname,
        e.event_name,
        e.event_time,
        e.value ?? null,
        e.currency ?? null,
        e.ad_allowed ? 1 : 0,
        e.em_present ? 1 : 0,
        e.ph_present ? 1 : 0,
        e.fbc_present ? 1 : 0,
        e.fbp_present ? 1 : 0,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    ledgerError('recordEventRaw', err, { site_id: e.site_id, event_name: e.event_name });
  }
}

export interface ConsentReceiptInput {
  event_id: string;
  lead_id?: string;
  site_id: string;
  consent?: ConsentState;
  require_consent: boolean;
  ad_allowed: boolean;
  /**
   * Fázis D — forrásonkénti, PARSE-OLT booleanok (NEM nyers stringek: azok
   * kizárólag a consent_debug táblába mennek, és csak mismatch esetén).
   * A `null` itt tartalmi állítás: az a forrás nem volt elérhető abban a
   * pillanatban — ez a betöltési verseny bizonyítéka, nem hiányzó adat.
   */
  sources?: ConsentReceiptSources;
}

export interface ConsentReceiptSources {
  cookie: ConsentSourceSnapshot;
  api: ConsentSourceSnapshot;
  server: ConsentSourceSnapshot;
  source_used: ConsentSourceName;
  source_consistent: 1 | 0 | null;
  ingress_kind: IngressKind;
  client_lib_version?: string;
  consent_age_s?: number;
  /**
   * A TRK-910 megállapítások vesszős listája (pl. "TRK-910-003,TRK-910-005"),
   * vagy undefined, ha az event tiszta. Enélkül a -005/-006 kód SEHOL nem lenne
   * D1-ből lekérdezhető, pedig épp azok aránya dönti el, hogy a CookieYes vagy a
   * saját bekötéseink hibáznak (a Fázis D döntési kapuja).
   */
  finding_codes?: string;
}

/** boolean|null → INTEGER|null (a NULL végig NULL marad). */
function boolCol(v: boolean | null | undefined): 0 | 1 | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

export async function recordConsentReceipt(env: Env, c: ConsentReceiptInput): Promise<void> {
  if (!env.LEDGER) return;
  const s = c.sources;
  try {
    await env.LEDGER.prepare(
      // Az új oszlopok a 0004 migrációból, az oszloplista VÉGÉN (ALTER TABLE
      // sorrend) — a meglévő pozíciófüggő olvasók így nem csúsznak el.
      `INSERT INTO consent_receipts
         (id, event_id, lead_id, site_id, ad_user_data, ad_personalization, ad_storage, analytics_storage, require_consent, ad_allowed, received_at,
          src_cookie_analytics, src_cookie_marketing, src_api_analytics, src_api_marketing, src_server_analytics, src_server_marketing,
          source_used, source_consistent, ingress_kind, client_lib_version, consent_age_s, finding_codes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id(),
        c.event_id,
        c.lead_id ?? null,
        c.site_id,
        c.consent?.ad_user_data ?? null,
        c.consent?.ad_personalization ?? null,
        c.consent?.ad_storage ?? null,
        c.consent?.analytics_storage ?? null,
        c.require_consent ? 1 : 0,
        c.ad_allowed ? 1 : 0,
        new Date().toISOString(),
        boolCol(s?.cookie.analytics),
        boolCol(s?.cookie.marketing),
        boolCol(s?.api.analytics),
        boolCol(s?.api.marketing),
        boolCol(s?.server.analytics),
        boolCol(s?.server.marketing),
        s?.source_used ?? null,
        s?.source_consistent ?? null,
        s?.ingress_kind ?? null,
        s?.client_lib_version ?? null,
        // CookieYes alatt MINDIG NULL — a süti nem hordoz timestampet, és
        // heurisztikát nem találunk ki rá.
        s?.consent_age_s ?? null,
        s?.finding_codes ?? null
      )
      .run();
  } catch (err) {
    ledgerError('recordConsentReceipt', err, { site_id: c.site_id });
  }
}

export interface ConsentDebugInput {
  event_id: string;
  site_id: string;
  error_code: string;
  raw_cookie?: string;
  raw_api?: string;
  raw_server?: string;
}

/**
 * Nyers consent-stringek — KIZÁRÓLAG mismatch/parse-hiba esetén (TRK-910-002 /
 * TRK-910-003), és KIZÁRÓLAG ebbe a táblába. A `consent_receipts` sosem kap
 * nyers sütit; ez a tábla 14 nap után purge-ölődik (lib/retention.ts).
 *
 * Sosem dob és sosem logolja ki a nyers tartalmat (CLAUDE.md 13.).
 */
export async function recordConsentDebug(env: Env, d: ConsentDebugInput): Promise<void> {
  if (!env.LEDGER) return;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO consent_debug
         (id, event_id, site_id, error_code, raw_cookie, raw_api, raw_server, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id(),
        d.event_id,
        d.site_id,
        d.error_code,
        d.raw_cookie ?? null,
        d.raw_api ?? null,
        d.raw_server ?? null,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    ledgerError('recordConsentDebug', err, { site_id: d.site_id });
  }
}

export interface DeliveriesInput {
  event_id: string;
  lead_id?: string;
  site_id: string;
  event_name: string;
  origin?: 'fanout' | 'retry' | 'offline';
  records: DeliveryRecord[];
}

/**
 * Utolsó védvonal az írás előtt. A típus (DeliveryRecord) már kizárja a HTTP
 * nélküli 'accepted'-et, a normalizeDelivery pedig a négy hívó-út közös
 * fojtópontja — ez a harmadik réteg arra van, hogy egy `as any` cast vagy egy
 * jövőbeli, normalizeDelivery-t megkerülő hívó SE tudjon ilyen sort a ledgerbe
 * tenni. Nem dobunk (a ledger-írás soha nem buktathat konverziót): a sort
 * 'skipped'-re minősítjük vissza, CRITICAL kóddal, ami a füstteszten is bukik.
 */
function enforceVendorStatus(r: DeliveryRecord, siteId: string): DeliveryRecord {
  if (r.status !== 'accepted' || typeof r.http_status === 'number') return r;
  logStructured({
    level: 'error',
    error_code: TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS,
    message: ERROR_DESCRIPTIONS[TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS],
    platform: r.platform,
    site_id: siteId
  });
  return {
    platform: r.platform,
    status: 'skipped',
    error_code: TrackingErrorCode.ACCEPTED_WITHOUT_VENDOR_STATUS,
    vendor_message: r.vendor_message,
    error_detail: r.error_detail
  };
}

export async function recordDeliveries(env: Env, d: DeliveriesInput): Promise<void> {
  if (!env.LEDGER || d.records.length === 0) return;
  const origin = d.origin ?? 'fanout';
  const now = new Date().toISOString();
  const records = d.records.map((r) => enforceVendorStatus(r, d.site_id));
  try {
    const stmt = env.LEDGER.prepare(
      // A `skip_reason` SZÁNDÉKOSAN az oszloplista VÉGÉN van (0004 migráció):
      // az ALTER TABLE hozzáfűzi, és így a meglévő pozíciófüggő olvasók
      // (tesztek, ad-hoc lekérdezések) indexei érintetlenek maradnak.
      `INSERT INTO deliveries
         (id, event_id, lead_id, site_id, event_name, platform, status, http_status, error_code, vendor_message, error_detail, attempt, origin, created_at, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const batch = records.map((r) =>
      stmt.bind(
        id(),
        d.event_id,
        d.lead_id ?? null,
        d.site_id,
        d.event_name,
        r.platform,
        r.status,
        r.http_status ?? null,
        r.error_code ?? null,
        r.vendor_message ?? null,
        r.error_detail ?? null,
        0,
        origin,
        now,
        // Csak skipped soron van értelme; egyébként NULL (accepted/rejected).
        r.status === 'skipped' ? (r.skip_reason ?? null) : null
      )
    );
    await env.LEDGER.batch(batch);
  } catch (err) {
    ledgerError('recordDeliveries', err, { site_id: d.site_id, event_name: d.event_name });
  }
}

export interface LeadStatusInput {
  lead_id: string;
  site_id: string;
  status: string;
  value?: number;
  currency?: string;
  occurred_at: string;
  uploaded_to_gads: boolean;
  gads_error_code?: string;
}

export async function recordLeadStatus(env: Env, l: LeadStatusInput): Promise<void> {
  if (!env.LEDGER) return;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO lead_status
         (id, lead_id, site_id, status, value, currency, occurred_at, source, uploaded_to_gads, gads_error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'crm', ?, ?, ?)`
    )
      .bind(
        id(),
        l.lead_id,
        l.site_id,
        l.status,
        l.value ?? null,
        l.currency ?? null,
        l.occurred_at,
        l.uploaded_to_gads ? 1 : 0,
        l.gads_error_code ?? null,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    ledgerError('recordLeadStatus', err, { site_id: l.site_id });
  }
}

export interface LeadConsentRecord {
  ad_allowed: boolean;
  /**
   * A capture-kori EXPLICIT Consent Mode jel ('GRANTED' | 'DENIED' |
   * 'UNSPECIFIED'), vagy null, ha a receipt jel nélkül íródott (fail-open site,
   * consent-objektum nélküli szerver-dispatch). Az offline-kapu CSAK a
   * GRANTED/DENIED értéket kezeli bizonyítékként — a jel nélküli receipt
   * ad_allowed=1-e a require_consent=false defaultból is jöhet, az NEM consent.
   */
  ad_user_data: string | null;
  /**
   * A capture-kori EXPLICIT ad_personalization jel ('GRANTED' | 'DENIED' |
   * 'UNSPECIFIED'), vagy null. KÜLÖN jel az ad_user_data-tól — az offline upload
   * ezt önállóan jelenti a Google-nek, NEM vezeti le az ad_user_data-ból (különben
   * hamis ad_personalization=GRANTED menne olyan usernek, aki csak a data-
   * használatot engedte, a személyre szabást nem).
   */
  ad_personalization: string | null;
}

/**
 * A lead legutóbbi consent-döntése (offline-loop GDPR-kapuhoz). Ha a capture-kor
 * a felhasználó visszavonta az ad-consentet (ad_allowed=0), az offline Google Ads
 * upload kimarad. null = nincs rekord (D1-hiba / ismeretlen lead / nincs binding).
 */
export async function getLatestConsentForLead(
  env: Env,
  siteId: string,
  leadId: string
): Promise<LeadConsentRecord | null> {
  if (!env.LEDGER) return null;
  try {
    // A JEL-HORDOZÓ receipt megelőzi a puszta frissességet.
    //
    // MIÉRT: a capture-kori böngésző-receipt hordozza az egyetlen VALÓDI consent-
    // evidenciát (a CMP jelét). A későbbi szerver-oldali kézbesítések (CRM-recovery,
    // outbox-replay) viszont jel NÉLKÜL írnak receiptet — és sima `received_at DESC`
    // mellett ezek elárnyékolták a valódi GRANTED-et, amitől a precedencia
    // visszaesett a CRM newsletter-szemantikájú `ad_allowed`-jára, és a lead offline
    // Enhanced-Conversion loopja csendben, VÉGLEG blokkolódott.
    //
    // Az `ad_user_data IS NOT NULL` 1/0-t ad, DESC-cel a jel-hordozó sorok kerülnek
    // előre; azokon belül továbbra is a legfrissebb nyer (egy valódi későbbi
    // visszavonás → DENIED tehát helyesen felülírja a korábbi GRANTED-et). Ha
    // egyetlen receipt sem hordoz jelet, marad a régi „legfrissebb sor" viselkedés.
    const row = await env.LEDGER.prepare(
      `SELECT ad_allowed, ad_user_data, ad_personalization FROM consent_receipts
       WHERE site_id = ? AND lead_id = ?
       ORDER BY (ad_user_data IS NOT NULL) DESC, received_at DESC LIMIT 1`
    )
      .bind(siteId, leadId)
      .first<{ ad_allowed: number; ad_user_data: string | null; ad_personalization: string | null }>();
    if (!row) return null;
    return {
      ad_allowed: row.ad_allowed === 1,
      ad_user_data: row.ad_user_data ?? null,
      ad_personalization: row.ad_personalization ?? null
    };
  } catch (err) {
    ledgerError('getLatestConsentForLead', err, { site_id: siteId });
    return null;
  }
}

export interface LeadTrail {
  events: unknown[];
  deliveries: unknown[];
  consent_receipts: unknown[];
  lead_status: unknown[];
}

/**
 * Egy lead teljes ledger-nyomvonala (admin audit): events_raw → deliveries →
 * consent_receipts → lead_status, site_id-re szűkítve (tenant-izoláció).
 * null = nincs LEDGER binding vagy D1-hiba.
 */
export async function getLeadTrail(
  env: Env,
  siteId: string,
  leadId: string
): Promise<LeadTrail | null> {
  if (!env.LEDGER) return null;
  try {
    const [events, deliveries, consent, status] = await Promise.all([
      env.LEDGER.prepare(
        `SELECT * FROM events_raw WHERE site_id = ? AND lead_id = ? ORDER BY received_at`
      )
        .bind(siteId, leadId)
        .all(),
      env.LEDGER.prepare(
        `SELECT * FROM deliveries WHERE site_id = ? AND lead_id = ? ORDER BY created_at`
      )
        .bind(siteId, leadId)
        .all(),
      env.LEDGER.prepare(
        `SELECT * FROM consent_receipts WHERE site_id = ? AND lead_id = ? ORDER BY received_at`
      )
        .bind(siteId, leadId)
        .all(),
      env.LEDGER.prepare(
        `SELECT * FROM lead_status WHERE site_id = ? AND lead_id = ? ORDER BY created_at`
      )
        .bind(siteId, leadId)
        .all()
    ]);
    return {
      events: events.results ?? [],
      deliveries: deliveries.results ?? [],
      consent_receipts: consent.results ?? [],
      lead_status: status.results ?? []
    };
  } catch (err) {
    ledgerError('getLeadTrail', err, { site_id: siteId });
    return null;
  }
}

/**
 * Eldönti, hogy egy offline-loop upload tiltott-e consent alapján (pure, tesztelhető).
 *  - Ha a leadnek explicit ad_allowed=false consentje van → tiltott.
 *  - Fail-closed (EEA): ha a site `require_consent`, ÉS nincs (vagy nem olvasható)
 *    consent-rekord (leadConsent===null, ami D1-hibát IS jelenthet) → tiltott.
 *    Így egy D1-kiesés nem fordítja át a „consent ismeretlen"-t „consent megadott"-ra.
 *  - Egyébként (nem kötelező consent, és nincs explicit tiltás) → engedett.
 */
export function isOfflineUploadBlocked(
  leadConsent: { ad_allowed: boolean } | null,
  requireConsent: boolean
): boolean {
  if (leadConsent !== null && leadConsent.ad_allowed === false) return true;
  if (requireConsent && leadConsent === null) return true;
  return false;
}

function ledgerError(op: string, err: unknown, ctx: Record<string, unknown>): void {
  logStructured({
    level: 'warn',
    error_code: TrackingErrorCode.LEDGER_WRITE_FAILED,
    message: `${ERROR_DESCRIPTIONS[TrackingErrorCode.LEDGER_WRITE_FAILED]} (${op})`,
    ...ctx,
    error: err instanceof Error ? err.message : String(err)
  });
}
