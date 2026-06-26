import { describe, it, expect } from 'vitest';
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
});
