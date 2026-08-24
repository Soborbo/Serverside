import type { Env } from '../env';
import { logStructured } from '../types';
import { corsHeaders } from '../worker';
import { lookupSiteConfig } from '../lib/config';
import { checkOrigin } from '../lib/origin';
import {
  parseConsentPayload,
  parseConsentMetricPayload,
  isConsentProviderSbo
} from '../lib/consent-log';
import { recordConsentDecision, recordConsentMetric, getConsentState } from '../lib/ledger';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';

/**
 * Soborbo CMP · Fázis 1 — a saját consent-modul szerveroldala.
 *
 *   POST /api/consent              — egy döntés rögzítése (append-only)
 *   POST /api/consent/shown        — banner-megjelenés (ID-MENTES UX-mérés)
 *   GET  /api/consent/:consent_id  — az AKTUÁLIS állapot (legmagasabb revision)
 *
 * INERT, amíg a site `consent.provider`-e nem `'sbo'`. Minden más site-on a POST
 * 403-at ad: nem a mi CMP-nk fut ott, tehát tőle nem fogadunk el consent-proofot.
 *
 * ŐSZINTE STÁTUSZKÓDOK — ez a rendszer alapelve („a veszély a csend"), és itt
 * ELTÉR a böngésző-konverzió 204-étől (CLAUDE.md 12.):
 *
 *   204 = tényleg eltárolva, VAGY idempotens duplikátum (a kliens retry-ja)
 *   400 = hibás payload, MEGNEVEZETT okkal
 *   403 = rossz origin, vagy a site nem `provider='sbo'`
 *   429 = rate limit
 *   503 = D1/infra hiba → a kliens ŐRZI a döntést és újraküldi
 *
 * MIÉRT NEM 204 MINDENRE: a konverziós beacon 204-e azért helyes, mert a
 * sendBeacon úgysem olvas választ, és a kliens felé nem szivárogtatunk hibát. Egy
 * consent-döntésnél viszont a kliensnek TUDNIA KELL, hogy megérkezett-e — mert ha
 * nem, ő az egyetlen, aki még őrzi. Egy csendes 204 D1-hiba fölött azt jelentené,
 * hogy a consent-proof elveszett, és soha senki nem szerez róla tudomást.
 */

const MAX_BODY_BYTES = 4 * 1024;

/** A 204-en visszaadott fejléc — a kliens ebből tudja, hogy TÉNYLEG tárolva van. */
const RECEIVED_HEADER = { 'X-Consent-Received': '1' } as const;

async function readBody(request: Request): Promise<unknown | undefined> {
  const declared = request.headers.get('Content-Length');
  if (declared) {
    const len = parseInt(declared, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) return undefined;
  }
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function consentRateLimit(env: Env, hostname: string, request: Request): Promise<boolean> {
  const limiter = env.INGEST_LIMITER;
  if (!limiter) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    // Külön kulcstér a konverziós ingresstől: egy consent-döntés-hullám ne merítse
    // ki ugyanannak a látogatónak a konverzió-budgetjét (és fordítva).
    const { success } = await limiter.limit({ key: `consent:${hostname}:${ip}` });
    return success;
  } catch {
    return true;
  }
}

/**
 * A consent-útvonalak belépője. A worker.ts a `/api/consent`-tel KEZDŐDŐ
 * útvonalakat irányítja ide.
 */
export async function handleConsent(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;
  const cors = corsHeaders(request, env);

  // CLAUDE.md 14.: hostname-alapú site-feloldás, fallback-config SOHA.
  const { config: siteConfig, unavailable } = await lookupSiteConfig(hostname, env);
  if (!siteConfig) {
    // Tranziens KV-kiesés ≠ nem létező site — és egy consent-döntésnél ez a
    // különbség még többet nyom, mint a konverziónál: 404-re a kliens ELDOBNÁ a
    // pending receiptet („ez a site nem is létezik"), és a döntés bizonyítéka
    // véglegesen elveszne. 503 → megőrzi és újraküldi.
    if (unavailable) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.KV_READ_FAILED,
        message: 'Consent endpoint: site config lookup failed — 503 so the client retries',
        hostname,
        duration_ms: Date.now() - startedAt
      });
      return new Response('storage_unavailable', {
        status: 503,
        headers: { ...cors, 'Retry-After': '60' }
      });
    }
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.NO_SITE_CONFIG,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.NO_SITE_CONFIG],
      hostname,
      duration_ms: Date.now() - startedAt
    });
    return new Response('Not found', { status: 404, headers: cors });
  }

  // Origin allow-list — ez böngésző-ág, tehát ugyanaz a kontroll, mint a
  // konverziós beaconön (lib/origin.ts). Hiányzó Origin → fail-closed.
  const verdict = checkOrigin(request.headers.get('Origin'), hostname, siteConfig);
  if (verdict !== 'allowed') {
    logStructured({
      level: verdict === 'missing' ? 'info' : 'warn',
      error_code:
        verdict === 'missing'
          ? TrackingErrorCode.ORIGIN_MISSING
          : TrackingErrorCode.ORIGIN_NOT_ALLOWED,
      message: 'Consent endpoint: origin rejected',
      hostname,
      site_id: siteConfig.site_id,
      duration_ms: Date.now() - startedAt
    });
    return new Response('Forbidden origin', { status: 403, headers: cors });
  }

  if (!(await consentRateLimit(env, hostname, request))) {
    return new Response(null, { status: 429, headers: cors });
  }

  // ── A KAPCSOLÓ. A `provider` alapértéke MINDEN site-on 'cookieyes' → a Fázis 1
  // merge nulla viselkedésváltozás. Egy CookieYes-site-tól nem fogadunk el
  // consent-döntést: az ott nem a mi modulunkból jönne, tehát nem is bizonyítana
  // semmit, viszont a `consent_log`-ot szennyezné.
  if (!isConsentProviderSbo(siteConfig)) {
    logStructured({
      level: 'info',
      message: 'Consent endpoint: provider is not sbo, ignoring',
      hostname,
      site_id: siteConfig.site_id,
      duration_ms: Date.now() - startedAt
    });
    return new Response('Consent provider not enabled for this site', {
      status: 403,
      headers: cors
    });
  }

  const path = url.pathname.replace(/\/+$/, '');

  if (request.method === 'POST' && path === '/api/consent') {
    return await handleDecision(request, env, siteConfig.site_id, hostname, cors, startedAt);
  }
  if (request.method === 'POST' && path === '/api/consent/shown') {
    return await handleShown(request, env, siteConfig.site_id, hostname, cors, startedAt);
  }
  if (request.method === 'GET' && path.startsWith('/api/consent/')) {
    const consentId = decodeURIComponent(path.slice('/api/consent/'.length));
    return await handleLookup(env, siteConfig.site_id, consentId, cors);
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}

