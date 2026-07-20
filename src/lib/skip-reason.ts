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
 * | ok               | DLQ | markDispatched | riasztás |
 * |------------------|-----|----------------|----------|
 * | consent_denied   | ✗   | ✓ (terminális) | —        |
 * | not_expected     | ✗   | ✓ (terminális) | —        |
 * | not_configured   | ✓   | ✓ ha a DLQ-írás sikerült | CRITICAL |
 *
 * A `not_configured` az EGYETLEN retryable skip: a config helyreállítása után a
 * DLQ-rekord újrajátszható az EREDETI event_id-vel és event_time-mal.
 */
export type SkipReason =
  /** Consent Mode v2: ad_allowed=false → GDPR-tiltás. Soha nem próbáljuk újra. */
  | 'consent_denied'
  /** A platform nincs konfigurálva ÉS nem is elvárt ezen a site-on (pl. TikTok). */
  | 'not_expected'
  /** A platform ELVÁRT, de a config-blokkja hiányzik → retryable konfigurációs blokk. */
  | 'not_configured';

/**
 * Terminális skip = nincs mit visszanyerni, a retry értelmetlen (vagy tilos).
 * A `not_configured` az EGYETLEN nem-terminális ok.
 *
 * A hiányzó ok (`undefined`) szándékosan TERMINÁLIS: a nem-migrált vagy egyedi
 * skip-ágak (LinkedIn „nincs matchelhető azonosító", Microsoft Ads scaffold-only
 * transport) így a régi, DLQ-mentes viselkedést tartják meg. Fail-safe irány:
 * inkább ne készüljön retry-rekord, mint hogy egy soha nem kézbesíthető event
 * örökre a DLQ-ban keringjen.
 */
export function isTerminalSkip(reason: SkipReason | undefined): boolean {
  return reason !== 'not_configured';
}
