import { describe, it, expect, vi, afterEach } from 'vitest';
// cloudflare:email runtime-import elkerülése (lásd lead-status-consent.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s) => s
}));

import { handleLeadStatus } from '../src/routes/lead-status';
import { retrySingle } from '../src/scheduled/retry';
import type { DeadLetterRecord } from '../src/lib/deadletter';
import type { Env } from '../src/env';

/**
 * CMP Fázis 2 (2.5) — a consent_log az offline/replay ág legerősebb precedenciája.
 *
 * Ha a lead receiptje consent_id-t hordoz (provider='sbo' site), az upload-döntést
 * a consent_log AKTUÁLIS állapota (legmagasabb revision) adja, NEM a capture-kori
 * receipt. A nap-1 GRANTED / nap-3 visszavonás / nap-10 revenue_confirmed esetnek
 * skippelnie KELL — és a skip do_not_replay=1-gyel végleges.
 *
 * consent_id nélkül (a teljes CookieYes-flotta) minden bitre a mai — ezt a
 * meglévő lead-status-consent.test.ts őrzi.
 */

const SITE_CONFIG_JSON = {
  site_id: 'olcso',
  country_code: 'HU',
  currency: 'HUF',
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { lead_qualified: '99887766' }
  }
};

interface ConsentLogRow {
  consent_id: string;
  revision: number;
  decision: string;
  cat_analytics: number;
  cat_marketing: number;
  ad_user_data: string;
  ad_personalization: string;
  ad_storage: string;
  analytics_storage: string;
  client_decided_at: string;
  server_received_at: string;
}

function logRow(overrides: Partial<ConsentLogRow>): ConsentLogRow {
  return {
    consent_id: 'cid-0123456789abcdef',
    revision: 3,
    decision: 'accept_all',
    cat_analytics: 1,
    cat_marketing: 1,
    ad_user_data: 'GRANTED',
    ad_personalization: 'GRANTED',
    ad_storage: 'GRANTED',
    analytics_storage: 'GRANTED',
    client_decided_at: '2026-08-20T10:00:00.000Z',
    server_received_at: '2026-08-20T10:00:01.000Z',
    ...overrides
  };
}

/**
 * Fake LEDGER, SQL-alapú útválasztással:
 *  - `FROM consent_receipts` → a megadott receipt-sor (consent_id-VEL)
 *  - `FROM consent_log`      → a megadott consent_log-állapot (vagy null)
 *  - `INSERT INTO idempotency` + `do_not_replay = 1` → rögzítjük (markDoNotReplay)
 *  - minden más statement no-op
 */
function makeLedger(opts: {
  receipt?: {
    ad_allowed: number;
    ad_user_data: string | null;
    ad_personalization?: string | null;
    consent_id?: string | null;
  };
  consentLog?: ConsentLogRow | null;
  doNotReplayCalls: Array<{ sql: string; args: unknown[] }>;
}) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (/FROM consent_receipts/.test(sql)) return opts.receipt ?? null;
          if (/FROM consent_log/.test(sql)) return opts.consentLog ?? null;
          return null;
        },
        run: async () => {
          if (/INSERT INTO idempotency/.test(sql) && /do_not_replay = 1/.test(sql)) {
            opts.doNotReplayCalls.push({ sql, args });
          }
          return undefined;
        },
        all: async () => ({ results: [] })
      })
    })
  };
}

function makeEnv(ledger: unknown): Env {
  return {
    ADMIN_API_TOKEN: 'admin-token',
    GADS_OAUTH_CLIENT_ID: 'c',
    GADS_OAUTH_CLIENT_SECRET: 's',
    SITE_CONFIG: { get: async () => SITE_CONFIG_JSON },
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    },
    LEDGER: ledger
  } as unknown as Env;
}

