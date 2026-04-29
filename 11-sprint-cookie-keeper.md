# Sprint 11 — Cookie Keeper (Safari ITP server-set first-party cookies)

**Cél:** Safari ITP-megkerülés server-set HTTPOnly cookie-kkal. `_fbc` (és opcionálisan `_fbp`) megmarad 7 nap helyett 365 napig Safari-on.

**Idő Claude Code-dal:** 5-7 óra (hibrid) vagy 8-15 óra (teljes).

## Mikor építsd ezt

**A Sprint 1-10 + 2.5/6.5/8.5 lezárása UTÁN, 4-hét Painless production data alapján:**

```
Painless Meta EMQ score?
├─ ≥8/10 → NE építsd (nincs üzleti igény)
├─ 7-8/10 → BIZONYTALAN; ha mobil Safari >30%, építsd hibrid verziót
└─ <7/10 → ELŐSZÖR check hash + dedup; ha azok OK, építsd hibrid verziót
```

**Két variáns**:
- **Hibrid (csak `_fbc`)**: 5-7 óra, +0.5-1 EMQ pont
- **Teljes (`_fbp` + `_fbc`)**: 8-15 óra, +1-1.5 EMQ pont

A **hibrid** az ajánlott első kör, mert a `_fbc` (kattintási attribution) a kritikus.

## Architektúra

A Worker `Set-Cookie` headert ad vissza minden conversion response-ban:

```
Set-Cookie: _fbc_long=<value>; Path=/; Domain=.painlessremovals.com; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax
```

**Shadow cookie pattern**: nem közvetlenül `_fbc`-t set-tel, mert a Meta Pixel JS-ből újra beállítaná. Helyette `_fbc_long`-ot tárolunk **HTTPOnly** módban (JS nem olvassa).

A Worker minden conversion request-nél:
1. Olvassa `_fbc`-t (kliens-oldali, JS-set, 7 napon belül érvényes)
2. Olvassa `_fbc_long`-ot (server-side shadow, 365 napos)
3. Ha van friss `_fbc`: használja azt + frissíti `_fbc_long`-ot
4. Ha nincs `_fbc` (Safari ITP törölte) de van `_fbc_long`: használja a long-ot

## Mielőtt nekiállsz

### 1. Sprint 9 lezárt + 4 hét adat

Painless EMQ score <8 → indokolt. EMQ score ≥8 → ne építsd.

### 2. Custom domain proxy ellenőrzés

A Sprint 1-ben a Worker route-ot a fő domain alá tettük (`painlessremovals.com/api/event/*`). Ez **first-party**, **nem** `*.workers.dev`. Ellenőrizd Cloudflare dashboard-on.

### 3. Cloudflare zone IP alignment

Cloudflare-en a Workers és a Pages projektek **automatikusan** azonos zone alatt futnak, ha mindkét deploy ugyanazon a Cloudflare account-on belül van.

## Új fájl: `src/lib/cookie-keeper.ts`

```typescript
import type { SiteConfig } from './config';

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 365 days

export interface CookieKeeperResult {
  effective_fbp?: string;
  effective_fbc?: string;
  setCookieHeaders: string[];
}

/**
 * Reads cookies from request, decides effective values, prepares Set-Cookie headers.
 * @param mode 'fbc-only' (hybrid) or 'full' (fbp + fbc)
 */
export function processCookieKeeper(
  request: Request,
  siteConfig: SiteConfig,
  payload: { fbp?: string; fbc?: string },
  mode: 'fbc-only' | 'full' = 'fbc-only'
): CookieKeeperResult {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const setCookieHeaders: string[] = [];

  const url = new URL(request.url);
  const cookieDomain = `.${url.hostname.replace(/^www\./, '')}`;

  // _fbc handling (always)
  const fbcKlient = payload.fbc || cookies['_fbc'];
  const fbcShadow = cookies['_fbc_long'];
  const effective_fbc = fbcKlient || fbcShadow;

  if (fbcKlient) {
    setCookieHeaders.push(buildCookieHeader('_fbc_long', fbcKlient, cookieDomain));
  }

  // _fbp handling (only if mode === 'full')
  let effective_fbp: string | undefined;
  if (mode === 'full') {
    const fbpKlient = payload.fbp || cookies['_fbp'];
    const fbpShadow = cookies['_fbp_long'];
    effective_fbp = fbpKlient || fbpShadow;
    if (fbpKlient) {
      setCookieHeaders.push(buildCookieHeader('_fbp_long', fbpKlient, cookieDomain));
    }
  } else {
    effective_fbp = payload.fbp || cookies['_fbp'];
  }

  return { effective_fbp, effective_fbc, setCookieHeaders };
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[name] = value;
  });
  return cookies;
}

function buildCookieHeader(name: string, value: string, domain: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Domain=${domain}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}
```

## Módosítandó: `src/routes/conversion.ts`

