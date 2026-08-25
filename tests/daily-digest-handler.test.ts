import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentEmails: { subject: string; html: string }[] = [];
vi.mock('../src/lib/notify', () => ({
  sendAdminEmail: vi.fn(async (_env: unknown, subject: string, html: string) => {
    sentEmails.push({ subject, html });
    return true;
  }),
  sendAlert: vi.fn(async () => {}),
  sendCriticalSMS: vi.fn(async () => {}),
  escapeHtml: (s: string) => s
}));

import { handleDailyDigest } from '../src/scheduled/daily-digest';
import { TrackingErrorCode } from '../src/lib/error-codes';

/**
 * A napi digest TELJES kezelője — eddig csak a részgyűjtői (collect*) voltak
 * tesztelve, maga a handler nem. Márpedig a riasztás ITT dől el: a
 * részgyűjtők adatot adnak, a handler dönti el, mi számít vészjelnek, és mi
 * kerül a levélbe.
 *
 * A konkrét ok, amiért ez a fájl megszületett: a szintetikus smoke-lead lánc
 * bukása kód nélküli `level:'error'` sort írt. A napi „él-e a pénz-út" próba
 * eredménye tehát egy mondatban tűnt el, amire nem lehetett riasztást kötni.
 */

const logs: Record<string, unknown>[] = [];

/**
 * Ledger-stub. A digest több különböző lekérdezést futtat ugyanazon a
 * bindingen; a SQL alapján válogatunk, hogy a smoke-ág vezérelhető legyen.
 */
function makeLedger(smokeRows: Record<string, unknown>[]) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => ({ results: sql.includes('smoke') || sql.includes('lead_id LIKE') ? smokeRows : [] }),
        first: async () => null,
        run: async () => ({})
      }),
      all: async () => ({ results: [] }),
      first: async () => null
    })
  };
}

function makeEnv(smokeRows: Record<string, unknown>[]): never {
  return {
    SMOKE_SITES: 'painless',
    SITE_CONFIG: {
      list: async () => ({
        keys: [{ name: 'painlessremovals.com' }],
        list_complete: true
      }),
      get: async () => ({ site_id: 'painless', expected_platforms: { smoke: ['meta'] } })
    },
    LEDGER: makeLedger(smokeRows),
    DEAD_LETTER: { list: async () => ({ objects: [], truncated: false }) },
    ADMIN_EMAIL: { send: async () => {} }
  } as never;
}

beforeEach(() => {
  logs.length = 0;
  sentEmails.length = 0;
  const capture = (line: unknown) => {
    try { logs.push(JSON.parse(String(line))); } catch { /* nem strukturált sor */ }
  };
  vi.spyOn(console, 'log').mockImplementation(capture as never);
  vi.spyOn(console, 'warn').mockImplementation(capture as never);
  vi.spyOn(console, 'error').mockImplementation(capture as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('handleDailyDigest — a smoke-lánc bukása nem tűnik el a szövegben', () => {
  it('bukott smoke-lead → TRK-950-021 strukturált error, nem csak egy mondat a levélben', async () => {
    // Az elvárt `meta` platform `skipped` — ez a lomtalan 2026-07-15 esete:
    // a KV-ből kiesett a meta blokk, és a fan-out némán skip-re váltott.
    await handleDailyDigest(
      makeEnv([{ site_id: 'painless', platform: 'meta', status: 'skipped', http_status: null }])
    );

    const hit = logs.find((l) => l.error_code === TrackingErrorCode.SMOKE_LEAD_CHECK_FAILED);
    expect(hit, 'a smoke-bukás kód nélkül maradt').toBeTruthy();
    expect(hit!.level).toBe('error');
  });

  it('ép smoke-lánc → NINCS TRK-950-021 (a jelzés nem zajos)', async () => {
    await handleDailyDigest(
      makeEnv([{ site_id: 'painless', platform: 'meta', status: 'accepted', http_status: 200 }])
    );
    expect(logs.find((l) => l.error_code === TrackingErrorCode.SMOKE_LEAD_CHECK_FAILED)).toBeUndefined();
  });

  it('a digest minden esetben KIMEGY — a néma nap nem lehet „nincs hír, jó hír"', async () => {
    await handleDailyDigest(
      makeEnv([{ site_id: 'painless', platform: 'meta', status: 'accepted', http_status: 200 }])
    );
    expect(sentEmails.length).toBe(1);
  });
});
