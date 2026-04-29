import type { Env } from '../env';

/**
 * Admin authentication for debug endpoints (/api/event/oauth-debug,
 * /api/event/debug-ga4). The Worker secret ADMIN_API_TOKEN must match the
 * `X-Admin-Token` header. If ADMIN_API_TOKEN is unset (test deploy), the
 * routes are disabled entirely (return 404).
 *
 * Comparison uses constant-time equality to prevent timing attacks.
 */
export function authenticateAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_TOKEN) return false;
  const provided = request.headers.get('X-Admin-Token');
  if (!provided) return false;
  return timingSafeEqual(provided, env.ADMIN_API_TOKEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a constant-time comparison against b to prevent length leak
    // via timing — but the result is always false.
    let acc = 1;
    for (let i = 0; i < b.length; i++) acc |= b.charCodeAt(i) ^ b.charCodeAt(i);
    void acc;
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
