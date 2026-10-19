import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A notify.ts top-level `cloudflare:email` importja node alatt nem oldható fel
// (lásd fanout-isolation.test.ts) — kimockoljuk; az alertet csak számoljuk.
const alerts: string[] = [];
vi.mock('../src/lib/notify', () => ({
  sendAlert: async (_env: unknown, code: string) => {
    alerts.push(code);
  },
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

// A fan-out SZINKRON felépítésének hibáját idézzük elő: a hash-elt user_data
// első olvasása (recordEventRaw `em_present`) a fanOut try-blokkjában történik.
// Egy dobó getter pontosan azt a „váratlan setup-hibát" adja, amire a
// TRK-000-008 ág készült — valós úton, a handleConversion-ön át.
vi.mock('../src/lib/hash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/hash')>();
  return {
    ...actual,
    hashUserData: async () =>
      Object.defineProperty({}, 'em', {
        enumerable: true,
        get() {
          throw new Error('boom: payload build');
        }
      })
  };
});

import { handleConversion } from '../src/routes/conversion';
import { TrackingErrorCode } from '../src/lib/error-codes';

const HOST = 'fanout-setup.example.com';

const SITE_CONFIG = {
  site_id: 'fanout-setup',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: { customer_id: null, login_customer_id: null }
};

function conversionRequest(): Request {
  return new Request(`https://${HOST}/api/event/conversion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `https://${HOST}` },
    body: JSON.stringify({
      event_name: 'phone_number_clicked',
      event_id: 'evt-setup-1',
      event_time: Math.floor(Date.now() / 1000),
      turnstile_token: 'tok',
      event_source_url: `https://${HOST}/contact`,
      user_data: { email: 'a@b.com' }
    })
  });
}

describe('fan-out setup hiba (TRK-000-008)', () => {
  let logged: string[];

  beforeEach(() => {
    alerts.length = 0;
    logged = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('challenges.cloudflare.com')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('szinkron setup-hiba → CRITICAL log + alert, nem némán nyelődik el', async () => {
    const tasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
      passThroughOnException() {}
    } as unknown as ExecutionContext;
    const env = {
      TURNSTILE_SECRET_KEY: 'secret',
      SITE_CONFIG: { get: async () => SITE_CONFIG },
      DEAD_LETTER: { put: async () => {} }
    } as any;

    await handleConversion(conversionRequest(), env, ctx);
    await Promise.allSettled(tasks);

    const setupLog = logged.find((l) => l.includes(TrackingErrorCode.FANOUT_SETUP_FAILED));
    expect(setupLog).toBeDefined();
    expect(setupLog).toContain('boom: payload build');
    expect(alerts).toContain(TrackingErrorCode.FANOUT_SETUP_FAILED);
  });
});
