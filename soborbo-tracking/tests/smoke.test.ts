/**
 * 6.14.0 — a napi smoke-lead site-azonosítója env-ből (TRACKING_SITE_ID).
 *
 * A `const SITE = 'REPLACE_ME_SITE_ID'` miatt egy vendorolt smoke.ts sosem
 * lehetett bájtra azonos a kanonikussal, és egy ottfelejtett placeholder
 * `smoke-REPLACE_ME_SITE_ID-…` kulcsot küldött (audit 2026-07-21, K2-L13).
 * Itt: a hiányzó / rossz id HANGOS elutasítása küldés nélkül, és a
 * `smoke-<site>-YYYYMMDD` alak megőrzése event_id-n ÉS lead_id-n.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDailySmokeLead, resolveSmokeSiteId, smokeEventId } from '../server/backend/smoke';
import type { GatewayEnv } from '../server/backend/gateway-dispatch';

const TEST_EMAIL = 'smoke@example.com';

function makeEnv(overrides: Partial<GatewayEnv> = {}): { env: GatewayEnv; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const env: GatewayEnv = {
    GATEWAY: { fetch },
    TRACKING_GATEWAY_TOKEN: 'tok',
    SITE_URL: 'https://example.com',
    TRACKING_SITE_ID: 'skinlab',
    TRACKING_TEST_LEAD_EMAIL: TEST_EMAIL,
    TRACKING_TEST_EVENT_CODE: 'TEST12345',
    ...overrides,
  };
  return { env, fetch };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('smokeEventId — a determinisztikus napi kulcs alakja', () => {
  it('smoke-<site>-YYYYMMDD (UTC nap)', () => {
    expect(smokeEventId('skinlab', new Date('2026-10-19T04:43:00Z'))).toBe('smoke-skinlab-20261019');
    expect(smokeEventId('painless', new Date('2026-01-02T23:59:59Z'))).toBe('smoke-painless-20260102');
  });

  it('a kulcs belefér a gateway event_id szabályába (max 40, [A-Za-z0-9_-])', () => {
    const id = smokeEventId('a'.repeat(25), new Date());
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('resolveSmokeSiteId — hiányzó / rossz id hangos elutasítása', () => {
  it.each([undefined, '', '   '])('TRACKING_SITE_ID=%j → undefined + console.error', (v) => {
    expect(resolveSmokeSiteId({ TRACKING_SITE_ID: v as string | undefined })).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('TRACKING_SITE_ID');
  });

  it.each(['skin lab', 'skinlab.hu', 'a'.repeat(26), 'REPLACE ME'])('érvénytelen slug %j → undefined + console.error', (v) => {
    expect(resolveSmokeSiteId({ TRACKING_SITE_ID: v })).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('not a valid site slug');
  });

  it('érvényes slug: trimmelve, változatlanul', () => {
    expect(resolveSmokeSiteId({ TRACKING_SITE_ID: ' skinlab ' })).toBe('skinlab');
    expect(resolveSmokeSiteId({ TRACKING_SITE_ID: 'olcso_kontener-2' })).toBe('olcso_kontener-2');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('runDailySmokeLead', () => {
  it('TRACKING_SITE_ID nélkül: NINCS küldés, hangos log — a digest hiányzó-sor riasztása él', async () => {
    const { env, fetch } = makeEnv({ TRACKING_SITE_ID: undefined });
    await runDailySmokeLead(env);
    expect(fetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('TRACKING_SITE_ID');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a teszt-e-mail / test-kód nélkül továbbra is elutasít (a produkciós Meta-stream védelme)', async () => {
    const { env, fetch } = makeEnv({ TRACKING_TEST_EVENT_CODE: undefined });
    await runDailySmokeLead(env);
    expect(fetch).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain('TRACKING_TEST_LEAD_EMAIL');
  });

  it('teljes konfiggal: egy POST a szerver-ingressre, event_id = lead_id = smoke-<site>-YYYYMMDD', async () => {
    const { env, fetch } = makeEnv();
    await runDailySmokeLead(env);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.com/api/event/conversion-server');
    const body = JSON.parse(String(init.body));
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(body.event_id).toBe(`smoke-skinlab-${today}`);
    expect(body.lead_id).toBe(body.event_id);
    expect(body.event_name).toBe('contact_form_submitted');
    expect(body.source).toBe('daily_smoke');
    expect(body.test_event_code).toBe('TEST12345');
    expect(body.user_data).toEqual({ email: TEST_EMAIL });
    expect(body.consent.ad_storage).toBe('GRANTED');
    expect(body.event_source_url).toBe('https://example.com/__smoke');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(String(logSpy.mock.calls[0][0])).toContain('daily synthetic lead dispatched');
  });

  it('a site id trimmelve kerül a kulcsba', async () => {
    const { env, fetch } = makeEnv({ TRACKING_SITE_ID: '  befilo ' });
    await runDailySmokeLead(env);
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.event_id).toMatch(/^smoke-befilo-\d{8}$/);
  });
});
