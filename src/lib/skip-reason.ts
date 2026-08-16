/**
 * Skip-okok — miért maradt ki egy platform-hívás.
 *
 * A `skipped: true` önmagában NEM elég: a lomtalan 2026-07-15-i adatvesztés pont
 * abból állt, hogy egy KONFIGURÁCIÓS BLOKK ugyanúgy nézett ki, mint egy jogos
 * kihagyás (consent-tiltás). Mindkettő `skipped`-ként került a ledgerbe, mindkettő
 * `success: true`-t adott a fan-outnak → nem készült retry-rekord, és a
 * `markDispatched` is lefutott. Az eredmény: 3 valódi lead veszett el úgy, hogy a
 * monitor zöld maradt.
 *
 * A ledger-státusz mindhárom esetben 'skipped' marad (vendorhívás nem történt —
 * 'accepted' SOHA nem íródhat HTTP-státusz nélkül, lásd normalizeDelivery), de a
 * FELDOLGOZÁSI kimenet háromfelé válik:
 *
 * | ok                 | DLQ | markDispatched | riasztás |
 * |--------------------|-----|----------------|----------|
 * | consent_denied     | ✗   | ✓ (terminális) | —        |
 * | not_expected       | ✗   | ✓ (terminális) | —        |
 * | not_configured     | ✓   | ✓ ha a DLQ-írás sikerült | CRITICAL |
 * | invalid_identifier | ✓   | ✓ ha a DLQ-írás sikerült | CRITICAL |
 *
 * A `not_configured` és az `invalid_identifier` az EGYETLEN két retryable skip: a
 * config javítása után a DLQ-rekord újrajátszható az EREDETI event_id-vel és
 * event_time-mal. A kettő ugyanaz a kárkép (halott platform-láb, ami magától soha
 * nem javul meg), csak az egyiknél hiányzik a blokk, a másiknál formahibás a
 * benne lévő azonosító.
 */
export type SkipReason =
  /** Consent Mode v2: ad_allowed=false → GDPR-tiltás. Soha nem próbáljuk újra. */
  | 'consent_denied'
  /** A platform nincs konfigurálva ÉS nem is elvárt ezen a site-on (pl. TikTok). */
  | 'not_expected'
  /** A platform ELVÁRT, de a config-blokkja hiányzik → retryable konfigurációs blokk. */
  | 'not_configured'
  /**
   * A config-blokk MEGVAN, de a benne lévő azonosító alakja használhatatlan
   * (kitöltetlen `REPLACE_ME_*` placeholder, elgépelt vagy rossz típusú ID).
   *
   * Azért nem indul el a hívás, mert a Meta CAPI-nál a `pixel_id` az endpoint-URL
   * ÚTVONALÁBA kerül: egy formahibás érték nem validációs hibát ad, hanem a Graph
   * API objektumként próbálja feloldani (400 „Object with ID … does not exist").
   * Az agykontroll 2026-07-27 és 08-11 között 43 ilyen külső hívást futtatott el,
   * mire a hiba egyáltalán észrevehetővé vált — egy azonnali skip helyett.
   */
  | 'invalid_identifier';

/**
 * Terminális skip = nincs mit visszanyerni, a retry értelmetlen (vagy tilos).
 * A `not_configured` és az `invalid_identifier` az EGYETLEN két nem-terminális ok
 * — mindkettő KV-javítás után újrajátszható.
 *
 * A hiányzó ok (`undefined`) szándékosan TERMINÁLIS: a nem-migrált vagy egyedi
 * skip-ágak (LinkedIn „nincs matchelhető azonosító", Microsoft Ads scaffold-only
 * transport) így a régi, DLQ-mentes viselkedést tartják meg. Fail-safe irány:
 * inkább ne készüljön retry-rekord, mint hogy egy soha nem kézbesíthető event
 * örökre a DLQ-ban keringjen.
 */
export function isTerminalSkip(reason: SkipReason | undefined): boolean {
  return reason !== 'not_configured' && reason !== 'invalid_identifier';
}
