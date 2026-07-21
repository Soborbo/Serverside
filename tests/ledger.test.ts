import { describe, it, expect } from 'vitest';
import {
  buildIdempotencyKey,
  normalizeDelivery,
  recordDeliveries,
  mapLeadStatusToEventName,
  isValidLeadId,
  VALID_LEAD_STATUSES,
  type VendorResult
} from '../src/lib/ledger';

describe('buildIdempotencyKey', () => {
  it('joins site:event:id (gateway-ingress dedup, NOT vendor dedup)', () => {
    expect(buildIdempotencyKey('painless', 'callback_conversion', 'abc-123')).toBe(
      'painless:callback_conversion:abc-123'
    );
  });

  it('keeps different events under different keys for a shared event_id', () => {
    // CLAUDE.md 16: egy event_id meg van osztva a platformok közt — de a gateway
    // dedup event_name-enként különül, így a platform-szintű kézbesítés nem ütközik.
    const a = buildIdempotencyKey('s', 'quote_calculator_conversion', 'evt');
    const b = buildIdempotencyKey('s', 'callback_conversion', 'evt');
    expect(a).not.toBe(b);
  });
});

describe('normalizeDelivery', () => {
  const ok: VendorResult = { success: true, status: 200 };
  const fail: VendorResult = {
    success: false,
    status: 400,
    error_code: undefined,
    error: 'bad user_data'
  };

  it('maps fulfilled success → accepted', () => {
    const r = normalizeDelivery('meta', { status: 'fulfilled', value: ok });
    expect(r).toEqual({ platform: 'meta', status: 'accepted', http_status: 200 });
  });

  it('maps fulfilled failure → rejected with message', () => {
    const r = normalizeDelivery('ga4', { status: 'fulfilled', value: fail });
    expect(r.status).toBe('rejected');
    expect(r.http_status).toBe(400);
    expect(r.vendor_message).toBe('bad user_data');
  });

  it('maps a rejected promise → rejected with reason string', () => {
    const r = normalizeDelivery('gads', { status: 'rejected', reason: new Error('boom') });
    expect(r.status).toBe('rejected');
    expect(r.vendor_message).toContain('boom');
  });

  it('consent-blocked no-op → skipped (the vendor result carries the flag)', () => {
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true, skipped: true }
    });
    expect(r).toEqual({ platform: 'meta', status: 'skipped' });
  });

  it('prefers partial_failure_error message when present', () => {
    const partial: VendorResult = { success: false, partial_failure_error: 'partial boom' };
    const r = normalizeDelivery('gads', { status: 'fulfilled', value: partial });
    expect(r.vendor_message).toBe('partial boom');
  });

  it('sanitizes + caps vendor messages (§13: no PII persisted to the ledger)', () => {
    // sanitizeErrorMessage a perzisztencia-határon: 200-ra vág ÉS PII-t strippel.
    const longMsg = 'x'.repeat(900);
    const r = normalizeDelivery(
      'meta',
      { status: 'fulfilled', value: { success: false, error: longMsg } }
    );
    expect(r.vendor_message?.length).toBe(200);

    // A vendor visszhangozhatja a beküldött email/telefont — a ledgerbe NEM kerülhet.
    const echoed = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: false, error: 'Invalid parameter: jane@example.com / +447123456789' }
    });
    expect(echoed.vendor_message).not.toContain('jane@example.com');
    expect(echoed.vendor_message).not.toContain('447123456789');
    expect(echoed.vendor_message).toContain('[email]');
  });

  // ── Fix 1 invariáns: accepted SOHA nem íródhat vendor HTTP-státusz nélkül ────
  // A lomtalan 2026-07-14-i esetben a no-config Meta-skip {success:true}-t adott
  // → 'accepted' http_status=NULL sor, ami örökre egészségesnek mutatott egy
  // soha-nem-élt platform-lábat.

  it('vendor result skipped:true → skipped (config-less skip path)', () => {
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true, skipped: true }
    });
    expect(r.status).toBe('skipped');
  });

  it("NEVER records 'accepted' without a vendor HTTP status — downgrades to skipped with a critical error code", () => {
    // Egy jövőbeli skip-ág, ami elfelejti a skipped flaget → ne 'accepted' legyen.
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true } // nincs status, nincs skipped
    });
    expect(r.status).toBe('skipped');
    expect(r.status).not.toBe('accepted');
    expect(r.error_code).toBe('TRK-950-004'); // ACCEPTED_WITHOUT_VENDOR_STATUS
  });

  it("records 'accepted' when (and only when) the vendor HTTP status is present", () => {
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true, status: 200 }
    });
    expect(r).toEqual({ platform: 'meta', status: 'accepted', http_status: 200 });
  });
});

