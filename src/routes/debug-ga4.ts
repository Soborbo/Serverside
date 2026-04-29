import type { Env } from '../env';
import { corsHeaders } from '../worker';
import { getSiteConfig } from '../lib/config';
import { sendToGA4MP } from '../lib/ga4';

export async function handleDebugGA4(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.searchParams.get('host') || url.hostname;
  const cors = corsHeaders(request);

  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    return new Response(JSON.stringify({ error: 'No site config', hostname }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const result = await sendToGA4MP(
    siteConfig,
    {
      event_name: 'debug_test',
      event_id: 'debug-' + Date.now(),
      client_id: '1234567890.1714400000',
      value: 100,
      currency: 'GBP',
      source: 'debug_endpoint'
    },
    { debug: true }
  );

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
