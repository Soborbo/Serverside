> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: README.md + CLAUDE.md + docs/HANDOVER-run6.md (a kanonikus élő állapot)
>
> Ez egy TERVEZÉSI/SPRINT-dokumentum a Run 1–6 építési fázisból. A benne leírt
> premisszák egy része AZÓTA MEGDŐLT (pl. Turnstile-before-everything, quote-state
> Durable Object, offline GA4 — mind törölve; lásd CLAUDE.md Rule 10/17). NE
> implementálj ez alapján; a jelenlegi valóság a fenti kanonikus fájlokban van.
> ---

# Sprint 6.5 — Durable Objects a quote state-hez

**Cél:** A 60 perces upgrade-logikát kiszedjük a kliens `sessionStorage`-ból + KV-ből (eventually consistent), és átrakjuk Durable Object-be (strongly consistent globally).

**Idő Claude Code-dal:** 6-10 óra.

## Miért szükséges

A Workers KV **eventually consistent**, ~60 másodperces global propagation. A 60 perces upgrade-logika nem tűri ezt:

**Problémás flow**:
1. User Bristol-ban (PoP-1) kitölti a kalkulátort → KV write `quote_state`
2. User mobilra vált, mobilszolgáltatóhoz csatlakozik (PoP-2)
3. 30 másodperccel később telefonál → Worker PoP-2 olvas KV-ből
4. KV propagáció még folyamatban → PoP-2 nem látja a `quote_state`-et
5. **Két konverzió tüzel** csendben

**A Durable Object** strong consistency-t ad: ugyanaz a state bárhonnan ugyanazt látja.

## Mielőtt nekiállsz

### Wrangler config bővítés

```toml
[[durable_objects.bindings]]
name = "QUOTE_STATE"
class_name = "QuoteStateObject"

[[migrations]]
tag = "v1"
new_classes = ["QuoteStateObject"]
```

**Cost**: <$1/hó Painless-volumenre.

## Új fájl: `src/durable-objects/quote-state.ts`