describe('recordDeliveries — az írás előtti utolsó védvonal', () => {
  /** A bind-argumentumokat gyűjti; sorrend a recordDeliveries INSERT-jéből. */
  function makeCapturingLedger() {
    const bound: unknown[][] = [];
    return {
      bound,
      env: {
        LEDGER: {
          prepare: () => ({ bind: (...args: unknown[]) => (bound.push(args), {}) }),
          batch: async () => []
        }
      } as any
    };
  }
  const STATUS_IDX = 6;
  const HTTP_IDX = 7;
  const ERROR_IDX = 8;

  it('a normalizeDelivery-t MEGKERÜLŐ accepted sor HTTP nélkül nem íródik be accepted-ként', async () => {
    // Ezt a típus már nem engedné — a cast pont azt a jövőbeli hívót modellezi,
    // aki kézzel épít rekordot és megkerüli a fojtópontot.
    const { bound, env } = makeCapturingLedger();
    await recordDeliveries(env, {
      event_id: 'evt-1',
      site_id: 'lomtalan',
      event_name: 'contact_form_submitted',
      records: [{ platform: 'meta', status: 'accepted' } as any]
    });

    expect(bound).toHaveLength(1);
    expect(bound[0][STATUS_IDX]).toBe('skipped');
    expect(bound[0][STATUS_IDX]).not.toBe('accepted');
    expect(bound[0][ERROR_IDX]).toBe('TRK-950-004');
  });

  it('a szabályos accepted sor érintetlenül megy át', async () => {
    const { bound, env } = makeCapturingLedger();
    await recordDeliveries(env, {
      event_id: 'evt-2',
      site_id: 'painless',
      event_name: 'quote_calculator_submitted',
      records: [{ platform: 'meta', status: 'accepted', http_status: 200 }]
    });

    expect(bound[0][STATUS_IDX]).toBe('accepted');
    expect(bound[0][HTTP_IDX]).toBe(200);
    expect(bound[0][ERROR_IDX]).toBeNull();
  });

  it('a rejected/skipped sor HTTP-státusz nélkül is érvényes marad', async () => {
    const { bound, env } = makeCapturingLedger();
    await recordDeliveries(env, {
      event_id: 'evt-3',
      site_id: 'painless',
      event_name: 'contact_form_submitted',
      records: [
        { platform: 'tiktok', status: 'skipped' },
        { platform: 'meta', status: 'rejected', error_code: 'TRK-600-004' }
      ]
    });

    expect(bound[0][STATUS_IDX]).toBe('skipped');
    expect(bound[0][HTTP_IDX]).toBeNull();
    expect(bound[1][STATUS_IDX]).toBe('rejected');
    expect(bound[1][ERROR_IDX]).toBe('TRK-600-004');
  });
});

describe('mapLeadStatusToEventName', () => {
  it('maps known statuses to event names', () => {
    expect(mapLeadStatusToEventName('revenue_confirmed')).toBe('revenue_confirmed');
    expect(mapLeadStatusToEventName('booking_confirmed')).toBe('booking_confirmed');
  });

  it('returns null for unknown status (rejection)', () => {
    expect(mapLeadStatusToEventName('hacked_status')).toBeNull();
    expect(mapLeadStatusToEventName('')).toBeNull();
  });

  it('VALID_LEAD_STATUSES covers all mapped keys', () => {
    expect(VALID_LEAD_STATUSES).toContain('lead_qualified');
    expect(VALID_LEAD_STATUSES).toContain('job_completed');
  });
});

describe('isValidLeadId', () => {
  it('accepts UUID-shaped and opaque tokens', () => {
    expect(isValidLeadId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidLeadId('lead_AbC-123')).toBe(true);
  });

  it('rejects PII-looking values and bad shapes', () => {
    expect(isValidLeadId('jane@email.com')).toBe(false); // contains @ .
    expect(isValidLeadId('+447123456789')).toBe(false); // contains +
    expect(isValidLeadId('short')).toBe(false); // < 8
    expect(isValidLeadId('x'.repeat(65))).toBe(false); // > 64
    expect(isValidLeadId(12345678)).toBe(false); // not string
    expect(isValidLeadId(undefined)).toBe(false);
  });
});
