# Astro Frontend Tracking Spec — 17 event teljes implementáció

**Cél:** Painless és minden Soborbo Astro site kliens-oldali tracking-je. **Ez a spec a Worker-rel együtt használandó** (lásd Sprint 9), de önállóan is alkalmazható kliensoldali stack-ként.

## 17 esemény áttekintés

| # | Event | Konverzió Google Ads-ben? | GA4 | Meta |
|---|---|---|---|---|
| 1 | `page_view` | nem | igen (auto) | `PageView` (auto + SPA-only manuális fix) |
| 2 | `pricing_view` | nem | igen | — |
| 3 | `form_start` | nem | igen | — |
| 4 | `form_step_complete` | nem | igen | — |
| 5 | `form_abandonment` | nem | igen (best-effort) | — |
| 6 | `quote_calculator_complete` | nem (engagement) | igen | `ViewContent` (csak első, value nélkül) |
| 7 | `quote_calculator_conversion` | **IGEN** | igen | `Lead` |
| 8 | `callback_conversion` | **IGEN** | igen | `Lead` |
| 9 | `contact_form_submit` | **IGEN** | igen | `Contact` |
| 10 | `phone_conversion` | **IGEN** | igen | `Contact` |
| 11 | `email_conversion` | **IGEN** | igen | `Contact` |
| 12 | `whatsapp_conversion` | **IGEN** | igen | `Contact` |
| 13 | `video_play` | nem | igen | `ViewContent` |
| 14 | `video_progress_25/50/75` | nem | igen | — |
| 15 | `video_complete` | nem | igen | — |
| 16 | `scroll_50` | nem | igen | — |
| 17 | `scroll_90` | nem | igen | — |

## Critical implementation rules

```md
## Critical implementation rules — DO NOT VIOLATE

1. **Do not use ES imports inside `<script is:inline>` blocks.**
   Use Astro's default bundled `<script>` (module-scoped, processed by Astro)
   for any code that imports from `src/lib/`. `is:inline` is reserved for
   self-contained snippets with NO imports.

2. **Global event listeners (click, scroll, pagehide) must be registered ONCE
   per page-load with proper cleanup.**
   Use AbortController for every listener attached on `astro:page-load`.
   Abort all signals in `astro:before-swap` to prevent duplication during
   View Transitions navigation.

3. **Consent defaults MUST be set before GTM loads.**
   The `gtag('consent', 'default', { ... })` call with all signals = 'denied'
   MUST be the FIRST script in `<head>`, before the GTM bootstrap snippet.

4. **PII (email, phone, names, addresses) MUST NOT be pushed to dataLayer.**
   User-provided data goes into hidden DOM `data-*` attributes on a dedicated
   confirmation element, OR via sendToWorker() POST body. GTM Variables read
   from DOM directly. NEVER through dataLayer.

5. **Meta Pixel `eventID` MUST be passed in the dedicated 4th argument of
   fbq() OR in GTM's Meta Pixel tag's `eventID` field — NOT as a normal
   custom event parameter.**
   Without correct placement, Meta does NOT deduplicate Browser+Server.

6. **Google Ads Enhanced Conversions require a GTM User-Provided Data
   variable, not raw DLVs.**
   In GTM: Variables → New → User-Provided Data → "Manual Configuration".
   (Vagy server-side úton, Sprint 9-ben.)

7. **`form_abandonment` is best-effort, not guaranteed.**
   Use both `pagehide` and `visibilitychange` events, and use
   `navigator.sendBeacon()` to a dedicated endpoint for reliability on mobile.

8. **`crypto.randomUUID()` requires HTTPS or localhost.**
   Use a UUID v4 fallback for non-secure contexts.

9. **Manual Meta `PageView` fires ONLY on SPA navigation, not on initial load.**
   The base Pixel snippet fires `PageView` automatically on first load.

10. **Quote `ViewContent` to Meta fires ONLY on the FIRST calculator
    completion in a session, and WITHOUT `value` parameter.**
```

## File structure

```
src/lib/
├── tracking-config.ts     # Constants (currency, timeouts, beacon URL)
├── uuid.ts                # UUID generator with HTTPS fallback
├── tracking.ts            # trackEvent + setUserDataOnDOM (PII-safe)
├── conversion-state.ts    # 60-min upgrade-window logic
├── form-tracking.ts       # form_start, form_step, form_abandonment
├── global-listeners.ts    # click (phone/email/whatsapp), scroll
└── worker-tracking.ts     # sendToWorker (Sprint 9)
```

