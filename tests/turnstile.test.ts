import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateTurnstile } from '../src/lib/turnstile';
import type { Env } from '../src/env';

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    TURNSTILE_SECRET_KEY: 'test-secret',
    ...extra
  } as unknown as Env;
}

describe('validateTurnstile — input validation', () => {
  it('rejects missing token', async () => {
    const env = makeEnv();
    const result = await validateTurnstile(undefined, undefined, env);
    expect(result.valid).toBe(false);
    expect(result.errorCodes).toContain('missing_token');
  });

  it('rejects empty string token', async () => {
    const env = makeEnv();
    const result = await validateTurnstile('', undefined, env);
    expect(result.valid).toBe(false);
    expect(result.errorCodes).toContain('missing_token');
  });
});

describe('validateTurnstile — fail-closed default (security audit fix)', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns valid:false on network error WITHOUT TURNSTILE_FAILOPEN flag', async () => {
    const env = makeEnv();
    const result = await validateTurnstile('any-token', undefined, env);
    expect(result.valid).toBe(false);
    expect(result.errorCodes).toContain('service_unavailable');
  });

  it('returns valid:true on network error WITH TURNSTILE_FAILOPEN=1 (explicit opt-in)', async () => {
    const env = makeEnv({ TURNSTILE_FAILOPEN: '1' });
    const result = await validateTurnstile('any-token', undefined, env);
    expect(result.valid).toBe(true);
    expect(result.errorCodes).toContain('service_unavailable_failopen');
  });

  it('returns valid:false when TURNSTILE_FAILOPEN is anything else', async () => {
    const env = makeEnv({ TURNSTILE_FAILOPEN: 'true' as string });
    const result = await validateTurnstile('any-token', undefined, env);
    expect(result.valid).toBe(false);
  });
});

describe('validateTurnstile — non-OK upstream response', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fail-closed on 5xx without flag', async () => {
    const env = makeEnv();
    const result = await validateTurnstile('any-token', undefined, env);
    expect(result.valid).toBe(false);
  });

  it('fail-open with TURNSTILE_FAILOPEN=1', async () => {
    const env = makeEnv({ TURNSTILE_FAILOPEN: '1' });
    const result = await validateTurnstile('any-token', undefined, env);
    expect(result.valid).toBe(true);
  });
});

describe('validateTurnstile — successful upstream', () => {
  it('passes through successful validation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    const env = makeEnv();
    const result = await validateTurnstile('valid-token', undefined, env);
    expect(result.valid).toBe(true);
    vi.restoreAllMocks();
  });

  it('rejects upstream-rejected token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    const env = makeEnv();
    const result = await validateTurnstile('bad-token', undefined, env);
    expect(result.valid).toBe(false);
    expect(result.errorCodes).toContain('invalid-input-response');
    vi.restoreAllMocks();
  });
});

function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true })
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

describe('validateTurnstile — verdict cache (TASK 1: 4-min token reuse)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('caches a positive verdict; reuse hits cache without a 2nd siteverify', async () => {
    const fetchSpy = mockFetch({ success: true });
    const cache = makeKV();
    const env = makeEnv({ TURNSTILE_CACHE: cache });

    const r1 = await validateTurnstile('tok-A', '1.2.3.4', env);
    expect(r1.valid).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(1);

    // Second event in the 4-min window reuses the same token → cache hit.
    const r2 = await validateTurnstile('tok-A', '1.2.3.4', env);
    expect(r2.valid).toBe(true);
    expect(r2.errorCodes).toContain('cache_hit');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // NOT re-verified → no duplicate 403
  });

  it('lenient (default): timeout-or-duplicate on cache-miss is ACCEPTED', async () => {
    mockFetch({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    const env = makeEnv({ TURNSTILE_CACHE: makeKV() });
    const r = await validateTurnstile('reused-tok', undefined, env);
    expect(r.valid).toBe(true);
    expect(r.errorCodes).toContain('reused_token_accepted');
  });

  it('strict (TURNSTILE_STRICT=1): timeout-or-duplicate on cache-miss is REJECTED', async () => {
    mockFetch({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    const env = makeEnv({ TURNSTILE_CACHE: makeKV(), TURNSTILE_STRICT: '1' });
    const r = await validateTurnstile('reused-tok', undefined, env);
    expect(r.valid).toBe(false);
    expect(r.errorCodes).toContain('timeout-or-duplicate');
  });

  it('caches a definitive invalid verdict; 2nd call short-circuits without siteverify', async () => {
    const fetchSpy = mockFetch({ success: false, 'error-codes': ['invalid-input-response'] });
    const cache = makeKV();
    const env = makeEnv({ TURNSTILE_CACHE: cache });

    const r1 = await validateTurnstile('spam-tok', undefined, env);
    expect(r1.valid).toBe(false);
    const r2 = await validateTurnstile('spam-tok', undefined, env);
    expect(r2.valid).toBe(false);
    expect(r2.errorCodes).toContain('cache_hit_invalid');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache timeout-or-duplicate as invalid (could be a racing legit token)', async () => {
    mockFetch({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    const cache = makeKV();
    const env = makeEnv({ TURNSTILE_CACHE: cache, TURNSTILE_STRICT: '1' });
    await validateTurnstile('dup-tok', undefined, env);
    // strict-mode rejection, but nothing cached as invalid
    expect(cache.store.size).toBe(0);
  });

  it('without a cache binding, verifies on every call (legacy behavior preserved)', async () => {
    const fetchSpy = mockFetch({ success: true });
    const env = makeEnv(); // no TURNSTILE_CACHE
    await validateTurnstile('tok-B', undefined, env);
    await validateTurnstile('tok-B', undefined, env);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
