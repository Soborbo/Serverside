import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import {
  buildConsentTelemetry,
  parseConsent,
  parseSboConsentCookieHeader,
  resolveConsent,
  CONSENT_SOURCE_UNAVAILABLE,
  type ConsentSourceSnapshot
} from '../src/lib/consent';
import { sha256Hex } from '../src/lib/hash';

/**
 * 2026-10 CMP pilot-review, A1/B1 — a worker SAJÁT süti-olvasata sbo site-on.
 *
 * A SkinLab 6.9.0-s kliense nem küld `consent_sources`-t, ezért a receipt
 * `source_used='none'`-t mutatott egy valójában `sbo_consent`-tel kapuzott döntés
 * fölött (60 sor). A worker eddig CSAK a `cookieyes-consent`-et olvasta — sbo
 * alatt ez egy 09-18 előtti maradvány. Ezek a tesztek őrzik, hogy (1) sbo alatt a
 * saját süti a szerver-olvasat, és (2) a régi CookieYes-maradvány eltérése
 * `consent_strict` mellett SEM blokkol valódi konverziót.
 */

const NONE = { ...CONSENT_SOURCE_UNAVAILABLE };
const snap = (analytics: boolean | null, marketing: boolean | null): ConsentSourceSnapshot => ({
  analytics,
  marketing
});
const CONSENT_ID = '74412686-71b9-494c-8b8b-044969b7ed66';
const sboCookie = (a: 0 | 1, m: 0 | 1, decision = 'accept_all') =>
  `sbo_consent=v2.${a}.${m}.1.${decision}.${CONSENT_ID}.1760000000.2026-09-18-a`;

describe('parseSboConsentCookieHeader', () => {
  it('érvényes accept_all → mindkét kategória true', () => {
    expect(parseSboConsentCookieHeader(`_ga=GA1.1.1.2; ${sboCookie(1, 1)}`).snapshot).toEqual(snap(true, true));
  });

  it('reject_all → mindkét kategória false (a nem ≠ a nincs)', () => {
    expect(parseSboConsentCookieHeader(sboCookie(0, 0, 'reject_all')).snapshot).toEqual(snap(false, false));
  });

  it('percent-kódolt érték is olvasható', () => {
    const enc = `sbo_consent=${encodeURIComponent(`v2.1.0.3.custom.${CONSENT_ID}.1760000000.p`)}`;
    expect(parseSboConsentCookieHeader(enc).snapshot).toEqual(snap(true, false));
  });

  it('a nyers sütit NEM adja vissza — consent_id nem kerülhet a consent_debug-ba', () => {
    expect(parseSboConsentCookieHeader(sboCookie(1, 1)).raw).toBeUndefined();
  });

  it.each([
    ['nincs header', null],
    ['nincs sbo süti', '_ga=GA1.1.1.2; cookieyes-consent=consent%3Ayes%2Cadvertisement%3Ayes'],
    ['rossz verzió', `sbo_consent=v1.1.1.1.accept_all.${CONSENT_ID}.1760000000.p`],
    ['csonka', 'sbo_consent=v2.1.1.1.accept_all'],
    ['nem bit kategória', `sbo_consent=v2.2.1.1.accept_all.${CONSENT_ID}.1760000000.p`],
    ['ismeretlen döntés', `sbo_consent=v2.1.1.1.maybe.${CONSENT_ID}.1760000000.p`],
    ['revision 0', `sbo_consent=v2.1.1.0.accept_all.${CONSENT_ID}.1760000000.p`],
    ['rövid consent_id', 'sbo_consent=v2.1.1.1.accept_all.abc.1760000000.p']
  ])('%s → minden NULL, nem találgatunk', (_name, header) => {
    expect(parseSboConsentCookieHeader(header).snapshot).toEqual(NONE);
  });
});

