import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd server-ingress.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import { hashUserData, mapPrehashedUserData, sha256Hex } from '../src/lib/hash';

/**
 * F3-A/2 · Prehashed PII contract.
 *
 * A CRM outbox már-hash-elt user_data-t küld (`user_data_hashed`), hogy a gateway NE
 * hash-eljen újra — a dupla hash némán nullára viszi a Meta match rate-et. A tesztek
 * a szerződés négy invariánsát bizonyítják:
 *   (1) nyers és prehashed út UGYANAZT a hash-t adja (regresszió, nincs dupla hash);
 *   (2) `user_data` és `user_data_hashed` kölcsönösen kizáró (400);
 *   (3) nem-64-hex mező → 400 (nem néma átengedés);
 *   (4) a böngésző-ág eldobja a prehashed mezőt (szerver-ingress-only trust field).
 */

const HOST = 'prehash-test.example.com';
const SITE_TOKEN = 'prehash-site-token-abc123';

async function makeSiteConfig() {
  return {
    site_id: 'prehash-test',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: '1234567890', access_token: 'TOKEN' },
    gads: { customer_id: null, login_customer_id: null },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
}

function makeEnv(siteConfig: unknown): any {
  return {
    TURNSTILE_SECRET_KEY: 'secret',
    ADMIN_API_TOKEN: 'global-operator-token',
    SITE_CONFIG: { get: async () => siteConfig },
    TRACKING_METRICS: { writeDataPoint: () => {} }
  };
}

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

function convRequest(opts: {
  token?: string;
  eventName?: string;
  userData?: Record<string, unknown>;
  userDataHashed?: Record<string, unknown>;
}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: `https://${HOST}`,
    'User-Agent': 'Cloudflare-Worker/1.0',
    'CF-Connecting-IP': '10.0.0.1'
  };
  if (opts.token !== undefined) headers['X-Admin-Token'] = opts.token;

  const body: Record<string, unknown> = {
    event_name: opts.eventName ?? 'callback_request_submitted',
    event_id: 'evt-prehash-1',
    event_time: Math.floor(Date.now() / 1000),
    event_source_url: `https://${HOST}/instantquote`
  };
  if (opts.userData !== undefined) body.user_data = opts.userData;
  if (opts.userDataHashed !== undefined) body.user_data_hashed = opts.userDataHashed;

  return new Request(`https://${HOST}/api/event/conversion`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

function installFetchSpy(): { calls: string[]; metaBodies: any[] } {
  const calls: string[] = [];
  const metaBodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.includes('facebook.com')) {
        if (init?.body) metaBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    })
  );
  return { calls, metaBodies };
}

// ── Unit: mapPrehashedUserData ──────────────────────────────────────────────

describe('mapPrehashedUserData (unit)', () => {
  const hex = (c: string) => c.repeat(64);

  it('maps sha256_* fields to HashedUserData keys and does NOT re-hash', () => {
    const r = mapPrehashedUserData({
      sha256_email: hex('a'),
      sha256_phone: hex('b'),
      sha256_first_name: hex('c'),
      sha256_last_name: hex('d'),
      sha256_city: hex('e'),
      sha256_postal_code: hex('f'),
      sha256_country: hex('0'),
      sha256_external_id: hex('9')
    });
    expect('data' in r).toBe(true);
    if (!('data' in r)) throw new Error('unreachable');
    // pass-through: the value is the exact input, NOT sha256(input).
    expect(r.data).toEqual({
      em: hex('a'),
      ph: hex('b'),
      fn: hex('c'),
      ln: hex('d'),
      ct: hex('e'),
      zp: hex('f'),
      country: hex('0'),
      external_id: hex('9')
    });
  });

  it('skips undefined/null fields', () => {
    const r = mapPrehashedUserData({ sha256_email: hex('a'), sha256_phone: undefined, sha256_city: null });
    expect(r).toEqual({ data: { em: hex('a') } });
  });

  it('fails loud on unknown keys (a rossz kulcsnév NEM némán eldobva)', () => {
    // Egy ismeretlen kulcs (pl. a régi doksi `email_sha256_google`-je, vagy egy
    // elgépelt mező) NEM csúszhat át némán: a hozzá tartozó identity-hash különben
    // jeltelenül elveszne (romló match). Fail-loud a mezőNÉVvel (a hash nem PII).
    const r = mapPrehashedUserData({ sha256_email: hex('a'), sha256_future_field: hex('b') });
    expect(r).toEqual({ invalidField: 'sha256_future_field' });

    const r2 = mapPrehashedUserData({ email_sha256_google: hex('a') });
    expect(r2).toEqual({ invalidField: 'email_sha256_google' });
  });

  it.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex char', 'g'.repeat(64)],
    ['not a string', 12345 as unknown as string]
  ])('rejects an invalid sha256_email (%s) with the field name', (_label, bad) => {
    const r = mapPrehashedUserData({ sha256_email: bad });
    expect(r).toEqual({ invalidField: 'sha256_email' });
  });
});