async function handleDecision(
  request: Request,
  env: Env,
  siteId: string,
  hostname: string,
  cors: HeadersInit,
  startedAt: number
): Promise<Response> {
  const body = await readBody(request);
  if (body === undefined) {
    return new Response('invalid_json_or_too_large', { status: 400, headers: cors });
  }

  const parsed = parseConsentPayload(body, siteId);
  if (!parsed.ok) {
    // A HIBAOK MEGNEVEZVE megy vissza és a logba. Egy csupasz „invalid payload"
    // mellett egy hónap múlva senki nem tudná megmondani, melyik banner-mező
    // romlott el — és a kliens vakon ismételné ugyanazt a hibás beacont.
    logStructured({
      level: 'warn',
      message: 'Consent payload rejected',
      hostname,
      site_id: siteId,
      reason: parsed.reason,
      duration_ms: Date.now() - startedAt
    });
    return new Response(parsed.reason, { status: 400, headers: cors });
  }

  const result = await recordConsentDecision(env, parsed.entry);

  if (result === 'failed') {
    // 503, NEM 204. A kliens `receipt_synced=false`-t tart és újraküldi ugyanazt a
    // `consent_event_id`-t a következő oldalletöltéskor; a duplikátumot a UNIQUE
    // index nyeli el. Csendes 204 = elveszett consent-proof, amiről senki nem tud.
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.LEDGER_WRITE_FAILED,
      message: 'Consent decision could not be stored',
      hostname,
      site_id: siteId,
      duration_ms: Date.now() - startedAt
    });
    return new Response('storage_unavailable', { status: 503, headers: cors });
  }

  logStructured({
    level: 'info',
    message: 'Consent decision recorded',
    hostname,
    site_id: siteId,
    decision: parsed.entry.decision,
    revision: parsed.entry.revision,
    duplicate: result === 'duplicate',
    // A `cky_agreement` a párhuzamos ablak fő mérőszáma — logban is látszik, hogy
    // a napi aggregátum előtt is észrevehető legyen egy szétcsúszás.
    cky_agreement: parsed.entry.cky_agreement ?? null,
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: { ...cors, ...RECEIVED_HEADER } });
}

async function handleShown(
  request: Request,
  env: Env,
  siteId: string,
  hostname: string,
  cors: HeadersInit,
  startedAt: number
): Promise<Response> {
  const body = await readBody(request);
  if (body === undefined) {
    return new Response('invalid_json_or_too_large', { status: 400, headers: cors });
  }

  const parsed = parseConsentMetricPayload(body, siteId);
  if (!parsed.ok) {
    // Az azonosítót hordozó megjelenés-ping ELUTASÍTOTT, nem megtisztított: a
    // banner megjelenésekor még nincs döntés, tehát egy consent_id ott
    // azonosító-gyűjtés lenne consent ELŐTT. A néma megtisztítás mellett a
    // kliens-bug hónapokig fennmaradna.
    logStructured({
      level: 'warn',
      message: 'Consent metric rejected',
      hostname,
      site_id: siteId,
      reason: parsed.reason,
      duration_ms: Date.now() - startedAt
    });
    return new Response(parsed.reason, { status: 400, headers: cors });
  }

  // UX-mérés: egy elvesztett sor nem indokol 5xx-et. A recordConsentMetric nyeli
  // a D1-hibát (és logolja) — a látogatónak ebből semmit nem kell látnia.
  await recordConsentMetric(env, parsed.entry);
  return new Response(null, { status: 204, headers: cors });
}

async function handleLookup(
  env: Env,
  siteId: string,
  consentId: string,
  cors: HeadersInit
): Promise<Response> {
  if (!consentId) return new Response('missing_consent_id', { status: 400, headers: cors });

  // A `site_id` a lekérdezés RÉSZE (ledger.getConsentState) — egy consent_id
  // ismerete nem adhat betekintést másik site rekordjába.
  const state = await getConsentState(env, siteId, consentId);
  if (!state) {
    // 404: nincs ilyen döntés ezen a site-on. A hívó (offline/replay ág) ezt a
    // meglévő, receipt-alapú szabályra visszaesésként kezeli — NEM tiltásként,
    // különben a CookieYes-flotta minden offline uploadja elakadna.
    return new Response('not_found', { status: 404, headers: cors });
  }

  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
