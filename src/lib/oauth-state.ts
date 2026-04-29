import type { Env } from '../env';

const NONCE_TTL_SECONDS = 600; // 10 minutes
const NONCE_KEY_PREFIX = 'oauth_state:';

/**
 * Generates a cryptographically random nonce, stores `nonce → customer_id`
 * mapping in OAUTH_TOKENS KV with 10-min TTL, and returns the nonce.
 * The nonce is single-use and validated by `consumeOAuthState`.
 */
export async function issueOAuthState(customerId: string, env: Env): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await env.OAUTH_TOKENS.put(NONCE_KEY_PREFIX + nonce, customerId, {
    expirationTtl: NONCE_TTL_SECONDS
  });
  return nonce;
}

/**
 * Looks up the nonce in KV, deletes it (single-use), and returns the
 * associated customer_id. Returns null if missing/expired.
 */
export async function consumeOAuthState(nonce: string, env: Env): Promise<string | null> {
  if (!nonce || !/^[a-f0-9]{64}$/.test(nonce)) return null;
  const key = NONCE_KEY_PREFIX + nonce;
  const customerId = await env.OAUTH_TOKENS.get(key);
  if (!customerId) return null;
  await env.OAUTH_TOKENS.delete(key);
  return customerId;
}