## `src/lib/tracking-config.ts`

```typescript
export const CURRENCY = 'GBP';
export const QUOTE_TIMEOUT_MS = 60 * 60 * 1000;
export const QUOTE_POST_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ABANDONMENT_BEACON_URL = '/api/event/abandonment';
```

## `src/lib/uuid.ts`

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

## `src/lib/tracking.ts`

```typescript
import { generateUUID } from './uuid';

declare global {
  interface Window {
    dataLayer: any[];
    gtag?: (...args: any[]) => void;
    fbq?: (...args: any[]) => void;
  }
}

type TrackingParams = Record<string, any>;

/**
 * Pushes a NON-PII event to dataLayer.
 * For PII (user_data), use DOM-based passing via setUserDataOnDOM()
 * or server-side via sendToWorker().
 */
export function trackEvent(name: string, params: TrackingParams = {}) {
  if (typeof window === 'undefined') return;
  const { user_data, ...safeParams } = params;
  if (user_data && import.meta.env.DEV) {
    console.warn(`[tracking] PII detected in trackEvent('${name}'). Use setUserDataOnDOM or sendToWorker instead.`);
  }
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: name,
    event_id: safeParams.event_id || generateUUID(),
    ...safeParams
  });
}

export type UserData = {
  email?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  street?: string;
  postal_code?: string;
  country?: string;
};

const USER_DATA_ELEMENT_ID = '__tracking_user_data__';

export function setUserDataOnDOM(data: UserData) {
  let el = document.getElementById(USER_DATA_ELEMENT_ID) as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = USER_DATA_ELEMENT_ID;
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  if (data.email)        el.dataset.email       = data.email;
  if (data.phone_number) el.dataset.phone       = data.phone_number;
  if (data.first_name)   el.dataset.firstName   = data.first_name;
  if (data.last_name)    el.dataset.lastName    = data.last_name;
  if (data.city)         el.dataset.city        = data.city;
  if (data.street)       el.dataset.street      = data.street;
  if (data.postal_code)  el.dataset.postalCode  = data.postal_code;
  if (data.country)      el.dataset.country     = data.country;
}

export function clearUserDataOnDOM() {
  document.getElementById(USER_DATA_ELEMENT_ID)?.remove();
}

export function normalizePhoneE164(phone: string, countryCode: 'GB' | 'HU' = 'GB'): string {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (countryCode === 'GB') {
    if (cleaned.startsWith('0')) cleaned = '+44' + cleaned.slice(1);
    else if (cleaned.startsWith('44')) cleaned = '+' + cleaned;
    else cleaned = '+44' + cleaned;
  } else if (countryCode === 'HU') {
    if (cleaned.startsWith('06')) cleaned = '+36' + cleaned.slice(2);
    else if (cleaned.startsWith('0')) cleaned = '+36' + cleaned.slice(1);
    else if (cleaned.startsWith('36')) cleaned = '+' + cleaned;
    else cleaned = '+36' + cleaned;
  }
  return cleaned;
}

export function normalizeUserData(input: Partial<UserData>, countryCode: 'GB' | 'HU' = 'GB'): UserData {
  return {
    email: input.email?.toLowerCase().trim() || undefined,
    phone_number: input.phone_number ? normalizePhoneE164(input.phone_number, countryCode) : undefined,
    first_name: input.first_name?.toLowerCase().trim() || undefined,
    last_name: input.last_name?.toLowerCase().trim() || undefined,
    city: input.city?.toLowerCase().trim() || undefined,
    street: input.street?.toLowerCase().trim() || undefined,
    postal_code: input.postal_code?.toUpperCase().replace(/\s/g, '') || undefined,
    country: countryCode
  };
}
```

## `src/lib/conversion-state.ts` — 60 perces upgrade-logika

