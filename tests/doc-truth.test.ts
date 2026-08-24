import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs gate, no type declarations by design
import { checkDocTruth } from '../scripts/check-doc-truth.mjs';

/**
 * vNext P0.5 — TRUTH-FREEZE kapu.
 *
 * A doksi↔valóság drift itt nem elméleti kockázat: 2026-08-24-ig két doksi a Google
 * Tag Gateway BEKAPCSOLÁSÁT írta elő (miközben a fleet-döntés a kikapcsolás), a
 * gtm-setup.md egy Custom HTML consent-default GTM-taget dokumentált (a valóság
 * inline `Tracking.astro`), és a generátor GA4-warningja azt sugallta, hogy a `ga4`
 * blokk kellene. Aki ezekből onboardol, konfigurációs hibát épít be.
 *
 * RED TEST: a javítás előtti doksikkal ez a teszt 3 FORBIDDEN + 5 ANCHOR sértéssel bukik.
 */
describe('P0.5 — truth-freeze: a doksi a JELENLEGI modellt írja le', () => {
  it('nincs cáfolt utasítás, és minden kanonikus állítás a helyén van', () => {
    const violations = checkDocTruth() as Array<{
      kind: string;
      rule: string;
      where: string;
      line: string;
      reason: string;
    }>;
    const report = violations.map((v) => `[${v.kind}: ${v.rule}] ${v.where}\n  > ${v.line}\n  ${v.reason}`).join('\n\n');
    expect(violations, `DOC_TRUTH_FAIL\n\n${report}`).toEqual([]);
  });
});
