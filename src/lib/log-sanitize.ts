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
export function sanitizeErrorMessage(msg: string | undefined): string {
  if (!msg) return 'unknown';
  return msg
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,18}\d/g, '[phone]')
    // Echo-zott SHA-256 (vagy más hosszú hex) is user_data — a #13 a hashed
    // értéket is tiltja logolni. 32+ hex karakter → [hash].
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hash]')
    .slice(0, 200);
}
