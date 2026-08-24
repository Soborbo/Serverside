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
  /**
   * Consent Mode v2: EXPLICIT `ad_user_data: 'DENIED'` → GDPR-tiltás. Soha nem
   * próbáljuk újra. FONTOS: csak a kimondott elutasítás — a hiányzó vagy
   * bizonytalan consent külön okot kap (lásd lentebb), különben a Fázis D
   * mérése pont a kérdéses ágakat mosná össze a jogos tiltással.
   */
  | 'consent_denied'
  /** A platform nincs konfigurálva ÉS nem is elvárt ezen a site-on (pl. TikTok). */
  | 'not_expected'
  /** A platform ELVÁRT, de a config-blokkja hiányzik → retryable konfigurációs blokk. */
  | 'not_configured'
  // ── Fázis D (2026-08) — a skip-ágak megnevezése ────────────────────────────
  // A `not_configured` és az `invalid_identifier` kivételével mind TERMINÁLIS.
  /**
   * `require_consent: true` (fail-closed site), és a consent-jel nem GRANTED,
   * de nem is kimondott DENIED: az egész consent-objektum hiányzik, VAGY az
   * `ad_user_data` mező hiányzik/UNSPECIFIED. Ez a betöltési verseny (a
   * CookieYes szkript még nem töltött be, amikor az event elsült) várható
   * aláírása — épp ezért NEM olvad össze a `consent_denied`-del.
   */
  | 'consent_missing_failclosed'
  /**
   * Nincs consent-objektum ÉS a site fail-open (`require_consent !== true`) →
   * a régi, backward-compat szabály szerint az ad-platform ENGEDETT.
   *
   * Ma ezért NINCS producere a browser fan-outban: ahol ez a helyzet áll fenn,
   * ott skip sem történik (a hívás elmegy). Az enumban azért van benne, mert a
   * végleges terv (v4 §2.1) így rögzíti, és mert ha a `consent_strict` valaha a
   * hiányzó consentre is kiterjed, EZ az az ág, aminek külön nevet kell kapnia
   * — nem a `consent_denied`. Amíg nem terjed ki, a hiányzó-consent-fail-open
   * eset a receipten (source_used='none' + TRK-910-001) látszik, nem itt.
   */
  | 'consent_missing_legacy'
  /**
   * A consent BIZONYTALAN (parse-olhatatlan / a források ellentmondanak / a
   * jelek belül inkonzisztensek), ÉS a site `consent_strict: true`.
   * Bizonytalanból soha nem lesz GRANTED. Alapból KI van kapcsolva — lásd
   * lib/consent.ts `resolveConsentStrictness`.
   */
  | 'consent_uncertain_failclosed'
  /**
   * Van config, de egyetlen matchelhető azonosító sincs (LinkedIn: se hash-elt
   * email, se li_fat_id; Microsoft: nincs msclkid; Data Manager: se
   * userIdentifier, se click ID). NEM konfig-hiba → se retry, se CRITICAL:
   * a küldés maga lenne permanens 400.
   */
  | 'no_identifiers'
  /** A hívás egy már kézbesített/párhuzamos duplikátum miatt maradt ki. */
  | 'dedup'
  /** Régió-alapú policy-tiltás (EEA-szabály) zárta ki a platformot. */
  | 'eea_rule'
  /** A platform sablon-/payload-őre utasította el a küldést a hívás előtt. */
  | 'template_guard'
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
 * A perzisztálható skip-okok teljes listája — a `deliveries.skip_reason` oszlop
 * értelmezési tartománya. Futásidejű őr (`isSkipReason`) és tesztek használják;
 * a D1-ben nincs CHECK constraint, tehát ez a szűk keresztmetszet.
 */
export const SKIP_REASONS: readonly SkipReason[] = [
  'consent_denied',
  'not_expected',
  'not_configured',
  'consent_missing_failclosed',
  'consent_missing_legacy',
  'consent_uncertain_failclosed',
  'no_identifiers',
  'dedup',
  'eea_rule',
  'template_guard',
  'invalid_identifier'
];

export function isSkipReason(v: unknown): v is SkipReason {
  return typeof v === 'string' && (SKIP_REASONS as readonly string[]).includes(v);
}

/**
 * Terminális skip = nincs mit visszanyerni, a retry értelmetlen (vagy tilos).
 * A `not_configured` és az `invalid_identifier` a KÉT nem-terminális ok —
 * mindkettő KV-javítás után újrajátszható. A Fázis D-ben felvett okok MIND
 * terminálisak. Ha ez valaha megváltozik, a `not_expected` és a
 * `not_configured` szétválasztását (2026-07-15-i lomtalan-adatvesztés) akkor
 * SEM szabad összevonni.
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
