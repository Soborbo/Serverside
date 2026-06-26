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
  // A hossz-különbséget az akkumulátorba hajtjuk (nem korai return-nel), és
  // mindig `a.length` iterációt futunk — így a „rossz hossz" és a „jó hossz,
  // rossz bájt" eset nem különböztethető meg időzítésből.
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i < b.length ? i : 0);
  }
  return mismatch === 0;
}
