import type { Env } from '../env';
import type { HashedUserData } from '../lib/hash';
import type { ConsentState } from '../lib/consent';
import type { AttributionParams } from '../lib/attribution';

export interface QuoteStateData {
  client_id: string;
  value: number;
  currency: string;
  service: string;
  completed_at: number;
  event_time: number;
  event_id: string;
  upgraded: boolean;
  fired_at: number | null;
  user_data?: HashedUserData;
  hostname: string;
  view_content_fired: boolean;
  // Consent a quote időpontjában rögzítve — a 60 perces alarm-tüzeléskor a
  // request-kontextus (és így a friss consent) már nem elérhető.
  consent?: ConsentState;
  // false → ad-platform (Meta + Google Ads) konverzió tiltva. undefined/true →
  // engedett (backward-compat).
  ad_allowed?: boolean;
  // Attribúció a quote időpontjában (gclid/fbclid/UTM stb.) — a +60 perces
  // tüzeléskor a click ID-k még érvényesek a feltöltéshez.
  attribution?: AttributionParams;
}

const STORAGE_KEY = 'quote';
const DEFAULT_ALARM_DURATION_MS = 60 * 60 * 1000;

function getAlarmDurationMs(env: Env): number {
  const override = env.QUOTE_ALARM_SECONDS;
  if (!override) return DEFAULT_ALARM_DURATION_MS;
  const seconds = parseInt(override, 10);
  if (!Number.isFinite(seconds) || seconds < 1) return DEFAULT_ALARM_DURATION_MS;
  return seconds * 1000;
}

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
      newQuote.value <= 0 ||
      typeof newQuote.currency !== 'string' ||
      typeof newQuote.service !== 'string' ||
      typeof newQuote.event_id !== 'string' ||
      typeof newQuote.hostname !== 'string'
    ) {
      return new Response('Missing or invalid required fields', { status: 400 });
    }

    const completed_at = newQuote.completed_at || Date.now();
    const quote: QuoteStateData = {
      client_id: newQuote.client_id,
      value: newQuote.value,
      currency: newQuote.currency,
      service: newQuote.service,
      completed_at,
      event_time: newQuote.event_time || Math.floor(completed_at / 1000),
      event_id: newQuote.event_id,
      upgraded: false,
      fired_at: null,
      user_data: newQuote.user_data,
      hostname: newQuote.hostname,
      view_content_fired: previous?.view_content_fired ?? false,
      consent: newQuote.consent,
      ad_allowed: newQuote.ad_allowed,
      attribution: newQuote.attribution
    };

    await this.state.storage.put(STORAGE_KEY, quote);
    await this.state.storage.setAlarm(Date.now() + getAlarmDurationMs(this.env));

    return new Response(JSON.stringify(quote), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGet(): Promise<Response> {
    const quote = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);
    if (!quote || quote.upgraded || quote.fired_at !== null) {
      return new Response('null', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (Date.now() - quote.completed_at > getAlarmDurationMs(this.env)) {
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
   *
   * Idempotency: CF DOs guarantee at-least-once alarm delivery (max 6 retries
   * on throw). We set `fired_at` BEFORE fan-out to ensure double-firing
   * doesn't duplicate conversions across all 3 platforms.
   */
  async alarm(): Promise<void> {
    const quote = await this.state.storage.get<QuoteStateData>(STORAGE_KEY);
    if (!quote || quote.upgraded || quote.fired_at !== null) return;

    quote.fired_at = Date.now();
    await this.state.storage.put(STORAGE_KEY, quote);

    try {
      await this.fireDelayedConversion(quote);
    } finally {
      await this.state.storage.deleteAll();
    }
  }

  private async fireDelayedConversion(quote: QuoteStateData): Promise<void> {
    const { getSiteConfig } = await import('../lib/config');
    const { sendToMetaCAPI } = await import('../lib/meta');
    const { sendToGA4MP } = await import('../lib/ga4');
    const { sendToGoogleAdsCAPI } = await import('../lib/gads');
    const { buildFbcFromFbclid } = await import('../lib/attribution');
    const { enqueueFailure } = await import('../lib/deadletter');
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
    const event_time = quote.event_time;
    const userData = quote.user_data || {};
    // Consent gating: ha az ad-platform tiltott, a Meta + Google Ads hívást
    // teljesen kihagyjuk (no-op success, nincs DLQ). GA4 mindig megy.
    const adAllowed = quote.ad_allowed !== false;
    const attr = quote.attribution;

    const metaPayload = {
      event_name,
      event_id: quote.event_id,
      event_time,
      value: quote.value,
      currency: quote.currency,
      source: 'delayed_60min',
      event_source_url: `https://${quote.hostname}/quote`,
      fbc: buildFbcFromFbclid(attr?.fbclid, event_time)
    };
    const ga4Payload = {
      event_name,
      event_id: quote.event_id,
      client_id: quote.client_id,
      value: quote.value,
      currency: quote.currency,
      source: 'delayed_60min',
      service: quote.service,
      consent: quote.consent,
      attribution: attr
    };
    const gadsPayload = {
      event_name,
      event_id: quote.event_id,
      event_time,
      value: quote.value,
      currency: quote.currency,
      consent: quote.consent,
      gclid: attr?.gclid,
      gbraid: attr?.gbraid,
      wbraid: attr?.wbraid
    };

    const noopSuccess: Promise<{ success: true; error?: string }> = Promise.resolve({
      success: true
    });
    const results = await Promise.allSettled([
      adAllowed ? sendToMetaCAPI(siteConfig, metaPayload, userData) : noopSuccess,
      sendToGA4MP(siteConfig, ga4Payload),
      adAllowed ? sendToGoogleAdsCAPI(siteConfig, this.env, gadsPayload, userData) : noopSuccess
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
      await enqueueFailure(this.env, {
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