// ── Route: server ingress ───────────────────────────────────────────────────

describe('prehashed PII contract — route (server ingress)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('REGRESSION: raw and prehashed paths send the IDENTICAL Meta user_data hashes', async () => {
    const rawUserData = {
      email: 'Jane@Email.com',
      phone_number: '07123456789',
      first_name: 'Jane',
      city: 'Pécs'
    };
    // The hashes the CRM would compute with the same normalizer as the gateway:
    const hashed = await hashUserData(rawUserData, 'GB');

    // Run A — raw path (gateway hashes).
    const spyA = installFetchSpy();
    const { ctx: ctxA, tasks: tA } = collectingCtx();
    const resA = await handleConversion(
      convRequest({ token: SITE_TOKEN, userData: rawUserData }),
      makeEnv(await makeSiteConfig()),
      ctxA
    );
    await Promise.all(tA);
    vi.unstubAllGlobals();

    // Run B — prehashed path (gateway must NOT re-hash).
    const spyB = installFetchSpy();
    const { ctx: ctxB, tasks: tB } = collectingCtx();
    const resB = await handleConversion(
      convRequest({
        token: SITE_TOKEN,
        userDataHashed: {
          sha256_email: hashed.em,
          sha256_phone: hashed.ph,
          sha256_first_name: hashed.fn,
          sha256_city: hashed.ct
        }
      }),
      makeEnv(await makeSiteConfig()),
      ctxB
    );
    await Promise.all(tB);

    expect(resA.status).toBe(204);
    expect(resB.status).toBe(204);
    const udA = spyA.metaBodies[0].data[0].user_data;
    const udB = spyB.metaBodies[0].data[0].user_data;
    expect(udB.em).toBe(udA.em);
    expect(udB.ph).toBe(udA.ph);
    expect(udB.fn).toBe(udA.fn);
    expect(udB.ct).toBe(udA.ct);
    // and the prehashed value is passed through verbatim (no double hash):
    expect(udB.em).toBe(hashed.em);
  });

  it('400s when BOTH user_data and user_data_hashed are present (mutually exclusive)', async () => {
    const { calls } = installFetchSpy();
    const { ctx } = collectingCtx();
    const res = await handleConversion(
      convRequest({
        token: SITE_TOKEN,
        userData: { email: 'jane@example.com' },
        userDataHashed: { sha256_email: 'a'.repeat(64) }
      }),
      makeEnv(await makeSiteConfig()),
      ctx
    );
    expect(res.status).toBe(400);
    expect(calls.some((u) => u.includes('facebook.com'))).toBe(false);
  });

  it('400s when a user_data_hashed field is not 64-char lowercase hex', async () => {
    const { calls } = installFetchSpy();
    const { ctx } = collectingCtx();
    const res = await handleConversion(
      convRequest({ token: SITE_TOKEN, userDataHashed: { sha256_email: 'NOT-A-VALID-HASH' } }),
      makeEnv(await makeSiteConfig()),
      ctx
    );
    expect(res.status).toBe(400);
    expect(calls.some((u) => u.includes('facebook.com'))).toBe(false);
  });

  it('accepts a valid prehashed-only payload and forwards the exact hashes', async () => {
    const em = 'a'.repeat(64);
    const { metaBodies } = installFetchSpy();
    const { ctx, tasks } = collectingCtx();
    const res = await handleConversion(
      convRequest({ token: SITE_TOKEN, userDataHashed: { sha256_email: em } }),
      makeEnv(await makeSiteConfig()),
      ctx
    );
    await Promise.all(tasks);
    expect(res.status).toBe(204);
    expect(metaBodies[0].data[0].user_data.em).toBe(em);
  });
});

// ── Route: browser path (prehashed is server-ingress-only) ──────────────────

describe('prehashed PII contract — browser path strips user_data_hashed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does NOT 400 on an INVALID user_data_hashed from a token-less browser event — it is stripped, not validated', async () => {
    installFetchSpy();
    const { ctx, tasks } = collectingCtx();
    // No token → browser path. A low-risk click event. If the prehashed field were
    // honored here, the invalid hex would 400; instead it is dropped → 204.
    const res = await handleConversion(
      convRequest({ eventName: 'phone_number_clicked', userDataHashed: { sha256_email: 'INVALID' } }),
      makeEnv(await makeSiteConfig()),
      ctx
    );
    await Promise.all(tasks);
    expect(res.status).toBe(204);
  });
});
