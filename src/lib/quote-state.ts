import type { Env } from '../env';
import type { QuoteStateData } from '../durable-objects/quote-state';

function getQuoteStateDO(env: Env, clientId: string): DurableObjectStub {
  const id = env.QUOTE_STATE.idFromName(clientId);
  return env.QUOTE_STATE.get(id);
}

export async function setQuoteState(
  env: Env,
  clientId: string,
  state: Omit<QuoteStateData, 'upgraded' | 'view_content_fired'>
): Promise<QuoteStateData> {
  const stub = getQuoteStateDO(env, clientId);
  const response = await stub.fetch('https://internal/?op=set', {
    method: 'POST',
    body: JSON.stringify(state)
  });
  return (await response.json()) as QuoteStateData;
}

export async function getQuoteState(env: Env, clientId: string): Promise<QuoteStateData | null> {
  const stub = getQuoteStateDO(env, clientId);
  const response = await stub.fetch('https://internal/?op=get');
  const text = await response.text();
  if (text === 'null') return null;
  return JSON.parse(text) as QuoteStateData;
}

export async function markQuoteUpgraded(
  env: Env,
  clientId: string
): Promise<QuoteStateData | null> {
  const stub = getQuoteStateDO(env, clientId);
  const response = await stub.fetch('https://internal/?op=upgrade', { method: 'POST' });
  const text = await response.text();
  if (text === 'null') return null;
  return JSON.parse(text) as QuoteStateData;
}

export async function markViewContentFired(env: Env, clientId: string): Promise<void> {
  const stub = getQuoteStateDO(env, clientId);
  await stub.fetch('https://internal/?op=mark-view-content', { method: 'POST' });
}
