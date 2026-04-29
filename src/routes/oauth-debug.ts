import type { Env } from '../env';
import { getAccessToken } from '../lib/gads-oauth';
import { authenticateAdmin } from '../lib/admin-auth';

export async function handleOAuthDebug(request: Request, env: Env): Promise<Response> {
  if (!authenticateAdmin(request, env)) {
    return new Response('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  if (!customerId) {
    return new Response('Missing customer_id query param', { status: 400 });
  }
  if (!/^\d{10}$/.test(customerId)) {
    return new Response('Invalid customer_id format', { status: 400 });
  }

  const token = await getAccessToken(customerId, env);
  return new Response(
    JSON.stringify(
      {
        customer_id: customerId,
        access_token_received: !!token
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