describe('buildConsentTelemetry — sbo site', () => {
  const granted = {
    ad_user_data: 'GRANTED',
    ad_personalization: 'GRANTED',
    ad_storage: 'GRANTED',
    analytics_storage: 'GRANTED'
  };
  const build = (over: Partial<Parameters<typeof buildConsentTelemetry>[0]> = {}) => {
    const consent = parseConsent(granted);
    return buildConsentTelemetry({
      rawConsent: granted,
      rawSources: undefined,
      consent,
      baseAdAllowed: resolveConsent(consent, true).adAllowed,
      requireConsent: true,
      strict: true,
      ingressKind: 'browser',
      serverCookie: { snapshot: NONE },
      ...over
    });
  };

  it('régi kliens (nincs forrás-blokk) + sbo süti a headerben → server_cookie, nem none', () => {
    const t = build({ sboSite: true, serverCookie: { snapshot: snap(true, true) } });
    expect(t.sources.source_used).toBe('server_cookie');
    expect(t.sources.server).toEqual(snap(true, true));
    expect(t.adAllowed).toBe(true);
  });

  // A régi CookieYes-süti „nem"-et mond, a saját süti „igen"-t: a kliens cookie-
  // snapshotja (CookieYes) és a szerver-olvasat (sbo) eltér. sbo alatt a
  // CookieYes nem döntési forrás → nem lehet TRK-910-003, nem lehet strict-blokk.
  const staleCookieYes = {
    cookie: { analytics: false, marketing: false },
    api: { analytics: null, marketing: null },
    source_used: 'sbo_cookie',
    client_lib_version: '6.17.3'
  };

  it('sbo site: régi CookieYes-maradvány eltérése NEM blokkol strict mellett', () => {
    const t = build({ sboSite: true, rawSources: staleCookieYes, serverCookie: { snapshot: snap(true, true) } });
    expect(t.diagnostics.findings).not.toContain('source_mismatch');
    expect(t.strictBlocked).toBe(false);
    expect(t.adAllowed).toBe(true);
    // A receiptre a CookieYes-olvasat változatlanul kiíródik (mérési ablak).
    expect(t.sources.cookie).toEqual(snap(false, false));
    expect(t.sources.source_used).toBe('sbo_cookie');
  });

  it('kontroll: ugyanez sboSite nélkül blokkolna — ezt előzi meg a kapcsoló', () => {
    const t = build({ rawSources: staleCookieYes, serverCookie: { snapshot: snap(true, true) } });
    expect(t.diagnostics.findings).toContain('source_mismatch');
    expect(t.strictBlocked).toBe(true);
  });

  it('a kapu nem lazul: sbo alatt sem lesz DENIED-ből engedély', () => {
    const consent = parseConsent({ ad_user_data: 'DENIED' });
    const t = build({
      sboSite: true,
      rawConsent: { ad_user_data: 'DENIED' },
      consent,
      baseAdAllowed: resolveConsent(consent, true).adAllowed,
      serverCookie: { snapshot: snap(true, true) }
    });
    expect(t.adAllowed).toBe(false);
  });
});

// ── Route-szint: a teljes /conversion út a valódi receipt-írással ─────────────

const HOST = 'sbo-read.example.com';
const SITE_TOKEN = 'sbo-read-token';

async function config(): Promise<Record<string, unknown>> {
  return {
    site_id: 'sbo-read',
    country_code: 'HU',
    currency: 'HUF',
    require_consent: true,
    consent_strict: true,
    consent: { provider: 'sbo', mode: 'basic' },
    meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
    expected_platforms: { smoke: ['meta'] },
    gads: { customer_id: null, login_customer_id: null },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
}

function makeLedger() {
  const receipts: unknown[][] = [];
  const ledger = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async first() {
              if (sql.includes('INSERT INTO idempotency')) {
                return { seen_count: 1, dispatched: 0, do_not_replay: 0, first_seen_at: new Date().toISOString() };
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO consent_receipts')) receipts.push(args);
              return {};
            }
          };
        }
      };
    },
    async batch() {
      return [];
    }
  };
  return { ledger, receipts };
}

async function run(cookie: string, body: Record<string, unknown>) {
  const metaCalls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('facebook.com')) {
        metaCalls.push(url);
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );
  const { ledger, receipts } = makeLedger();
  const env = {
    SITE_CONFIG: { get: async () => await config() },
    LEDGER: ledger,
    DEAD_LETTER: { put: async () => {} }
  } as never;
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException() {} } as never;
  const req = new Request(`https://${HOST}/api/event/conversion-server`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': SITE_TOKEN,
      'CF-Connecting-IP': '10.0.0.1',
      Cookie: cookie
    },
    body: JSON.stringify({
      event_name: 'callback_request_submitted',
      event_id: 'evt-sbo-read',
      event_time: Math.floor(Date.now() / 1000),
      lead_id: 'lead-sbo-read-1',
      event_source_url: `https://${HOST}/kapcsolat`,
      user_data: { email: 'x@example.com' },
      consent: {
        ad_user_data: 'GRANTED',
        ad_personalization: 'GRANTED',
        ad_storage: 'GRANTED',
        analytics_storage: 'GRANTED'
      },
      ...body
    })
  });
  const res = await handleConversion(req, env, ctx, { serverOnly: true });
  await Promise.allSettled(tasks);
  // consent_receipts bind-sorrend (ledger.ts recordConsentReceipt):
  // 15/16 = src_server_*, 17 = source_used, 18 = source_consistent, 22 = finding_codes
  const r = receipts[0] ?? [];
  return {
    status: res.status,
    metaCalls: metaCalls.length,
    srcServer: [r[15], r[16]],
    sourceUsed: r[17],
    findings: r[22]
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/conversion sbo site-on — a worker a saját sütit olvassa', () => {
  it('6.9.0-s kliens (nincs consent_sources): source_used=server_cookie, src_server a sbo-ból', async () => {
    const r = await run(sboCookie(1, 1), {});
    expect(r.sourceUsed).toBe('server_cookie');
    expect(r.srcServer).toEqual([1, 1]);
    expect(r.metaCalls).toBe(1);
  });

  it('régi CookieYes „nem" + saját süti „igen", strict=true → a konverzió MEGY', async () => {
    const r = await run(
      `cookieyes-consent=consent%3Ano%2Canalytics%3Ano%2Cadvertisement%3Ano; ${sboCookie(1, 1)}`,
      {
        consent_sources: {
          cookie: { analytics: false, marketing: false },
          api: { analytics: null, marketing: null },
          source_used: 'sbo_cookie',
          client_lib_version: '6.17.3'
        }
      }
    );
    expect(r.metaCalls).toBe(1);
    expect(r.srcServer).toEqual([1, 1]);
    expect(r.findings ?? '').not.toContain('910-003');
  });
});
