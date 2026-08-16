/**
 * Strips PII patterns from upstream API error messages before logging.
 * Per CLAUDE.md rule 13: NEVER log user_data, even after hashing.
 * Meta and Google Ads sometimes echo submitted values in error responses.
 *
 * Másodlagos védvonal (defense-in-depth): az ELSŐDLEGES szabály, hogy a hívók ne
 * logoljanak nyers vendor-body-t. Név/város szabad szöveg, regexszel nem fogható
 * megbízhatóan — ezeknél a structured log mezőkre (error_code + status) kell
 * hagyatkozni, nem erre a sanitizerre.
 */
/** Rövid, ember által olvasható hibaüzenet felső határa (alapértelmezés). */
export const ERROR_MESSAGE_MAX_LEN = 200;

/**
 * Strukturált vendor-hibarészlet (pl. Data Manager `error.details[]`) felső
 * határa. A 200 karakteres alapérték pont a hasznos rész ELŐTT vágott: a
 * Data Manager a `fieldViolations` tömbben mondja meg, MELYIK mező rossz, és
 * az a generikus "There was a problem with the request." + ErrorInfo-fejléc
 * után kezdődik. 10 db trapezlemezes `INVALID_ARGUMENT` volt így
 * diagnosztizálhatatlan (2026-08-11).
 */
export const VENDOR_DETAIL_MAX_LEN = 4000;

export function sanitizeErrorMessage(
  msg: string | undefined,
  maxLen: number = ERROR_MESSAGE_MAX_LEN
): string {
  if (!msg) return 'unknown';
  return msg
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,18}\d/g, '[phone]')
    // Echo-zott SHA-256 (vagy más hosszú hex) is user_data — a #13 a hashed
    // értéket is tiltja logolni. 32+ hex karakter → [hash].
    // FIGYELEM: ez a maszkolás a nagyobb maxLen mellett is fut — a
    // fieldViolations mezőnevek és leírások megmaradnak, a hashelt
    // identifierek nem.
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hash]')
    .slice(0, maxLen);
}
