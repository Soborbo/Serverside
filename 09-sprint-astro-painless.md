# Sprint 9 — Astro production integráció Painless-en

**Cél:** A Painless Astro oldalon a 6 konverziós event server-side megy a Worker-en keresztül, párhuzamosan a meglévő kliensoldali GTM-mel. Painless production traffic kezdi használni a Worker stack-et.

**Idő Claude Code-dal:** 4-6 óra. **Az első sprint, ami valós Painless user-eket érint.**

## Mielőtt nekiállsz

### 1. Painless GTM container backup

GTM → Painless container → Admin → Export Container → JSON. Mentsd `painless-gtm-backup-2026-04-29.json` névvel. **Ne hagyd ki.** Ha valami baja van Sprint 9-nek, vissza kell tudnod állni 5 percen belül.

### 2. Painless KV config: test_event_code KIVÉTELE

```bash
# A meglévő config-ot frissítsd, töröld a test_event_code mezőt
wrangler kv:key put --binding=SITE_CONFIG "painlessremovals.com" '{
  "site_id": "painless",
  "country_code": "GB",
  "currency": "GBP",
  "meta": {
    "pixel_id": "...",
    "access_token": "..."
    // NINCS test_event_code mező
  },
  "ga4": { ... },
  "gads": { ... }
}'
```

**KRITIKUS:** Ha a `test_event_code` bent marad, **minden Painless valós konverzió Test stream-be megy**, nem a fő Meta Ads Manager-be.

### 3. Painless Astro projekt branch

```bash
cd ~/projects/PainlessRemovals2026
git checkout -b worker-tracking-integration
```

## Új fájl Painless Astro projektben: `src/lib/uuid.ts`

(Ha még nincs ilyen fájl)

```typescript
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
```

## Új fájl: `src/lib/worker-tracking.ts`

```typescript
import { generateUUID } from './uuid';

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId?: string) => void;
      execute: (container?: string | HTMLElement) => void;
      getResponse: (widgetId?: string) => string | undefined;
    };
    dataLayer: any[];
    fbq?: (...args: any[]) => void;
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
}

let cachedTurnstileToken: string | undefined;
let cachedTokenExpiresAt = 0;

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

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn('[tracking] Turnstile timeout');
        resolve(undefined);
      }
    }, 10000);

    window.turnstile!.render(container, {
      sitekey: import.meta.env.PUBLIC_TURNSTILE_SITE_KEY,
      size: 'invisible',
      callback: (token: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        cachedTurnstileToken = token;
        cachedTokenExpiresAt = Date.now() + 4 * 60 * 1000;
        resolve(token);
      },
      'error-callback': () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(undefined);
      }
    });

    window.turnstile!.execute(container);
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

export async function sendToWorker(payload: ConversionPayload): Promise<boolean> {
  const turnstileToken = await getTurnstileToken();
  if (!turnstileToken) {
    console.warn('[tracking] No Turnstile token, skipping server-side dispatch', payload.event_name);
    return false;
  }

  const fbp = getCookie('_fbp');
  const fbc = getCookie('_fbc');
  const clientId = extractGAClientId(getCookie('_ga'));

  const body = JSON.stringify({
    ...payload,
    turnstile_token: turnstileToken,
    fbp,
    fbc,
    client_id: clientId,
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
  } = {}
): Promise<void> {
  const eventId = params.event_id || generateUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // 1. Existing kliens GTM dataLayer push (Meta Pixel browser-side dedup-hoz)
  // NOTE: user_data NEM megy dataLayer-be (PII protection)
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

  // 2. Server-side Worker dispatch
  await sendToWorker({
    event_name: eventName,
    event_id: eventId,
    event_time: eventTime,
    value: params.value,
    currency: params.currency,
    source: params.source,
    service: params.service,
    user_data: params.user_data
  });
}
```

## Layout módosítás: `src/layouts/BaseLayout.astro`

A `<head>` végéhez (közvetlenül a GTM snippet UTÁN):

```astro
<!-- Cloudflare Turnstile -->
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" async defer></script>
```

A `<body>` legelején (a noscript GTM iframe UTÁN):

