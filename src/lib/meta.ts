import type { SiteConfig } from './config';
import type { SkipReason } from './skip-reason';
import type { HashedUserData } from './hash';
import type { EcommerceParams } from './ecommerce';
import { logStructured, EVENT_NAME_MAP } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';

const META_API_VERSION = 'v25.0';
const META_API_TIMEOUT_MS = 5000;

// A pixel_id (dataset ID) elfogadott alakja. UGYANAZ a minta, amit az onboarding
// már kikényszerít (scripts/generate-site.mjs) — a runtime-ellenőrzés nem lehet
// lazább a beviteli oldalnál, különben a kézzel írt KV-bejegyzés kicsúszik alóla.
const META_PIXEL_ID_PATTERN = /^\d{5,}$/;

export interface MetaCAPIPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  value?: number;
  currency?: string;
  // A `source` (CTA-kontextus) mező TÖRÖLVE (2026-08-16 audit): a hívó kitöltötte,
  // de a Meta-body építése SOHA nem olvasta — halott mező volt, ami azt a látszatot
  // keltette, hogy a CTA-kontextus eljut a Metához. Nem jutott el. Ha kell,
  // TUDATOS döntéssel `custom_data.cta_context`-ként vezethető be (a `source` NÉV
  // szándékosan kerülendő — a GA4-ben foglalt kampány-kulcs, lásd lib/ga4.ts) —
  // de az már viselkedés-változás, nem takarítás.
  event_source_url?: string;
  fbp?: string;
  fbc?: string;
  client_ip?: string;
  client_user_agent?: string;
  // §3 — automatikus lead-útvonal (cold|post_quote|from_quote_email). A Meta
  // custom_data-ba kerül; nem PII. Ingress-validált (lib/provenance.ts).
  lead_provenance?: string;
  // Webshop-tenantok katalógus-paraméterei (lib/ecommerce.ts). Lead-gen site-okon
  // undefined. Nélkülük a purchase megérkezik, de nem köthető katalógus-tételhez,
  // így a dinamikus remarketing és a termékszintű ROAS némán üres marad.
  ecommerce?: EcommerceParams;
  // Per-request Test-stream override — az EGYETLEN elfogadott forrás (§17). Csak a
  // hitelesített szerver-ingress tölti ki (routes/conversion.ts); a böngésző-ág
  // eldobja. A KV `meta.test_event_code`-ot SOHA nem használjuk (detektáljuk+riasztunk).
  test_event_code?: string;
}

// internal event_name → Meta standard event. A térkép az events.json-ból
// generálódik (lib ../types EVENT_NAME_MAP); ismeretlen név → passthrough.
function mapEventName(internalName: string): string {
  return EVENT_NAME_MAP[internalName] || internalName;
}

export interface MetaCAPIResult {
  success: boolean;
  events_received?: number;
  fbtrace_id?: string;
  error?: string;
  error_code?: TrackingErrorCode;
  status?: number;
  // true → a hívás szándékosan kimaradt (nincs meta config). A ledger 'skipped'-
  // ként könyveli, NEM 'accepted'-ként — accepted CSAK valós vendor HTTP-válasz
  // mellett íródhat (lásd lib/ledger.ts normalizeDelivery).
  skipped?: boolean;
  // Miért maradt ki — lásd lib/skip-reason.ts. A fan-out ez alapján dönt DLQ-ról.
  skip_reason?: SkipReason;
}

function classifyMetaError(
  status: number,
  metaCode: number | undefined,
  metaMessage: string | undefined
): TrackingErrorCode {
  if (metaCode === 190 || status === 401) return TrackingErrorCode.META_INVALID_ACCESS_TOKEN;
  if (metaCode === 4 || metaCode === 17 || status === 429) return TrackingErrorCode.META_RATE_LIMITED;
  if (metaCode === 803 || (status === 400 && metaMessage && /pixel|object/i.test(metaMessage)))
    return TrackingErrorCode.META_PIXEL_NOT_FOUND;
  if (status === 400 && metaMessage && /user_data|hash|normaliz/i.test(metaMessage))
    return TrackingErrorCode.META_INVALID_USER_DATA;
  return TrackingErrorCode.META_API_REJECTED;
}