```typescript
import { trackEvent, type UserData } from './tracking';
import { generateUUID } from './uuid';
import { QUOTE_TIMEOUT_MS, QUOTE_POST_WINDOW_MS } from './tracking-config';

type QuoteState = {
  value: number;
  currency: string;
  service: string;
  completedAt: number;
  eventId: string;
  upgraded: boolean;
  userData?: UserData;
  viewContentFired: boolean;
};

const STATE_KEY = 'quote_state';
let pendingTimerId: number | null = null;

function clearPendingTimer() {
  if (pendingTimerId !== null) {
    clearTimeout(pendingTimerId);
    pendingTimerId = null;
  }
}

function getRawState(): QuoteState | null {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function resetQuoteState(input: {
  value: number;
  currency: string;
  service: string;
  userData?: UserData;
}): QuoteState {
  clearPendingTimer();
  const previous = getRawState();

  const state: QuoteState = {
    value: input.value,
    currency: input.currency,
    service: input.service,
    completedAt: Date.now(),
    eventId: generateUUID(),
    upgraded: false,
    userData: input.userData,
    viewContentFired: previous?.viewContentFired ?? false
  };

  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  pendingTimerId = window.setTimeout(() => fireQuoteConversionIfStillActive(false), QUOTE_TIMEOUT_MS);
  return state;
}

export function getActiveQuoteState(): QuoteState | null {
  const state = getRawState();
  if (!state || state.upgraded) return null;
  if (Date.now() - state.completedAt > QUOTE_TIMEOUT_MS) return null;
  return state;
}

export function markQuoteUpgraded() {
  const state = getRawState();
  if (!state) return;
  state.upgraded = true;
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  clearPendingTimer();
}

export function markViewContentFired() {
  const state = getRawState();
  if (!state) return;
  state.viewContentFired = true;
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function fireQuoteConversionIfStillActive(isLate: boolean) {
  const state = getRawState();
  if (!state || state.upgraded) return;

  trackEvent('quote_calculator_conversion', {
    value: state.value,
    currency: state.currency,
    service: state.service,
    event_id: state.eventId,
    late_conversion: isLate || undefined
  });

  sessionStorage.removeItem(STATE_KEY);
  clearPendingTimer();
}

export function resumeQuoteTimer() {
  const state = getRawState();
  if (!state || state.upgraded) return;

  const elapsed = Date.now() - state.completedAt;
  clearPendingTimer();

  if (elapsed <= QUOTE_TIMEOUT_MS) {
    pendingTimerId = window.setTimeout(
      () => fireQuoteConversionIfStillActive(false),
      QUOTE_TIMEOUT_MS - elapsed
    );
  } else if (elapsed <= QUOTE_TIMEOUT_MS + QUOTE_POST_WINDOW_MS) {
    fireQuoteConversionIfStillActive(true);
  } else {
    sessionStorage.removeItem(STATE_KEY);
  }
}
```

## `src/lib/form-tracking.ts`

```typescript
import { trackEvent } from './tracking';
import { ABANDONMENT_BEACON_URL } from './tracking-config';

type FormState = {
  formName: string;
  startedAt: number;
  lastStep?: string;
  lastField?: string;
  submitted: boolean;
};

const activeForms = new Map<string, FormState>();
let listenerController: AbortController | null = null;

export function initFormTracking(formId: string, formName: string) {
  const form = document.getElementById(formId);
  if (!form) return;

  const formController = new AbortController();

  form.addEventListener('focusin', (e) => {
    const target = e.target as HTMLElement;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

    if (!activeForms.has(formId)) {
      activeForms.set(formId, { formName, startedAt: Date.now(), submitted: false });
      trackEvent('form_start', {
        form_name: formName,
        page_path: location.pathname,
        page_title: document.title
      });
    }
    activeForms.get(formId)!.lastField = target.getAttribute('name') || target.id;
  }, { signal: formController.signal });

  form.addEventListener('submit', () => {
    const state = activeForms.get(formId);
    if (state) state.submitted = true;
  }, { signal: formController.signal });

  (form as any).__abandonmentController = formController;
}

export function trackFormStep(formId: string, stepName: string, stepNumber: number, totalSteps: number) {
  const state = activeForms.get(formId);
  if (state) state.lastStep = stepName;

  trackEvent('form_step_complete', {
    form_name: state?.formName,
    step_name: stepName,
    step_number: stepNumber,
    total_steps: totalSteps,
    page_path: location.pathname
  });
}

function reportAbandonment(state: FormState) {
  const payload = {
    event: 'form_abandonment',
    form_name: state.formName,
    last_step: state.lastStep || 'unknown',
    last_field: state.lastField || 'unknown',
    time_spent_seconds: Math.round((Date.now() - state.startedAt) / 1000),
    exit_page_path: location.pathname,
    exit_page_title: document.title,
    exit_page_url: location.href,
    timestamp: Date.now()
  };

  if (typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(ABANDONMENT_BEACON_URL, blob);
    } catch { /* swallow */ }
  }

  trackEvent('form_abandonment', payload);
}

function handleAbandonment() {
  activeForms.forEach((state) => {
    if (state.submitted) return;
    reportAbandonment(state);
  });
  activeForms.clear();
}

export function initAbandonmentListeners() {
  listenerController?.abort();
  listenerController = new AbortController();
  const signal = listenerController.signal;

  window.addEventListener('pagehide', handleAbandonment, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handleAbandonment();
  }, { signal });
  document.addEventListener('astro:before-swap', handleAbandonment, { signal });
}

export function cleanupAbandonmentListeners() {
  listenerController?.abort();
  listenerController = null;
}
```

