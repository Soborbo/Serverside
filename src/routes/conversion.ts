import type { Env } from '../env';
import {
  logStructured,
  isValidConversionPayload,
  canonicalizeEventName,
  ALLOWED_EVENT_NAMES,
  SERVER_INGRESS_ONLY_EVENTS,
  type ConversionRequestPayload
} from '../types';
import { corsHeaders } from '../worker';
import { getSiteConfig, isExpectedPlatform, type SiteConfig } from '../lib/config';
import { checkOrigin } from '../lib/origin';
import { authenticateServerIngress } from '../lib/admin-auth';
import { hashUserData, type CountryCode, type HashedUserData } from '../lib/hash';
import { sendToMetaCAPI, type MetaCAPIPayload, type MetaCAPIResult } from '../lib/meta';
// Modell 2 (§0/§4.3): az on-site fan-outból a GA4 ÉS a Google Ads láb kikerült.
// On-site GA4 = csak böngésző (GA4 nem dedup-ol event_id-re → dupla lenne).
// On-site Google Ads = csak böngésző (AWCT + Enhanced Conversions). A szerver a
// Google Adset KIZÁRÓLAG offline-ként küldi (routes/lead-status.ts). Meta CAPI +
// a click-ID forwarderek (TikTok/LinkedIn/MsAds) maradnak (event_id-dedup, mint a Meta).
import { sendToTikTok, type TikTokPayload, type TikTokResult } from '../lib/tiktok';
import { sendToLinkedIn, type LinkedInPayload, type LinkedInResult } from '../lib/linkedin';
import { sendToMsAds, type MsAdsPayload, type MsAdsResult } from '../lib/msads';
import { parseConsent, resolveConsent, type ConsentDecision } from '../lib/consent';
import { parseAttribution, buildFbcFromFbclid, type AttributionParams } from '../lib/attribution';
import { isValidProvenance } from '../lib/provenance';
import { enqueueFailure, type Platform } from '../lib/deadletter';
import { isTerminalSkip } from '../lib/skip-reason';
import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY } from '../lib/error-codes';
import { recordFanoutMetric, recordConversionMetric } from '../lib/metrics';
import { sendAlert } from '../lib/notify';
import {
  checkIdempotency,
  markDispatched,
  recordEventRaw,
  recordConsentReceipt,
  recordDeliveries,
  normalizeDelivery,
  isValidLeadId,
  type DeliveryRecord
} from '../lib/ledger';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Body-olvasás KEMÉNY felső korláttal. A stream-et olvasás közben mérjük, és a cap
 * átlépésekor megszakítjuk — szemben a puszta Content-Length-ellenőrzéssel, amit egy
 * chunked kérés (nincs Content-Length) megkerül. `null` = túl nagy.
 */
