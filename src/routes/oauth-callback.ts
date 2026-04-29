import type { Env } from '../env';
import { logStructured } from '../types';
import { exchangeCodeForTokens, storeRefreshToken } from '../lib/gads-oauth';

export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing code or state parameter', { status: 400 });
  }

  const customerId = state;
  const redirectUri = `${url.origin}/api/track/oauth-callback`;

  const result = await exchangeCodeForTokens(code, redirectUri, env);
  if (result.error) {
    return new Response(`OAuth exchange failed: ${result.error}`, { status: 500 });
  }

  await storeRefreshToken(customerId, result.refreshToken, env);

  logStructured({
    level: 'info',
    message: 'OAuth flow completed successfully',
    customer_id: customerId
  });

  return new Response(
    `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 2rem;">
<h1>OAuth Setup Complete</h1>
<p>Refresh token stored for customer ID: <code>${customerId}</code></p>
<p><strong>Important:</strong> Delete or protect this endpoint now to prevent unauthorized access.</p>
</body></html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    }
  );
}