```astro
<!-- Invisible Turnstile widget -->
<div id="cf-turnstile-invisible" style="display: none;"></div>
```

## Environment variable

`.env.production` (és Cloudflare Pages secret):
```
PUBLIC_TURNSTILE_SITE_KEY=<TURNSTILE_SITE_KEY_FROM_DASHBOARD>
```

## Astro forms módosítások

### Quote calculator complete

```typescript
import { trackConversion } from '../lib/worker-tracking';
import { resetQuoteState, markViewContentFired } from '../lib/conversion-state';

async function onCalculatorSuccess(data) {
  const userData = {
    email: data.email,
    phone_number: data.phone,
    first_name: data.firstName,
    last_name: data.lastName,
    city: data.city,
    postal_code: data.postcode,
    country: 'GB'
  };

  const state = resetQuoteState({
    value: data.estimated_price,
    currency: 'GBP',
    service: 'removal',
    userData
  });

  // GA4 engagement event (kliens, NEM Google Ads conversion)
  if (typeof window !== 'undefined' && window.dataLayer) {
    window.dataLayer.push({
      event: 'quote_calculator_complete',
      event_id: state.eventId,
      value: data.estimated_price,
      currency: 'GBP',
      service: 'removal'
    });
  }

  // Meta ViewContent: csak az első completion-nél, value nélkül
  if (!state.viewContentFired) {
    if (typeof window.fbq === 'function') {
      window.fbq('track', 'ViewContent', {}, { eventID: state.eventId });
    }
    markViewContentFired();
  }
}
```

### Callback request submit

```typescript
import { trackConversion } from '../lib/worker-tracking';
import { getActiveQuoteState, markQuoteUpgraded } from '../lib/conversion-state';
import { generateUUID } from '../lib/uuid';

async function onCallbackSubmit(formData: FormData) {
  const userData = {
    email: formData.get('email') as string,
    phone_number: formData.get('phone') as string,
    first_name: formData.get('firstName') as string,
    last_name: formData.get('lastName') as string,
    country: 'GB'
  };

  const activeQuote = getActiveQuoteState();

  if (activeQuote) {
    markQuoteUpgraded();
    await trackConversion('callback_conversion', {
      event_id: activeQuote.eventId,
      value: activeQuote.value,
      currency: activeQuote.currency,
      service: activeQuote.service,
      source: 'after_calculator',
      user_data: userData
    });
  } else {
    await trackConversion('callback_conversion', {
      event_id: generateUUID(),
      source: 'standalone',
      user_data: userData
    });
  }
}
```

### tel: link click

`src/layouts/BaseLayout.astro` body végén:

```astro
<script>
  import { trackConversion } from '../lib/worker-tracking';
  import { getActiveQuoteState, markQuoteUpgraded } from '../lib/conversion-state';
  import { generateUUID } from '../lib/uuid';

  document.addEventListener('astro:page-load', () => {
    document.addEventListener('click', async (e) => {
      const link = (e.target as HTMLElement).closest('a');
      if (!link) return;
      const href = link.getAttribute('href') || '';

      let eventName: string | undefined;
      if (href.startsWith('tel:')) eventName = 'phone_conversion';
      else if (href.includes('wa.me')) eventName = 'whatsapp_conversion';
      else if (href.startsWith('mailto:')) eventName = 'email_conversion';
      if (!eventName) return;

      const activeQuote = getActiveQuoteState();
      if (activeQuote) {
        markQuoteUpgraded();
        await trackConversion(eventName, {
          event_id: activeQuote.eventId,
          value: activeQuote.value,
          currency: activeQuote.currency,
          service: activeQuote.service,
          source: 'after_calculator'
        });
      } else {
        await trackConversion(eventName, {
          event_id: generateUUID(),
          source: 'standalone'
        });
      }
    });
  });
</script>
```

## GTM container módosítások

### Tagek, amiket ELTÁVOLÍTASZ

**1. Google Ads Conversion Tracking tagek**: a 6 conversion action mindegyikéhez tartozó tag **kikapcsolva** vagy **törölve**. Indok: most server-side megy a Worker-en. Ha bent marad: dupla számolás.

