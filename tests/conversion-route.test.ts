import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import { TrackingErrorCode } from '../src/lib/error-codes';

/**
 * Konverzió-route reject-observability tesztek (2026-07-13 incidens után):
 *
 * 1. Minden elutasító ág (403 token, 404 no-config) AE-datapointot ír
 *    accepted=0-val — enélkül a néma kiesés hetekig láthatatlan (a ledger csak
 *    accepted eventet rögzít).
 * 2. Az `invalid-input-secret` a MI misconfigunk, nem bot-jelzés: low-risk
 *    eventnél degraded-accept (a money-signal nem vész el), form-eventnél
 *    továbbra is 403 (fail-closed).
 */

const HOST = 'route-test.example.com';

const SITE_CONFIG = {
  site_id: 'route-test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
  gads: { customer_id: null, login_customer_id: null }
};

interface DataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

function makeEnv(opts: { siteConfig?: unknown } = { siteConfig: SITE_CONFIG }): {
  env: any;
  datapoints: DataPoint[];
} {
  const datapoints: DataPoint[] = [];
  const env = {
    TURNSTILE_SECRET_KEY: 'secret',
    SITE_CONFIG: { get: async () => opts.siteConfig ?? null },
    TRACKING_METRICS: {
      writeDataPoint: (dp: DataPoint) => {
        datapoints.push(dp);
      }
    }
  };
  return { env, datapoints };
}

// FIGYELEM: a config.ts negatív cache-e modul-globális (60s TTL) — a 404-es
// tesztnek SAJÁT hostname kell, különben beszennyezi a többi tesztet.
function conversionRequest(eventName: string, token: string | undefined, host: string = HOST): Request {
  return new Request(`https://${host}/api/event/conversion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: eventName,
      event_id: `evt-${eventName}`,
      event_time: Math.floor(Date.now() / 1000),
      turnstile_token: token ?? '',
      event_source_url: `https://${host}/`
    })
  });
}

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

/** A `conversion_total` indexű AE-datapointok (a fan-out metrikák kiszűrve). */
function conversionDatapoints(datapoints: DataPoint[]): DataPoint[] {
  return datapoints.filter((d) => d.indexes?.[0] === 'conversion_total');
}

function installSiteverify(body: { success: boolean; 'error-codes'?: string[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('challenges.cloudflare.com')) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
      // Meta (degraded-accept fan-out) — sikeres válasz, ne legyen DLQ-ág.
      if (url.includes('facebook.com')) {
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );
}

describe('conversion route — reject paths write AE datapoints (accepted=0)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('403 invalid token → datapoint with INVALID_TURNSTILE_TOKEN, accepted=0', async () => {
    installSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
    const { env, datapoints } = makeEnv();
    const { ctx } = collectingCtx();

    const res = await handleConversion(conversionRequest('contact_form_submitted', 'bad-token'), env, ctx);
    expect(res.status).toBe(403);

    const dps = conversionDatapoints(datapoints);
    expect(dps).toHaveLength(1);
    expect(dps[0].doubles?.[0]).toBe(0); // accepted=0
    expect(dps[0].blobs).toContain(TrackingErrorCode.INVALID_TURNSTILE_TOKEN);
    expect(dps[0].blobs).toContain('route-test');
  });

  it('403 missing token (form event) → datapoint with MISSING_TURNSTILE_TOKEN', async () => {
    installSiteverify({ success: true }); // nem jut el idáig — a missing_token korábban rövidre zár
    const { env, datapoints } = makeEnv();
    const { ctx } = collectingCtx();

    const res = await handleConversion(conversionRequest('contact_form_submitted', undefined), env, ctx);
    expect(res.status).toBe(403);

    const dps = conversionDatapoints(datapoints);
    expect(dps).toHaveLength(1);
    expect(dps[0].doubles?.[0]).toBe(0);
    expect(dps[0].blobs).toContain(TrackingErrorCode.MISSING_TURNSTILE_TOKEN);
  });

  it('404 no site config → datapoint with NO_SITE_CONFIG, site_id=unknown', async () => {
    installSiteverify({ success: true });
    const { env, datapoints } = makeEnv({ siteConfig: null });
    const { ctx } = collectingCtx();

    const res = await handleConversion(
      conversionRequest('contact_form_submitted', 'tok', 'no-config.example.com'),
      env,
      ctx
    );
    expect(res.status).toBe(404);

    const dps = conversionDatapoints(datapoints);
    expect(dps).toHaveLength(1);
    expect(dps[0].doubles?.[0]).toBe(0);
    expect(dps[0].blobs).toContain(TrackingErrorCode.NO_SITE_CONFIG);
    expect(dps[0].blobs).toContain('unknown');
  });

  it('204 unknown event_name → datapoint with UNKNOWN_EVENT_NAME', async () => {
    installSiteverify({ success: true });
    const { env, datapoints } = makeEnv();
    const { ctx } = collectingCtx();

    const res = await handleConversion(conversionRequest('totally_made_up_event', 'tok'), env, ctx);
    expect(res.status).toBe(204);

    const dps = conversionDatapoints(datapoints);
    expect(dps).toHaveLength(1);
    expect(dps[0].blobs).toContain(TrackingErrorCode.UNKNOWN_EVENT_NAME);
  });
});

describe('conversion route — invalid-input-secret is a SERVER misconfig, not a bot signal', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('low-risk event (phone click) survives via degraded accept → 204', async () => {
    installSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    const { env } = makeEnv();
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(conversionRequest('phone_number_clicked', 'real-token'), env, ctx);
    expect(res.status).toBe(204);
    await Promise.allSettled(tasks);
  });

  it('form event still gets a hard 403 (fail-closed)', async () => {
    installSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    const { env, datapoints } = makeEnv();
    const { ctx } = collectingCtx();

    const res = await handleConversion(conversionRequest('contact_form_submitted', 'real-token'), env, ctx);
    expect(res.status).toBe(403);
    expect(conversionDatapoints(datapoints)).toHaveLength(1);
  });

  it('logs TURNSTILE_SECRET_INVALID at error level', async () => {
    installSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    const logs: string[] = [];
    // logStructured a level:'error'-t console.error-ra írja (types.ts).
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { env } = makeEnv();
    const { ctx } = collectingCtx();

    await handleConversion(conversionRequest('contact_form_submitted', 'real-token'), env, ctx);
    expect(logs.some((l) => l.includes(TrackingErrorCode.TURNSTILE_SECRET_INVALID))).toBe(true);
  });
});
