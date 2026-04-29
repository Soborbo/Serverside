/**
 * Strips PII patterns from upstream API error messages before logging.
 * Per CLAUDE.md rule 13: NEVER log user_data, even after hashing.
 * Meta and Google Ads sometimes echo submitted values in error responses.
 */
export function sanitizeErrorMessage(msg: string | undefined): string {
  if (!msg) return 'unknown';
  return msg
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,18}\d/g, '[phone]')
    .slice(0, 200);
}