**2. GA4 Event tagek a 6 konverziós event-re**:
- `quote_calculator_conversion`, `callback_conversion`, `contact_form_submit`, `phone_conversion`, `email_conversion`, `whatsapp_conversion`

Indok: most server-side GA4 MP-n megy.

### Tagek, amiket MEGTARTASZ

- **GA4 Configuration tag** (page_view, scroll, engagement)
- **Meta Pixel base + custom event tagek** (dual-source dedup-hoz)
- **Engagement event GA4 Event tagek**: `pricing_view`, `form_start`, `form_step_complete`, `form_abandonment`, `quote_calculator_complete`, `video_play`, `video_progress_*`, `scroll_50`, `scroll_90`

### Meta Pixel tagek `eventID` field hozzáadása

KRITIKUS dedup-hoz. Minden konverziós Meta Pixel tag-be (Lead, Contact):
- Trigger: `quote_calculator_conversion` Custom Event → Meta Pixel `Lead`, `eventID = {{DLV - event_id}}`
- Ugyanez minden konverziós event-re

Ha hiányzik: Meta dupla Lead-et számol, EMQ torz, lookalike audience torz.

## Cloudflare Pages config

Cloudflare Pages → Painless project → Functions → Routes:
- `painlessremovals.com/api/event/*` → Worker `soborbo-tracking` szolgálja ki

Az Astro projektben **NE legyen** `src/pages/api/event/` mappa (ütközne a Worker route-tal).

## Manuális tesztelés

### A. Staging deploy first

```bash
git checkout worker-tracking-integration
npm run build
# Cloudflare Pages auto-deploy
```

Staging URL-en:
1. DevTools Network tab nyitva
2. Töltsd ki a kalkulátort, kérj visszahívást
3. Network tab: `POST /api/event/conversion` → 204
4. Request payload: `event_name`, `event_id`, `turnstile_token`, `user_data`, `fbp`, `fbc`, `client_id`
5. Console: `JSON.stringify(window.dataLayer)` — NINCS PII benne

### B. Meta validation

Meta Events Manager → Painless Pixel → Diagnostics → 1-2 nap után event "Browser AND Server" jelzéssel, EMQ ≥7.

### C. GA4 Real-time validation

GA4 → Reports → Realtime → Painless live form submit → user megjelenik server-side forrás-jelzéssel. NINCS duplikáció.

### D. Google Ads diagnosis

48 óra múlva: Google Ads → Painless → Goals → Conversions → "Callback Request" → Diagnosis → "Recording", EC match rate ≥30%.

### E. Worker logs

```bash
wrangler tail --format pretty
```

`"Conversion event accepted"` → `"Meta CAPI event sent"` → `"GA4 MP event sent"` → `"Google Ads conversion uploaded"` → `"Fan-out completed"` minden `success: true`.

### F. ROAS validation 1-2 hét múlva

- Conversion volumes nem csökkennek érzékelhetően
- ROAS 2-4 hét után stabilizál
- Meta EMQ score 7+ stabilan
- Painless CRM vs Google Ads conversions count <15% mismatch

## Sprint 9 utáni státusz

- ✅ Painless Astro production traffic megy a Worker-en keresztül
- ✅ Dual-source Meta dedup-pal
- ✅ Server-side EC Google Ads-nek
- ✅ GA4 server-side conversions
- ✅ NINCS dupla számolás
- ✅ Turnstile bot-szűrés
- ✅ DLQ + cron retry production-ben
- ❌ A többi 14 site még nincs migrálva: Sprint 10

## Mit KÉRDEZZ a usertől

1. Painless GTM backup mentve?
2. test_event_code kivéve KV-ből?
3. Painless Astro deploy (worker-tracking-integration branch) sikeres staging-en?
4. Network tab `POST /api/event/conversion` 204?
5. Meta Test Events: dual-source jelzés (Browser AND Server)?
6. GA4 Realtime: server-side event-ek, NINCS duplikáció?
7. GTM container: Google Ads + GA4 conversion tagek **eltávolítva**?
8. Meta Pixel tagek `eventID` field hozzáadva?
9. ROAS 1-2 hét stabilan teljesít, mielőtt Sprint 10-re lépsz?
