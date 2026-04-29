import { describe, it, expect, beforeEach } from 'vitest';
import { issueOAuthState, consumeOAuthState } from '../src/lib/oauth-state';
import type { Env } from '../src/env';

class MockKV {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }
}

function makeEnv(): Env {
  return { OAUTH_TOKENS: new MockKV() } as unknown as Env;
}

describe('issueOAuthState', () => {
  it('returns a 64-char hex string', async () => {
    const env = makeEnv();
    const nonce = await issueOAuthState('1234567890', env);
    expect(nonce).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different nonces on each call', async () => {
    const env = makeEnv();
    const a = await issueOAuthState('1234567890', env);
    const b = await issueOAuthState('1234567890', env);
    expect(a).not.toBe(b);
  });
});

describe('consumeOAuthState', () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  it('returns customer_id for a valid nonce', async () => {
    const nonce = await issueOAuthState('1234567890', env);
    expect(await consumeOAuthState(nonce, env)).toBe('1234567890');
  });

  it('returns null for unknown nonce', async () => {
    const fakeNonce = 'a'.repeat(64);
    expect(await consumeOAuthState(fakeNonce, env)).toBeNull();
  });

  it('rejects malformed nonce (not 64 hex chars)', async () => {
    expect(await consumeOAuthState('short', env)).toBeNull();
    expect(await consumeOAuthState('z'.repeat(64), env)).toBeNull();
    expect(await consumeOAuthState('a'.repeat(63), env)).toBeNull();
  });

  it('rejects empty/falsy nonce', async () => {
    expect(await consumeOAuthState('', env)).toBeNull();
  });

  it('is single-use — second consume returns null', async () => {
    const nonce = await issueOAuthState('1234567890', env);
    expect(await consumeOAuthState(nonce, env)).toBe('1234567890');
    expect(await consumeOAuthState(nonce, env)).toBeNull();
  });
});
