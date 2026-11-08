import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleLeadStatus } from '../src/routes/lead-status';
import { retrySingle } from '../src/scheduled/retry';
import { consentTextVendors, decideAdConsent, type ConsentLogState } from '../src/lib/consent-log';
import type { DeadLetterRecord } from '../src/lib/deadletter';
import type { Env } from '../src/env';

/**
 * 2026-10-18 review — a hozzájárulási döntés EGY szabálya a szerveroldali
 * kézbesítési utakon (CRM-esemény, cron/Queue/admin újraküldés):
 *   engedélyezett / tiltott / új döntés szükséges / átmenetileg nem ellenőrizhető.
 * Saját CMP (sbo) alatt a régi CookieYes-receipt és a CRM-jel NEM evidencia.
 */

// A hatókör (effective_*) alapból a bizonyíték-mezőkből következik, ahogy a
// ledger toConsentState-je is képzi; egy teszt külön is felülírhatja.
const STATE = (o: Partial<ConsentLogState> = {}): ConsentLogState => {
  const s = {
  consent_id: 'cid-0123456789abcdef',
  revision: 2,
  decision: 'accept_all',
  cat_analytics: true,
  cat_marketing: true,
  ad_user_data: 'GRANTED',
  ad_personalization: 'GRANTED',
  ad_storage: 'GRANTED',
  analytics_storage: 'GRANTED',
  // Relatív idő: a 180 napos lejárat miatt egy rögzített dátum idővel elévülne.
  client_decided_at: new Date(Date.now() - 3_600_000).toISOString(),
  server_received_at: new Date(Date.now() - 3_599_000).toISOString(),
  consent_text_version: '2026-09-a.ga4_google_ads_google_ec_meta',
  ...o
  };
  return {
    effective_vendors: consentTextVendors(s.consent_text_version),
    effective_received_at: s.server_received_at,
    ...s
  } as ConsentLogState;
};
const ONLY_MARKETING = STATE({
  decision: 'custom', cat_analytics: false, analytics_storage: 'DENIED'
});
const GRANTED_RECEIPT = { kind: 'found' as const, record: { ad_allowed: true, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' } };

describe('decideAdConsent — a négy kimenet', () => {
  const base = { sbo: true, requireConsent: false, category: 'ads' as const, receipt: null };

  it('engedélyezett: consent_log GRANTED, a jelek a logból', () => {
    expect(decideAdConsent({ ...base, consentLog: { kind: 'found', state: STATE() } })).toEqual({
      kind: 'allowed', source: 'consent_log', signals: { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' }
    });
  });

  it('tiltott: visszavont állapot → consent_withdrawn', () => {
    const v = decideAdConsent({
      ...base,
      consentLog: { kind: 'found', state: STATE({ decision: 'withdrawn', ad_user_data: 'DENIED' }) }
    });
    expect(v).toMatchObject({ kind: 'denied', skip_reason: 'consent_withdrawn' });
  });

  it('új döntés szükséges: sbo, nincs consent_log-sor — a GRANTED receipt és a CRM-jel NEM számít', () => {
    expect(
      decideAdConsent({ ...base, consentLog: { kind: 'missing' }, receipt: GRANTED_RECEIPT, crmAdAllowed: true })
    ).toEqual({ kind: 'needs_decision', skip_reason: 'consent_missing_failclosed' });
    expect(decideAdConsent({ ...base, consentLog: null, passedCaptureGate: true }).kind).toBe('needs_decision');
  });

  it('átmenetileg nem ellenőrizhető: D1-hiba sosem engedély', () => {
    expect(decideAdConsent({ ...base, consentLog: { kind: 'error' } })).toEqual({ kind: 'unavailable' });
    expect(decideAdConsent({ ...base, consentLog: null, receipt: { kind: 'error' } })).toEqual({ kind: 'unavailable' });
  });

  it('kategória-különbség megmarad: csak-marketing engedély → hirdetés mehet, analitika nem', () => {
    const log = { kind: 'found' as const, state: ONLY_MARKETING };
    expect(decideAdConsent({ ...base, consentLog: log }).kind).toBe('allowed');
    expect(decideAdConsent({ ...base, category: 'analytics', consentLog: log }).kind).toBe('denied');
  });

  it('CookieYes-site: a mai precedencia (receipt → CRM → capture-kapu → require_consent)', () => {
    const cy = { sbo: false, requireConsent: true, category: 'ads' as const, consentLog: null };
    expect(decideAdConsent({ ...cy, receipt: GRANTED_RECEIPT }).kind).toBe('allowed');
    expect(decideAdConsent({ ...cy, receipt: { kind: 'missing' }, crmAdAllowed: false })).toMatchObject({ kind: 'denied', source: 'crm' });
    expect(decideAdConsent({ ...cy, receipt: { kind: 'missing' }, passedCaptureGate: true }).kind).toBe('allowed');
    expect(decideAdConsent({ ...cy, receipt: { kind: 'missing' } })).toMatchObject({ kind: 'denied', source: 'fallback' });
    // CookieYes-en a lead-olvasás hibája nem állítja meg (ott nincs visszavonás-forrás).
    expect(decideAdConsent({ ...cy, requireConsent: false, receipt: { kind: 'error' } }).kind).toBe('allowed');
  });
});

// ── Útvonal-szintű próbák ───────────────────────────────────────────────────

const SBO_SITE = {
  site_id: 'sbosite',
  country_code: 'HU',
  currency: 'HUF',
  consent: { provider: 'sbo', mode: 'basic' },
  meta: { pixel_id: '123456789012345', access_token: 'tok' },
  ga4: { measurement_id: 'G-ABCDEF1234', api_secret: 'sec' },
  gads: { customer_id: '1234567890', login_customer_id: null, conversion_actions: { lead_qualified: '99887766' } }
};

function makeLedger(opts: { receipt?: Record<string, unknown> | null; consentLog?: Record<string, unknown> | null }) {
  const deliveries: unknown[][] = [];
  const ledger = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (/FROM consent_receipts/.test(sql)) return opts.receipt ?? null;
          if (/FROM consent_log/.test(sql)) return opts.consentLog ?? null;
          return null;
        },
        run: async () => {
          if (/INSERT INTO deliveries/.test(sql)) deliveries.push(args);
          return undefined;
        },
        all: async () => ({ results: [] })
      })
    })
  };
  return { ledger, deliveries };
}

