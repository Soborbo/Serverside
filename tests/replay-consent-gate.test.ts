import { describe, it, expect, vi, afterEach } from 'vitest';
// cloudflare:email runtime-import elkerülése (lásd lead-status-consent.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { retrySingle } from '../src/scheduled/retry';
import { handleLeadStatus } from '../src/routes/lead-status';
import { readConsentState } from '../src/lib/ledger';
import { TrackingErrorCode } from '../src/lib/error-codes';
import type { DeadLetterRecord, Platform } from '../src/lib/deadletter';
import type { Env } from '../src/env';

/**
 * 2026-10-18 review R1 + R2 — a replay-kapu CSATORNAFÜGGETLEN, és a D1-hiba
 * NEM azonos a „nincs consent_id"-val.
 *
 * R1: korábban csak a gads-replay nézte a consent_log aktuális állapotát; a
 *     Meta/TikTok/LinkedIn egy azóta visszavont engedéllyel is kiment.
 * R2: a consent_log olvasási hibája `null`-t adott, amit a kapu „nincs tiltás"-nak
 *     olvasott — üzemzavar alatt a régi engedély érvényesült.
 */

const SBO_SITE = {
  site_id: 'review',
  country_code: 'GB',
  currency: 'GBP',
  require_consent: true,
  consent: { provider: 'sbo' },
  meta: { pixel_id: '12345678', access_token: 'fake' },
  tiktok: { pixel_code: 'fake', access_token: 'fake' },
  linkedin: { access_token: 'fake', conversion_rules: { lead_qualified: 'urn:li:llaConversion:1' } },
  msads: { customer_id: '1', conversion_names: { lead_qualified: 'Lead' } },
  gads: { customer_id: '1234567890', conversion_actions: { lead_qualified: '123' } }
};
const COOKIEYES_SITE = { ...SBO_SITE, consent: undefined };

const WITHDRAWN = {
  consent_id: 'consent-12345678',
  revision: 4,
  decision: 'withdrawn',
  cat_analytics: 0,
  cat_marketing: 0,
  ad_user_data: 'DENIED',
  ad_personalization: 'DENIED',
  ad_storage: 'DENIED',
  analytics_storage: 'DENIED',
  client_decided_at: '2026-10-01T10:00:00.000Z',
  server_received_at: '2026-10-01T10:00:01.000Z'
};
const GRANTED = { ...WITHDRAWN, revision: 3, decision: 'accept_all', cat_analytics: 1, cat_marketing: 1,
  ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', ad_storage: 'GRANTED', analytics_storage: 'GRANTED' };

type Answer = Record<string, unknown> | null | 'throw';

function makeLedger(opts: { receipt?: Answer; consentLog?: Answer }) {
  const queries: string[] = [];
  const answer = (a: Answer | undefined) => {
    if (a === 'throw') throw new Error('D1 unavailable');
    return a ?? null;
  };
  return {
    queries,
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          queries.push(sql);
          if (/FROM consent_receipts/.test(sql)) return answer(opts.receipt);
          if (/FROM consent_log/.test(sql)) return answer(opts.consentLog);
          return null;
        },
        run: async () => undefined,
        all: async () => ({ results: [] })
      })
    })
  };
}

function makeEnv(site: unknown, ledger: unknown): Env {
  return {
    ADMIN_API_TOKEN: 'admin-token',
    GADS_OAUTH_CLIENT_ID: 'c',
    GADS_OAUTH_CLIENT_SECRET: 's',
    SITE_CONFIG: { get: async () => site },
    OAUTH_TOKENS: { get: async () => 'cached-token', put: async () => undefined },
    LEDGER: ledger
  } as unknown as Env;
}

function record(platform: Platform, extra: Partial<DeadLetterRecord> = {}): DeadLetterRecord {
  const now = new Date().toISOString();
  return {
    platform,
    site_id: 'review',
    hostname: 'review.example',
    event_payload: {
      event_name: 'lead_qualified',
      event_id: 'event-12345678',
      event_time: Math.floor(Date.now() / 1000),
      consent: { ad_user_data: 'GRANTED' },
      ttclid: 'tt',
      li_fat_id: 'li',
      msclkid: 'ms',
      gclid: 'gc'
    },
    hashed_user_data: { em: 'a'.repeat(64) },
    failure_reason: 'test',
    retry_count: 0,
    first_failed_at: now,
    last_attempted_at: now,
    ...extra
  };
}

afterEach(() => vi.unstubAllGlobals());

const AD_PLATFORMS: Platform[] = ['meta', 'gads', 'tiktok', 'linkedin', 'msads'];

