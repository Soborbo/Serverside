import type { Env } from '../env';
import { getAccessToken } from '../lib/gads-oauth';

export async function handleOAuthDebug(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  if (!customerId) {
    return new Response('Missing customer_id query param', { status: 400 });
  }

  const token = await getAccessToken(customerId, env);
  return new Response(
    JSON.stringify(
      {
        customer_id: customerId,
        access_token_received: !!token,
        access_token_preview: token ? token.slice(0, 20) + '...' : null
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
