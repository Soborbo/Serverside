import type { Env } from '../env';
import type { SiteConfig } from './config';
import { type HashedUserData, normalizePostalCode, normalizeCountry } from './hash';
import type { ConsentState } from './consent';
import { getAccessTokenDetailed } from './gads-oauth';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage, VENDOR_DETAIL_MAX_LEN } from './log-sanitize';
import type { GAdsPayload, GAdsResult } from './gads';

/**
 * Google Data Manager API transport — the migration target for the legacy
 * Google Ads `uploadClickConversions` leg (see lib/gads.ts).
 *
 * Why: as of 2026-06-15 the Google Ads API blocks NEW adopters of
 * uploadClickConversions (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE). The Data
 * Manager API is the self-serve replacement — NO developer token, OAuth
 * `datamanager` scope only. Under Model 2 the server is Google-Ads-offline-only
 * (Enhanced Conversions for Leads), so this is the single Google Ads path.
 *
 * Drop-in: same (payload, hashedUserData) → GAdsResult shape as
 * sendToGoogleAdsCAPI, so the lead-status.ts wiring + ledger normalizeDelivery
 * ('gads') stay unchanged.
 *
 * CRITICAL platform differences vs uploadClickConversions:
 *  - eventTimestamp is RFC3339 (`...T...Z`), NOT the CLAUDE.md Rule 6
 *    "YYYY-MM-DD HH:MM:SS+00:00" format.
 *  - the hashed email MUST be Google-normalized (Gmail dot/plus stripped) —
 *    the caller passes hashUserDataForGoogle, NOT hashUserData (Meta's rule).
 *  - consent enum is CONSENT_GRANTED / CONSENT_DENIED, not GRANTED / DENIED.
 *  - no `developer-token` header; login_customer_id goes in loginAccount, not a header.
 *  - address: givenName/familyName HASHED; regionCode/postalCode PLAIN (Rule 7 holds).
 */

const DATAMANAGER_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';
const DATAMANAGER_API_TIMEOUT_MS = 5000;
const DATAMANAGER_ACCOUNT_TYPE = 'GOOGLE_ADS';

/**
 * Vendor-hiba OSZTÁLYOZÁSA — a retryability miatt, nem esztétikából.
 *
 * A korábbi változat egyetlen `warning` súlyú kódba (`DATAMANAGER_API_REJECTED`)
 * gyűjtött minden 4xx-et ÉS 5xx-et. Következmény: a ledgerben egy Google-oldali
 * kiesés megkülönböztethetetlen volt egy véglegesen rossz payloadtól, holott az
 * egyik RETRYABLE, a másik TERMINAL — a retry-logika és a riasztás is rossz
 * döntést hozott rájuk.
 *
 * A `details` is bemenet, nem csak a `message`: a Google felső szintű üzenete
 * generikus („There was a problem with the request."), az érdemi ok — az
 * `ErrorInfo.reason`, a `fieldViolations` — a `details[]`-ben van. Ezért futott
 * a `NOT_ALLOWLISTED` felismerés eddig szinte mindig mellé.
 */
