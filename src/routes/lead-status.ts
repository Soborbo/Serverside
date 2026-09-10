import type { Env } from '../env';
import { logStructured } from '../types';
import { lookupSiteConfig, isExpectedOfflinePlatform } from '../lib/config';
import { authenticateLeadStatus } from '../lib/admin-auth';
import {
  hashUserDataForGoogle,
  mapPrehashedUserData,
  sha256Hex,
  type CountryCode,
  type HashedUserData,
  type PlainUserData
} from '../lib/hash';
import { type GAdsPayload } from '../lib/gads';
import { sendToDataManager } from '../lib/datamanager';
import { enqueueFailure } from '../lib/deadletter';
import { sendAlert } from '../lib/notify';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import {
  isValidLeadId,
  isOfflineUploadBlocked,
  mapLeadStatusToEventName,
  VALID_LEAD_STATUSES,
  REPEATABLE_LEAD_STATUSES,
  ADJUSTMENT_LEAD_STATUSES,
  getLatestConsentForLead,
  getConsentState,
  markDoNotReplay,
  recordLeadStatus,
  recordDeliveries,
  normalizeDelivery
} from '../lib/ledger';
import { isBlockedByConsentState } from '../lib/consent-log';

/**
 * CRM offline-loop endpoint (P0 üzleti érték). A CRM ide POST-olja a lead
 * lifecycle-státuszait (lead_qualified, booking_confirmed, revenue_confirmed,
 * stb.), amiket Enhanced Conversions for Leads-ként visszaküldünk a Google Ads
 * felé — így a bidding tudja, MELYIK leadből lett valódi pénz.
 *
 * - Admin-auth (X-Admin-Token) — server-to-server, megbízható hívó.
 * - Hostname-alapú site routing (CLAUDE.md 14.) — a CRM a site gateway-hostjára hív.
 * - PII (user_data) menet közben hash-elődik és továbbítódik, SOHA nem tárolódik.
 * - GDPR: ha a lead capture-kor visszavonta az ad-consentet, az upload kimarad.
 */

interface LeadStatusBody {
  lead_id: string;
  status: string;
  occurred_at?: string;
  value?: number;
  currency?: string;
  user_data?: PlainUserData;
  // F3-D · Prehashed PII contract a lifecycle-lábhoz. A CRM outbox CSAK SHA-256
  // hash-eket tárol (nyers email/telefon soha), és a wire-kulcsok a KANONIKUS
  // `sha256_*` nevek (`sha256_email`, `sha256_phone`, … — lásd hash.ts
  // PREHASHED_FIELD_MAP); ismeretlen kulcs (pl. a régi doksi `email_sha256_google`-je)
  // 400-at ad, NEM némán eldobva. A gateway NE hash-eljen újra (dupla hash → néma
  // Google EC match-rate esés).
  //
  // ⚠️ NORMALIZÁCIÓS FIGYELEM: EZEN a végponton az `sha256_email` a GOOGLE-normalizált
  // email hash-e (Gmail dot/plus strip — normalizeEmailForGoogle). UGYANEZ a wire-kulcs
  // a /conversion-server (Meta) végponton a META-normalizált hash-t hordozza — a
  // kulcsnév NEM különbözteti meg a kettőt, ezért a CRM outbox felelőssége, hogy
  // ENDPOINT-HELYES normalizálóval hash-eljen. Meta-hash ide küldve a Gmail-userek
  // EC match-je CSENDBEN romlik (a hash opaque, a gateway nem tudja ellenőrizni).
  //
  // Kölcsönösen kizáró a `user_data` NYERS identity-mezőivel (email/telefon/név) — a
  // plain CÍM (postal_code/country) viszont a `user_data`-ban marad (a Data Manager
  // plain-t vár rájuk). Az endpoint teljes egészében admin-auth (szerver-szerver),
  // ezért — a /conversion-server böngésző-ágával ellentétben — nincs külön serverIngress-kapu.
  user_data_hashed?: Record<string, unknown>;
  // A CRM ad-consent jele a leadre (a CRM marketingConsent-jéből). FALLBACK:
  // a Worker saját consent-receiptje (explicit GRANTED/DENIED capture-kori jel)
  // MEGELŐZI — a CRM marketingConsent-je newsletter-optin szemantikájú, és a
  // 2026-07-17-es consent-audit szerint a site-ok soha nem töltik a CookieYes
  // ad-consentből, így önmagában minden uploadot némán blokkolna.
  ad_allowed?: boolean;
  // Google click ID-k a lead capture-ből (site URL → Benolám orders → outbox).
  // Jelenlétükkor a Data Manager match determinisztikus (pontosan egy megy fel,
  // gclid > gbraid > wbraid prioritással — datamanager.ts), a hash-elt PII-match
  // MELLETT, nem helyette.
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  /**
   * P10 — az ISMÉTELHETŐ státuszok (ma: `payment_received`) egy-egy előfordulásának
   * stabil azonosítója a hívó rendszerében (pl. a CRM `payments` sorának id-ja).
   *
   * MIÉRT KÖTELEZŐ OTT. Az `orderId` a `(lead_id, status)` hash-e — ez az egyszeri
   * státuszokra helyes (a retry ugyanazt küldi, a Google dedupál), de két
   * részfizetésre VÉGZETES: azonos `orderId` → a Google ugyanannak a konverziónak
   * látja őket → a második fizetés némán elveszik. Az `occurrence_id` teszi őket
   * megkülönböztethetővé ÚGY, hogy a retry továbbra is idempotens marad.
   */
  occurrence_id?: string;
  /**
   * P10 §5.4 — a lead megnyerésének időpontja. Ha a fizetés ennél LÉNYEGESEN
   * később érkezik, a fizetés dátuma már kifuthat a Google offline-ablakából, és
   * a konverzió elveszne. Ilyenkor a `won_at` a jobb időbélyeg — a MÁR ISMERT,
   * helyes értékkel. Hiánya nem hiba: akkor a fizetés ideje marad.
   */
  won_at?: string;
}

