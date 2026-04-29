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