function makeEnv(ledger: unknown): Env {
  return {
    ADMIN_API_TOKEN: 'admin-token',
    GADS_OAUTH_CLIENT_ID: 'c',
    GADS_OAUTH_CLIENT_SECRET: 's',
    SITE_CONFIG: { get: async () => SBO_SITE },
    OAUTH_TOKENS: { get: async (k: string) => (k.endsWith(':access_token') ? 'cached' : null), put: async () => undefined },
    LEDGER: ledger
  } as unknown as Env;
}

const ctx = () => ({ waitUntil: () => undefined, passThroughOnException: () => undefined }) as unknown as ExecutionContext;

function leadStatus(body: Record<string, unknown>): Request {
  return new Request('https://sbosite.example/api/event/lead-status', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: 'lead-12345678', status: 'lead_qualified', user_data: { email: 'a@b.hu' }, ...body })
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('decideAdConsent — lejárat és vendor-fedés (saját CMP)', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-11-03T12:00:00.000Z');
  const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const run = (state: ConsentLogState, extra: { platform?: string; nowMs?: number } = {}) =>
    decideAdConsent({
      sbo: true, requireConsent: true, category: 'ads', receipt: null,
      consentLog: { kind: 'found', state }, nowMs: NOW, ...extra
    });

  it('180 napon belüli engedély érvényes, a 180. nap után consent_expired', () => {
    expect(run(STATE({ server_received_at: at(179) }), { platform: 'gads' }).kind).toBe('allowed');
    expect(run(STATE({ server_received_at: at(181) }), { platform: 'gads' })).toMatchObject({
      kind: 'denied', source: 'consent_log', skip_reason: 'consent_expired'
    });
  });

  it('a lejárat a SZERVER beérkezési idejéből számít, nem a kliens órájából', () => {
    // A kliens „ma"-t állít, de a sor 200 napja érkezett → lejárt.
    expect(run(STATE({ client_decided_at: at(0), server_received_at: at(200) })).kind).toBe('denied');
  });

  it('olvashatatlan beérkezési idő → lejártnak számít (bizonytalanból nincs engedély)', () => {
    expect(run(STATE({ server_received_at: 'nem-dátum' }))).toMatchObject({ skip_reason: 'consent_expired' });
  });

  it('a visszavonás a lejárat ELŐTT dönt: régi visszavont állapot → consent_withdrawn marad', () => {
    expect(run(STATE({ decision: 'withdrawn', ad_user_data: 'DENIED', server_received_at: at(400) }))).toMatchObject({
      skip_reason: 'consent_withdrawn'
    });
  });

  it('Google offline: a google_ec szöveg is fedi (befilo-alak)', () => {
    expect(run(STATE({ consent_text_version: '2026-09-a.clarity_ga4_google_ec' }), { platform: 'gads' }).kind).toBe('allowed');
    expect(run(STATE({ consent_text_version: '2026-09-a.clarity_ga4_google_ec.t431acc4a' }), { platform: 'gads' }).kind).toBe('allowed');
  });

  it('a szövegben meg nem nevezett platform → consent_vendor_not_covered', () => {
    // nonmono-hu alak: GA4 + Clarity — se Meta, se Google hirdetés.
    expect(run(STATE({ consent_text_version: '2026-09-a.clarity_ga4' }), { platform: 'meta' })).toMatchObject({
      kind: 'denied', skip_reason: 'consent_vendor_not_covered'
    });
    expect(run(STATE({ consent_text_version: '2026-09-a.clarity_ga4' }), { platform: 'gads' })).toMatchObject({
      skip_reason: 'consent_vendor_not_covered'
    });
    // Olyan platform, amire vendor-azonosító sincs → soha nem fedett.
    expect(run(STATE(), { platform: 'msads' })).toMatchObject({ skip_reason: 'consent_vendor_not_covered' });
  });

  it('hiányzó vagy ismeretlen szövegverzió → nincs fedés (fail-closed)', () => {
    expect(run(STATE({ consent_text_version: '2026-09-a.ga4_tiktok' }), { platform: 'gads' }).kind).toBe('denied');
    expect(run(STATE({ consent_text_version: '' as string }), { platform: 'gads' }).kind).toBe('denied');
  });

  it('platform nélkül a vendor-szűkítés kimarad (a lejárat nem)', () => {
    expect(run(STATE({ consent_text_version: '2026-09-a.clarity_ga4' })).kind).toBe('allowed');
  });
});

