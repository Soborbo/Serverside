import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A notify.ts top-level `cloudflare:email` importja a Workers-runtime sajátja,
// node/vitest alatt nem feloldható. A conversion.ts csak a sendAlert-et hívja →
// kimockoljuk, hogy a valós modul (és vele a runtime-import) be se töltődjön.
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';

/**
 * Fan-out izolációs integ-teszt (net-új lefedettség). A spec-garancia:
 * a fan-out `Promise.allSettled`-t használ → EGY platform bukása NEM viszi el a
 * többit, a kliens MINDIG 204-et kap, és csak a bukott platform megy DLQ-ba.
 *
 * Ez az invariáns korábban csak per-modul tesztekkel volt fedve; itt a VALÓS
 * handleConversion → fanOut úton hajtjuk végre, hogy egy jövőbeli refaktor
 * (pl. a fanOut szétszedése) ne tudja csendben elrontani az izolációt.
 */

const HOST = 'fanout-iso.example.com';
const TURNSTILE_OK = JSON.stringify({ success: true });

const SITE_CONFIG = {
  site_id: 'fanout-iso',
  country_code: 'GB',
  currency: 'GBP',
  // Meta konfigurálva → tényleg hív (graph.facebook.com).
  meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
  // GA4 konfigurálva, DE Modell 2-ben az on-site fan-out NEM hív GA4-et
  // (a böngésző birtokolja az on-site GA4-et → nincs dupla).
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  // gads customer_id null → no-op success (nincs hívás, nincs DLQ).
  gads: { customer_id: null, login_customer_id: null }
  // require_consent unset → fail-open: adAllowed=true → Meta megy (GA4/gads on-site nélkül).
};

function makeEnv(deadLetterPut: (key: string, body: string) => void): any {
  return {
    TURNSTILE_SECRET_KEY: 'secret',
    SITE_CONFIG: { get: async () => SITE_CONFIG },
    DEAD_LETTER: {
      put: async (key: string, body: string) => {
        deadLetterPut(key, body);
      }
    }
    // Nincs LEDGER / DLQ / INGEST_LIMITER / TRACKING_METRICS binding → mind no-op.
  };
}

function conversionRequest(): Request {
  return new Request(`https://${HOST}/api/event/conversion`, {
    method: 'POST',
    // Az Origin a Turnstile eltávolítása óta a böngésző-ág KAPUJA — nélküle a
    // route 403-at ad, és sosem jutnánk el a fan-outig (lib/origin.ts).
    headers: { 'Content-Type': 'application/json', Origin: `https://${HOST}` },
    body: JSON.stringify({
      event_name: 'contact_form_submitted', // NEM quote/upgrade event → kihagyja a DO-t
      event_id: 'evt-iso-1',
      event_time: Math.floor(Date.now() / 1000),
      turnstile_token: 'tok',
      value: 250,
      currency: 'GBP',
      event_source_url: `https://${HOST}/contact`,
      fbp: 'fb.1.1700000000.1234567890',
      user_data: { email: 'a@b.com' }
    })
  });
}

/** ctx, ami a háttér- (waitUntil) promise-okat gyűjti, hogy a teszt bevárja. */
function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

describe('fan-out platform isolation (handleConversion → fanOut)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let fetchedUrls: string[];

  function installFetch(metaStatus: number) {
    fetchedUrls = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);
      if (url.includes('challenges.cloudflare.com')) {
        return new Response(TURNSTILE_OK, { status: 200 });
      }
      if (url.includes('facebook.com')) {
        // 200 → events_received>0 = success; 500 → !ok = failure (DLQ).
        return new Response(JSON.stringify({ events_received: 1 }), { status: metaStatus });
      }
      if (url.includes('google-analytics.com')) {
        return new Response(null, { status: 204 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Meta fails (500) → client still 204, GA4 NOT fired on-site (Model 2), ONLY Meta lands in DLQ', async () => {
    installFetch(500);
    const deadKeys: string[] = [];
    const env = makeEnv((key) => deadKeys.push(key));
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(conversionRequest(), env, ctx);
    expect(res.status).toBe(204); // a kliens sosem lát platform-hibát

    await Promise.allSettled(tasks); // bevárjuk a háttér fan-outot

    // Modell 2: a GA4 on-site NEM hívódik (a böngésző birtokolja); a Meta IGEN.
    expect(fetchedUrls.some((u) => u.includes('google-analytics.com'))).toBe(false);
    expect(fetchedUrls.some((u) => u.includes('facebook.com'))).toBe(true);

    // Pontosan a Meta ment DLQ-ba; GA4/gads/tiktok/linkedin/msads nem.
    expect(deadKeys).toHaveLength(1);
    expect(deadKeys[0]).toContain('/meta/');
  });

  it('all platforms succeed → client 204, zero DLQ writes', async () => {
    installFetch(200);
    const deadKeys: string[] = [];
    const env = makeEnv((key) => deadKeys.push(key));
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(conversionRequest(), env, ctx);
    expect(res.status).toBe(204);

    await Promise.allSettled(tasks);

    expect(deadKeys).toHaveLength(0);
  });
});
