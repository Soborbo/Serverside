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
 *  - GA4: MINDIG elküldjük a consent-objektummal együtt; ha analytics_storage
 *    DENIED, a Google cookieless modellezést végez (nem mi gate-eljük ki).
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
  /** Mehet-e ad-platform konverzió (Meta CAPI + Google Ads). */
  adAllowed: boolean;
  /** Mehet-e GA4 esemény (gyakorlatilag mindig igen, consent-jelekkel). */
  analyticsAllowed: boolean;
  /** A normalizált consent-állapot a platformok felé továbbításhoz. */
  consent?: ConsentState;
}

export function resolveConsent(
  consent: ConsentState | undefined,
  requireConsent: boolean
): ConsentDecision {
  if (!consent) {
    // Nincs explicit consent jel a kliensről.
    return { adAllowed: !requireConsent, analyticsAllowed: true, consent: undefined };
  }
  const adAllowed = consent.ad_user_data !== 'DENIED';
  return { adAllowed, analyticsAllowed: true, consent };
}
