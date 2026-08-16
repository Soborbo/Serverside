import type { ConsentState } from './consent';
import type { TrackingErrorCode } from './error-codes';

/**
 * Google Ads offline-konverzió KONTRAKTUS (payload + eredmény típusok) + az API
 * major verzió.
 *
 * A LEGACY `uploadClickConversions` transport (sendToGoogleAdsCAPI) 2026-08-16-án
 * TÖRÖLVE lett ebből a fájlból. Miért:
 *  - 2026-06-15 óta a Google BLOKKOLJA az új adoptereket ezen a metóduson
 *    (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE) — mi új adopter vagyunk, tehát a
 *    kód a mi fiókjainkon SOHA nem tudott volna sikeresen lefutni.
 *  - A helyére lépő Data Manager API (lib/datamanager.ts) éles forgalomban
 *    validált (accepted delivery-sorok a D1 ledgerben), és a retry-út is azt hívja.
 *  - A fájl saját deprecation-jegyzete pontosan ezt a feltételt szabta a törléshez:
 *    „remove once the Data Manager path is validated in production".
 * A 230 sornyi halott transport megtartása azt kockáztatta, hogy egy jövőbeli hívó
 * véletlenül a nem működő úton küldjön. A git-történet megőrzi (lásd lib/gads.ts
 * a törlés előtti commitban).
 *
 * A típusok itt maradnak, mert a Data Manager transport, a lead-status route és a
 * retry-ág MIND ezeket használja — ez a Google-ág közös alakja.
 */

// Google Ads API major verzió. A REST-útvonal csak a MAJOR verziót tartalmazza
// (`/v24/`); a v24.x minor kiadások ugyanezen az úton mennek. 2026-06: v24 a
// legfrissebb major (v24.2 a legújabb minor), sunset ~2027 közepe.
// Exportált: a cross-check (lib/cross-check.ts) GAQL-lekérdezése ugyanezen a
// verzión megy — verzió-bump itt egy helyen történik.
export const GADS_API_VERSION = 'v24';

export interface GAdsPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  value?: number;
  currency?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  // Consent Mode v2 — EEA-attribúcióhoz erősen ajánlott. Ha hiányzik, a
  // konverzió lehet, hogy nem attribútálódik.
  consent?: ConsentState;
  // Google click ID-k. Pontosan EGY kerül a konverzióra (prioritás: gclid >
  // gbraid > wbraid). Az Enhanced Conversions for Leads (userIdentifiers)
  // emellett is mehet — a click ID a legerősebb attribúciós jel.
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
}

export interface GAdsResult {
  success: boolean;
  conversions_processed?: number;
  partial_failure_error?: string;
  error?: string;
  /**
   * Gépi olvasású vendor-hibarészlet (Data Manager `error.details[]`, benne a
   * `fieldViolations` tömbbel). Az `error` marad a rövid összefoglaló; ez a
   * mező a ledger `error_detail` oszlopába megy, hogy egy 400-as
   * INVALID_ARGUMENT találgatás nélkül diagnosztizálható legyen.
   */
  error_detail?: string;
  error_code?: TrackingErrorCode;
  status?: number;
  // true → a hívás szándékosan kimaradt (nincs customer_id / conversion action /
  // identifier). A hívó NEM könyvelheti valós uploadnak (lead-status, ledger).
  skipped?: boolean;
}