```typescript
import type { Env } from '../env';
import type { HashedUserData } from '../lib/hash';

export interface QuoteStateData {
  client_id: string;
  value: number;
  currency: string;
  service: string;
  completed_at: number;
  event_id: string;
  upgraded: boolean;
  user_data?: HashedUserData;
  hostname: string;
  view_content_fired: boolean;
}

const STORAGE_KEY = 'quote';
const ALARM_DURATION_MS = 60 * 60 * 1000;

export class QuoteStateObject implements DurableObject {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get('op');

    try {
      if (op === 'set') return await this.handleSet(request);
      if (op === 'get') return await this.handleGet();
      if (op === 'upgrade') return await this.handleUpgrade();
      if (op === 'mark-view-content') return await this.handleMarkViewContent();
      return new Response('Unknown op', { status: 400 });
    } catch (err) {
      console.error('QuoteStateObject error', err);
      return new Response('Internal error', { status: 500 });
    }
  }

  private async handleSet(request: Request): Promise<Response> {
    const newQuote = await request.json() as Partial<QuoteStateData>;
    const previous = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);

    const quote: QuoteStateData = {
      client_id: newQuote.client_id!,
      value: newQuote.value!,
      currency: newQuote.currency!,
      service: newQuote.service!,
      completed_at: newQuote.completed_at || Date.now(),
      event_id: newQuote.event_id!,
      upgraded: false,
      user_data: newQuote.user_data,
      hostname: newQuote.hostname!,
      view_content_fired: previous?.view_content_fired ?? false
    };

    await this.state.storage.put(STORAGE_KEY, quote);
    await this.state.storage.setAlarm(Date.now() + ALARM_DURATION_MS);

    return new Response(JSON.stringify(quote), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGet(): Promise<Response> {
    const quote = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);
    if (!quote || quote.upgraded) {
      return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (Date.now() - quote.completed_at > ALARM_DURATION_MS) {
      return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(quote), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleUpgrade(): Promise<Response> {
    const quote = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);
    if (!quote) return new Response('null', { status: 200 });
    quote.upgraded = true;
    await this.state.storage.put(STORAGE_KEY, quote);
    await this.state.storage.deleteAlarm();
    return new Response(JSON.stringify(quote), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleMarkViewContent(): Promise<Response> {
    const quote = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);
    if (!quote) return new Response('null', { status: 200 });
    quote.view_content_fired = true;
    await this.state.storage.put(STORAGE_KEY, quote);
    return new Response('OK', { status: 200 });
  }

  /**
   * Alarm: 60 perccel a quote completion után tüzel a kalkulátor conversion fan-out.
   */
  async alarm(): Promise<void> {
    const quote = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);
    if (!quote || quote.upgraded) return;

    await this.fireDelayedConversion(quote);
    await this.state.storage.deleteAll();
  }

  private async fireDelayedConversion(quote: QuoteStateData): Promise<void> {
    const { getSiteConfig } = await import('../lib/config');
    const { sendToMetaCAPI } = await import('../lib/meta');
    const { sendToGA4MP } = await import('../lib/ga4');
    const { sendToGoogleAdsCAPI } = await import('../lib/gads');
    const { writeDeadLetter } = await import('../lib/deadletter');
    const { logStructured } = await import('../types');
    const { TrackingErrorCode } = await import('../lib/error-codes');

    const siteConfig = await getSiteConfig(quote.hostname, this.env);
    if (!siteConfig) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.NO_SITE_CONFIG,
        message: 'Cannot fire delayed conversion: no site config',
        hostname: quote.hostname
      });
      return;
    }

    const event_name = 'quote_calculator_conversion';
    const event_time = Math.floor(Date.now() / 1000);

    const fanout = await Promise.allSettled([
      sendToMetaCAPI(siteConfig, {
        event_name, event_id: quote.event_id, event_time,
        value: quote.value, currency: quote.currency,
        source: 'delayed_60min',
        event_source_url: `https://${quote.hostname}/quote`
      }, quote.user_data || {}),
      sendToGA4MP(siteConfig, {
        event_name, event_id: quote.event_id,
        client_id: quote.client_id,
        value: quote.value, currency: quote.currency,
        source: 'delayed_60min', service: quote.service
      }),
      sendToGoogleAdsCAPI(siteConfig, this.env, {
        event_name, event_id: quote.event_id, event_time,
        value: quote.value, currency: quote.currency
      }, quote.user_data || {})
    ]);

    const platforms: ('meta' | 'ga4' | 'gads')[] = ['meta', 'ga4', 'gads'];
    const nowIso = new Date().toISOString();

    for (let i = 0; i < fanout.length; i++) {
      const result = fanout[i];
      const platform = platforms[i];
      const failed = result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.success);
      if (failed) {
        const reason = result.status === 'rejected' ? String(result.reason)
          : (result.status === 'fulfilled' ? result.value.error || 'unknown' : 'unknown');
        await writeDeadLetter(this.env, {
          platform,
          site_id: siteConfig.site_id,
          hostname: quote.hostname,
          event_payload: { event_name, event_id: quote.event_id, event_time, value: quote.value, currency: quote.currency },
          hashed_user_data: quote.user_data as Record<string, unknown>,
          failure_reason: reason,
          retry_count: 0,
          first_failed_at: nowIso,
          last_attempted_at: nowIso
        });
      }
    }

    logStructured({
      level: 'info',
      message: 'Delayed quote conversion fired (60min alarm)',
      site_id: siteConfig.site_id,
      event_name
    });
  }
}
```

## Új fájl: `src/lib/quote-state.ts` (helper)

```typescript
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
  return await response.json() as QuoteStateData;
}