## `src/lib/global-listeners.ts`

```typescript
import { trackEvent } from './tracking';
import { generateUUID } from './uuid';
import { getActiveQuoteState, markQuoteUpgraded } from './conversion-state';

let controller: AbortController | null = null;

export function initGlobalListeners() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;

  // Click tracking — phone, email, whatsapp
  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a');
    if (!link) return;
    const href = link.getAttribute('href') || '';

    let eventName: string | null = null;
    const extras: Record<string, any> = {};
    if (href.startsWith('tel:'))         { eventName = 'phone_conversion';    extras.phone = href.replace('tel:', ''); }
    else if (href.includes('wa.me'))     { eventName = 'whatsapp_conversion'; }
    else if (href.startsWith('mailto:')) { eventName = 'email_conversion';    }
    if (!eventName) return;

    const activeQuote = getActiveQuoteState();
    if (activeQuote) {
      markQuoteUpgraded();
      trackEvent(eventName, {
        event_id: activeQuote.eventId,
        value: activeQuote.value,
        currency: activeQuote.currency,
        service: activeQuote.service,
        source: 'after_calculator',
        ...extras
      });
    } else {
      trackEvent(eventName, {
        event_id: generateUUID(),
        source: 'standalone',
        ...extras
      });
    }
  }, { signal });

  // Scroll depth
  let fired50 = false, fired90 = false;
  window.addEventListener('scroll', () => {
    const pct = (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100;
    if (pct >= 50 && !fired50) { fired50 = true; trackEvent('scroll_50'); }
    if (pct >= 90 && !fired90) { fired90 = true; trackEvent('scroll_90'); }
  }, { passive: true, signal });
}

export function cleanupGlobalListeners() {
  controller?.abort();
  controller = null;
}
```

## `src/layouts/BaseLayout.astro`

```astro
---
const GTM_ID = 'GTM-W8V3BVGD';
---
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />

  <!-- 1. CONSENT DEFAULT — MUST BE FIRST, BEFORE GTM -->
  <script is:inline>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('consent', 'default', {
      'ad_storage': 'denied',
      'analytics_storage': 'denied',
      'ad_user_data': 'denied',
      'ad_personalization': 'denied',
      'wait_for_update': 500
    });
  </script>

  <!-- 2. CookieYes (calls gtag('consent','update',...) when user chooses) -->
  <script id="cookieyes" type="text/javascript" src="https://cdn-cookieyes.com/client_data/<your_id>/script.js"></script>

  <!-- 3. GTM bootstrap -->
  <script is:inline>
    (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-W8V3BVGD');
  </script>

  <!-- 4. Cloudflare Turnstile (Sprint 9-tól) -->
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" async defer></script>
</head>
<body>
  <slot />

  <!-- GTM noscript -->
  <noscript><iframe src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`} height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

  <!-- Invisible Turnstile widget -->
  <div id="cf-turnstile-invisible" style="display: none;"></div>

  <!-- Bundled module script — imports work here, NOT in is:inline -->
  <script>
    import { resumeQuoteTimer } from '../lib/conversion-state';
    import { initGlobalListeners, cleanupGlobalListeners } from '../lib/global-listeners';
    import { initAbandonmentListeners, cleanupAbandonmentListeners } from '../lib/form-tracking';
    import { trackEvent } from '../lib/tracking';

    let isFirstLoad = true;

    function onPageLoad() {
      if (!isFirstLoad && typeof window.fbq === 'function') {
        window.fbq('track', 'PageView');
      }
      if (!isFirstLoad && typeof window.gtag === 'function') {
        window.gtag('event', 'page_view', {
          page_path: location.pathname,
          page_title: document.title
        });
      }
      isFirstLoad = false;

      if (location.pathname.startsWith('/quote') || location.pathname.startsWith('/pricing')) {
        trackEvent('pricing_view', {
          page_path: location.pathname,
          page_title: document.title
        });
      }

      resumeQuoteTimer();
      initGlobalListeners();
      initAbandonmentListeners();
    }

    function onBeforeSwap() {
      cleanupGlobalListeners();
      cleanupAbandonmentListeners();
    }

    document.addEventListener('astro:page-load', onPageLoad);
    document.addEventListener('astro:before-swap', onBeforeSwap);
  </script>