export async function sendToMetaCAPI(
  siteConfig: SiteConfig,
  payload: MetaCAPIPayload,
  hashedUserData: HashedUserData
): Promise<MetaCAPIResult> {
  const startedAt = Date.now();

  // Nincs `meta` blokk (a site be van kötve, de a CAPI access token még nincs
  // kiállítva) → skip `not_configured` okkal. Hogy ez ártalmatlan kihagyás-e vagy
  // adatvesztő konfigurációs blokk, azt NEM itt döntjük el: az `expected_platforms`
  // site-policy, amit a fan-out ismer (lásd routes/conversion.ts handleResult).
  // A `skipped: true` KÖTELEZŐ: enélkül a ledger 'accepted'-et írna http_status
  // nélkül — a lomtalan 2026-07-14-i esetben pont így nézett ki egészségesnek egy
  // soha-nem-élt Meta-láb.
  const meta = siteConfig.meta;
  if (!meta) {
    return { success: true, skipped: true, skip_reason: 'not_configured' };
  }

  // A blokk megvan, de a pixel_id alakja használhatatlan (kitöltetlen
  // `REPLACE_ME_*` placeholder, üres string, elgépelt vagy rossz típusú ID).
  //
  // MIÉRT ÁLLUNK MEG ITT: a pixel_id nem a body-ba megy, hanem az endpoint-URL
  // ÚTVONALÁBA (lásd a `url`-t lentebb). Ezért a Meta nem validációs hibát ad rá,
  // hanem Graph-objektumként próbálja feloldani — a válasz 400
  // „Object with ID … does not exist, cannot be loaded due to missing
  // permissions", ami első ránézésre jogosultsági problémának látszik, nem
  // konfigurációs elgépelésnek. Az agykontroll 2026-07-27 és 08-11 között 43 ilyen
  // külső hívást futtatott el `warning` súlyú vendor-hibakóddal (TRK-600-005),
  // mire a hiba egyáltalán észrevehetővé vált.
  //
  // A skip ugyanabba a retryable ágba fut, mint a hiányzó blokk: DLQ-rekord +
  // CRITICAL riasztás, és a KV javítása után az EREDETI event_id-vel újrajátszható.
  // Így 43 néma külső 400 helyett egy azonnal látható, önmagát megmagyarázó sor lesz.
  if (!META_PIXEL_ID_PATTERN.test(meta.pixel_id ?? '')) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      // Az érték HOSSZA és alakja diagnosztikus, maga az érték nem PII (a
      // pixel_id publikus azonosító) — de a nyers logolást kerüljük, mert egy
      // elrontott configba tévedésből bármi kerülhetett. A vendor_message-be
      // úgysem jut el, hiszen hívás nem történik.
      pixel_id_length: (meta.pixel_id ?? '').length
    });
    // SZÁNDÉKOSAN nincs `error_code` a visszatérési értéken: a fan-out a vendor-
    // oldali kódokra általános CRITICAL-riasztást lő, MÉG a skip-osztályozás előtt
    // (routes/conversion.ts). Ha itt kódot adnánk, egy be nem kötött platform
    // formahibás ID-je is riasztana, és az elvárt platformnál duplán menne ki a
    // riasztás. A ledger-kódot ezért — a `not_configured` mintájára — a
    // normalizeDelivery képezi le a skip_reason-ből (lib/ledger.ts).
    return { success: true, skipped: true, skip_reason: 'invalid_identifier' };
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${meta.pixel_id}/events`;

  // hashedUserData már tartalmazza az external_id-t (hash-elve), ha a kliens
  // küldte — a spread automatikusan beemeli a Meta user_data-ba.
  const user_data: Record<string, unknown> = { ...hashedUserData };
  if (payload.fbp) user_data.fbp = payload.fbp;
  if (payload.fbc) user_data.fbc = payload.fbc;
  if (payload.client_ip) user_data.client_ip_address = payload.client_ip;
  if (payload.client_user_agent) user_data.client_user_agent = payload.client_user_agent;

  const custom_data: Record<string, unknown> = {};
  if (typeof payload.value === 'number' && payload.value > 0 && payload.currency) {
    custom_data.value = payload.value;
    custom_data.currency = payload.currency;
  }
  // §3 lead_provenance — Meta custom_data paraméter (nem PII). Modell 2-ben a
  // Meta a fő on-site sink (a GA4/Google Ads on-site láb kikerült).
  if (payload.lead_provenance) custom_data.lead_provenance = payload.lead_provenance;
  // Katalógus-paraméterek (webshop). Már ingress-validáltak (lib/ecommerce.ts):
  // itt csak átemeljük őket, hogy egy formahibás mező ne itt, a vendor-hívás
  // közepén bukjon el. A `contents` az ajánlott forma; a `content_ids` a lapos
  // fallback — a Meta a `contents`-t részesíti előnyben, ha mindkettő jelen van.
  const ecom = payload.ecommerce;
  if (ecom) {
    if (ecom.contents) custom_data.contents = ecom.contents;
    if (ecom.content_ids) custom_data.content_ids = ecom.content_ids;
    if (ecom.content_type) custom_data.content_type = ecom.content_type;
    if (ecom.num_items !== undefined) custom_data.num_items = ecom.num_items;
    if (ecom.order_id) custom_data.order_id = ecom.order_id;
  }

  const event: Record<string, unknown> = {
    event_name: mapEventName(payload.event_name),
    event_time: payload.event_time,
    event_id: payload.event_id,
    action_source: 'website',
    event_source_url: payload.event_source_url,
    user_data,
    custom_data
  };

  const body: Record<string, unknown> = {
    data: [event],
    access_token: meta.access_token
  };

  // CCPA Limited Data Use — kötelező US-traffic opt-out kezeléséhez.
  // FONTOS: a Meta ezeket a REQUEST TOP-LEVEL-jén várja (a `data` tömb MELLETT),
  // NEM az event objektumon belül — különben csendben figyelmen kívül hagyja.
  // country/state = 0,0 → Meta geolokáció dönti el, hogy alkalmazza-e.
  // (EU/GDPR-gating NEM itt történik: nem-konszenzuáló EU usernél a hívás
  //  fel sem indul — lásd routes/conversion.ts + lib/consent.ts.)
  if (siteConfig.country_code === 'US') {
    body.data_processing_options = ['LDU'];
    body.data_processing_options_country = 0;
    body.data_processing_options_state = 0;
  }

  // §17: a test_event_code KIZÁRÓLAG per-request jöhet (hitelesített szerver-ingress),
  // SOHA a KV-configból. A site-config edge-cache-elt (cacheTtl=300s), így egy bent
  // felejtett KV-kód a cache-ablakban VALÓDI konverziókat terelne a Meta Test
  // streambe (két éles leak történt már így). Ha egy KV-config mégis hordoz ilyet,
  // NEM használjuk, és hangosan riasztunk — a config-ból ki kell venni.
  if (meta.test_event_code) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.META_KV_TEST_EVENT_CODE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.META_KV_TEST_EVENT_CODE],
      site_id: siteConfig.site_id,
      event_name: payload.event_name
    });
  }
  const testEventCode = payload.test_event_code;
  if (testEventCode) {
    body.test_event_code = testEventCode;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), META_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const responseBody = (await response.json()) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string; code?: number };
    };

    if (response.ok && responseBody.events_received && responseBody.events_received > 0) {
      logStructured({
        level: 'info',
        message: 'Meta CAPI event sent',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        events_received: responseBody.events_received,
        fbtrace_id: responseBody.fbtrace_id,
        // Melyik stream-be ment: Test vagy PRODUCTION. Enélkül a CLAUDE.md 17
        // csendes hibája (bent felejtett test_event_code → minden konverzió a Test
        // stream-be) csak hetekkel később, a hiányzó riportokból derül ki — és egy
        // szintetikus proof-event Test-voltát sem lehet bizonyítani, csak hinni.
        test_event: Boolean(testEventCode),
        duration_ms: Date.now() - startedAt
      });
      return {
        success: true,
        events_received: responseBody.events_received,
        fbtrace_id: responseBody.fbtrace_id,
        status: response.status
      };
    }

    if (response.ok && (!responseBody.events_received || responseBody.events_received === 0)) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.META_EVENTS_RECEIVED_ZERO,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.META_EVENTS_RECEIVED_ZERO],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        fbtrace_id: responseBody.fbtrace_id,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error_code: TrackingErrorCode.META_EVENTS_RECEIVED_ZERO,
        error: 'events_received: 0',
        status: response.status,
        fbtrace_id: responseBody.fbtrace_id
      };
    }

    const errorCode = classifyMetaError(
      response.status,
      responseBody.error?.code,
      responseBody.error?.message
    );

    logStructured({
      level: errorCode === TrackingErrorCode.META_INVALID_ACCESS_TOKEN ? 'error' : 'warn',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      status: response.status,
      meta_error: sanitizeErrorMessage(responseBody.error?.message),
      meta_error_code: responseBody.error?.code,
      fbtrace_id: responseBody.fbtrace_id,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      error_code: errorCode,
      // §13: a Meta a beküldött értékeket (email/telefon) VISSZHANGOZHATJA a hiba-
      // üzenetben. A returned `error` a ledger vendor_message-be és a DLQ
      // failure_reason-be perzisztálódik — ezért itt is sanitizáljuk, nem csak a logban.
      error: responseBody.error?.message
        ? sanitizeErrorMessage(responseBody.error.message)
        : `HTTP ${response.status}`,
      status: response.status,
      fbtrace_id: responseBody.fbtrace_id
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.META_API_TIMEOUT
      : TrackingErrorCode.META_API_NETWORK_ERROR;

    logStructured({
      level: 'warn',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: errMsg,
      duration_ms: Date.now() - startedAt
    });
    return {
      success: false,
      error_code: errorCode,
      error: isTimeout ? 'timeout' : sanitizeErrorMessage(errMsg)
    };
  }
}
