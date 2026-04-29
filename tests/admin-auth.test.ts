import { describe, it, expect } from 'vitest';
import { authenticateAdmin } from '../src/lib/admin-auth';
import type { Env } from '../src/env';

function makeEnv(token?: string): Env {
  return { ADMIN_API_TOKEN: token } as unknown as Env;
}

function makeRequest(headerToken?: string): Request {
  const headers = new Headers();
  if (headerToken !== undefined) headers.set('X-Admin-Token', headerToken);
  return new Request('https://example.com/admin', { headers });
}

describe('authenticateAdmin', () => {
  it('returns false when ADMIN_API_TOKEN is unset', () => {
    expect(authenticateAdmin(makeRequest('any'), makeEnv())).toBe(false);
  });

  it('returns false when X-Admin-Token header is missing', () => {
    expect(authenticateAdmin(makeRequest(), makeEnv('expected'))).toBe(false);
  });

  it('returns true when X-Admin-Token matches', () => {
    expect(authenticateAdmin(makeRequest('expected'), makeEnv('expected'))).toBe(true);
  });

  it('returns false on mismatch', () => {
    expect(authenticateAdmin(makeRequest('wrong'), makeEnv('expected'))).toBe(false);
  });

  it('returns false on length mismatch', () => {
    expect(authenticateAdmin(makeRequest('short'), makeEnv('much-longer-token'))).toBe(false);
  });

  it('returns false on empty string vs token', () => {
    expect(authenticateAdmin(makeRequest(''), makeEnv('expected'))).toBe(false);
  });

  it('treats long random tokens correctly', () => {
    const token = 'a'.repeat(64);
    expect(authenticateAdmin(makeRequest(token), makeEnv(token))).toBe(true);
    expect(authenticateAdmin(makeRequest('a'.repeat(63) + 'b'), makeEnv(token))).toBe(false);
  });
});
