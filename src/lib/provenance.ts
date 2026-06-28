/**
 * lead_provenance — automatikus lead-útvonal paraméter (§3). A KÓD állítja a
 * session-flaget (kalkulátor-befejezés → post_quote, ajánlat-email visszatérés →
 * from_quote_email, egyébként cold), NEM a CRM-es ember. Minden lead-gen
 * konverzión paraméterként utazik (NEM külön event).
 *
 * A gateway csak a három engedélyezett értéket fogadja el; bármi más → a paraméter
 * eldobva (TRK-PROV-001), de az event maga megy tovább.
 */
export const LEAD_PROVENANCE_VALUES = ['cold', 'post_quote', 'from_quote_email'] as const;
export type LeadProvenance = (typeof LEAD_PROVENANCE_VALUES)[number];

export function isValidProvenance(value: unknown): value is LeadProvenance {
  return (
    typeof value === 'string' && (LEAD_PROVENANCE_VALUES as readonly string[]).includes(value)
  );
}
