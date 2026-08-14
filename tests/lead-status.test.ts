import { describe, it, expect, vi } from 'vitest';
// cloudflare:email runtime-import elkerülése (a lead-status.ts a sendAlert-en
// keresztül húzná be a notify.ts-t — lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s) => s
}));

import { validateLeadStatusBody } from '../src/routes/lead-status';

const base = {
  lead_id: '550e8400-e29b-41d4-a716-446655440000',
  status: 'revenue_confirmed'
};

describe('validateLeadStatusBody', () => {
  it('accepts a minimal valid body', () => {
    const r = validateLeadStatusBody(base);
    expect(r).not.toBeNull();
    expect(r?.status).toBe('revenue_confirmed');
  });

  it('accepts value, currency, occurred_at, user_data', () => {
    const r = validateLeadStatusBody({
      ...base,
      value: 1200,
      currency: 'GBP',
      occurred_at: '2026-06-26T10:30:00Z',
      user_data: { email: 'jane@email.com', phone_number: '+447123456789' }
    });
    expect(r?.value).toBe(1200);
    expect(r?.currency).toBe('GBP');
    expect(r?.user_data?.email).toBe('jane@email.com');
  });

  it('rejects missing/invalid lead_id', () => {
    expect(validateLeadStatusBody({ status: 'lead_qualified' })).toBeNull();
    expect(validateLeadStatusBody({ ...base, lead_id: 'jane@email.com' })).toBeNull();
  });

  it('rejects unknown status (allowlist)', () => {
    expect(validateLeadStatusBody({ ...base, status: 'drop_table' })).toBeNull();
    expect(validateLeadStatusBody({ ...base, status: 123 })).toBeNull();
  });

  it('rejects malformed occurred_at', () => {
    expect(validateLeadStatusBody({ ...base, occurred_at: 'not-a-date' })).toBeNull();
  });

  it('rejects negative or non-finite value', () => {
    expect(validateLeadStatusBody({ ...base, value: -5 })).toBeNull();
    expect(validateLeadStatusBody({ ...base, value: Infinity })).toBeNull();
  });

  it('rejects bad currency shape', () => {
    expect(validateLeadStatusBody({ ...base, currency: 'POUNDS' })).toBeNull();
    expect(validateLeadStatusBody({ ...base, currency: 'G1P' })).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(validateLeadStatusBody(null)).toBeNull();
    expect(validateLeadStatusBody('string')).toBeNull();
    expect(validateLeadStatusBody({ ...base, user_data: 'nope' })).toBeNull();
  });

  it('rejects user_data arrays (typeof [] === object)', () => {
    expect(validateLeadStatusBody({ ...base, user_data: ['x'] })).toBeNull();
  });

  it('normalizes currency to uppercase', () => {
    const r = validateLeadStatusBody({ ...base, currency: 'gbp' });
    expect(r?.currency).toBe('GBP');
  });

  it('normalizes occurred_at to UTC ISO (Z)', () => {
    const r = validateLeadStatusBody({ ...base, occurred_at: '2026-06-26T10:30:00+02:00' });
    expect(r?.occurred_at).toBe('2026-06-26T08:30:00.000Z');
  });

  it('accepts ad_allowed boolean, rejects non-boolean', () => {
    expect(validateLeadStatusBody({ ...base, ad_allowed: true })?.ad_allowed).toBe(true);
    expect(validateLeadStatusBody({ ...base, ad_allowed: false })?.ad_allowed).toBe(false);
    expect(validateLeadStatusBody({ ...base, ad_allowed: 'yes' })).toBeNull();
    expect(validateLeadStatusBody({ ...base, ad_allowed: 1 })).toBeNull();
  });

  it('leaves ad_allowed undefined when absent (ledger fallback)', () => {
    expect(validateLeadStatusBody(base)?.ad_allowed).toBeUndefined();
  });

  it('passes through well-formed click IDs', () => {
    const r = validateLeadStatusBody({
      ...base,
      gclid: 'Cj0KCQjw_abc-123.x',
      gbraid: '1kAbC_d-e',
      wbraid: '2wXyZ.9'
    });
    expect(r?.gclid).toBe('Cj0KCQjw_abc-123.x');
    expect(r?.gbraid).toBe('1kAbC_d-e');
    expect(r?.wbraid).toBe('2wXyZ.9');
  });

  it('drops malformed click IDs without rejecting the body (money leg survives)', () => {
    // Tamperelt URL-paraméter nem égetheti el a lifecycle-konverziót: a hibás
    // click ID kimarad, az esemény (PII-matchcsel) megy tovább.
    expect(validateLeadStatusBody({ ...base, gclid: 'has space' })?.gclid).toBeUndefined();
    expect(validateLeadStatusBody({ ...base, gclid: 'x'.repeat(513) })?.gclid).toBeUndefined();
    expect(validateLeadStatusBody({ ...base, gclid: 123 })?.gclid).toBeUndefined();
    expect(validateLeadStatusBody({ ...base, gclid: 'jó=rossz&' })).not.toBeNull();
    expect(validateLeadStatusBody({ ...base, gclid: 'jó=rossz&' })?.gclid).toBeUndefined();
  });

  it('leaves click IDs undefined when absent', () => {
    const r = validateLeadStatusBody(base);
    expect(r?.gclid).toBeUndefined();
    expect(r?.gbraid).toBeUndefined();
    expect(r?.wbraid).toBeUndefined();
  });
});
