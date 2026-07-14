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
import { sha256Hex } from '../src/lib/hash';

/**
 * Szerver-szerver ingress (/api/event/conversion + X-Admin-Token).
 *
 * Ez a Turnstile ALTERNATÍVÁJA a site saját backendje számára. A tesztek a két
 * dolgot bizonyítják, ami miatt a változás egyáltalán megengedhető:
 *   (A) a böngésző-ág posture-je VÁLTOZATLAN (token nélkül továbbra is 403), és
 *   (B) NINCS globális bypass — egy szivárgott token blast-radiusa 1 site.
 */

const HOST = 'ingress-test.example.com';
const SITE_TOKEN = 'painless-server-token-abc123';
const GLOBAL_TOKEN = 'global-operator-token';

async function makeSiteConfig(withToken = true) {
  return {
    site_id: 'ingress-test',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
    gads: { customer_id: null, login_customer_id: null },
    ...(withToken ? { crm_token_sha256: await sha256Hex(SITE_TOKEN) } : {})
  };
}

interface DataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

function makeEnv(siteConfig: unknown): { env: any; datapoints: DataPoint[] } {
  const datapoints: DataPoint[] = [];
  const env = {
    TURNSTILE_SECRET_KEY: 'secret',
    ADMIN_API_TOKEN: GLOBAL_TOKEN,
    SITE_CONFIG: { get: async () => siteConfig },
    TRACKING_METRICS: {
      writeDataPoint: (dp: DataPoint) => datapoints.push(dp)
    }
  };
  return { env, datapoints };
}

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

/** Szerver-szerver POST: nincs turnstile_token a bodyban, van X-Admin-Token. */
function serverRequest(
  opts: {
    token?: string;
    eventName?: string;
    host?: string;
    clientIp?: string;
    clientUserAgent?: string;
    turnstileToken?: string;
    origin?: string | null;
  } = {}
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token !== undefined) headers['X-Admin-Token'] = opts.token;
  // A böngésző-ág kapuja az Origin (a Turnstile helyén). A szerver-ingress nem
  // küld Origin-t — ott a per-site token hitelesít.
  if (opts.origin !== null) headers['Origin'] = opts.origin ?? `https://${opts.host ?? HOST}`;
  // A hívó Worker transport-UA/IP-je — ezt NEM szabad a Metának küldeni.
  headers['User-Agent'] = 'Cloudflare-Worker/1.0';
  headers['CF-Connecting-IP'] = '10.0.0.1';

  const body: Record<string, unknown> = {
    event_name: opts.eventName ?? 'callback_request_submitted',
    event_id: 'evt-server-ingress-1',
    event_time: Math.floor(Date.now() / 1000),
    event_source_url: `https://${opts.host ?? HOST}/instantquote`,
    user_data: { email: 'jane@example.com' }
  };
  if (opts.turnstileToken !== undefined) body.turnstile_token = opts.turnstileToken;
  if (opts.clientIp) body.client_ip_address = opts.clientIp;
  if (opts.clientUserAgent) body.client_user_agent = opts.clientUserAgent;

  return new Request(`https://${opts.host ?? HOST}/api/event/conversion`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

/** Rögzíti a kimenő hívásokat, hogy a siteverify-t és a Meta-payloadot lássuk. */
function installFetchSpy(): { calls: string[]; metaBodies: any[] } {
  const calls: string[] = [];
  const metaBodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.includes('challenges.cloudflare.com')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes('facebook.com')) {
        if (init?.body) metaBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );
  return { calls, metaBodies };
}

describe('server-to-server ingress — acceptance', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('accepts a form conversion with a valid per-site token and NO turnstile token', async () => {
    const { calls } = installFetchSpy();
    const { env, datapoints } = makeEnv(await makeSiteConfig());
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(serverRequest({ token: SITE_TOKEN }), env, ctx);
    await Promise.all(tasks);

    expect(res.status).toBe(204);
    // Turnstile-t MEG SEM hívtuk — nincs mit ellenőrizni, és egy siteverify-
    // kimaradás nem dönthetné el a szerveroldali leadet.
    expect(calls.some((u) => u.includes('challenges.cloudflare.com'))).toBe(false);
    // Elfogadva (accepted=1) az AE-ben.
    const dps = datapoints.filter((d) => d.indexes?.[0] === 'conversion_total');
    expect(dps).toHaveLength(1);
    expect(dps[0].doubles?.[0]).toBe(1);
  });

  it('forwards the REAL end-user ip/ua to Meta, not the calling Worker transport ip/ua', async () => {
    const { metaBodies } = installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx, tasks } = collectingCtx();

    await handleConversion(
      serverRequest({
        token: SITE_TOKEN,
        clientIp: '203.0.113.9',
        clientUserAgent: 'Mozilla/5.0 (iPhone)'
      }),
      env,
      ctx
    );
    await Promise.all(tasks);

    expect(metaBodies).toHaveLength(1);
    const ud = metaBodies[0].data[0].user_data;
    expect(ud.client_ip_address).toBe('203.0.113.9');
    expect(ud.client_user_agent).toBe('Mozilla/5.0 (iPhone)');
    // A transport-értékek (a hívó Worker) NEM szivároghatnak be.
    expect(ud.client_ip_address).not.toBe('10.0.0.1');
    expect(ud.client_user_agent).not.toBe('Cloudflare-Worker/1.0');
  });

  it('IGNORES body-supplied ip/ua on the BROWSER path (anti-spoofing)', async () => {
    const { metaBodies } = installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx, tasks } = collectingCtx();

    // Nincs X-Admin-Token → böngésző-ág. Érvényes Turnstile-token, de spoofolt IP.
    await handleConversion(
      serverRequest({
        turnstileToken: 'valid-browser-token',
        clientIp: '203.0.113.9',
        clientUserAgent: 'Spoofed/1.0'
      }),
      env,
      ctx
    );
    await Promise.all(tasks);

    expect(metaBodies).toHaveLength(1);
    const ud = metaBodies[0].data[0].user_data;
    // A request-header nyer — a body-ból jövő IP/UA-t eldobjuk.
    expect(ud.client_ip_address).toBe('10.0.0.1');
    expect(ud.client_user_agent).toBe('Cloudflare-Worker/1.0');
  });
});