/**
 * P10 §5.4 — meddig fogadjuk el a fizetés saját dátumát konverzió-időpontnak.
 *
 * A Google offline feltöltésnek ablaka van a kattintástól számítva; egy hónapokkal
 * későbbi fizetés már nem köthető a kattintáshoz. A `won_at`-hoz mérünk, mert a
 * kattintás idejét a gateway nem ismeri — a megnyerés viszont mindig a kattintás
 * UTÁN van, tehát ez KONZERVATÍV becslés: ha a `won_at`-tól számítva még belefér,
 * a kattintástól számítva is belefért.
 */
export const OFFLINE_WINDOW_DAYS = 90;

/**
 * Melyik időpont legyen a konverzió ideje. A user döntése (2026-09-09):
 * ablakon belül a fizetés ideje, azon túl a `won_at` — mert egy elveszett
 * konverzió rosszabb, mint egy pontatlan időbélyeg.
 */
export function resolveConversionTimeIso(occurredAtIso: string, wonAtIso?: string): string {
  if (!wonAtIso) return occurredAtIso;
  const occurred = Date.parse(occurredAtIso);
  const won = Date.parse(wonAtIso);
  if (!Number.isFinite(occurred) || !Number.isFinite(won)) return occurredAtIso;
  const days = (occurred - won) / 86_400_000;
  return days > OFFLINE_WINDOW_DAYS ? wonAtIso : occurredAtIso;
}

export function validateLeadStatusBody(payload: unknown): LeadStatusBody | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (!isValidLeadId(p.lead_id)) return null;
  if (typeof p.status !== 'string' || !VALID_LEAD_STATUSES.includes(p.status)) return null;

  if (p.occurred_at !== undefined) {
    if (typeof p.occurred_at !== 'string' || Number.isNaN(Date.parse(p.occurred_at))) return null;
  }
  if (
    p.value !== undefined &&
    (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0 || p.value > 1_000_000_000)
  ) {
    return null;
  }
  if (p.currency !== undefined && (typeof p.currency !== 'string' || !/^[A-Za-z]{3}$/.test(p.currency))) {
    return null;
  }
  // user_data: objektum, de NEM tömb (typeof [] === 'object') — a tömb junk
  // kulcsokkal jutna a hash-előhöz.
  if (
    p.user_data !== undefined &&
    (typeof p.user_data !== 'object' || p.user_data === null || Array.isArray(p.user_data))
  ) {
    return null;
  }
  // ad_allowed: ha jelen van, csak boolean lehet (a CRM autoritatív consentje).
  if (p.ad_allowed !== undefined && typeof p.ad_allowed !== 'boolean') return null;

  // occurrence_id: opaque, PII-mentes token — ugyanaz a szűk charset, mint a
  // lead_id-nál, hogy ne lehessen e-mailt/telefont belecsempészni.
  if (
    p.occurrence_id !== undefined &&
    (typeof p.occurrence_id !== 'string' ||
      p.occurrence_id.length < 1 ||
      p.occurrence_id.length > 64 ||
      !/^[a-zA-Z0-9_-]+$/.test(p.occurrence_id))
  ) {
    return null;
  }
  if (p.won_at !== undefined) {
    if (typeof p.won_at !== 'string' || Number.isNaN(Date.parse(p.won_at))) return null;
  }

  // user_data_hashed: objektum, de NEM tömb (a mező-tartalmi hash-validáció a
  // handlerben, mapPrehashedUserData-val — az fail-loud hibás mezőnévvel).
  if (
    p.user_data_hashed !== undefined &&
    (typeof p.user_data_hashed !== 'object' ||
      p.user_data_hashed === null ||
      Array.isArray(p.user_data_hashed))
  ) {
    return null;
  }

  // Click ID: end-user URL-ből örökölt érték (a CRM csak továbbítja). A hibás
  // formájút ELDOBJUK, nem 400-olunk — egy tamperelt URL-paraméter nem égetheti
  // el a lifecycle-konverziót; a PII-match click ID nélkül is él.
  const clickId = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[A-Za-z0-9._-]{1,512}$/.test(v) ? v : undefined;

  return {
    lead_id: p.lead_id as string,
    status: p.status,
    // UTC ISO-ra normalizálva → konzisztens lexikális rendezés a ledgerben.
    occurred_at:
      typeof p.occurred_at === 'string' ? new Date(p.occurred_at).toISOString() : undefined,
    value: p.value as number | undefined,
    // 3-betűs ISO uppercase (a Google Ads/Meta nagybetűt vár).
    currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : undefined,
    user_data: p.user_data as PlainUserData | undefined,
    user_data_hashed: p.user_data_hashed as Record<string, unknown> | undefined,
    ad_allowed: p.ad_allowed as boolean | undefined,
    occurrence_id: p.occurrence_id as string | undefined,
    won_at: typeof p.won_at === 'string' ? new Date(p.won_at).toISOString() : undefined,
    gclid: clickId(p.gclid),
    gbraid: clickId(p.gbraid),
    wbraid: clickId(p.wbraid)
  };
}