</body>
</html>
```

## GTM bekötés

### GTM User-Provided Data Variable (Enhanced Conversions-höz)

GTM → Variables → New → Variable Configuration → **User-Provided Data**:

- Email: `{{JS - Email from DOM}}`
- Phone Number: `{{JS - Phone from DOM}}`
- First name: `{{JS - First Name from DOM}}`
- Last name: `{{JS - Last Name from DOM}}`
- Address.City: `{{JS - City from DOM}}`
- Address.Postal code: `{{JS - Postcode from DOM}}`

Mindegyik egy Custom JavaScript variable:

```javascript
function() {
  return document.getElementById('__tracking_user_data__')?.dataset.email || undefined;
}
```

### Triggerek

Custom Event triggerek minden eventre.

### Tagek + Consent Settings

| dataLayer event | GA4 tag | Google Ads | Meta Pixel |
|---|---|---|---|
| `quote_calculator_complete` | GA4 Event | — | — |
| `quote_calculator_first_view` | — | — | Meta `ViewContent`, eventID, NO value |
| `quote_calculator_conversion` | GA4 Event | "Quote Calculator" (UPD, value) | Meta `Lead` (eventID, value) |
| `callback_conversion` | GA4 Event | "Callback Request" (UPD) | Meta `Lead` (eventID) |
| `contact_form_submit` | GA4 Event | "Contact Form" (UPD) | Meta `Contact` (eventID) |
| `phone_conversion` | GA4 Event | "Phone Click" (UPD) | Meta `Contact` (eventID) |
| `email_conversion` | GA4 Event | "Email Click" (UPD) | Meta `Contact` (eventID) |
| `whatsapp_conversion` | GA4 Event | "WhatsApp Click" (UPD) | Meta `Contact` (eventID) |

**FONTOS Sprint 9-cél**: a Google Ads + 6 GA4 conversion tag eltávolításra kerül a kliens GTM-ből, mert server-side megy a Worker-en.

## Dashboard-feladatok

1. **Meta Events Manager** → Pixel → Meta-enabled CAPI bekapcsolás (alternatív/kiegészítő server-side)
2. **Cloudflare** → Engagement → Google tag gateway → Sign in (minden Astro zone-on)
3. **CookieYes**: Advanced Settings → "Support GCM" toggle ON
4. **GA4 Admin → Events → Mark as conversion** a 6 konverziós event-en
5. **GA4 Admin → Custom Dimensions** — csak a kritikus paraméterek (50-es limit)
6. **Google Ads → Conversions** — 6 conversion action

## Tesztelés

| Mit | Hol | Pass kritérium |
|---|---|---|
| Pixel + CAPI dedup | Meta Events Manager Test Events | "Browser AND Server" jelzés azonos eventID-vel |
| GA4 17 event | GA4 DebugView | Mind az 17 megjelenik |
| Google Ads conversions | Google Ads Diagnosis | EC match rate > 30% |
| Konverziós lépcső | Kalkulátor → 30s → tel: click | Csak 1 konverzió, kalkulátor érték rajta |
| Multi-completion | Kalkulátor 3× | Csak 1× ViewContent Meta-ba |
| View Transitions | 5 oldal-navigáció | Click listener nem duplikálódik |
| `form_abandonment` mobile | iPhone Safari, swap app | sendBeacon endpoint logba |
| PII leak teszt | Console: `JSON.stringify(window.dataLayer)` | NINCS email/phone/név |

## A 60 perces upgrade-ablak trade-off

A spec a "valódi intent-minőség" oldalt választja: csak az upgrade számít konverziónak.

- **Előny**: Google Ads Smart Bidding tisztább signal-okra optimalizál
- **Hátrány**: Kevesebb conversion event → lassabb tanulás új kampányoknál

Ha a Painless 4 hét után nem ér 30 konverziót/hét: átmenetileg a `quote_calculator_complete` is konverziónak számít Google Ads-ben (külön conversion action), de GA4 primary conversion-nek marad csak az upgrade-elt változat.