describe('server-to-server ingress — the browser path no longer needs a token', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // SZERZŐDÉS-VÁLTÁS: a Turnstile kikerült a gateway-ből (a secret a Cloudflare
  // teszt-kulcsa volt → mindent átengedett). A böngésző-ág kapuja most az Origin.
  it('accepts a token-less form conversion from an ALLOWED origin (no X-Admin-Token)', async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(serverRequest({}), env, ctx);
    await Promise.all(tasks);
    expect(res.status).toBe(204);
  });

  it('403s the same event from a FORBIDDEN origin', async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx } = collectingCtx();

    const res = await handleConversion(
      serverRequest({ origin: 'https://evil.example.net' }),
      env,
      ctx
    );
    expect(res.status).toBe(403);
  });
});

// A WAF rate-limiting szabály (Free plan) CSAK a `Path` mezőt tudja matchelni,
// ezért a hitelesített money-path-ot egy KÜLÖN útvonal veszi ki alóla:
// /api/event/conversion-server. Ez a kivétel viszont csak akkor biztonságos, ha az
// az útvonal NEM nyitott a böngésző előtt — különben bárki odaposztolna hamisított
// Origin-nel, és a limitet triviálisan megkerülné. Ezt zárják le az alábbiak.
describe('server-only route (WAF-exempt path) is not a back door', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('accepts a valid per-site token', async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx, tasks } = collectingCtx();

    const res = await handleConversion(
      serverRequest({ token: SITE_TOKEN, origin: null }),
      env,
      ctx,
      { serverOnly: true }
    );
    await Promise.all(tasks);
    expect(res.status).toBe(204);
  });

  it('401s a token-less request EVEN FROM AN ALLOWED ORIGIN (no browser fallback)', async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx } = collectingCtx();

    // Ugyanez a kérés a böngésző-úton 204 lenne. Itt 401 — különben a
    // rate-limit-kivétel ingyen bypass lenne.
    const res = await handleConversion(serverRequest({}), env, ctx, { serverOnly: true });
    expect(res.status).toBe(401);
  });

  it('401s the GLOBAL operator token here too', async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx } = collectingCtx();

    const res = await handleConversion(serverRequest({ token: GLOBAL_TOKEN }), env, ctx, {
      serverOnly: true
    });
    expect(res.status).toBe(401);
  });
});

describe('server-to-server ingress — tenant isolation (no global bypass)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('401s the GLOBAL ADMIN_API_TOKEN — it must NOT open the Turnstile gate for any site', async () => {
    const { calls } = installFetchSpy();
    const { env, datapoints } = makeEnv(await makeSiteConfig());
    const { ctx } = collectingCtx();

    const res = await handleConversion(serverRequest({ token: GLOBAL_TOKEN }), env, ctx);

    expect(res.status).toBe(401);
    // És NEM esik vissza csendben a Turnstile-ágra.
    expect(calls.some((u) => u.includes('challenges.cloudflare.com'))).toBe(false);
    const dps = datapoints.filter((d) => d.indexes?.[0] === 'conversion_total');
    expect(dps[0].doubles?.[0]).toBe(0);
    expect(dps[0].blobs).toContain(TrackingErrorCode.SERVER_INGRESS_UNAUTHORIZED);
  });

  it("401s another site's token (cross-tenant attempt)", async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig());
    const { ctx } = collectingCtx();

    const res = await handleConversion(serverRequest({ token: 'some-other-site-token' }), env, ctx);
    expect(res.status).toBe(401);
  });

  it('401s a token for a site that has NO crm_token_sha256 provisioned', async () => {
    installFetchSpy();
    const { env } = makeEnv(await makeSiteConfig(false));
    const { ctx } = collectingCtx();

    const res = await handleConversion(serverRequest({ token: SITE_TOKEN }), env, ctx);
    expect(res.status).toBe(401);
  });
});
