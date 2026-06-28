import { describe, it, expect } from 'vitest';
import {
  isTokenlessLowRiskAcceptable,
  degradedRateLimit,
  DEGRADED_LOW_RISK_EVENTS
} from '../src/lib/degraded';

describe('isTokenlessLowRiskAcceptable (TASK 2)', () => {
  it('accepts token-less (missing_token) low-risk click events', () => {
    for (const ev of ['phone_number_clicked', 'email_address_clicked', 'whatsapp_button_clicked']) {
      expect(isTokenlessLowRiskAcceptable(['missing_token'], ev)).toBe(true);
    }
  });

  it('accepts low-risk events when Turnstile verify was unavailable', () => {
    expect(isTokenlessLowRiskAcceptable(['service_unavailable'], 'phone_number_clicked')).toBe(true);
  });

  it('does NOT degrade-accept high-risk form events (spam surface)', () => {
    expect(isTokenlessLowRiskAcceptable(['missing_token'], 'contact_form_submitted')).toBe(false);
    expect(isTokenlessLowRiskAcceptable(['missing_token'], 'quote_calculator_submitted')).toBe(false);
    // callback is a callback-request form → high risk, excluded
    expect(isTokenlessLowRiskAcceptable(['missing_token'], 'callback_request_submitted')).toBe(false);
  });

  it('does NOT degrade-accept a PRESENT-but-INVALID token (bot signal)', () => {
    expect(isTokenlessLowRiskAcceptable(['invalid-input-response'], 'phone_number_clicked')).toBe(false);
    expect(isTokenlessLowRiskAcceptable(['timeout-or-duplicate'], 'phone_number_clicked')).toBe(false);
  });

  it('handles undefined/empty codes', () => {
    expect(isTokenlessLowRiskAcceptable(undefined, 'phone_number_clicked')).toBe(false);
    expect(isTokenlessLowRiskAcceptable([], 'phone_number_clicked')).toBe(false);
  });

  it('the low-risk set is exactly the click events', () => {
    expect([...DEGRADED_LOW_RISK_EVENTS].sort()).toEqual([
      'email_address_clicked',
      'phone_number_clicked',
      'whatsapp_button_clicked'
    ]);
  });
});

describe('degradedRateLimit', () => {
  it('returns true (fail-open to top-level limiter) when no DEGRADED_LIMITER', async () => {
    expect(await degradedRateLimit({} as any, 'k')).toBe(true);
  });

  it('passes through the limiter verdict', async () => {
    const allow = { DEGRADED_LIMITER: { limit: async () => ({ success: true }) } } as any;
    const deny = { DEGRADED_LIMITER: { limit: async () => ({ success: false }) } } as any;
    expect(await degradedRateLimit(allow, 'k')).toBe(true);
    expect(await degradedRateLimit(deny, 'k')).toBe(false);
  });

  it('fail-open if the limiter throws', async () => {
    const boom = { DEGRADED_LIMITER: { limit: async () => { throw new Error('x'); } } } as any;
    expect(await degradedRateLimit(boom, 'k')).toBe(true);
  });
});
