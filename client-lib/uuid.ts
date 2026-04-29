/**
 * UUID v4 generálás. Használja a natív crypto.randomUUID-t HTTPS / localhost
 * alatt; egyébként Math.random fallback (kevésbé biztonságos, de Astro
 * ASTRO-FRONTEND-SPEC.md #8 megengedi non-secure contexts-re).
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
