/**
 * Astro client-lib: server-side tracking dispatch a Soborbo Worker-hez.
 *
 * Használat: copy-paste az Astro site src/lib/-jába (Painless, BeautyFlow, stb.).
 * Astro env: PUBLIC_TURNSTILE_SITE_KEY publikus változó kell.
 *
 * Sprint 9 spec a 09-sprint-astro-painless.md-ben.
 */

import { generateUUID } from './uuid';

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId?: string) => void;
      execute: (container?: string | HTMLElement) => void;
      getResponse: (widgetId?: string) => string | undefined;
    };
    dataLayer: unknown[];
    fbq?: (...args: unknown[]) => void;
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  size?: 'normal' | 'compact' | 'invisible';
  appearance?: 'always' | 'execute' | 'interaction-only';
}

export interface UserData {
  email?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  street?: string;
  postal_code?: string;
  country?: string;
  // Stabil user/cookie azonosító (Meta external_id → EMQ-javítás). A Worker
  // hash-eli; ugyanezt az értéket add a böngésző Pixelnek is a dedup miatt.
  external_id?: string;
}

export type ConsentSignal = 'GRANTED' | 'DENIED' | 'UNSPECIFIED';

export interface ConsentState {
  ad_user_data?: ConsentSignal;
  ad_personalization?: ConsentSignal;
  ad_storage?: ConsentSignal;
  analytics_storage?: ConsentSignal;
}

export interface ConversionPayload {
  event_name: string;
  event_id: string;
  event_time: number;
  value?: number;
  currency?: string;
  source?: string;
  service?: string;
  user_data?: UserData;
  event_source_url?: string;
  consent?: ConsentState;
}

let cachedTurnstileToken: string | undefined;
let cachedTokenExpiresAt = 0;
let turnstileWidgetId: string | undefined;
// A single widget is rendered once. Subsequent calls reset it and route the
// resolution through this pending pointer, so the original callbacks (which
// closed over the first call) can still resolve later promises.
let pendingResolver:
  | { resolve: (v: string | undefined) => void; timeout: ReturnType<typeof setTimeout> }
  | undefined;

export async function getTurnstileToken(): Promise<string | undefined> {
  if (cachedTurnstileToken && Date.now() < cachedTokenExpiresAt) {
    return cachedTurnstileToken;
  }

  if (!window.turnstile) {
    console.warn('[tracking] Turnstile not loaded');
    return undefined;
  }

  return new Promise((resolve) => {
    const container = document.getElementById('cf-turnstile-invisible');
    if (!container) {
      console.warn('[tracking] Turnstile container not found');
      resolve(undefined);
      return;
    }

    // If a previous request is still pending, resolve it as undefined
    // (we'll start a fresh challenge).
    if (pendingResolver) {
      clearTimeout(pendingResolver.timeout);
      pendingResolver.resolve(undefined);
    }

    const timeout = setTimeout(() => {
      if (pendingResolver) {
        const r = pendingResolver;
        pendingResolver = undefined;
        console.warn('[tracking] Turnstile timeout');
        r.resolve(undefined);
      }
    }, 10000);
    pendingResolver = { resolve, timeout };

    const onCallback = (token: string) => {
      if (!pendingResolver) return;
      const r = pendingResolver;
      pendingResolver = undefined;
      clearTimeout(r.timeout);
      cachedTurnstileToken = token;
      cachedTokenExpiresAt = Date.now() + 4 * 60 * 1000;
      r.resolve(token);
    };
    const onError = () => {
      if (!pendingResolver) return;
      const r = pendingResolver;
      pendingResolver = undefined;
      clearTimeout(r.timeout);
      r.resolve(undefined);
    };

    if (turnstileWidgetId !== undefined) {
      // Subsequent calls — reset and re-execute the existing widget.
      // The original callbacks delegate to the current pendingResolver above.
      window.turnstile!.reset(turnstileWidgetId);
      window.turnstile!.execute(container);
    } else {
      turnstileWidgetId = window.turnstile!.render(container, {
        sitekey: import.meta.env.PUBLIC_TURNSTILE_SITE_KEY,
        size: 'invisible',
        callback: onCallback,
        'error-callback': onError
      });
      window.turnstile!.execute(container);
    }
  });
}

function getCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : undefined;
}

function extractGAClientId(gaCookie: string | undefined): string | undefined {
  if (!gaCookie) return undefined;
  const parts = gaCookie.split('.');
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : undefined;
}

// GA4 session id a `_ga_<STREAM>` cookie-ból. Két formátumot kell kezelni:
//   GS1: `GS1.1.<session_id>.<...>`
//   GS2: `GS2.1.s<session_id>$o..$g..`  ← 2025-05-06 óta az új session-ök defaultja
// A GS2-nél a session_id elé egy literál `s` kerül. Az opcionális `s`-t és a
// több jegyű verzió/slot szegmenseket is kezeljük. Nélküle az MP-event nem
// jelenik meg rendesen a GA4 riportokban.
function extractGASessionId(): string | undefined {
  const match = document.cookie.match(/_ga_[A-Z0-9]+=GS\d+\.\d+\.s?(\d+)/);
  return match ? match[1] : undefined;
}

// Consent Mode v2 állapot. A site beállítja a window.__trackingConsent-et a
// CMP-jéből (vagy a Google Consent Mode-ból). Hiányában undefined → a Worker a
// SiteConfig.require_consent szerint dönt.
function getConsentState(): ConsentState | undefined {
  if (typeof window === 'undefined') return undefined;
  const c = (window as unknown as { __trackingConsent?: ConsentState }).__trackingConsent;
  if (!c || typeof c !== 'object') return undefined;
  return c;
}

export async function sendToWorker(payload: ConversionPayload): Promise<boolean> {
  const turnstileToken = await getTurnstileToken();
  if (!turnstileToken) {
    console.warn('[tracking] No Turnstile token, skipping server-side dispatch', payload.event_name);
    return false;
  }

  const fbp = getCookie('_fbp');
  const fbc = getCookie('_fbc');
  const clientId = extractGAClientId(getCookie('_ga'));
  const sessionId = extractGASessionId();

  const body = JSON.stringify({
    ...payload,
    turnstile_token: turnstileToken,
    fbp,
    fbc,
    client_id: clientId,
    session_id: sessionId,
    consent: payload.consent || getConsentState(),
    event_source_url: payload.event_source_url || location.href
  });

  if (typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      const queued = navigator.sendBeacon('/api/event/conversion', blob);
      if (queued) return true;
    } catch {
      // Fall through to fetch
    }
  }

  try {
    await fetch('/api/event/conversion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    });
    return true;
  } catch (err) {
    console.warn('[tracking] sendToWorker failed', err);
    return false;
  }
}

export async function trackConversion(
  eventName: string,
  params: {
    event_id?: string;
    value?: number;
    currency?: string;
    source?: string;
    service?: string;
    user_data?: UserData;
    consent?: ConsentState;
  } = {}
): Promise<void> {
  const eventId = params.event_id || generateUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // 1. Existing kliens GTM dataLayer push (Meta Pixel browser-side dedup-hoz).
  // PII NEM kerül dataLayer-be — CLAUDE.md #15.
  if (typeof window !== 'undefined') {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: eventName,
      event_id: eventId,
      ...(params.value !== undefined && { value: params.value }),
      ...(params.currency && { currency: params.currency }),
      ...(params.source && { source: params.source }),
      ...(params.service && { service: params.service })
    });
  }

  // 2. Server-side Worker dispatch (PII a body-ban, hash-elve a Worker-ben).
  await sendToWorker({
    event_name: eventName,
    event_id: eventId,
    event_time: eventTime,
    value: params.value,
    currency: params.currency,
    source: params.source,
    service: params.service,
    user_data: params.user_data,
    consent: params.consent
  });
}