export function classifyError(
  status: number,
  apiMessage: string | undefined,
  details?: unknown
): TrackingErrorCode {
  if (status === 401) return TrackingErrorCode.DATAMANAGER_AUTH_REJECTED;
  // 403 ≠ 401. A 401 lejárt tokent jelent (magától megoldódik a refreshsel), a
  // 403 hiányzó scope-ot vagy fiók-hozzáférést — ez operátori teendő.
  if (status === 403) return TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED;
  if (status === 429) return TrackingErrorCode.DATAMANAGER_RATE_LIMITED;

  const haystack = [apiMessage ?? '', details !== undefined ? safeJson(details) : ''].join(' ');

  if (/not.?allowlisted|NOT_ALLOWLISTED/i.test(haystack))
    return TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED;

  if (status >= 500) return TrackingErrorCode.DATAMANAGER_SERVER_ERROR;

  if (
    status === 400 &&
    /INVALID_ARGUMENT|fieldViolations|BadRequest|VALIDATION/i.test(haystack)
  ) {
    return TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED;
  }

  return TrackingErrorCode.DATAMANAGER_API_REJECTED;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Klikk-azonosító alaki ellenőrzés.
 *
 * MIÉRT KELL. A klikk-ID a CRM-ből érkezik, ahol egy elrontott mentés
 * ('undefined', csonka URL-részlet, idézőjelek) simán bekerülhet. Egy szemét
 * gclid nem CSAK azt a mezőt rontja el: a Data Manager az EGÉSZ eventet
 * elutasítja 400-zal, tehát egy rossz karakter miatt olyan konverzió vész el,
 * amit a hashelt identity amúgy párosítana. Ezért a hibás azonosítót ELDOBJUK
 * (hangosan), és az event a többi jellel megy fel.
 *
 * A minta szándékosan megengedő: a Google nem publikál pontos formátumot, így
 * csak a nyilvánvalóan hibásat zárjuk ki (üres, túl rövid, nem base64url-szerű,
 * túl hosszú).
 */
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{10,512}$/;

export function isValidClickId(value: string): boolean {
  return CLICK_ID_PATTERN.test(value);
}

// Google Consent Mode signal → Data Manager Consent enum. Anything that is not
// an explicit GRANTED/DENIED is omitted (the field defaults to unspecified).
function mapConsentSignal(signal: ConsentState['ad_user_data']): string | undefined {
  if (signal === 'GRANTED') return 'CONSENT_GRANTED';
  if (signal === 'DENIED') return 'CONSENT_DENIED';
  return undefined;
}

// Unix seconds → RFC3339 with second precision (e.g. "2026-06-10T20:07:01Z").
// Drops the milliseconds toISOString() always appends, to match the documented
// Data Manager sample exactly.
function toRfc3339Seconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function sendToDataManager(
  siteConfig: SiteConfig,
  env: Env,
  payload: GAdsPayload,
  hashedUserData: HashedUserData
): Promise<GAdsResult> {
  const startedAt = Date.now();

  // Skip-ágak: `skipped: true` KÖTELEZŐ. Enélkül a hívó (lead-status) sikeres
  // uploadnak könyvelné (`uploaded_to_gads: true`) azt, ami el sem indult, és a
  // ledger 'accepted'-et írna vendor HTTP-státusz nélkül.
  const customerId = siteConfig.gads?.customer_id;
  if (!customerId) {
    return {
      success: true,
      skipped: true,
      error_code: TrackingErrorCode.PLATFORM_NOT_CONFIGURED
    };
  }

  const conversionActionId = siteConfig.gads?.conversion_actions?.[payload.event_name];
  if (!conversionActionId) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.MISSING_CONVERSION_ACTION,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.MISSING_CONVERSION_ACTION],
      site_id: siteConfig.site_id,
      event_name: payload.event_name
    });
    return {
      success: true,
      skipped: true,
      error_code: TrackingErrorCode.MISSING_CONVERSION_ACTION
    };
  }

  // A KONKRÉT OK utazik tovább a ledgerbe (hiányzó secret / visszavont
  // hozzájárulás / Google-outage / időtúllépés), nem egy „nincs token" gyűjtő.
  const tokenResult = await getAccessTokenDetailed(customerId, env);
  if ('error_code' in tokenResult) {
    return {
      success: false,
      error_code: tokenResult.error_code,
      error: tokenResult.error
    };
  }
  const accessToken = tokenResult.accessToken;

  // --- userData.userIdentifiers -------------------------------------------
  const userIdentifiers: Record<string, unknown>[] = [];
  if (hashedUserData.em) userIdentifiers.push({ emailAddress: hashedUserData.em });
  if (hashedUserData.ph) userIdentifiers.push({ phoneNumber: hashedUserData.ph });

  // address is matched "all at once" — only worth sending when we have the
  // hashed name parts (parity with the legacy addressInfo behaviour). region/
  // postal are PLAIN (CLAUDE.md Rule 7 holds for the Data Manager too).
  if (hashedUserData.fn || hashedUserData.ln) {
    const address: Record<string, unknown> = {};
    if (hashedUserData.fn) address.givenName = hashedUserData.fn;
    if (hashedUserData.ln) address.familyName = hashedUserData.ln;
    const region = normalizeCountry(payload.country) || normalizeCountry(siteConfig.country_code);
    if (region) address.regionCode = region.toUpperCase();
    const zp = normalizePostalCode(payload.postal_code);
    if (zp) address.postalCode = zp;
    userIdentifiers.push({ address });
  }

  // --- event ---------------------------------------------------------------
  const event: Record<string, unknown> = {
    transactionId: payload.event_id,
    eventTimestamp: toRfc3339Seconds(payload.event_time),
    eventSource: 'WEB'
  };

  // Click ID — exactly one, by priority. At CRM/offline time it's usually
  // absent (ECL matches via hashed PII), but forward it if present.
  //
  // ALAKILAG ELLENŐRIZVE: egy szemét klikk-ID az EGÉSZ eventet 400-ba viszi, és
  // vele veszne a hashelt identity párosítása is. A hibásat eldobjuk — hangosan.
  for (const [kind, raw] of [
    ['gclid', payload.gclid],
    ['gbraid', payload.gbraid],
    ['wbraid', payload.wbraid]
  ] as const) {
    if (!raw) continue;
    if (!isValidClickId(raw)) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.DATAMANAGER_INVALID_CLICK_ID,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.DATAMANAGER_INVALID_CLICK_ID],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        click_id_kind: kind,
        // Az értéket NEM logoljuk (klikk-azonosító), csak a hosszát — annyi
        // elég a diagnózishoz („üres" vs „csonka" vs „egy egész URL").
        click_id_length: raw.length
      });
      continue;
    }
    event.adIdentifiers = { [kind]: raw };
    break;
  }

  // CLAUDE.md Rule 3: never send value:0 — omit the field entirely.
  if (typeof payload.value === 'number' && payload.value > 0) {
    event.conversionValue = payload.value;
  }
  // currency CSAK conversionValue mellett — érték nélküli currency-t a Data
  // Manager validáció elutasíthatja, és önmagában értelme sincs.
  if (payload.currency && event.conversionValue !== undefined) {
    event.currency = payload.currency;
  }

  if (userIdentifiers.length > 0) event.userData = { userIdentifiers };

  // A Data Manager eventenként LEGALÁBB EGY azonosítót követel (userData vagy
  // adIdentifiers). Enélkül a hívás determinisztikus 400 — PERMANENS hiba, amit
  // a DLQ-retry sosem nyerne vissza, csak zajt termelne. Skip-success, mint a
  // MISSING_CONVERSION_ACTION eset.
  if (userIdentifiers.length === 0 && !event.adIdentifiers) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS],
      site_id: siteConfig.site_id,
      event_name: payload.event_name
    });
    return {
      success: true,
      skipped: true,
      error_code: TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS
    };
  }

  if (payload.consent) {
    const consent: Record<string, string> = {};
    const adUserData = mapConsentSignal(payload.consent.ad_user_data);
    if (adUserData) consent.adUserData = adUserData;
    const adPersonalization = mapConsentSignal(payload.consent.ad_personalization);
    if (adPersonalization) consent.adPersonalization = adPersonalization;
    if (Object.keys(consent).length > 0) event.consent = consent;
  }

  // --- destination ---------------------------------------------------------
  const destination: Record<string, unknown> = {
    operatingAccount: {
      accountType: DATAMANAGER_ACCOUNT_TYPE,
      accountId: customerId
    },
    productDestinationId: conversionActionId
  };
  if (siteConfig.gads?.login_customer_id) {
    destination.loginAccount = {
      accountType: DATAMANAGER_ACCOUNT_TYPE,
      accountId: siteConfig.gads.login_customer_id
    };
  }

  const validateOnly = env.DATAMANAGER_VALIDATE_ONLY === '1';
  const body = {
    destinations: [destination],
    events: [event],
    encoding: 'HEX',
    validateOnly
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DATAMANAGER_API_TIMEOUT_MS);

  try {
    const response = await fetch(DATAMANAGER_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    // ŐRZÖTT parse, DE a kudarcot MEGJEGYEZZÜK.
    //
    // A korábbi `.catch(() => ({}))` egy értelmezhetetlen 2xx-választ üres
    // objektummá tett, ami végigcsúszott a siker-ágra: `accepted`,
    // `conversions_processed: 1`, http_status 200 — miközben FOGALMUNK SINCS,
    // rögzített-e a Google bármit. Ez a §17 „néma siker" tilalmának pontos
    // megsértése volt, ráadásul a money-path közepén.
    let parsedBody: unknown;
    let bodyParseFailed = false;
    try {
      parsedBody = await response.json();
    } catch {
      bodyParseFailed = true;
      parsedBody = {};
    }
    const responseBody = (
      parsedBody !== null && typeof parsedBody === 'object' ? parsedBody : {}
    ) as {
      requestId?: string;
      error?: { code?: number; message?: string; status?: string; details?: unknown[] };
    };
    // Egy 2xx, aminek a törzse nem objektum (pl. `"OK"` vagy `null`), ugyanolyan
    // ismeretlen állapot, mint a parse-hiba.
    if (!bodyParseFailed && response.ok && (parsedBody === null || typeof parsedBody !== 'object')) {
      bodyParseFailed = true;
    }

    if (response.ok && bodyParseFailed) {
      const code = TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE;
      logStructured({
        level: 'error',
        error_code: code,
        message: ERROR_DESCRIPTIONS[code],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        validate_only: validateOnly,
        duration_ms: Date.now() - startedAt
      });
      // FAIL-LOUD, nem fail-silent-success. A státuszt átadjuk, hogy a ledger
      // lássa: a vendor válaszolt — csak épp értelmezhetetlenül.
      return {
        success: false,
        error_code: code,
        error: 'unparseable Data Manager response body',
        status: response.status
      };
    }

    if (!response.ok || responseBody.error) {
      const errorCode = classifyError(
        response.status,
        responseBody.error?.message,
        responseBody.error?.details
      );
      const sanitizedError = sanitizeErrorMessage(responseBody.error?.message);
      // The top-level message is generic ("There was a problem with the request.").
      // The actionable per-field validation errors live in error.details[] — log a
      // capped, sanitized snapshot so a 400 is diagnosable without guessing.
      // A sanitizer alapértelmezett 200-as vágása pont a hasznos rész előtt
      // ért véget (a generikus message + ErrorInfo-fejléc elviszi), így a
      // `fieldViolations` — az EGYETLEN mező, ami megmondja MI a baj — sosem
      // került a ledgerbe. VENDOR_DETAIL_MAX_LEN mellett megmarad; a PII-
      // maszkolás (email/telefon/32+ hex → placeholder) változatlanul fut.
      const detailSnippet = responseBody.error?.details
        ? sanitizeErrorMessage(JSON.stringify(responseBody.error.details), VENDOR_DETAIL_MAX_LEN)
        : undefined;
      logStructured({
        level:
          errorCode === TrackingErrorCode.DATAMANAGER_AUTH_REJECTED ||
          errorCode === TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED ||
          errorCode === TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED
            ? 'error'
            : 'warn',
        error_code: errorCode,
        message: ERROR_DESCRIPTIONS[errorCode],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        dm_error: sanitizedError,
        dm_error_status: responseBody.error?.status,
        dm_error_details: detailSnippet,
        validate_only: validateOnly,
        duration_ms: Date.now() - startedAt
      });
      return {
        success: false,
        error_code: errorCode,
        error: sanitizedError,
        error_detail: detailSnippet,
        status: response.status
      };
    }

    logStructured({
      level: validateOnly ? 'warn' : 'info',
      error_code: validateOnly ? TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY : undefined,
      message: validateOnly
        ? 'Data Manager event VALIDATED ONLY — nothing was recorded (DATAMANAGER_VALIDATE_ONLY=1)'
        : 'Data Manager event ingested',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      request_id: responseBody.requestId,
      ec_identifiers_provided: userIdentifiers.length,
      validate_only: validateOnly,
      duration_ms: Date.now() - startedAt
    });
    // Validate-only üzemmódban a Google SEMMIT nem rögzített. Ha ezt sikeres
    // uploadnak könyvelnénk (`accepted` + uploaded_to_gads:true), a rendszer
    // csendben zöldet mutatna nulla valós konverzió fölött — pontosan a
    // §11-es „skip ≠ siker-kézbesítés" invariáns megsértése. Ezért `skipped`.
    if (validateOnly) {
      return {
        success: true,
        skipped: true,
        error_code: TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY,
        status: response.status
      };
    }
    // A sikeres Data Manager válasz `requestId`-t hordoz — ez a vendor-oldali
    // nyom, amivel egy vitatott upload utólag visszakereshető. A hiánya NEM
    // fokozza le a kézbesítést (a 2xx a vendor igazolása), de nem is nyeljük le.
    if (!responseBody.requestId) {
      const code = TrackingErrorCode.DATAMANAGER_RESPONSE_NO_REQUEST_ID;
      logStructured({
        level: 'warn',
        error_code: code,
        message: ERROR_DESCRIPTIONS[code],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status
      });
    }
    return {
      success: true,
      conversions_processed: 1,
      status: response.status
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.DATAMANAGER_API_TIMEOUT
      : TrackingErrorCode.DATAMANAGER_API_NETWORK_ERROR;
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
      error: isTimeout ? 'timeout' : errMsg
    };
  }
}
