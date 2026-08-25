/**
 * Rekurzív patch-merge a SITE_CONFIG-hoz. `null` érték = a kulcs TÖRLÉSE; objektum
 * = mélyebb merge (bármilyen mélységben); minden más = csere.
 *
 * MIÉRT REKURZÍV: az eredeti egy szint mélyen merge-elt, ezért a
 * `{"gads":{"conversion_actions":{"lead_qualified":"…"}}}` patch a TELJES
 * conversion_actions map-et cserélte le — 2026-08-25-én a painless 5 offline
 * actionje ~1 percre eltűnt a configból (visszaállítva). Egy nested map-be egy
 * kulcsot beírni nem lehet destruktív.
 */
export function deepMerge(current, patch) {
  const merged = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) {
      delete merged[k];
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const base = merged[k];
      merged[k] = deepMerge(base && typeof base === 'object' && !Array.isArray(base) ? base : {}, v);
    } else {
      merged[k] = v;
    }
  }
  return merged;
}
