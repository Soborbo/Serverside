import type { Env } from '../env';
import { authenticateAdmin } from '../lib/admin-auth';
import { issueOAuthState } from '../lib/oauth-state';

const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// Data Manager API (offline conversions / ECL via lib/datamanager.ts) needs the
// `datamanager` scope. `adwords` is kept for the dormant uploadClickConversions
// path + general Google Ads access. Space-separated → one consent grants both.
// NOTE: existing refresh tokens minted before this change are adwords-only and
// must be re-consented (re-run /api/event/oauth-init) to gain datamanager.
const GADS_SCOPE =
  'https://www.googleapis.com/auth/datamanager https://www.googleapis.com/auth/adwords';

/**
 * Admin-only: starts the Google Ads OAuth flow for a given customer_id.
 * Generates a single-use state nonce stored in KV with 10-min TTL, then
 * redirects to Google's consent screen.
 */
export async function handleOAuthInit(request: Request, env: Env): Promise<Response> {
  if (!authenticateAdmin(request, env)) {
    return new Response('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  if (!customerId || !/^\d{10}$/.test(customerId)) {
    return new Response('Missing or invalid customer_id (must be 10 digits, no dashes)', {
      status: 400
    });
  }

  const state = await issueOAuthState(customerId, env);
  const redirectUri = `${url.origin}/api/event/oauth-callback`;
  const params = new URLSearchParams({
    client_id: env.GADS_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GADS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `${GOOGLE_OAUTH_AUTH_URL}?${params}` }
  });
}