describe('consentTextVendors — a consent_text_version felbontása', () => {
  it('az aláhúzásos azonosítókat egyben ismeri fel', () => {
    expect(consentTextVendors('2026-09-a.ga4_google_ads_google_ec_meta')).toEqual(['ga4', 'google_ads', 'google_ec', 'meta']);
    expect(consentTextVendors('2026-09-a.clarity_ga4_google_ec.t431acc4a')).toEqual(['clarity', 'ga4', 'google_ec']);
  });
  it('vendorlista nélküli (2026-08-a kori) szöveg → az alapkészlet', () => {
    expect(consentTextVendors('2026-08-a')).toEqual(['ga4', 'google_ads', 'meta']);
    expect(consentTextVendors('2026-08-a.t0000beef')).toEqual(['ga4', 'google_ads', 'meta']);
  });
  it('none → üres; ismeretlen darab vagy hiány → null', () => {
    expect(consentTextVendors('2026-09-a.none')).toEqual([]);
    expect(consentTextVendors('2026-09-a.ga4_googl')).toBeNull();
    expect(consentTextVendors(undefined)).toBeNull();
  });
});

describe('CRM-esemény (lead-status) sbo-site-on: nincs visszaesés régi engedélyre', () => {
  it('consent_id ismert, de nincs consent_log-sora → a GRANTED receipt ellenére NINCS feltöltés', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ledger } = makeLedger({
      receipt: { ad_allowed: 1, ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', consent_id: 'cid-0123456789abcdef' },
      consentLog: null
    });
    const res = await handleLeadStatus(leadStatus({}), makeEnv(ledger), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).consent_blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nincs consent_id (telefonos lead), CRM ad_allowed=true → NINCS feltöltés (a CRM-jel nem hozzájárulás)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ledger } = makeLedger({ receipt: null });
    const res = await handleLeadStatus(leadStatus({ ad_allowed: true }), makeEnv(ledger), ctx());
    expect((await res.json()).consent_blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('újraküldés (retrySingle) sbo-site-on', () => {
  const rec = (o: Partial<DeadLetterRecord>): DeadLetterRecord =>
    ({
      platform: 'meta',
      site_id: 'sbosite',
      hostname: 'sbosite.example',
      event_payload: { event_name: 'Lead', event_id: 'ev-1', event_time: 1760000000, action_source: 'website' },
      hashed_user_data: {},
      failure_reason: 'timeout',
      retry_count: 1,
      first_failed_at: '2026-10-01T10:00:00.000Z',
      last_attempted_at: '2026-10-01T11:00:00.000Z',
      ...o
    }) as DeadLetterRecord;

  it('consent_id nélküli rekord → nem megy ki a régi capture-engedéllyel (új döntés szükséges)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ledger } = makeLedger({});
    const result = await retrySingle(makeEnv(ledger), rec({}));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, skipped: true, skip_reason: 'consent_missing_failclosed' });
  });

  it('friss rekord, a döntés még úton lehet (a böngésző 503 után újraküldi) → NEM végleges, újrapróbálható', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ledger } = makeLedger({});
    const result = await retrySingle(
      makeEnv(ledger),
      rec({ consent_id: 'cid-0123456789abcdef', first_failed_at: new Date().toISOString() } as Partial<DeadLetterRecord>)
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // NEM próbálkozás és NEM végleges: újrapróbálható skip (a cron nem növeli a
    // retry_count-ot, nem ír 'rejected' sort; a Queue a cron R2-sorába adja át).
    expect(result).toMatchObject({ success: true, skipped: true, skip_reason: 'consent_pending' });
  });

  it('GA4-replay: a capture-kori GRANTED jel helyett a consent_log AKTUÁLIS analitika-állapota dönt', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ledger } = makeLedger({
      consentLog: {
        consent_id: 'cid-0123456789abcdef', revision: 3, decision: 'custom', cat_analytics: 0, cat_marketing: 1,
        ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', ad_storage: 'GRANTED', analytics_storage: 'DENIED',
        client_decided_at: '2026-10-02T10:00:00.000Z', server_received_at: '2026-10-02T10:00:01.000Z', verified: 1, seq: 1
      }
    });
    const result = await retrySingle(
      makeEnv(ledger),
      rec({
        platform: 'ga4',
        consent_id: 'cid-0123456789abcdef',
        event_payload: { client_id: '1.2', events: [{ name: 'lead' }], consent: { analytics_storage: 'GRANTED' } }
      } as Partial<DeadLetterRecord>)
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, skipped: true });
  });

  it('a consent_log olvasási hibája → nincs küldés, a rekord újrapróbálható marad', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ledger = {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); }, run: async () => undefined, all: async () => ({ results: [] }) }) })
    };
    const result = await retrySingle(makeEnv(ledger), rec({ consent_id: 'cid-0123456789abcdef' } as Partial<DeadLetterRecord>));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.skipped).toBeUndefined();
  });
});