describe('R1 — minden hirdetési replay az AKTUÁLIS consent-állapotot nézi', () => {
  for (const platform of AD_PLATFORMS) {
    it(`${platform}: lead_id-n át feloldott visszavonás → nulla kimenő kérés, consent_withdrawn skip`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const ledger = makeLedger({
        receipt: { ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', consent_id: 'consent-12345678' },
        consentLog: WITHDRAWN
      });
      const result = await retrySingle(makeEnv(SBO_SITE, ledger), record(platform, { lead_id: 'lead-12345678' }));
      expect(result).toMatchObject({ success: true, skipped: true, skip_reason: 'consent_withdrawn' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${platform}: lead_id NÉLKÜL, a rekord consent_id-ja alapján is skippel`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const ledger = makeLedger({ consentLog: WITHDRAWN });
      const result = await retrySingle(makeEnv(SBO_SITE, ledger), record(platform, { consent_id: 'consent-12345678' }));
      expect(result).toMatchObject({ skipped: true, skip_reason: 'consent_withdrawn' });
      expect(fetchMock).not.toHaveBeenCalled();
      // A rekordban hordozott consent_id mellett a lead-receiptet nem is kell olvasni.
      expect(ledger.queries.some((q) => /FROM consent_receipts/.test(q))).toBe(false);
    });
  }

  it('meta: aktuális GRANTED állapot mellett a küldés megy', async () => {
    const fetchMock = vi.fn(async () => new Response('{"events_received":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ledger = makeLedger({ consentLog: GRANTED });
    const result = await retrySingle(makeEnv(SBO_SITE, ledger), record('meta', { consent_id: 'consent-12345678' }));
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('CookieYes-site, consent_id nélkül: a mai viselkedés bitre változatlan (küld)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"events_received":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ledger = makeLedger({ receipt: { ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', consent_id: null } });
    const result = await retrySingle(makeEnv(COOKIEYES_SITE, ledger), record('meta', { lead_id: 'lead-12345678' }));
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ledger.queries.some((q) => /FROM consent_log/.test(q))).toBe(false);
  });
});

describe('R2 — olvasási hiba: nincs küldés, a rekord újrapróbálható marad', () => {
  for (const platform of AD_PLATFORMS) {
    it(`${platform}: consent_log D1-hiba → nulla kimenő kérés, CONSENT_STATE_UNAVAILABLE`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const ledger = makeLedger({
        receipt: { ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', consent_id: 'consent-12345678' },
        consentLog: 'throw'
      });
      const result = await retrySingle(makeEnv(SBO_SITE, ledger), record(platform, { lead_id: 'lead-12345678' }));
      // NEM siker és NEM terminális skip → a hívók (cron/Queue/admin) megtartják a rekordot.
      expect(result).toMatchObject({ success: false, error_code: TrackingErrorCode.CONSENT_STATE_UNAVAILABLE });
      expect(result.skipped).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('sbo-site: a lead-receipt olvasási hibája is megállítja a küldést', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ledger = makeLedger({ receipt: 'throw' });
    const result = await retrySingle(makeEnv(SBO_SITE, ledger), record('meta', { lead_id: 'lead-12345678' }));
    expect(result).toMatchObject({ success: false, error_code: TrackingErrorCode.CONSENT_STATE_UNAVAILABLE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CookieYes-site: a lead-receipt olvasási hibája NEM állít meg semmit (ott consent_log nem létezik)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"events_received":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ledger = makeLedger({ receipt: 'throw' });
    const result = await retrySingle(makeEnv(COOKIEYES_SITE, ledger), record('meta', { lead_id: 'lead-12345678' }));
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('helyreállás után az AKKORI állapot dönt (visszavont → skip)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const rec = record('gads', { consent_id: 'consent-12345678' });
    const down = await retrySingle(makeEnv(SBO_SITE, makeLedger({ consentLog: 'throw' })), rec);
    expect(down.success).toBe(false);
    const up = await retrySingle(makeEnv(SBO_SITE, makeLedger({ consentLog: WITHDRAWN })), rec);
    expect(up).toMatchObject({ skipped: true, skip_reason: 'consent_withdrawn' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('readConsentState megkülönbözteti a hiányt és a hibát', async () => {
    const env = (consentLog: Answer) => makeEnv(SBO_SITE, makeLedger({ consentLog }));
    expect(await readConsentState(env(null), 'review', 'x')).toEqual({ kind: 'missing' });
    expect(await readConsentState(env('throw'), 'review', 'x')).toEqual({ kind: 'error' });
    expect((await readConsentState(env(GRANTED), 'review', 'x')).kind).toBe('found');
  });
});

describe('R2 — /lead-status: consent-olvasási hiba → 503, a CRM újrapróbálja', () => {
  function request(): Request {
    return new Request('https://review.example/api/event/lead-status', {
      method: 'POST',
      headers: { 'X-Admin-Token': 'admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: 'lead-12345678', status: 'lead_qualified', ad_allowed: true, user_data: { email: 'jane@example.com' } })
    });
  }
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

  it('consent_log D1-hiba → 503 consent_state_unavailable, nulla Google-hívás', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ledger = makeLedger({
      receipt: { ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', consent_id: 'consent-12345678' },
      consentLog: 'throw'
    });
    const res = await handleLeadStatus(request(), makeEnv(SBO_SITE, ledger), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'consent_state_unavailable', retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sbo-site lead-receipt D1-hiba → 503', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleLeadStatus(request(), makeEnv(SBO_SITE, makeLedger({ receipt: 'throw' })), ctx);
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
