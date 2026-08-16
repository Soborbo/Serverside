/**
 * Consent resolution for GDPR / Google Consent Mode v2 / Meta data use.
 *
 * A kliens egy `consent` objektumot küld (Google Consent Mode v2 jelek):
 *   { ad_user_data, ad_personalization, ad_storage, analytics_storage }
 * minden mező 'GRANTED' | 'DENIED' | 'UNSPECIFIED'.
 *
 * Szabályok (kutatás 2026-06 alapján):
 *  - Meta CAPI + Google Ads: ad-konverzió CSAK akkor mehet, ha `ad_user_data`
 *    nem DENIED. Meta hivatalos álláspont: nem-konszenzuáló EEA-felhasználónak
 *    EGYÁLTALÁN ne tüzelj CAPI-eventet (2026-02 drezdai ítélet: 1500 €/fő).
 *    A Google Ads ebben a kódban kizárólag Enhanced Conversions for Leads-szel
 *    megy (gclid nélkül) → ha PII-t nem küldhetünk, nincs azonosító → skip.
 *  - GA4: a gateway on-site GA4-et NEM küld (Modell 2, 2026-06-28 óta — a
 *    böngésző/GTM birtokolja, és a GA4 MP nem dedup-ol event_id-re, tehát a
 *    szerver-leg dupla konverziót adna). Ezért a consent-feloldásnak NINCS GA4-ága
 *    ezen az úton. A modul régi doksija itt még azt írta, hogy „GA4-et MINDIG
 *    elküldjük" — az a Modell 2 előtti állapot volt, és 2026-08-16-ig bent maradt
 *    félrevezető szövegként. (A GA4 Consent Mode-továbbítás logikája a lib/ga4.ts-ben
 *    ÉL és helyes; azt a modult ma a debug-endpoint és a legacy DLQ-ürítés hívja.)
 *
 * Backward-compat: ha a payloadban nincs `consent` ÉS a SiteConfig nem írja elő
 * (`require_consent !== true`), a régi viselkedést tartjuk → ad-platform engedett.
 */

export type ConsentSignal = 'GRANTED' | 'DENIED' | 'UNSPECIFIED';

export interface ConsentState {
  ad_user_data?: ConsentSignal;
  ad_personalization?: ConsentSignal;
  ad_storage?: ConsentSignal;
  analytics_storage?: ConsentSignal;
}

const VALID_SIGNALS: ReadonlySet<string> = new Set(['GRANTED', 'DENIED', 'UNSPECIFIED']);

/** Validál + normalizál egy nyers consent objektumot a payloadból. */
export function parseConsent(raw: unknown): ConsentState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pick = (v: unknown): ConsentSignal | undefined =>
    typeof v === 'string' && VALID_SIGNALS.has(v) ? (v as ConsentSignal) : undefined;
  const state: ConsentState = {
    ad_user_data: pick(r.ad_user_data),
    ad_personalization: pick(r.ad_personalization),
    ad_storage: pick(r.ad_storage),
    analytics_storage: pick(r.analytics_storage)
  };
  // Ha minden mező undefined, ne adjunk vissza üres objektumot.
  if (
    !state.ad_user_data &&
    !state.ad_personalization &&
    !state.ad_storage &&
    !state.analytics_storage
  ) {
    return undefined;
  }
  return state;
}

export interface ConsentDecision {
  /** Mehet-e ad-platform konverzió (Meta CAPI + a click-ID forwarderek). */
  adAllowed: boolean;
  /** A normalizált consent-állapot a platformok felé továbbításhoz. */
  consent?: ConsentState;
  // Az `analyticsAllowed` mező TÖRÖLVE (2026-08-16 audit): konstans `true` volt, és
  // a Modell 2 (2026-06-28) óta SEHOL nem olvasta senki — a gateway nem küld on-site
  // GA4-et, tehát nem volt mit kapuznia. Egy örökre igaz, sosem olvasott „engedély"
  // mező azt sugallja, hogy van egy analytics-kapu, ami valójában nem létezik.
}

export function resolveConsent(
  consent: ConsentState | undefined,
  requireConsent: boolean
): ConsentDecision {
  // Fail-closed (require_consent=true): ad-platform CSAK explicit
  //   ad_user_data === 'GRANTED' esetén. Hiányzó/UNSPECIFIED/DENIED → tiltva.
  //   FONTOS: ez akkor is érvényes, ha a kliens részleges consent objektumot
  //   küld (pl. csak analytics_storage) — különben a require_consent kapu
  //   megkerülhető lenne.
  // Fail-open (require_consent=false, backward-compat): csak az explicit
  //   ad_user_data === 'DENIED' tilt; minden más enged.
  if (requireConsent) {
    const adAllowed = consent?.ad_user_data === 'GRANTED';
    return { adAllowed, consent };
  }
  const adAllowed = consent?.ad_user_data !== 'DENIED';
  return { adAllowed, consent };
}