export async function handleLeadStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const hostname = new URL(request.url).hostname;

  // Site-feloldás ELŐSZÖR (hostname-alapú, CLAUDE.md 14.) — a per-site CRM-token
  // auth EHHEZ a site-hoz kötött. Ismeretlen host → 404, fallback nélkül.
  const { config: siteConfig, unavailable: siteConfigUnavailable } = await lookupSiteConfig(
    hostname,
    env
  );
  if (!siteConfig) {
    // Tranziens KV-hiba → 503 (retry-olható), NEM 404: a CRM outbox a 404-et
    // failed_permanent-nek osztályozza, így egy KV-blip véglegesen elégetné a
    // lifecycle-konverziót. A valóban ismeretlen host marad 404.
    if (siteConfigUnavailable) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.KV_READ_FAILED,
        message: 'Site config lookup failed (KV read error) — responding 503 so the CRM retries',
        hostname,
        duration_ms: Date.now() - startedAt
      });
      return json({ error: 'site_config_unavailable', retryable: true }, 503);
    }
    return json({ error: 'not_configured' }, 404);
  }

  // Per-site token: a globális ADMIN_API_TOKEN NEM ad hozzáférést egy saját tokennel
  // rendelkező site-hoz. Rossz site tokenjével (cross-tenant kísérlet) → 401.
  if (!(await authenticateLeadStatus(request, env, siteConfig))) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.LEAD_STATUS_UNAUTHORIZED],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return json({ error: 'unauthorized' }, 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const body = validateLeadStatusBody(raw);
  if (!body) {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_LEAD_STATUS_PAYLOAD],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return json({ error: 'invalid_payload', valid_statuses: VALID_LEAD_STATUSES }, 400);
  }

  const eventName = mapLeadStatusToEventName(body.status);
  if (!eventName) {
    // Ez volt az offline út EGYETLEN elutasítási ága kód, strukturált log és
    // bármilyen nyom nélkül: a CRM 400-at kapott, a gateway-oldalon viszont
    // semmi nem jelezte, hogy egy konverzió elveszett. Egy CRM-oldali
    // státusz-átnevezés így némán, hetekig üríthette volna az offline lábat —
    // pont az a hibaosztály, amit a P1 recon utólag mér, de itt előbb látszik.
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING],
      hostname,
      lead_status: body.status,
      duration_ms: Date.now() - startedAt
    });
    return json(
      { error: 'unknown_status', error_code: TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING, valid_statuses: VALID_LEAD_STATUSES },
      400
    );
  }

  // ── P10 · a helyesbítő státuszok MÉG NEM kézbesíthetők ───────────────────
  // A Data Manager `events.ingest` hivatalos referenciája (lekérdezve 2026-09-09)
  // az Event-objektumon EGYETLEN adjustment/retract/restate mezőt sem dokumentál.
  // A kézenfekvő rossz megoldás az lenne, hogy a helyesbítés a normál upload-úton
  // megy: az egy POZITÍV konverziót töltene fel egy VISSZAVONÁSRA, vagyis a hibát
  // a kétszeresére növelné. Ezért hangos, nevesített elutasítás — a CRM outbox
  // ebből tudja, hogy őrizze meg a sort, és NE könyvelje kézbesítettnek.
  if (ADJUSTMENT_LEAD_STATUSES.has(body.status)) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.LEAD_STATUS_ADJUSTMENT_UNSUPPORTED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.LEAD_STATUS_ADJUSTMENT_UNSUPPORTED],
      hostname,
      site_id: siteConfig.site_id,
      lead_status: body.status,
      duration_ms: Date.now() - startedAt
    });
    // 501: a kérés ÉRVÉNYES, csak a képesség hiányzik nálunk. 400 azt üzenné,
    // hogy a CRM küldött rosszat, és a hibát a rossz helyen keresnék.
    return json(
      {
        error: 'adjustment_not_supported',
        error_code: TrackingErrorCode.LEAD_STATUS_ADJUSTMENT_UNSUPPORTED,
        retryable: false
      },
      501
    );
  }

  // ── P10 · ismételhető státusz → `occurrence_id` KÖTELEZŐ ──────────────────
  // Enélkül két részfizetés ugyanazt az `orderId`-t kapná (az a (lead_id, status)
  // hash-e), és a Google a másodikat ugyanannak a konverziónak látná: a pénz
  // némán elveszne. A hangos 400 az egyetlen helyes válasz — a csendes összevonás
  // pont az a hibaosztály, ami ellen az egész ledger épült.
  if (REPEATABLE_LEAD_STATUSES.has(body.status) && !body.occurrence_id) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.LEAD_STATUS_OCCURRENCE_ID_REQUIRED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.LEAD_STATUS_OCCURRENCE_ID_REQUIRED],
      hostname,
      site_id: siteConfig.site_id,
      lead_status: body.status,
      duration_ms: Date.now() - startedAt
    });
    return json(
      {
        error: 'occurrence_id_required',
        error_code: TrackingErrorCode.LEAD_STATUS_OCCURRENCE_ID_REQUIRED,
        repeatable_statuses: [...REPEATABLE_LEAD_STATUSES]
      },
      400
    );
  }

  // ── P10 · dupla-számolás elleni config-őr ─────────────────────────────────
  // A `revenue_confirmed` a MEGNYERT ajánlat értéke, a `payment_received` a
  // TÉNYLEGESEN befolyt pénz. A user döntése szerint a kettő két KÜLÖN
  // konverzió-akció. Ha egy site configja ugyanarra az akcióra képezi őket,
  // ugyanaz a bevétel kétszer számít — és ezt semmi más nem jelezné: a riport
  // csak azt mutatná, hogy jól teljesítünk.
  {
    const actions = siteConfig.gads?.conversion_actions;
    const revenueAction = actions?.revenue_confirmed;
    const paymentAction = actions?.payment_received;
    if (revenueAction && paymentAction && revenueAction === paymentAction) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.LEAD_STATUS_DOUBLE_COUNT_CONFIG,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.LEAD_STATUS_DOUBLE_COUNT_CONFIG],
        hostname,
        site_id: siteConfig.site_id,
        lead_status: body.status,
        duration_ms: Date.now() - startedAt
      });
      return json(
        {
          error: 'double_count_config',
          error_code: TrackingErrorCode.LEAD_STATUS_DOUBLE_COUNT_CONFIG,
          retryable: false
        },
        500
      );
    }
  }

  // ── F3-D · Prehashed PII contract ────────────────────────────────────────
  // A CRM lifecycle-outbox a Google-normalizált hash-eket küldi (`user_data_hashed`),
  // hogy a gateway NE hash-eljen újra. Fail-loud: hibás hash / kettős identity-forrás
  // → 400 (a néma pass-through Google EC match-et rontana jel nélkül). Az identity
  // (email/telefon/név) prehashed; a plain CÍM (postal_code/country) a user_data-ban
  // marad — a kettő diszjunkt, ezért együtt élhet.
  let prehashedUserData: HashedUserData | null = null;
  if (body.user_data_hashed) {
    const ud = body.user_data ?? {};
    const rawIdentityPresent = !!(ud.email || ud.phone_number || ud.first_name || ud.last_name);
    if (rawIdentityPresent) {
      logStructured({
        level: 'info',
        error_code: TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.PREHASHED_AND_RAW_USER_DATA],
        hostname,
        site_id: siteConfig.site_id,
        event_name: eventName,
        duration_ms: Date.now() - startedAt
      });
      return json({ error: 'user_data and user_data_hashed are mutually exclusive' }, 400);
    }
    const mapped = mapPrehashedUserData(body.user_data_hashed);
    if ('invalidField' in mapped) {
      logStructured({
        level: 'info',
        error_code: TrackingErrorCode.INVALID_PREHASHED_USER_DATA,
        // A mezőNÉV nem PII (a hash-érték sem az) — a konkrét mező kell a CRM-nek.
        message: `${ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_PREHASHED_USER_DATA]} (${mapped.invalidField})`,
        hostname,
        site_id: siteConfig.site_id,
        event_name: eventName,
        duration_ms: Date.now() - startedAt
      });
      return json({ error: `invalid_user_data_hashed`, field: mapped.invalidField }, 400);
    }
    prehashedUserData = mapped.data;
  }

  const occurredAtIso = body.occurred_at ?? new Date().toISOString();
  // P10 §5.4: ablakon belül a fizetés ideje, azon túl a `won_at` — egy elveszett
  // konverzió rosszabb, mint egy pontatlan időbélyeg. A ledger továbbra is a
  // VALÓDI `occurred_at`-et őrzi (lásd lentebb): a helyesbítés a platformnak
  // szól, nem a saját könyvelésünknek.
  const conversionTimeIso = resolveConversionTimeIso(occurredAtIso, body.won_at);
  const eventTimeSec = Math.floor(Date.parse(conversionTimeIso) / 1000);

  // GDPR-kapu, precedencia szerint (2026-07-17 consent-audit):
  //  1. A Worker SAJÁT consent-receiptje, ha EXPLICIT capture-kori jelet hordoz
  //     (ad_user_data GRANTED/DENIED). Ez az időbélyeges, bizonyítható consent —
  //     a szerver-ingress dispatch óta a receipt hordozza a CRM lead_id-t.
  //     (A korábbi „a receipt lead_id=NULL-lal íródik" premissza HAMIS volt, és a
  //     CRM newsletter-szemantikájú marketingConsent-je — amit a site-ok soha nem
  //     töltenek a CookieYes ad-consentből — némán blokkolt minden uploadot.)
  //  2. A CRM ad_allowed jele — fallback, ha nincs explicit receipt (telefonos/
  //     manuális lead, vagy fail-open site consent-objektum nélküli receipttel).
  //  3. require_consent fail-closed: kötelező consent + semmilyen jel → tiltott.
  // A jel nélküli receipt ad_allowed=1-e NEM evidencia (fail-open default is adhatja).
  const leadConsent = await getLatestConsentForLead(env, siteConfig.site_id, body.lead_id);
  const receiptSignal =
    leadConsent?.ad_user_data === 'GRANTED' || leadConsent?.ad_user_data === 'DENIED'
      ? leadConsent.ad_user_data
      : null;
  // ad_personalization KÜLÖN jel — NEM az ad_user_data-ból vezetjük le (lásd lentebb
  // a Data Manager consent-építésnél). Csak az explicit GRANTED/DENIED bizonyíték.
  const receiptAdPersonalization =
    leadConsent?.ad_personalization === 'GRANTED' || leadConsent?.ad_personalization === 'DENIED'
      ? leadConsent.ad_personalization
      : null;
  // ── CMP Fázis 2 (2.5): a consent_log az ÚJ, legerősebb precedencia. ─────────
  // Ha a lead receiptje consent_id-t hordoz (provider='sbo' site), az upload-
  // döntést NEM a capture-kori receipt adja, hanem a consent_log AKTUÁLIS
  // állapota (legmagasabb revision). A nap-1 GRANTED / nap-3 visszavonás /
  // nap-10 revenue_confirmed eset csak így skippel helyesen. `null` (nincs
  // consent_id — a teljes CookieYes-flotta —, ismeretlen consent_id, vagy
  // D1-hiba) → a MAI precedencia-lánc változatlanul fut tovább.
  const consentLogState = leadConsent?.consent_id
    ? await getConsentState(env, siteConfig.site_id, leadConsent.consent_id)
    : null;

  let consentBlocked: boolean;
  let consentSource: 'consent_log' | 'receipt' | 'crm' | 'fallback';
  if (consentLogState !== null) {
    consentBlocked = isBlockedByConsentState(consentLogState);
    consentSource = 'consent_log';
  } else if (receiptSignal !== null) {
    consentBlocked = receiptSignal === 'DENIED';
    consentSource = 'receipt';
  } else if (body.ad_allowed !== undefined) {
    consentBlocked = body.ad_allowed === false;
    consentSource = 'crm';
  } else {
    consentBlocked = isOfflineUploadBlocked(leadConsent, siteConfig.require_consent === true);
    consentSource = 'fallback';
  }

  // Ütközésbiztos, determinisztikus orderId: a (lead_id, status) SHA-256-ja —
  // ez megy a Google Ads offline uploadnak event_id-ként (transactionId).
  // A naiv `${lead_id}_${status}`.slice(0,64) hosszú lead_id-knál csonkolt és
  // ütközhetett (két különböző lead → egy orderId → a platform összevonja őket).
  // Ismételhető státusznál az `occurrence_id` is bekerül a hash-be: két
  // részfizetés így KÜLÖN konverzió, a retry viszont továbbra is ugyanazt az
  // orderId-t adja, tehát idempotens marad. Az egyszeri státuszok képlete
  // VÁLTOZATLAN — különben minden korábban feltöltött konverzió orderId-je
  // elmozdulna, és a Google újaknak látná őket.
  const orderIdSeed = REPEATABLE_LEAD_STATUSES.has(body.status)
    ? `${body.lead_id}_${body.status}_${body.occurrence_id}`
    : `${body.lead_id}_${body.status}`;
  const orderId = (await sha256Hex(orderIdSeed)).slice(0, 32);

  let uploadedToGads = false;
  let gadsErrorCode: string | undefined;
  let gadsRetryQueued = false;
  let deliveryNotDurable = false;
  let configurationBlocked = false;
  let invalidIdentifiers = false;
  // Sikerült-e a konfigurációs blokk retry-példányát tartósan letenni (R2 DLQ).
  // Ettől függ, hogy a CRM 202-t (a gateway őrzi tovább) vagy 503-at (tartsd meg
  // te) kap — lásd a záró státusz-leképezést.
  let configBlockQueued = false;

  // Consent Mode jelek a Data Manager eventre. EEA/DMA alatt a jelöletlen
  // (unspecified) consentű eventet a Google csendben kizárhatja az ads-
  // mérésből — ha van POZITÍV consent-evidenciánk (explicit GRANTED receipt a
  // capture-ből, vagy a CRM ad_allowed=true jele), azt explicit
  // CONSENT_GRANTED-ként továbbítjuk. Evidencia nélkül (fail-open site jel
  // nélküli receipttel) a mező kimarad — consentet nem találunk ki.
  // ad_user_data és ad_personalization KÜLÖN Consent Mode jel — NEM egyenlők.
  // Az ad_user_data-t a receipt/CRM evidencia adja; az ad_personalization-t NEM
  // vezetjük le belőle (különben hamis GRANTED menne olyan usernek, aki csak a
  // data-használatot engedte). Az ad_personalization csak SAJÁT bizonyítékra
  // GRANTED: explicit receipt-jel, VAGY — granular receipt hiányában — a CRM
  // ad_allowed=true (a CookieYes `advertisement` az ads-consentet egységként adja,
  // ad_user_data + ad_personalization együtt). Explicit DENIED receiptet tisztelünk.
  //
  // A számítás a gads-ágak ELŐTT fut, mert a konfigurációs blokk DLQ-rekordjának
  // ugyanezt a payloadot kell hordoznia — a replay később ugyanazzal a consent-
  // jellel megy ki, mint amit most küldtünk volna.
  // Consent_log-állapot mellett a JELEK IS onnan jönnek (mindkét mező explicit
  // GRANTED/DENIED a logban) — a capture-kori receipt jele elavult lehet, és a
  // Google felé a döntés pillanatában ÉRVÉNYES consentet kell jelenteni.
  const adUserDataGranted = consentLogState
    ? consentLogState.ad_user_data === 'GRANTED'
    : receiptSignal === 'GRANTED' || body.ad_allowed === true;
  const adPersonalizationSignal = consentLogState
    ? consentLogState.ad_personalization
    : (receiptAdPersonalization ??
      (receiptSignal === null && body.ad_allowed === true ? 'GRANTED' : undefined));
  const consentSignals: {
    ad_user_data?: 'GRANTED' | 'DENIED';
    ad_personalization?: 'GRANTED' | 'DENIED';
  } = {};
  if (adUserDataGranted) consentSignals.ad_user_data = 'GRANTED';
  if (adPersonalizationSignal) {
    consentSignals.ad_personalization = adPersonalizationSignal;
  }

  if (consentBlocked) {
    logStructured({
      level: 'info',
      message: 'Offline conversion skipped — consent not satisfied',
      site_id: siteConfig.site_id,
      event_name: eventName,
      require_consent: siteConfig.require_consent === true,
      has_consent_record: leadConsent !== null,
      consent_source: consentSource,
      // consent_log-blokknál a bizonyíték is a logba: melyik revision döntött.
      consent_log_decision: consentLogState?.decision,
      consent_log_revision: consentLogState?.revision
    });
    if (consentSource === 'consent_log') {
      // 2.5: az AKTUÁLIS állapot DENIED/withdrawn → a skip VÉGLEGES erre az
      // eventre. A do_not_replay=1 nélkül egy későbbi CRM-retry vagy admin-replay
      // — akár egy időközbeni ÚJ hozzájárulás után — újra kiküldené a döntés
      // idején tiltott konverziót. Best-effort: ha a jelölés elbukik, a skip
      // ettől a kérésen belül még áll, csak a replay-védelem gyengül (logolva).
      await markDoNotReplay(env, siteConfig.site_id, eventName, orderId);
    }
    // 'skipped' ledger-sor MINDEN consent-ágra — a szándékos kihagyás NEM némaság
    // (CLAUDE.md 11.).
    //
    // Eddig CSAK a consent_log-ág (provider='sbo', ma NULLA éles site) írt sort,
    // tehát a receipt/crm/fallback kihagyások NYOMTALANOK voltak: se delivery-sor,
    // se hibakód, se riasztás — csak egy `lead_status` sor `uploaded_to_gads=0`-val,
    // amit se a napi digest, se a reconciliation nem olvas. ÉLŐ MÉRÉS (2026-09-09,
    // D1 ledger): a beautyflow 37 `revenue_confirmed` státuszából 28 pontosan így
    // tűnt el — 21 receipt nélkül, 7 DENIED receipttel —, miközben a CRM outbox
    // mind a 37-et `accepted`-nek könyvelte. Ez az a néma pénz-lábas kiesés, ami
    // ellen az egész háromállapotú `deliveries` szerződés készült.
    //
    // A skip OKA megkülönböztetett: a `consent_withdrawn` a consent_log AKTUÁLIS
    // állapotából jövő visszavonás, a `consent_denied` a capture-kori receipt /
    // CRM-jel / fail-closed tiltás. A kettő eltérő teendő, ezért nem mosható össze.
    const consentSkipReason =
      consentSource === 'consent_log' ? ('consent_withdrawn' as const) : ('consent_denied' as const);
    ctx.waitUntil(
      recordDeliveries(env, {
        event_id: orderId,
        lead_id: body.lead_id,
        site_id: siteConfig.site_id,
        event_name: eventName,
        origin: 'offline',
        records: [
          normalizeDelivery('gads', {
            status: 'fulfilled',
            value: { success: true, skipped: true, skip_reason: consentSkipReason }
          })
        ]
      })
    );
  } else if (siteConfig.gads?.customer_id) {
    // Model 2: the server is Google-Ads-offline-only (Enhanced Conversions for
    // Leads), delivered via the Data Manager API. The email hash MUST use the
    // Google normalization (Gmail dot/plus strip), NOT the Meta rule.
    // F3-D: a CRM lifecycle-outbox már Google-normalizált hash-eket küld
    // (`user_data_hashed`) → ilyenkor NEM hash-elünk újra (nincs dupla-hash). Plain
    // user_data esetén (pl. telefonos/manuális lead) a gateway hash-el, mint eddig.
    const hashed =
      prehashedUserData ??
      (await hashUserDataForGoogle(body.user_data ?? {}, siteConfig.country_code as CountryCode));
    const gadsPayload: GAdsPayload = {
      event_name: eventName,
      event_id: orderId,
      event_time: eventTimeSec,
      value: body.value,
      currency: body.currency ?? siteConfig.currency,
      // city is dropped by the Data Manager (no AddressInfo.city field); only
      // postal_code/country (plain) are carried into the address identifier.
      postal_code: body.user_data?.postal_code ?? undefined,
      country: body.user_data?.country ?? undefined,
      consent: Object.keys(consentSignals).length > 0 ? consentSignals : undefined,
      gclid: body.gclid,
      gbraid: body.gbraid,
      wbraid: body.wbraid
    };
    const result = await sendToDataManager(siteConfig, env, gadsPayload, hashed);
    // `skipped` (nincs conversion action / nincs identifier) NEM upload — ha
    // success-ként könyvelnénk, a válasz `uploaded_to_gads: true`-t hazudna egy
    // soha el nem indult hívásról, és a CRM/ledger sosem jelezné a hiányt.
    uploadedToGads = result.success && result.skipped !== true;
    gadsErrorCode = result.error_code;

    // A Data Manager skip vendorhívás NÉLKÜLI kimenet. Consent-skip ide nem jut
    // (azt a külső ág kezeli), ezért itt a skip vagy konfigurációs blokk, vagy
    // hibásan azonosító nélküli lifecycle payload. Egyik sem kaphat csendes 200-at.
    if (result.skipped === true) {
      // A KONFIGURÁCIÓS BLOKK CSAK ELVÁRT OFFLINE LÁBRA BLOKK. A
      // `expected_platforms.offline` eddig KIZÁRÓLAG a `customer_id` NÉLKÜLI ágon
      // számított (lentebb); ha a configban volt customer_id, de nem volt
      // `conversion_actions` bejegyzés, MINDEN lifecycle-post 7 napos
      // `blocked_configuration` DLQ-rekordot írt + óránként újrapróbálta + 202-t
      // adott — olyan site-okon is, ahol az offline láb nincs is bekötve és nem is
      // elvárt. Élő KV (2026-09-09): olcsokontenerhaz, skinlab, szelloztetes
      // pontosan ilyen (customer_id a recon/health miatt, conversion_actions nélkül).
      //
      // A fan-out ugyanezt a megkülönböztetést már évek óta így csinálja
      // (`isExpectedPlatform` → `not_expected` skip, se DLQ, se riasztás) — az
      // offline láb most követi ugyanazt a szabályt.
      const offlineExpected = isExpectedOfflinePlatform(siteConfig, 'gads');
      configurationBlocked =
        result.error_code !== TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS && offlineExpected;
      invalidIdentifiers =
        result.error_code === TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS;
      if (!offlineExpected && result.error_code !== TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS) {
        logStructured({
          level: 'info',
          message:
            'Offline gads skipped — not an expected offline platform for this site (no DLQ record, no alert)',
          site_id: siteConfig.site_id,
          hostname,
          event_name: eventName,
          skip_error_code: result.error_code
        });
      }

      // Konfigurációs blokk (hiányzó conversion action, validate-only kapcsoló):
      // a vendorhívás el sem indult, és a config magától SOHA nem javul meg. A
      // böngésző-fan-out ezt 7 napos ablakú `blocked_configuration` DLQ-rekorddal
      // kezeli (deadletter.ts) — az OFFLINE lábon eddig nem volt ilyen, így a
      // visszanyerés kizárólag a CRM ~2 órás retry-keretén múlt, ami egy napos
      // config-kiesést nem él túl. Innentől a gateway is őrzi a példányt.
      if (configurationBlocked) {
        const blockedAtIso = new Date().toISOString();
        configBlockQueued = await enqueueFailure(env, {
          platform: 'gads',
          site_id: siteConfig.site_id,
          hostname,
          lead_id: body.lead_id,
          event_payload: gadsPayload as unknown as Record<string, unknown>,
          hashed_user_data: hashed as unknown as Record<string, unknown>,
          failure_reason: result.error_code ?? 'configuration_blocked',
          blocked_configuration: true,
          retry_count: 0,
          first_failed_at: blockedAtIso,
          last_attempted_at: blockedAtIso
        }).catch(() => false);
      }
    }

    ctx.waitUntil(
      recordDeliveries(env, {
        event_id: gadsPayload.event_id,
        lead_id: body.lead_id,
        site_id: siteConfig.site_id,
        event_name: eventName,
        origin: 'offline',
        records: [normalizeDelivery('gads', { status: 'fulfilled', value: result })]
      })
    );

    // A sikertelen offline Data Manager upload (tranziens 5xx/timeout) → DLQ, hogy a
    // retry (worker.ts queue() / scheduled retry → retrySingle, sendToDataManager)
    // visszanyerje. Enélkül egy átmeneti hiba VÉGLEG elveszítené az Enhanced
    // Conversion-t (P0: „melyik leadből lett valódi pénz"). event_id-vel dedup-ol.
    if (!result.success) {
      const nowIso = new Date().toISOString();
      const leadIdForDlq = body.lead_id;
      const statusForLog = body.status;
      const stored = await enqueueFailure(env, {
          platform: 'gads',
          site_id: siteConfig.site_id,
          hostname,
          lead_id: leadIdForDlq,
          event_payload: gadsPayload as unknown as Record<string, unknown>,
          hashed_user_data: hashed as unknown as Record<string, unknown>,
          failure_reason: result.error || gadsErrorCode || 'unknown',
          retry_count: 0,
          first_failed_at: nowIso,
          last_attempted_at: nowIso
        }).catch(() => false);
      gadsRetryQueued = stored;
      deliveryNotDurable = !stored;
      // Hármas kiesés (Data Manager fail + Queue fail + R2 fail): a retry-
      // példány SEHOL sincs. A CRM ezért 503-at kap, és a saját outboxában tartja
      // az eseményt; nincs többé „200 + uploaded_to_gads:false” hamis siker.
      if (!stored) {
        logStructured({
          level: 'error',
          error_code: TrackingErrorCode.RETRY_PERSIST_FAILED,
          message: ERROR_DESCRIPTIONS[TrackingErrorCode.RETRY_PERSIST_FAILED],
          site_id: siteConfig.site_id,
          hostname,
          event_name: eventName,
          lead_status: statusForLog
        });
        await sendAlert(env, TrackingErrorCode.RETRY_PERSIST_FAILED, {
          site_id: siteConfig.site_id,
          hostname,
          platform: 'gads',
          event_name: eventName,
          lead_status: statusForLog
        }).catch(() => {});
      }
    }
  } else {
    // NEM consent-tiltott, de nincs gads.customer_id → az offline gads-láb nincs
    // bekötve. Ha a site VÁRJA az offline gads-t (expected_platforms.offline), ez a
    // PÉNZ-lábon jelentkező config-vesztés (lomtalan-osztály) → hangos riasztás +
    // 'skipped|not_configured' ledger-sor, NEM némaság. Ha nem várt, jogos no-op.
    if (isExpectedOfflinePlatform(siteConfig, 'gads')) {
      configurationBlocked = true;
      gadsErrorCode = TrackingErrorCode.PLATFORM_NOT_CONFIGURED;
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.PLATFORM_NOT_CONFIGURED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.PLATFORM_NOT_CONFIGURED],
        site_id: siteConfig.site_id,
        hostname,
        event_name: eventName,
        platform: 'gads'
      });
      ctx.waitUntil(
        sendAlert(env, TrackingErrorCode.PLATFORM_NOT_CONFIGURED, {
          site_id: siteConfig.site_id,
          hostname,
          platform: 'gads',
          event_name: eventName,
          lead_status: body.status
        }).catch(() => {})
      );
      ctx.waitUntil(
        recordDeliveries(env, {
          event_id: orderId,
          lead_id: body.lead_id,
          site_id: siteConfig.site_id,
          event_name: eventName,
          origin: 'offline',
          records: [
            normalizeDelivery('gads', {
              status: 'fulfilled',
              value: { success: true, skipped: true, skip_reason: 'not_configured' }
            })
          ]
        })
      );

      // Ugyanaz a 7 napos `blocked_configuration` retry-példány, mint a hiányzó
      // conversion action ágon: a site VÁRJA az offline gads-t, csak a config
      // tűnt el (lomtalan-osztály). A payload a replay-hez teljes kell legyen,
      // ezért a hash-t itt is kiszámoljuk (prehashed esetén nem hash-elünk újra).
      const blockedAtIso = new Date().toISOString();
      const blockedHashed =
        prehashedUserData ??
        (await hashUserDataForGoogle(body.user_data ?? {}, siteConfig.country_code as CountryCode));
      configBlockQueued = await enqueueFailure(env, {
        platform: 'gads',
        site_id: siteConfig.site_id,
        hostname,
        lead_id: body.lead_id,
        event_payload: {
          event_name: eventName,
          event_id: orderId,
          event_time: eventTimeSec,
          value: body.value,
          currency: body.currency ?? siteConfig.currency,
          postal_code: body.user_data?.postal_code ?? undefined,
          country: body.user_data?.country ?? undefined,
          consent: Object.keys(consentSignals).length > 0 ? consentSignals : undefined,
          gclid: body.gclid,
          gbraid: body.gbraid,
          wbraid: body.wbraid
        } as unknown as Record<string, unknown>,
        hashed_user_data: blockedHashed as unknown as Record<string, unknown>,
        failure_reason: TrackingErrorCode.PLATFORM_NOT_CONFIGURED,
        blocked_configuration: true,
        retry_count: 0,
        first_failed_at: blockedAtIso,
        last_attempted_at: blockedAtIso
      }).catch(() => false);
    } else {
      logStructured({
        level: 'info',
        message: 'Offline gads not configured (not expected for this site) — no-op',
        site_id: siteConfig.site_id,
        event_name: eventName
      });
    }
  }


  ctx.waitUntil(
    recordLeadStatus(env, {
      lead_id: body.lead_id,
      site_id: siteConfig.site_id,
      status: body.status,
      value: body.value,
      currency: body.currency,
      occurred_at: occurredAtIso,
      uploaded_to_gads: uploadedToGads,
      gads_error_code: gadsErrorCode
    })
  );

  logStructured({
    level: 'info',
    message: 'Lead status recorded',
    site_id: siteConfig.site_id,
    event_name: eventName,
    uploaded_to_gads: uploadedToGads,
    // Az offline GA4 láb kikapcsolt (Run 6): client_id nélkül minden státusz új
    // szintetikus GA4-clientbe esett volna. A mező a válasz-séma stabilitásáért
    // marad, értéke definíció szerint false.
    uploaded_to_ga4: false,
    consent_blocked: consentBlocked,
    consent_source: consentSource,
    duration_ms: Date.now() - startedAt
  });

  if (deliveryNotDurable) {
    return json(
      { ok: false, error: 'delivery_not_durable', retryable: true, uploaded_to_gads: false },
      503
    );
  }
  if (configurationBlocked) {
    // A konfigurációs hiba DETERMINISZTIKUS: a CRM újrapróbálkozása magától soha
    // nem oldja meg — csak elégeti a ~2 órás retry-keretét, aztán failed_permanent
    // lesz belőle, és a konverzió a config javítása után is elveszett marad.
    // Ha a gateway tartósan letette a 7 napos replay-példányt, 202-t adunk („nálam
    // van, ne pörögj rajta"); ha a letétel NEM sikerült, marad az 503, mert akkor a
    // CRM outboxa az egyetlen őrző, és neki KELL megtartania.
    if (configBlockQueued) {
      return json(
        {
          ok: true,
          queued_for_retry: true,
          configuration_blocked: true,
          uploaded_to_gads: false,
          uploaded_to_ga4: false
        },
        202
      );
    }
    return json(
      { ok: false, error: 'gads_configuration_blocked', retryable: true, uploaded_to_gads: false },
      503
    );
  }
  if (invalidIdentifiers) {
    return json(
      { ok: false, error: 'no_match_identifiers', retryable: false, uploaded_to_gads: false },
      422
    );
  }
  if (gadsRetryQueued) {
    return json(
      { ok: true, queued_for_retry: true, uploaded_to_gads: false, uploaded_to_ga4: false },
      202
    );
  }

  return json(
    {
      ok: true,
      uploaded_to_gads: uploadedToGads,
      uploaded_to_ga4: false,
      consent_blocked: consentBlocked
    },
    200
  );
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
