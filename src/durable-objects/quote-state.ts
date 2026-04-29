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
    const newQuote = (await request.json()) as Partial<QuoteStateData>;
    const previous = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);

    if (
      typeof newQuote.client_id !== 'string' ||
      typeof newQuote.value !== 'number' ||
      typeof newQuote.currency !== 'string' ||
      typeof newQuote.service !== 'string' ||
      typeof newQuote.event_id !== 'string' ||
      typeof newQuote.hostname !== 'string'
    ) {
      return new Response('Missing required fields', { status: 400 });
    }

    const quote: QuoteStateData = {
      client_id: newQuote.client_id,
      value: newQuote.value,
      currency: newQuote.currency,
      service: newQuote.service,
      completed_at: newQuote.completed_at || Date.now(),
      event_id: newQuote.event_id,
      upgraded: false,
      user_data: newQuote.user_data,
      hostname: newQuote.hostname,
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
      return new Response('null', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (Date.now() - quote.completed_at > ALARM_DURATION_MS) {
      return new Response('null', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
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
   * Alarm: 60 perccel a quote completion után tüzel a 3-way fan-out
   * (Meta + GA4 + Google Ads). Failure → DLQ.
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
    const { TrackingErrorCode, ERROR_DESCRIPTIONS } = await import('../lib/error-codes');

    const siteConfig = await getSiteConfig(quote.hostname, this.env);
    if (!siteConfig) {
      logStructured({
        level: 'error',
        error_code: TrackingErrorCode.NO_SITE_CONFIG,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.NO_SITE_CONFIG],
        hostname: quote.hostname
      });
      return;
    }

    const event_name = 'quote_calculator_conversion';
    const event_time = Math.floor(Date.now() / 1000);
    const userData = quote.user_data || {};

    const metaPayload = {
      event_name,
      event_id: quote.event_id,
      event_time,
      value: quote.value,
      currency: quote.currency,
      source: 'delayed_60min',
      event_source_url: `https://${quote.hostname}/quote`
    };
    const ga4Payload = {
      event_name,
      event_id: quote.event_id,
      client_id: quote.client_id,
      value: quote.value,
      currency: quote.currency,
      source: 'delayed_60min',
      service: quote.service
    };
    const gadsPayload = {
      event_name,
      event_id: quote.event_id,
      event_time,
      value: quote.value,
      currency: quote.currency
    };

    const results = await Promise.allSettled([
      sendToMetaCAPI(siteConfig, metaPayload, userData),
      sendToGA4MP(siteConfig, ga4Payload),
      sendToGoogleAdsCAPI(siteConfig, this.env, gadsPayload, userData)
    ]);

    const nowIso = new Date().toISOString();
    const platforms = ['meta', 'ga4', 'gads'] as const;
    const payloads: Record<string, unknown>[] = [
      metaPayload as unknown as Record<string, unknown>,
      ga4Payload as unknown as Record<string, unknown>,
      gadsPayload as unknown as Record<string, unknown>
    ];
    const userDataMap = [true, false, true];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const failed =
        result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.success);
      if (!failed) continue;
      const reason =
        result.status === 'rejected'
          ? String(result.reason)
          : result.value.error || 'unknown';
      await writeDeadLetter(this.env, {
        platform: platforms[i],
        site_id: siteConfig.site_id,
        hostname: quote.hostname,
        event_payload: payloads[i],
        hashed_user_data: userDataMap[i]
          ? (userData as unknown as Record<string, unknown>)
          : undefined,
        failure_reason: reason,
        retry_count: 0,
        first_failed_at: nowIso,
        last_attempted_at: nowIso
      });
    }

    logStructured({
      level: 'info',
      message: 'Delayed quote conversion fired (60min alarm)',
      site_id: siteConfig.site_id,
      event_name,
      meta_success: results[0].status === 'fulfilled' && results[0].value.success,
      ga4_success: results[1].status === 'fulfilled' && results[1].value.success,
      gads_success: results[2].status === 'fulfilled' && results[2].value.success
    });
  }
}