```typescript
import { processCookieKeeper } from '../lib/cookie-keeper';

// ... existing parse/validate/turnstile/site_config code ...

// Cookie Keeper: read shadow cookies, decide effective values
const cookieKeeperMode: 'fbc-only' | 'full' = 'fbc-only';
const cookieResult = processCookieKeeper(
  request,
  siteConfig,
  { fbp: payload.fbp, fbc: payload.fbc },
  cookieKeeperMode
);

// Use effective values in fan-out
const metaPromise = sendToMetaCAPI(siteConfig, {
  // ...
  fbp: cookieResult.effective_fbp,
  fbc: cookieResult.effective_fbc,
}, hashedUserData);

// Build response with Set-Cookie headers
const responseHeaders = new Headers(cors);
for (const setCookieValue of cookieResult.setCookieHeaders) {
  responseHeaders.append('Set-Cookie', setCookieValue);
}

return new Response(null, { status: 204, headers: responseHeaders });
```

## Astro front-end change

A `worker-tracking.ts` fetch-be kéri, hogy a server set-eljen cookie-kat:

```typescript
await fetch('/api/event/conversion', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
  credentials: 'include',  // ← KRITIKUS
  keepalive: true
});
```

A `credentials: 'include'` nélkül a browser **eldobja** a Set-Cookie headert.

A `sendBeacon` automatikusan include-olja a cookie-kat — ott nem kell change.

## Manuális tesztelés

### A. First-time user — kliens cookie van

1. Painless oldal incognito-ban → Meta Pixel set-eli `_fbc`-t
2. Curl conversion → Worker visszaad `Set-Cookie: _fbc_long=...`
3. DevTools Application → Cookies: `_fbc` (JS, 7 napos) ÉS `_fbc_long` (HTTPOnly, 365 napos)

### B. Returning user simulation

1. Manuálisan töröld `_fbc` cookie-t
2. Hagyd `_fbc_long`-ot
3. Curl conversion → Worker olvassa `_fbc_long`-ot
4. Logs: `effective_fbc: fb.1.1714400000.AbCdE`

### C. Safari iOS valódi tesztelés

iPhone Safari (mobil device kell, simulator nem szimulálja ITP-t):
1. Painless oldal → Meta Pixel set-eli `_fbc`
2. Form submit → server set-eli `_fbc_long`
3. Várd 8 napot vagy módosítsd Safari Develop scriptet
4. Visszatérés → `_fbc` ITP-vel törölve, `_fbc_long` megmaradt
5. Form submit → Worker `_fbc_long`-ot használja

### D. Meta EMQ validation

4 hét után Meta Events Manager → Match Quality:
- iOS Safari traffic submetric javul
- Overall EMQ +0.5-1.5 pont

## Teljes verzió (full mode)

`cookieKeeperMode = 'full'`-re átállítva mind `_fbp`, mind `_fbc` shadow cookie-t kezel. **Plusz 3-5 óra** kódolás (kicsi).

A különbség: a `_fbp` is megőrződik 365 napig server-side, ami minden Safari user-nél javítja a dedup-ot.

**Csak akkor érdemes**, ha a hibrid 4 hét után még mindig nem ad elég EMQ-t.

## Edge case-ek

**1. iOS 26 / Safari 19+ APP**: Apple még szigorúbb cookie-kezelést vezetett be 2025 második felében. A HTTPOnly first-party Cookie Keeper trükk **továbbra is működik**, de évente újraértékelendő.

**2. SameSite=Lax vs Strict**: spec `Lax`-ot használ — Painless conversion lehet külső linkről érkező user-é.

**3. Domain pinning**: ha Painless valaha másik root domain-re vált, a `_fbc_long` elveszik, néhány hét után új domain-en visszaáll.

**4. Cookie size limit**: Safari 4096 byte limit. `_fbc` és `_fbp` formátum max 50 byte → bőven befér.

**5. GDPR**: a HTTPOnly first-party cookie technikailag kevésbé "tracker", funkcionálisan ugyanaz. Painless Privacy Policy-t nem kell módosítani — `_fbc` és `_fbp` már említve. `_fbc_long` és `_fbp_long` ugyanaz a cél, csak technical implementation különbözik.

## Sprint 11 utáni státusz

- ✅ Safari ITP server-set cookies
- ✅ `_fbc` 365 napos retention (hibrid)
- ✅ Optionálisan `_fbp` 365 napos retention (full)
- ✅ Painless EMQ +0.5-1.5 pont (várható)
- ✅ Mobil Safari matchback dramatikusan jobb

## Mit KÉRDEZZ a usertől

1. Sprint 9-10 lezárt, 4 hét production data?
2. Painless EMQ score <8 (indokolt)?
3. Hibrid (csak _fbc) vagy teljes (fbp + fbc)?
4. Custom domain proxy működik?
5. iPhone Safari kéznél valódi ITP teszteléshez?
