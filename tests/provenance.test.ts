import { describe, it, expect } from 'vitest';
import { isValidProvenance } from '../src/lib/provenance';

describe('lead_provenance', () => {
  it('accepts only the three allowed values', () => {
    for (const v of ['cold', 'post_quote', 'from_quote_email']) {
      expect(isValidProvenance(v)).toBe(true);
    }
    for (const v of ['', 'warm', 'email', undefined, null, 42]) {
      expect(isValidProvenance(v as unknown)).toBe(false);
    }
  });
});