export async function getQuoteState(
  env: Env,
  clientId: string
): Promise<QuoteStateData | null> {
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

export async function markViewContentFired(
  env: Env,
  clientId: string
): Promise<void> {
  const stub = getQuoteStateDO(env, clientId);
  await stub.fetch('https://internal/?op=mark-view-content', { method: 'POST' });
}
```

## Módosítandó fájlok

### `src/env.ts`

```typescript
export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;
  DEAD_LETTER: R2Bucket;
  QUOTE_STATE: DurableObjectNamespace;  // ÚJ

  TURNSTILE_SECRET_KEY: string;
  GADS_OAUTH_CLIENT_ID: string;
  GADS_OAUTH_CLIENT_SECRET: string;
  GADS_DEVELOPER_TOKEN: string;
}
```

### `src/worker.ts`

```typescript
import { QuoteStateObject } from './durable-objects/quote-state';

export { QuoteStateObject };

export default {
  async fetch(request, env, ctx) { /* ... */ },
  async scheduled(event, env, ctx) { /* ... */ }
};
```

### `src/routes/conversion.ts`

A conversion route-ban:

```typescript
import { setQuoteState, getQuoteState, markQuoteUpgraded, markViewContentFired } from '../lib/quote-state';

const clientId = payload.client_id;

if (payload.event_name === 'quote_calculator_conversion' && clientId) {
  // Quote complete: NEM tüzelünk azonnal, DO alarm kezeli 60 perc múlva
  await setQuoteState(env, clientId, {
    client_id: clientId,
    value: payload.value!,
    currency: payload.currency!,
    service: payload.service!,
    completed_at: Date.now(),
    event_id: payload.event_id,
    user_data: hashedUserData,
    hostname
  });

  // Meta ViewContent first-time only
  const state = await getQuoteState(env, clientId);
  if (state && !state.view_content_fired) {
    // ... fire ViewContent ...
    await markViewContentFired(env, clientId);
  }

  return new Response(null, { status: 204, headers: cors });
}

if (['callback_conversion', 'phone_conversion', 'email_conversion', 'whatsapp_conversion'].includes(payload.event_name) && clientId) {
  const activeQuote = await getQuoteState(env, clientId);
  if (activeQuote) {
    await markQuoteUpgraded(env, clientId);
    // Fan-out with quote's event_id and value (dedup)
    // ... using activeQuote.event_id and activeQuote.value ...
  } else {
    // Standalone conversion, no quote upgrade
    // ... standard fan-out with own event_id ...
  }
}
```

## Manuális tesztelés

### A. Quote complete

```bash
curl -X POST .../conversion -d '{
  "event_name": "quote_calculator_conversion",
  "client_id": "1111.2222",
  "value": 380, "currency": "GBP",
  ...
}'
```

→ 204. NINCS azonnali fan-out.

### B. Upgrade phone click 30 másodperc múlva

```bash
curl -X POST .../conversion -d '{
  "event_name": "phone_conversion",
  "client_id": "1111.2222",  # ugyanaz!
  ...
}'
```

→ Most fan-out a kalkulátor `event_id` és `value` használatával.

### C. Quote without upgrade — 60 perc várás

DO alarm 60 perc múlva tüzeli a delayed conversion-t.

### D. Cross-tab consistency

DevTools 2 tabban (mobil + desktop, ugyanaz a `_ga` cookie) → ugyanazt a state-et látja.

## Sprint 6.5 utáni státusz

- ✅ Strong consistency a quote state-en
- ✅ DO alarm a 60 perces delayed conversion-höz
- ✅ Cross-tab és cross-PoP konzisztencia
- ✅ Server-side state (kliens-oldali sessionStorage Sprint 9-ben elhagyható)

## Mit KÉRDEZZ a usertől

1. Wrangler config bővítve durable_objects + migrations blokkal?
2. `wrangler deploy` sikeres a migration-nel?
3. DO test (quote → 60 perc várakozás) tüzelte a fan-out-ot?
