import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { assessUploadWindow } from '../src/routes/lead-status';
import { retrySingle } from '../src/scheduled/retry';
import type { DeadLetterRecord } from '../src/lib/deadletter';
import type { Env } from '../src/env';

/**
 * 2026-10-18 review R8 — második utóellenőrzés. Hivatalos forrás (Google Ads Help,
 * „Guidelines for importing offline conversions", answer/15081888):
 *   - kattintásazonosítós offline import: a KAPCSOLÓDÓ UTOLSÓ kattintás után
 *     legfeljebb 90 nappal feltöltve;
 *   - Enhanced Conversions for Leads (csak személyes adat): legfeljebb 63 nappal.
 * Külön szabály (answer/3123169): a konverziós ablak (1–90 nap, műveletenként
 * állítható) a kattintás és a KONVERZIÓ közti időt korlátozza — ezt innen nem
 * látjuk, ezért nem is állítunk róla semmit.
 *
 * Az elvárt működés: kattintás / esemény / feltöltés / azonosítási mód külön; az
 * első ismert lead-esemény NEM a kattintás alsó becslése (egy régi leadhez új
 * kattintás tartozhat); bizonytalan adatból se biztos „within", se „expired".
 */

const DAY = 86_400_000;
const click = '2026-06-01T10:00:00.000Z';
const plus = (d: number) => new Date(Date.parse(click) + d * DAY).toISOString();

describe('assessUploadWindow — a négy időpont/mód külön', () => {
  it('időben történt esemény, késői első feltöltés → expired (a feltöltés ideje számít)', () => {
    expect(assessUploadWindow(plus(10), { clickAtIso: click, uploadAtIso: plus(95), hasClickId: true }))
      .toMatchObject({ status: 'expired', reference: 'click_at', limit_days: 90 });
  });

  it('hiányzó kattintási idő, friss konverzió → unknown (nem within)', () => {
    expect(assessUploadWindow(plus(10), { uploadAtIso: plus(12), hasClickId: true }))
      .toMatchObject({ status: 'unknown', reference: null });
  });

  it('hiányzó kattintási idő, de már a konverzió is régebbi a határnál → expired (az utolsó kattintás a konverzió ELŐTT volt)', () => {
    expect(assessUploadWindow(plus(0), { uploadAtIso: plus(64), hasClickId: false }))
      .toMatchObject({ status: 'expired', reference: 'occurred_at', limit_days: 63 });
  });

  it('régi leadhez kapcsolódó új kattintás: a lead első eseménye NEM bizonyít lejáratot', () => {
    // A lead 70 napja jelent meg, a konverzió friss: egy ÚJ kattintás is vezethetett hozzá.
    expect(
      assessUploadWindow(plus(70), { leadFirstSeenIso: click, uploadAtIso: plus(71), hasClickId: false } as never)
    ).toMatchObject({ status: 'unknown' });
  });

  it('eltérő azonosítási mód: ugyanaz a 70 napos kattintás click ID-vel within, személyes adattal NEM biztos lejárat', () => {
    const at = { clickAtIso: click, uploadAtIso: plus(70) };
    expect(assessUploadWindow(plus(30), { ...at, hasClickId: true }).status).toBe('within');
    // Személyes adatnál a Google a felhasználó UTOLSÓ kattintásához köt, ami lehet
    // újabb a CRM által ismertnél → a régi kattintás kora nem bizonyít lejáratot.
    expect(assessUploadWindow(plus(30), { ...at, hasClickId: false })).toMatchObject({
      status: 'unknown', identification: 'user_data', limit_days: 63
    });
    // …a határon belüli ismert kattintás viszont mindkét módban biztosan belefér.
    expect(assessUploadWindow(plus(30), { clickAtIso: click, uploadAtIso: plus(40), hasClickId: false }).status).toBe('within');
  });

  it('hibás időrend (a kattintás a konverzió UTÁN) → unknown, a hibás pontból nem számolunk', () => {
    expect(assessUploadWindow(plus(5), { clickAtIso: plus(10), uploadAtIso: plus(11), hasClickId: true }))
      .toMatchObject({ status: 'unknown', reference: 'click_after_conversion' });
  });
});

describe('újraküldés — a határidőt az AKKORI időpont dönti el', () => {
  const OFFLINE_SITE = {
    site_id: 'r8site',
    country_code: 'GB',
    currency: 'GBP',
    gads: { customer_id: '1234567890', login_customer_id: null, conversion_actions: { lead_qualified: '99887766' } }
  };
  const env = {
    GADS_OAUTH_CLIENT_ID: 'c',
    GADS_OAUTH_CLIENT_SECRET: 's',
    SITE_CONFIG: { get: async () => OFFLINE_SITE },
    OAUTH_TOKENS: { get: async (k: string) => (k.endsWith(':access_token') ? 'cached' : null), put: async () => undefined },
    LEDGER: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => undefined, all: async () => ({ results: [] }) }) }) }
  } as unknown as Env;
  const record = (clickDaysAgo: number): DeadLetterRecord =>
    ({
      platform: 'gads',
      site_id: 'r8site',
      hostname: 'r8.example',
      lead_id: 'lead-12345678',
      event_payload: {
        event_name: 'lead_qualified',
        event_id: 'order-r8',
        event_time: Math.floor((Date.now() - (clickDaysAgo - 2) * DAY) / 1000),
        gclid: 'Cj0KCQjw-test-gclid',
        click_at: new Date(Date.now() - clickDaysAgo * DAY).toISOString()
      },
      hashed_user_data: {},
      failure_reason: 'timeout',
      retry_count: 1,
      first_failed_at: new Date(Date.now() - 5 * DAY).toISOString(),
      last_attempted_at: new Date(Date.now() - DAY).toISOString()
    }) as DeadLetterRecord;

  afterEach(() => vi.unstubAllGlobals());

  it('határidő előtt sorba került, utána újraküldött esemény → conversion_window_expired, nincs hívás', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await retrySingle(env, record(92));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, skipped: true, skip_reason: 'conversion_window_expired' });
  });

  it('a határidőn belül újraküldött esemény kimegy', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ requestId: 'r' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await retrySingle(env, record(30));
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('újraküldés — hiányzó event_time nem dob', () => {
  it('event_time nélküli régi gads-rekord: nincs RangeError, a határidő ismeretlen → a Google dönt', () => {
    expect(assessUploadWindow('', { uploadAtIso: new Date().toISOString(), hasClickId: true }).status).toBe('unknown');
  });
});