async function readBoundedBody(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('Content-Length');
  if (declared) {
    const len = parseInt(declared, 10);
    if (Number.isFinite(len) && len > max) return null;
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function ingestRateLimit(env: Env, hostname: string, request: Request): Promise<boolean> {
  const limiter = env.INGEST_LIMITER;
  if (!limiter) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await limiter.limit({ key: `${hostname}:${ip}` });
    return success;
  } catch {
    // Limiter-hiba → engedjük tovább (a konverzió-vesztés drágább, mint egy
    // átcsúszó kérés; a spike-riasztás úgyis látja, ha ebből baj lesz).
    return true;
  }
}

function rateLimited(env: Env, hostname: string, cors: HeadersInit, startedAt: number): Response {
  logStructured({
    level: 'info',
    message: 'Rate limited',
    hostname,
    duration_ms: Date.now() - startedAt
  });
  recordConversionMetric(env, {
    hostname,
    site_id: 'unknown',
    event_name: 'unknown',
    accepted: false,
    error_code: 'rate_limited',
    total_duration_ms: Date.now() - startedAt
  });
  return new Response(null, { status: 429, headers: cors });
}

export interface ConversionRouteOptions {
  /**
   * `/api/event/conversion-server` — a WAF rate-limiting szabály alól KIVETT
   * útvonal (Free planen a Path az egyetlen matchelhető mező). Épp ezért itt
   * érvényes per-site token NÉLKÜL nincs belépés: böngésző-fallback nélkül 401.
   * Enélkül a kivétel egy nyitott hátsó ajtó lenne — bárki ide posztolna
   * hamisított Origin-nel, és a limitet triviálisan megkerülné.
   */
  serverOnly?: boolean;
}

export async function handleConversion(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: ConversionRouteOptions = {}
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;
  const cors = corsHeaders(request, env);

  // A per-site szerver-token JELENLÉTE (nem az érvényessége!) — csak arra kell,
  // hogy a hitelesített money-path ne akadjon fenn az IP-kulcsos rate limiten.
  // Az ÉRVÉNYESSÉG ellenőrzése lejjebb, a site-config feloldása után történik;
  // egy hamis tokennel érkező kérés ott bukik (401) ÉS ott is rate-limitelődik,
  // tehát ez nem ad ingyen bypasst — csak elhalasztja a limitet.
  const presentsServerToken = request.headers.get('X-Admin-Token') !== null;

  // Natív rate limiting — a Turnstile eltávolítása után ez az EGYIK tartóoszlop
  // a böngésző-ágon (a másik az Origin allow-list). IP+hostname kulcs: egy
  // site/IP nem meríti ki a többit. Guarded: binding nélkül kimarad.
  //
  // A hitelesített szerver-szerver ingress SZÁNDÉKOSAN kimarad: az a site saját
  // backendjéből jön, gyakran EGYETLEN egress-IP-ről, tehát egy forgalmas nap
  // simán kimerítené az IP-budget-et — és pont a pénzt jelentő konverziókat
  // dobnánk el. Ott a per-site token a kontroll, nem az IP.
  if (!presentsServerToken && env.INGEST_LIMITER) {
    if (!(await ingestRateLimit(env, hostname, request))) {
      return rateLimited(env, hostname, cors, startedAt);
    }
  }

  // Body-cap. Korábban CSAK a Content-Length fejlécet néztük — egy chunked
  // (Content-Length nélküli) kérés simán megkerülte, és a request.json() korlátlanul
  // olvasott. Most a streamet MÉRJÜK olvasás közben, és a cap átlépésekor
  // megszakítjuk. Ez a DLQ/AE-elárasztás elleni valódi korlát.
  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (raw === null) {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.BODY_TOO_LARGE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.BODY_TOO_LARGE],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    recordConversionMetric(env, {
      hostname,
      site_id: 'unknown',
      event_name: 'unknown',
      accepted: false,
      error_code: TrackingErrorCode.BODY_TOO_LARGE,
      total_duration_ms: Date.now() - startedAt
    });
    return new Response(null, { status: 413, headers: cors });
  }

  // Böngésző-beaconnek a drop 204 (nem szivárgunk hibát, a sendBeacon úgysem
  // olvassa). SZERVER-hívónak (token jelen VAGY server-only út) viszont 400 jár:
  // egy 204 hibás payloadra azt jelentené, hogy a site backendje sikernek könyveli
  // a drop-ot, és a high-value lead némán vész el (CLAUDE.md 12; Run 6 audit).
  const dropStatus = presentsServerToken || options.serverOnly ? 400 : 204;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.INVALID_JSON,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_JSON],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response(dropStatus === 204 ? null : 'Invalid JSON', {
      status: dropStatus,
      headers: cors
    });
  }

  if (!isValidConversionPayload(payload)) {
    // TRK-EVT-001 ha specifikusan az event_name ismeretlen (nincs az ALLOWED-ban);
    // egyébként strukturális hiba. Mindkettő 204 (a kliens felé nem szivárog hiba).
    const rawName = (payload as { event_name?: unknown } | null)?.event_name;
    const unknownEvent = typeof rawName === 'string' && !ALLOWED_EVENT_NAMES.has(rawName);
    const errorCode = unknownEvent
      ? TrackingErrorCode.UNKNOWN_EVENT_NAME
      : TrackingErrorCode.INVALID_PAYLOAD_STRUCTURE;
    logStructured({
      level: 'info',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    recordConversionMetric(env, {
      hostname,
      site_id: 'unknown',
      // Ismert-formájú de nem engedélyezett event_name mehet blobba (bounded
      // cardinality nem sérül: az AE-riport error_code+hostname szerint aggregál).
      event_name: unknownEvent && typeof rawName === 'string' ? rawName.slice(0, 64) : 'unknown',
      accepted: false,
      error_code: errorCode,
      total_duration_ms: Date.now() - startedAt
    });
    return new Response(dropStatus === 204 ? null : 'Invalid payload', {
      status: dropStatus,
      headers: cors
    });
  }

  // Ingress-normalizálás (§1 migráció): legacy GA4 alias → kanonikus név, hogy MINDEN
  // downstream (special-case logika, forwarderek, Meta-map, ledger) egységesen a
  // kanonikus nevet lássa. A régi kliensek/tesztek így sem törnek.
  payload.event_name = canonicalizeEventName(payload.event_name);

  // §3 lead_provenance — csak a három engedélyezett érték mehet tovább; bármi más
  // → drop (TRK-PROV-001 warn), de az event maga megy.
  if (payload.lead_provenance !== undefined && !isValidProvenance(payload.lead_provenance)) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.INVALID_LEAD_PROVENANCE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.INVALID_LEAD_PROVENANCE],
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    payload.lead_provenance = undefined;
  }

  // lead_id — ugyanaz a drop-nem-reject szabály, mint a lead_provenance-nél: a
  // join-kulcs formátumhibája (pl. a CRM rövid/numerikus id-t adott) NEM nyelheti
  // el magát a konverziót. Érvénytelen → mező eldobva (warn), az event megy.
  if (payload.lead_id !== undefined && !isValidLeadId(payload.lead_id)) {
    logStructured({
      level: 'warn',
      message: 'lead_id dropped — invalid format (8-64 chars of [A-Za-z0-9_-]); event proceeds without CRM join key',
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    payload.lead_id = undefined;
  }

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.NO_SITE_CONFIG,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.NO_SITE_CONFIG],
      hostname,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    recordConversionMetric(env, {
      hostname,
      site_id: 'unknown',
      event_name: payload.event_name,
      accepted: false,
      error_code: TrackingErrorCode.NO_SITE_CONFIG,
      total_duration_ms: Date.now() - startedAt
    });
    return new Response('Not configured', { status: 404, headers: cors });
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;

  // ── Szerver-szerver ingress: a Turnstile ALTERNATÍVÁJA (nem megkerülése) ────
  // A site saját backendje (Astro lead-endpoint) a `X-Admin-Token`-nel hitelesíti
  // magát, a site KV-jében tárolt `crm_token_sha256` ellen (ugyanaz a per-site
  // tenant-határ, mint a /lead-status-on — lásd lib/admin-auth.ts). Ott nincs
  // böngésző, tehát Turnstile-token sem lehet; enélkül a szerveroldali lead-láb
  // sosem tudna konverziót küldeni.
  //
  // A böngésző-ág (token nélküli/érvénytelen POST) posture-je VÁLTOZATLAN: aki
  // nem hoz érvényes per-site tokent, az pontosan a régi Turnstile-kapun megy át.
  const serverAuth = await authenticateServerIngress(request, siteConfig);

  // A szerver-only útvonalon (WAF-mentesített) a hiányzó token ugyanolyan
  // elutasítás, mint a rossz: ide böngésző NEM léphet be, különben a
  // rate-limit-kivétel megkerülhető lenne egy hamisított Origin-nel.
  const serverOnlyReject = options.serverOnly && serverAuth !== 'valid';

  if (serverAuth === 'invalid' || serverOnlyReject) {
    // Jelen lévő, de rossz token → 401. NEM esünk vissza a böngésző-ágra: az
    // elnyelné a misconfigot (rossz secret → csendes „forbidden origin"-ként).
    //
    // Itt limitelünk: a token JELENLÉTE fentebb kihagyta a rate limitet (hogy a
    // hitelesített money-path ne akadjon fenn rajta), tehát a token-találgatás
    // különben ingyen lenne. Így a bypass ára egy 401 + limit.
    if (!(await ingestRateLimit(env, hostname, request))) {
      return rateLimited(env, hostname, cors, startedAt);
    }
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED],
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    recordConversionMetric(env, {
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      accepted: false,
      error_code: TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED,
      total_duration_ms: Date.now() - startedAt
    });
    return new Response('Unauthorized', { status: 401, headers: cors });
  }
  const serverIngress = serverAuth === 'valid';

  // ── Böngésző-ág: Origin allow-list (a Turnstile HELYÉN) ────────────────────
  // A Turnstile-kapu kikerült a gateway-ből: a secret a Cloudflare *teszt*-kulcsa
  // volt, ami MINDEN tokenre `success:true`-t ad — vagyis nulla védelmet adott,
  // miközben a valódi konverziókat rendszeresen elnyelte (lásd a PR leírását).
  // A helyére az Origin allow-list lép, ez a böngésző-ág elsődleges kontrollja.
  //
  // Amit ad: egy idegen oldal nem tud a látogatói böngészőjéből konverziót lőni
  // ránk (a böngésző kötelezően a valódi Origin-t teszi rá, JS-ből nem hamisítható;
  // sendBeacon/no-cors CORS nélkül is ELINDULNA, tehát szerver-oldali ellenőrzés
  // nélkül ez nyitva állna). Amit NEM ad: védelmet curl/script ellen — azt a rate
  // limit + idempotencia + a spike-riasztás fedi. Lásd lib/origin.ts.
  //
  // A hitelesített szerver-ingress kimarad: ott nincs böngésző, tehát Origin sincs.
  if (!serverIngress) {
    const verdict = checkOrigin(request.headers.get('Origin'), hostname, siteConfig);
    if (verdict !== 'allowed') {
      const errorCode =
        verdict === 'missing'
          ? TrackingErrorCode.ORIGIN_MISSING
          : TrackingErrorCode.ORIGIN_NOT_ALLOWED;
      logStructured({
        level: verdict === 'missing' ? 'info' : 'warn',
        error_code: errorCode,
        message: ERROR_DESCRIPTIONS[errorCode],
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        duration_ms: Date.now() - startedAt
      });
      recordConversionMetric(env, {
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        accepted: false,
        error_code: errorCode,
        total_duration_ms: Date.now() - startedAt
      });
      return new Response('Forbidden origin', { status: 403, headers: cors });
    }

    // ── High-value gate: form/lead/purchase konverzió CSAK hitelesített szerver-
    // ingressen jöhet. Az Origin curl-ből hamisítható, és a Workers rate-limit
    // binding bizonyítottan nem throttle-olt (150+ kérés, nulla 429) — e nélkül
    // egy script tetszőleges hash-elt email/telefonnal hamisíthatna lead-eket.
    // Mindhárom élő site (painless, beautyflow, lomtalan) a backendjéből,
    // per-site tokennel dispatchel; a böngésző-Pixel ugyanazzal az event_id-vel
    // tüzel tovább → a Pixel/CAPI dedup érintetlen. A böngésző-út a low-risk
    // klikk-eventeké marad (tel/mailto/whatsapp/video).
    if (SERVER_INGRESS_ONLY_EVENTS.has(payload.event_name)) {
      const errorCode = TrackingErrorCode.HIGH_VALUE_EVENT_BROWSER_REJECTED;
      logStructured({
        level: 'warn',
        error_code: errorCode,
        message: ERROR_DESCRIPTIONS[errorCode],
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        duration_ms: Date.now() - startedAt
      });
      recordConversionMetric(env, {
        hostname,
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        accepted: false,
        error_code: errorCode,
        total_duration_ms: Date.now() - startedAt
      });
      return new Response('Server ingress required', { status: 403, headers: cors });
    }
  }

  const hashedUserData = await hashUserData(
    payload.user_data || {},
    siteConfig.country_code as CountryCode
  );

  // Szerver-ingressen a transport-IP/UA a HÍVÓ WORKERÉ, nem a végfelhasználóé —
  // ha ezt küldenénk a Metának, rossz geo + romló EMQ lenne (CLAUDE.md #2: az
  // ip/ua plain pass-through). Ezért hitelesített hívónál a body-ban átadott
  // valódi kliens-jeleket használjuk. Böngésző-ágon ezeket SZÁNDÉKOSAN eldobjuk:
  // ott a request-header az egyetlen igazságforrás (különben bárki spoofolna).
  const clientIp = serverIngress && payload.client_ip_address ? payload.client_ip_address : remoteIp;
  const userAgent =
    serverIngress && payload.client_user_agent
      ? payload.client_user_agent
      : request.headers.get('User-Agent') || undefined;

  // A Test-stream override ugyanebbe a bizalmi osztályba tartozik: KIZÁRÓLAG
  // hitelesített szerver-hívó terelhet a Meta Test stream-jébe. Böngésző-ágon
  // eldobjuk — különben bárki a Test stream-be küldhetné az oldal VALÓDI
  // konverzióit, ami néma ROAS-kiesés (a CLAUDE.md 17 hibája, kívülről kiváltva).
  if (!serverIngress) {
    payload.test_event_code = undefined;
  }

  // Consent feloldása (Consent Mode v2). adAllowed=false → Meta + Google Ads
  // konverzió tiltva (GDPR). GA4 mindig megy, consent-jelekkel.
  const consentState = parseConsent(payload.consent);
  const consentDecision = resolveConsent(consentState, siteConfig.require_consent === true);
  const attribution = parseAttribution(payload.attribution);

  // A quote-state Durable Object (60 perces halasztott Lead + upgrade-öröklés)
  // KIKAPCSOLVA (Run 6): az alarm némán ejthetett state-et, és üzleti indoka nem
  // volt — egy event jelentését írta át utólag. A quote_calculator_submitted most
  // azonnal fan-outol; a böngésző-Pixel ugyanazzal az event_id-vel tüzel → dedup ép.
  const leadId = typeof payload.lead_id === 'string' ? payload.lead_id : undefined;

  // Gateway-ingress idempotencia (NEM vendor-dedup): ugyanaz a submit 5× (dupla
  // klikk, retry, hálózati gond) → a fan-out csak egyszer fut. Fail-open: D1-hiba
  // vagy hiányzó binding esetén dispatch-elünk. A kliens felé mindkét esetben 204.
  const idem = await checkIdempotency(
    env,
    siteConfig.site_id,
    payload.event_name,
    payload.event_id
  );
  if (!idem.shouldDispatch) {
    const dupDuration = Date.now() - startedAt;
    recordConversionMetric(env, {
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      accepted: true,
      total_duration_ms: dupDuration
    });
    logStructured({
      level: 'info',
      message: 'Duplicate conversion suppressed by idempotency',
      hostname,
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      seen_count: idem.seenCount,
      duration_ms: dupDuration
    });
    return new Response(null, { status: 204, headers: cors });
  }

  fanOut(
    payload,
    siteConfig,
    hashedUserData,
    hostname,
    clientIp,
    userAgent,
    consentDecision,
    attribution,
    leadId,
    env,
    ctx
  );

  const totalDuration = Date.now() - startedAt;
  recordConversionMetric(env, {
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    accepted: true,
    total_duration_ms: totalDuration
  });

  logStructured({
    level: 'info',
    message: 'Conversion event accepted',
    // A szerver-ingressen elfogadott eventet KÜLÖN kódon logoljuk: enélkül nem
    // lehetne megkülönböztetni a böngésző-ágtól, és pont az új út némulása
    // maradna láthatatlan (ez volt a 2026-06→07 néma kiesés tanulsága).
    ...(serverIngress
      ? { error_code: TrackingErrorCode.SERVER_INGRESS_ACCEPTED, server_ingress: true }
      : {}),
    hostname,
    site_id: siteConfig.site_id,
    event_name: payload.event_name,
    duration_ms: totalDuration
  });

  return new Response(null, { status: 204, headers: cors });
}

