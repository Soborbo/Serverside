import type { Env } from '../env';
import { logStructured } from '../types';
import { exchangeCodeForTokens, storeRefreshToken } from '../lib/gads-oauth';
import { consumeOAuthState } from '../lib/oauth-state';
import { escapeHtml } from '../lib/notify';

export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing code or state parameter', { status: 400 });
  }

  const customerId = await consumeOAuthState(state, env);
  if (!customerId) {
    logStructured({
      level: 'warn',
      message: 'OAuth callback received with invalid/expired state'
    });
    return new Response('Invalid or expired state', { status: 403 });
  }

  const redirectUri = `${url.origin}/api/event/oauth-callback`;

  const result = await exchangeCodeForTokens(code, redirectUri, env);
  if (result.error) {
    return new Response('OAuth exchange failed', { status: 500 });
  }

  await storeRefreshToken(customerId, result.refreshToken, env);

  logStructured({
    level: 'info',
    message: 'OAuth flow completed successfully',
    customer_id: customerId
  });

  const safeCustomerId = escapeHtml(customerId);
  return new Response(
    `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 2rem;">
<h1>OAuth Setup Complete</h1>
<p>Refresh token stored for customer ID: <code>${safeCustomerId}</code></p>
</body></html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' }
    }
  );
}
