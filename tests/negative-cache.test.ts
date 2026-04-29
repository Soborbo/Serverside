import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';

class CountingKV {
  public getCount = 0;
  private store = new Map<string, unknown>();

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  async get(key: string, type?: string): Promise<unknown> {
    this.getCount++;
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json' && typeof v === 'object') return v;
    return v;
  }
}

function makeEnv(kv: CountingKV): Env {
  return { SITE_CONFIG: kv } as unknown as Env;
}

describe('getSiteConfig — negative cache', () => {
  let kv: CountingKV;
  let env: Env;

  beforeEach(() => {
    kv = new CountingKV();
    env = makeEnv(kv);
    vi.useFakeTimers();
  });

  it('caches a missing hostname so subsequent calls do not hit KV', async () => {
    expect(await getSiteConfig('unknown.example', env)).toBeNull();
    expect(kv.getCount).toBe(1);

    expect(await getSiteConfig('unknown.example', env)).toBeNull();
    expect(await getSiteConfig('unknown.example', env)).toBeNull();
    expect(kv.getCount).toBe(1); // still 1 — cached
  });

  it('TTL expires after 60s (vs old behavior where new sites were never picked up)', async () => {
    expect(await getSiteConfig('newsite.example', env)).toBeNull();
    expect(kv.getCount).toBe(1);

    // Advance time past the TTL
    vi.advanceTimersByTime(61_000);

    // New site added in KV
    kv.set('newsite.example', { site_id: 'newsite', country_code: 'GB' });

    const result = await getSiteConfig('newsite.example', env);
    expect(result).not.toBeNull();
    expect(kv.getCount).toBe(2); // re-checked after TTL
  });

  it('does not cache a successful (positive) result', async () => {
    kv.set('valid.example', { site_id: 'valid', country_code: 'GB' });

    expect(await getSiteConfig('valid.example', env)).not.toBeNull();
    expect(kv.getCount).toBe(1);

    // Each call hits KV again (no positive cache by design)
    expect(await getSiteConfig('valid.example', env)).not.toBeNull();
    expect(kv.getCount).toBe(2);
  });
});
