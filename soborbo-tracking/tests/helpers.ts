/** Közös teszt-segédek a jsdom környezethez. */

/**
 * Emits a REAL-shaped CookieYes `getCkyConsent()` payload. The `marketing`
 * option is the test's semantic word for the ads category — CookieYes exposes
 * it under the key `advertisement` (there is no `marketing` key). Mapping it
 * here keeps the test call-sites readable while exercising the real contract,
 * so a regression to the wrong key (the 2026-07 silent-death bug) fails a test.
 */
export function setCkyConsent(opts: { analytics?: boolean; marketing?: boolean } = {}): void {
  const categories = {
    necessary: true,
    functional: true,
    analytics: !!opts.analytics,
    performance: false,
    advertisement: !!opts.marketing,
  };
  (window as unknown as { getCkyConsent: () => unknown }).getCkyConsent = () => ({ categories });
}

export function clearCkyConsent(): void {
  delete (window as unknown as { getCkyConsent?: unknown }).getCkyConsent;
}

/** Beállítja a window.location.search/pathname-et (jsdom history-n keresztül). */
export function setUrl(pathAndQuery: string): void {
  window.history.pushState({}, '', pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery);
}

export function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/`;
}

export function clearCookies(): void {
  for (const c of document.cookie.split(';')) {
    const n = c.split('=')[0].trim();
    if (n) document.cookie = `${n}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

export function getDataLayer(): Record<string, unknown>[] {
  return (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer || [];
}

export function lastEvent(name?: string): Record<string, unknown> | undefined {
  const dl = getDataLayer();
  if (!name) return dl[dl.length - 1];
  for (let i = dl.length - 1; i >= 0; i--) if (dl[i].event === name) return dl[i];
  return undefined;
}

export function resetAll(): void {
  try { localStorage.clear(); } catch { /* */ }
  try { sessionStorage.clear(); } catch { /* */ }
  clearCookies();
  clearCkyConsent();
  (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
  // Enhanced Conversions side-channel (set by setUserDataForEC).
  delete (window as unknown as { __sbUserData?: unknown }).__sbUserData;
  document.getElementById('__sb_user_data__')?.remove();
  // Observability diagnostics ring.
  (window as unknown as { __sbTrackingDiag?: unknown[] }).__sbTrackingDiag = [];
  window.history.pushState({}, '', '/');
}