function fanOut(
  payload: ConversionRequestPayload,
  siteConfig: SiteConfig,
  hashedUserData: HashedUserData,
  hostname: string,
  clientIp: string | undefined,
  userAgent: string | undefined,
  consentDecision: ConsentDecision,
  attribution: AttributionParams | undefined,
  leadId: string | undefined,
  env: Env,
  ctx: ExecutionContext
): void {
  try {
  const adAllowed = consentDecision.adAllowed;

  // Meta fbc: a kliens _fbc cookie-ja elsődleges; ha nincs, fbclid-ből építjük.
  const fbc = payload.fbc || buildFbcFromFbclid(attribution?.fbclid, payload.event_time);

  // Ledger: az elfogadott event nyers rekordja + consent receipt (NEM PII;
  // csak az `em/ph` jelenléti flag-ek a match-quality audithoz). Fire-and-forget.
  ctx.waitUntil(
    recordEventRaw(env, {
      event_id: payload.event_id,
      lead_id: leadId,
      site_id: siteConfig.site_id,
      hostname,
      event_name: payload.event_name,
      event_time: payload.event_time,
      value: payload.value,
      currency: payload.currency,
      ad_allowed: adAllowed,
      em_present: Boolean(hashedUserData.em),
      ph_present: Boolean(hashedUserData.ph),
      // A KÜLDÖTT fbc-t rögzítjük (cookie VAGY fbclid-ből épített) — a Meta ezt
      // kapja, tehát a match-minőséget is ez határozza meg.
      fbc_present: Boolean(fbc),
      fbp_present: Boolean(payload.fbp)
    })
  );
  ctx.waitUntil(
    recordConsentReceipt(env, {
      event_id: payload.event_id,
      lead_id: leadId,
      site_id: siteConfig.site_id,
      consent: consentDecision.consent,
      require_consent: siteConfig.require_consent === true,
      ad_allowed: adAllowed
    })
  );

  const metaPayload: MetaCAPIPayload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    source: payload.source,
    event_source_url: payload.event_source_url,
    fbp: payload.fbp,
    fbc,
    client_ip: clientIp,
    client_user_agent: userAgent,
    lead_provenance: payload.lead_provenance,
    // Böngésző-ágon ez már undefined (a route fentebb eldobta) — ide csak
    // hitelesített szerver-ingressről juthat érték.
    test_event_code: payload.test_event_code
  };

  // TASK 3 — click-ID forwarderek. A click ID-k a validált `attribution`
  // paraméterből jönnek (parseAttribution: charset + hossz-bound). Mind
  // opcionális; a forwarder no-op, ha a site nincs konfigurálva az adott
  // platformra VAGY hiányzik a click ID.
  const tiktokPayload: TikTokPayload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    event_source_url: payload.event_source_url,
    ttclid: attribution?.ttclid,
    client_ip: clientIp,
    client_user_agent: userAgent
  };
  const linkedinPayload: LinkedInPayload = {
    event_name: payload.event_name,
    event_id: payload.event_id,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    li_fat_id: attribution?.li_fat_id
  };
  const msadsPayload: MsAdsPayload = {
    event_name: payload.event_name,
    event_time: payload.event_time,
    value: payload.value,
    currency: payload.currency,
    msclkid: attribution?.msclkid
  };

  // adAllowed=false → minden ad-platform no-op success (nincs hívás, nincs DLQ).
  // Modell 2: NINCS GA4 és NINCS Google Ads on-site láb (a böngésző birtokolja).
  // A szerver a Google Adset kizárólag offline-ként küldi (routes/lead-status.ts).
  // Szándékos kimaradás (consent-tiltás VAGY nincs meta config) → `skipped: true`.
  // A flag NEM elhagyható: e nélkül a ledger 'accepted'-et írna vendor HTTP-státusz
  // nélkül — a lomtalan Meta-lába pont így nézett ki egészségesnek, miközben a
  // Meta semmit nem kapott (2026-07-14, D1 ledger). Lásd normalizeDelivery.
  const skippedResult = () =>
    Promise.resolve({
      success: true as const,
      skipped: true as const,
      skip_reason: 'consent_denied' as const
    });
  const metaStart = Date.now();
  // A `&& siteConfig.meta` szándékosan KIKERÜLT: a config-hiányt a sender jelzi
  // `not_configured` okkal, hogy a fan-out meg tudja különböztetni a
  // consent-tiltástól. Korábban a kettő ugyanabba a néma skipbe olvadt össze.
  const metaPromise: Promise<MetaCAPIResult> = adAllowed
    ? sendToMetaCAPI(siteConfig, metaPayload, hashedUserData)
    : skippedResult();
  const tiktokStart = Date.now();
  const tiktokPromise: Promise<TikTokResult> = adAllowed
    ? sendToTikTok(siteConfig, tiktokPayload, hashedUserData)
    : skippedResult();
  const linkedinStart = Date.now();
  const linkedinPromise: Promise<LinkedInResult> = adAllowed
    ? sendToLinkedIn(siteConfig, linkedinPayload, hashedUserData)
    : skippedResult();
  const msadsStart = Date.now();
  const msadsPromise: Promise<MsAdsResult> = adAllowed
    ? sendToMsAds(siteConfig, msadsPayload, hashedUserData)
    : skippedResult();

  const fanout = Promise.allSettled([
    metaPromise,
    tiktokPromise,
    linkedinPromise,
    msadsPromise
  ]).then(
    async (results) => {
      const [metaResult, tiktokResult, linkedinResult, msadsResult] = results;
      const completedAt = Date.now();
      const nowIso = new Date(completedAt).toISOString();
      // Minden elem `true` = a retry-rekord biztosan tárolva (Queue vagy R2).
      const dlqWrites: Promise<boolean>[] = [];
      const alerts: Promise<void>[] = [];

      const handleResult = (
        platform: Platform,
        result: (typeof results)[number],
        platformPayload: Record<string, unknown>,
        includeUserData: boolean,
        platformStart: number
      ) => {
        const success =
          result.status === 'fulfilled' && result.value.success;
        const errorCode =
          result.status === 'fulfilled' ? result.value.error_code : undefined;

        recordFanoutMetric(env, {
          site_id: siteConfig.site_id,
          event_name: payload.event_name,
          platform,
          success,
          duration_ms: completedAt - platformStart,
          error_code: errorCode
        });

        if (errorCode && ERROR_SEVERITY[errorCode] === 'critical') {
          alerts.push(
            sendAlert(env, errorCode, {
              site_id: siteConfig.site_id,
              hostname,
              platform,
              event_name: payload.event_name
            })
          );
        }

        // ── Skip-osztályozás ────────────────────────────────────────────────
        // Három eset, három kimenet (lásd lib/skip-reason.ts). A `skipped` flag
        // önmagában NEM elég: 2026-07-15 és 07-20 között a lomtalan hiányzó Meta
        // configja pontosan úgy nézett ki, mint egy jogos consent-kihagyás, így
        // 3 valódi lead veszett el retry-rekord nélkül, zöld monitor mellett.
        const skipped =
          result.status === 'fulfilled' && result.value.skipped === true;
        if (skipped) {
          const skipReason = result.value.skip_reason;
          // (a) consent_denied / no-identifier / scaffold → terminális, nincs DLQ.
          if (isTerminalSkip(skipReason)) return;
          // (b) not_configured, de a platform nem is elvárt ezen a site-on
          //     (pl. TikTok egy csak-Meta site-on) → szintén terminális. Az okot
          //     `not_expected`-re minősítjük, hogy a ledger NE kapjon
          //     PLATFORM_NOT_CONFIGURED hibakódot: egy sosem-bekötött platform
          //     nem hiba, és ha kódot kapna, a digest tele lenne álriasztással.
          //     A minősítés a normalizeDelivery ELŐTT történik (lásd lentebb).
          if (!isExpectedPlatform(siteConfig, platform)) {
            result.value.skip_reason = 'not_expected';
            return;
          }
          // (c) ELVÁRT platform + hiányzó config → retryable konfigurációs blokk.
          //     Ez az egyetlen skip, ami DLQ-rekordot és CRITICAL riasztást kap:
          //     magától soha nem javul meg, viszont a config helyreállítása után
          //     az EREDETI event_id-vel és event_time-mal újrajátszható.
          logStructured({
            level: 'error',
            error_code: TrackingErrorCode.PLATFORM_NOT_CONFIGURED,
            message: ERROR_DESCRIPTIONS[TrackingErrorCode.PLATFORM_NOT_CONFIGURED],
            site_id: siteConfig.site_id,
            hostname,
            platform,
            event_name: payload.event_name
          });
          alerts.push(
            sendAlert(env, TrackingErrorCode.PLATFORM_NOT_CONFIGURED, {
              site_id: siteConfig.site_id,
              hostname,
              platform,
              event_name: payload.event_name
            })
          );
          dlqWrites.push(
            enqueueFailure(env, {
              platform,
              site_id: siteConfig.site_id,
              hostname,
              lead_id: leadId,
              event_payload: platformPayload,
              hashed_user_data: includeUserData
                ? (hashedUserData as unknown as Record<string, unknown>)
                : undefined,
              failure_reason: `expected platform '${platform}' has no config block for this site`,
              // Konfigurációs blokk: a retry-keretet nem szabad percek alatt
              // elégetnie (lásd lib/deadletter.ts backoffSeconds/blocked flag).
              blocked_configuration: true,
              retry_count: 0,
              first_failed_at: nowIso,
              last_attempted_at: nowIso
            })
          );
          return;
        }

        if (success) return;
        const reason =
          result.status === 'rejected'
            ? String(result.reason)
            : result.value.error || 'unknown';
        dlqWrites.push(
          enqueueFailure(env, {
            platform,
            site_id: siteConfig.site_id,
            hostname,
            lead_id: leadId,
            event_payload: platformPayload,
            hashed_user_data: includeUserData
              ? (hashedUserData as unknown as Record<string, unknown>)
              : undefined,
            failure_reason: reason,
            retry_count: 0,
            first_failed_at: nowIso,
            last_attempted_at: nowIso
          })
        );
      };

      handleResult(
        'meta',
        metaResult,
        metaPayload as unknown as Record<string, unknown>,
        true,
        metaStart
      );
      // TASK 3 — extra platformok. TikTok/LinkedIn hashed user_data-t használ a
      // matcheléshez → includeUserData=true (DLQ-retry-hoz). Microsoft csak
      // msclkid → false.
      handleResult('tiktok', tiktokResult, tiktokPayload as unknown as Record<string, unknown>, true, tiktokStart);
      handleResult('linkedin', linkedinResult, linkedinPayload as unknown as Record<string, unknown>, true, linkedinStart);
      handleResult('msads', msadsResult, msadsPayload as unknown as Record<string, unknown>, false, msadsStart);

      // Normalizált vendor-kézbesítés a ledgerbe (#9). A 'skipped' státusz a vendor-
      // eredmény `skipped` flagjéből jön (consent-tiltás VAGY nem konfigurált
      // platform) — a három állapot (accepted/skipped/rejected) így megkülönböztetett.
      const deliveryRecords: DeliveryRecord[] = [
        normalizeDelivery('meta', metaResult),
        normalizeDelivery('tiktok', tiktokResult),
        normalizeDelivery('linkedin', linkedinResult),
        normalizeDelivery('msads', msadsResult)
      ];

      // Külön settled a dlqWrites-ra: CSAK ezek eredménye táplálja a
      // retryPersistFailed döntést — egy alert- vagy ledger-írás hibája nem
      // blokkolhatja a markDispatched-et.
      const dlqOutcomes = await Promise.allSettled(dlqWrites);
      await Promise.allSettled([
        ...alerts,
        recordDeliveries(env, {
          event_id: payload.event_id,
          lead_id: leadId,
          site_id: siteConfig.site_id,
          event_name: payload.event_name,
          origin: 'fanout',
          records: deliveryRecords
        })
      ]);

      // Hármas kiesés őre: platform-hiba + a retry-rekord SEHOL nem landolt
      // (Queue send ÉS R2 write is elbukott). Ilyenkor NEM jelölünk dispatched-et
      // — a flag 0 marad, és TRK-900-007 CRITICAL riasztás megy. FONTOS őszintén:
      // a hívó ekkorra már 204-et kapott (a fan-out a válasz UTÁN, waitUntil-ben
      // fut), tehát automatikus kliens-retry NEM jön — a visszanyerés útja a
      // riasztás nyomán kézi újraküldés (a dispatched=0 pont ezt hagyja nyitva;
      // a vendorok event_id-vel dedup-olnak). Ha dispatched=1-et írnánk, még a
      // kézi replay-t is elnyelné az idempotencia.
      const retryPersistFailed = dlqOutcomes.some(
        (o) => o.status === 'rejected' || o.value !== true
      );
      if (retryPersistFailed) {
        logStructured({
          level: 'error',
          error_code: TrackingErrorCode.RETRY_PERSIST_FAILED,
          message: ERROR_DESCRIPTIONS[TrackingErrorCode.RETRY_PERSIST_FAILED],
          site_id: siteConfig.site_id,
          hostname,
          event_name: payload.event_name
        });
        await sendAlert(env, TrackingErrorCode.RETRY_PERSIST_FAILED, {
          site_id: siteConfig.site_id,
          hostname,
          platform: 'dlq',
          event_name: payload.event_name
        }).catch(() => {});
      } else {
        // A fan-out lefutott ÉS minden bukott platformnak van tárolt retry-példánya
        // → jelölhetjük kézbesítettnek (idempotencia). Csak ezután, hogy egy
        // crash-elt, soha-le-nem-kézbesített event újraküldhető maradjon.
        await markDispatched(env, siteConfig.site_id, payload.event_name, payload.event_id);
      }

      logStructured({
        level: 'info',
        message: 'Fan-out completed',
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
        tiktok_success: tiktokResult.status === 'fulfilled' && tiktokResult.value.success,
        linkedin_success: linkedinResult.status === 'fulfilled' && linkedinResult.value.success,
        msads_success: msadsResult.status === 'fulfilled' && msadsResult.value.success,
        platforms_failed: dlqWrites.length
      });
    }
  );

  ctx.waitUntil(fanout);
  } catch (setupErr) {
    // A fan-out SZINKRON felépítése dobott (rendkívül ritka — pure payload-építés).
    // A platform-hívások amúgy is Promise.allSettled+DLQ mögött vannak; ide csak egy
    // váratlan setup-hiba juthat. Ne némán: CRITICAL log + alert, hogy az event ne
    // tűnjön el nyom nélkül (a top-level catch különben 204-et adna némán).
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.FANOUT_SETUP_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.FANOUT_SETUP_FAILED],
      site_id: siteConfig.site_id,
      hostname,
      event_name: payload.event_name,
      error: setupErr instanceof Error ? setupErr.message : String(setupErr)
    });
    ctx.waitUntil(
      sendAlert(env, TrackingErrorCode.FANOUT_SETUP_FAILED, {
        site_id: siteConfig.site_id,
        hostname,
        event_name: payload.event_name
      })
    );
  }
}
