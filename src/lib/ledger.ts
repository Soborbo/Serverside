import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import type { ConsentState } from './consent';
import type { Platform } from './deadletter';

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

export interface DeliveryRecord {
  platform: Platform;
  status: DeliveryStatus;
  http_status?: number;
  error_code?: string;
  vendor_message?: string;
}

/** Egységes alak, amit mind a Meta/GA4/GAds + extra platform eredmény kielégít. */
export interface VendorResult {
  success: boolean;
  status?: number;
  error_code?: TrackingErrorCode;
  error?: string;
  partial_failure_error?: string;
  // true → a hívás szándékosan kimaradt (nem konfigurált platform / scaffold-only
  // transport). 'skipped'-ként kerül a ledgerbe, hogy ne torzítsa a reconciliation
  // coverage-számítását valódi kézbesítésként.
  skipped?: boolean;
}

/**
 * Vendor-válasz normalizálás (#9). A 3 platform különbözőképp válaszol; ez egy
 * közös DeliveryRecord-ba fordít. `skipped` = a hívás szándékosan kimaradt
 * (pl. consent-tiltás → no-op success külön jelölve a hívónál).
 */
export function normalizeDelivery(
  platform: Platform,
  settled: PromiseSettledResult<VendorResult>,
  opts?: { skipped?: boolean }
): DeliveryRecord {
  if (opts?.skipped || (settled.status === 'fulfilled' && settled.value.skipped === true)) {
    return { platform, status: 'skipped' };
  }
  if (settled.status === 'rejected') {
    return {
      platform,
      status: 'rejected',
      vendor_message: truncate(String(settled.reason), 500)
    };
  }
  const v = settled.value;
  if (v.success) {
    return { platform, status: 'accepted', http_status: v.status };
  }
  return {
    platform,
    status: 'rejected',
    http_status: v.status,
    error_code: v.error_code,
    vendor_message: truncate(v.partial_failure_error || v.error, 500)
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

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
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
  /**
   * Ki kell-e hagyni a GA4-leget ennél a dispatch-nél. A Meta/Google Ads
   * event_id-vel dedup-ol, a GA4 NEM (CLAUDE.md #16) — így egy gyors dupla-submit
   * (dupla-klikk, sendBeacon-retry), ami a fan-out ablakon BELÜL érkezik, a GA4-en
   * dupla konverziót/revenue-t okozna. Ezt csak akkor jelezzük, ha a korábbi
   * rekord még in-flight (friss first_seen_at + dispatched=0); egy régi, valószínű
   * crash-elt rekordnál továbbra is újraküldünk, hogy ne veszítsük el a GA4-hitet.
   */
  suppressGa4: boolean;
}

/** Az az ablak (ms), ameddig egy dispatched=0 rekordot „még in-flight"-nak tekintünk. */
const INFLIGHT_WINDOW_MS = 60_000;

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
  if (!env.LEDGER) return { shouldDispatch: true, seenCount: 1, suppressGa4: false };
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
       RETURNING seen_count, dispatched, do_not_replay, first_seen_at`
    )
      .bind(key, siteId, eventName, eventId, now, now)
      .first<{ seen_count: number; dispatched: number; do_not_replay: number; first_seen_at: string }>();

    const seenCount = row?.seen_count ?? 1;
    const blocked = (row?.do_not_replay ?? 0) === 1;
    const alreadyDispatched = (row?.dispatched ?? 0) === 1;
    // GA4-suppress: duplikátum (seen>1), a korábbi még nem dispatched, ÉS a
    // first_seen_at friss → az eredeti fan-out valószínűleg még fut.
    const firstSeenMs = row?.first_seen_at ? Date.parse(row.first_seen_at) : NaN;
    const inFlight =
      Number.isFinite(firstSeenMs) && Date.parse(now) - firstSeenMs < INFLIGHT_WINDOW_MS;
    const suppressGa4 = seenCount > 1 && !alreadyDispatched && inFlight;
    return { shouldDispatch: !blocked && !alreadyDispatched, seenCount, suppressGa4 };
  } catch (err) {
    ledgerError('checkIdempotency', err, { site_id: siteId, event_name: eventName });
    return { shouldDispatch: true, seenCount: 1, suppressGa4: false };
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
}

export async function recordEventRaw(env: Env, e: EventRawInput): Promise<void> {
  if (!env.LEDGER) return;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO events_raw
         (id, event_id, lead_id, site_id, hostname, event_name, event_time, value, currency, ad_allowed, em_present, ph_present, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
}

export async function recordConsentReceipt(env: Env, c: ConsentReceiptInput): Promise<void> {
  if (!env.LEDGER) return;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO consent_receipts
         (id, event_id, lead_id, site_id, ad_user_data, ad_personalization, ad_storage, analytics_storage, require_consent, ad_allowed, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    ledgerError('recordConsentReceipt', err, { site_id: c.site_id });
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

export async function recordDeliveries(env: Env, d: DeliveriesInput): Promise<void> {
  if (!env.LEDGER || d.records.length === 0) return;
  const origin = d.origin ?? 'fanout';
  const now = new Date().toISOString();
  try {
    const stmt = env.LEDGER.prepare(
      `INSERT INTO deliveries
         (id, event_id, lead_id, site_id, event_name, platform, status, http_status, error_code, vendor_message, attempt, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const batch = d.records.map((r) =>
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
        0,
        origin,
        now
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

/**
 * A lead legutóbbi consent-döntése (offline-loop GDPR-kapuhoz). Ha a capture-kor
 * a felhasználó visszavonta az ad-consentet (ad_allowed=0), az offline Google Ads
 * upload kimarad. null = nincs rekord (D1-hiba / ismeretlen lead / nincs binding).
 */
export async function getLatestConsentForLead(
  env: Env,
  siteId: string,
  leadId: string
): Promise<{ ad_allowed: boolean } | null> {
  if (!env.LEDGER) return null;
  try {
    const row = await env.LEDGER.prepare(
      `SELECT ad_allowed FROM consent_receipts
       WHERE site_id = ? AND lead_id = ?
       ORDER BY received_at DESC LIMIT 1`
    )
      .bind(siteId, leadId)
      .first<{ ad_allowed: number }>();
    if (!row) return null;
    return { ad_allowed: row.ad_allowed === 1 };
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