function makeCtx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    __pending: pending
  } as unknown as ExecutionContext;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://olcsokontenerhaz.hu/api/event/lead-status', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('handleLeadStatus — consent_log precedencia (2.5)', () => {
  it('consent_log GRANTED → upload megy, a jelek a LOG-ból (nem a receiptből) jönnek', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        // A CRM jele DENY — a consent_log GRANTED-je erősebb nála is.
        ad_allowed: false,
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(
        makeLedger({
          // A capture-kori receipt DENIED — a user AZÓTA igent mondott (revision 3).
          receipt: {
            ad_allowed: 0,
            ad_user_data: 'DENIED',
            ad_personalization: 'DENIED',
            consent_id: 'cid-0123456789abcdef'
          },
          consentLog: logRow({ decision: 'accept_all' }),
          doNotReplayCalls
        })
      ),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured.events[0].consent).toEqual({
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_GRANTED'
    });
    expect(doNotReplayCalls).toHaveLength(0);
  });

  it('consent_log withdrawn → skip + do_not_replay=1, a capture-kori GRANTED receipt ellenére', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        ad_allowed: true,
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(
        makeLedger({
          receipt: {
            ad_allowed: 1,
            ad_user_data: 'GRANTED',
            ad_personalization: 'GRANTED',
            consent_id: 'cid-0123456789abcdef'
          },
          consentLog: logRow({
            decision: 'withdrawn',
            revision: 4,
            cat_analytics: 0,
            cat_marketing: 0,
            ad_user_data: 'DENIED',
            ad_personalization: 'DENIED',
            ad_storage: 'DENIED',
            analytics_storage: 'DENIED'
          }),
          doNotReplayCalls
        })
      ),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // A skip VÉGLEGES: az idempotency táblába do_not_replay=1 került.
    expect(doNotReplayCalls).toHaveLength(1);
  });

  it('custom (csak analytics, marketing DENIED) → blokkolt: ad_user_data nem GRANTED', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(
        makeLedger({
          receipt: {
            ad_allowed: 1,
            ad_user_data: 'GRANTED',
            consent_id: 'cid-0123456789abcdef'
          },
          consentLog: logRow({
            decision: 'custom',
            cat_analytics: 1,
            cat_marketing: 0,
            ad_user_data: 'DENIED',
            ad_personalization: 'DENIED',
            ad_storage: 'DENIED'
          }),
          doNotReplayCalls
        })
      ),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(doNotReplayCalls).toHaveLength(1);
  });

  it('consent_id VAN, de a consent_log üres (ismeretlen id / D1-hiba) → a MAI receipt-szabály fut', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const res = await handleLeadStatus(
      makeRequest({
        lead_id: 'lead-12345678',
        status: 'lead_qualified',
        user_data: { email: 'jane@example.com' }
      }),
      makeEnv(
        makeLedger({
          receipt: {
            ad_allowed: 1,
            ad_user_data: 'GRANTED',
            ad_personalization: 'GRANTED',
            consent_id: 'cid-0123456789abcdef'
          },
          consentLog: null,
          doNotReplayCalls
        })
      ),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(false);
    expect(captured).not.toBeNull();
    expect(doNotReplayCalls).toHaveLength(0);
  });
});

describe('retrySingle — gads replay a consent_log aktuális állapota mögött (2.5)', () => {
  const record: DeadLetterRecord = {
    platform: 'gads',
    site_id: 'olcso',
    hostname: 'olcsokontenerhaz.hu',
    lead_id: 'lead-12345678',
    event_payload: {
      event_name: 'lead_qualified',
      event_id: 'order-abc123',
      event_time: 1756000000
    },
    hashed_user_data: { em: 'a'.repeat(64) },
    failure_reason: 'timeout',
    retry_count: 1,
    first_failed_at: '2026-08-20T10:00:00.000Z',
    last_attempted_at: '2026-08-20T11:00:00.000Z'
  } as unknown as DeadLetterRecord;

  it('visszavont consent → skipped consent_withdrawn, vendor-hívás NÉLKÜL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const result = await retrySingle(
      makeEnv(
        makeLedger({
          receipt: {
            ad_allowed: 1,
            ad_user_data: 'GRANTED',
            consent_id: 'cid-0123456789abcdef'
          },
          consentLog: logRow({
            decision: 'withdrawn',
            revision: 4,
            ad_user_data: 'DENIED',
            ad_personalization: 'DENIED'
          }),
          doNotReplayCalls
        })
      ),
      record
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toBe('consent_withdrawn');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GRANTED consent_log → a replay továbbmegy a Data Managerre', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const result = await retrySingle(
      makeEnv(
        makeLedger({
          receipt: {
            ad_allowed: 1,
            ad_user_data: 'GRANTED',
            consent_id: 'cid-0123456789abcdef'
          },
          consentLog: logRow({ decision: 'accept_all' }),
          doNotReplayCalls
        })
      ),
      record
    );

    expect(result.success).toBe(true);
    expect(result.skipped).not.toBe(true);
    expect(captured).not.toBeNull();
  });

  it('consent_id nélküli lead (CookieYes-flotta) → a replay bitre a mai: nincs consent-kapu', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as any;
    });

    const doNotReplayCalls: Array<{ sql: string; args: unknown[] }> = [];
    const result = await retrySingle(
      makeEnv(
        makeLedger({
          receipt: { ad_allowed: 1, ad_user_data: 'GRANTED', consent_id: null },
          consentLog: logRow({ decision: 'withdrawn' }),
          doNotReplayCalls
        })
      ),
      record
    );

    expect(result.success).toBe(true);
    expect(result.skipped).not.toBe(true);
    expect(captured).not.toBeNull();
  });
});
