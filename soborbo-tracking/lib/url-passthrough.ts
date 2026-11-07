/**
 * URL-passthrough — a Consent Mode `url_passthrough` saját párja (OPT-IN,
 * `PUBLIC_TRACKING_URL_PASSTHROUGH=1`, csak `consentProvider='sbo'` alatt).
 *
 * A probléma: döntés előtt a klikk-ID-k/UTM-ek csak memóriában élnek
 * (`captureUrlParams`). Ha a látogató a banner elfogadása ELŐTT egy másik oldalra
 * lép, a kattintás elveszik. Megoldás: amíg NINCS döntés, a belső link-navigáció
 * (és a belső GET-form) URL-jére átírjuk a jelenlegi URL jeleit — a következő
 * oldal `captureUrlParams`-a onnan olvassa, elfogadáskor a megszokott
 * `persistTrackingParams` perzisztál.
 *
 * Tárolót NEM ír és NEM olvas (csak a CMP saját `sbo_consent` sütijét, ahogy
 * minden kapu). Külső linkre soha. Döntés után (elfogadás, elutasítás,
 * visszavonás) nem dekorál: a kapu kattintáskor dönt, nem induláskor.
 *
 * A CookieYes-ág SZÁNDÉKOSAN kimarad: ott a „még nem döntött" és az „elutasított"
 * a kit mai olvasatában nem különíthető el (`getCkyConsent` hiánya ≠ döntés hiánya).
 */
import { isSboConsentProvider, trackingConfig } from './config';
import { readSboConsent } from './consent-sbo-state';
import { urlTrackingParams } from './persistence';

/** Dekorálható jelek — `null`, ha a passthrough nem aktív, van döntés, vagy nincs jel. */
function passthroughParams(): Record<string, string> | null {
  if (!trackingConfig.urlPassthrough || !isSboConsentProvider()) return null;
  if (readSboConsent(trackingConfig.policyVersion)) return null;
  return urlTrackingParams() as Record<string, string> | null;
}

/** A hiányzó jelek ráírása; igaz, ha változott. A meglévő kulcsot nem írja felül. */
function addMissing(u: URL, p: Record<string, string>): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(p)) {
    if (!u.searchParams.has(k)) { u.searchParams.set(k, v); changed = true; }
  }
  return changed;
}

function isInternal(u: URL): boolean {
  // Az `origin` a tel:/mailto:/javascript:-re 'null' — azok így maguktól kiesnek.
  return u.origin === window.location.origin;
}

function onClick(e: Event): void {
  const p = passthroughParams();
  if (!p) return;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || a.hasAttribute('download')) return;
  let u: URL;
  try { u = new URL(a.href); } catch { return; }
  if (!isInternal(u)) return;
  // Oldalon belüli horgony: query-íráskor teljes újratöltés lenne belőle.
  if (u.pathname === window.location.pathname && u.hash) return;
  if (addMissing(u, p)) a.href = u.href;
}

function onSubmit(e: Event): void {
  const p = passthroughParams();
  const f = e.target;
  if (!p || !(f instanceof HTMLFormElement) || f.method !== 'get') return;
  let u: URL;
  try { u = new URL(f.action, window.location.href); } catch { return; }
  if (!isInternal(u)) return;
  // GET-formnál az action query-jét a mezők felülírják — rejtett mező kell.
  for (const [k, v] of Object.entries(p)) {
    if (f.elements.namedItem(k)) continue;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v;
    f.appendChild(input);
  }
}

let installed = false;

/**
 * Egyszer köti a dokumentum-szintű figyelőket (capture-fázis, hogy a site- és az
 * Astro-router-kezelők ELŐTT fusson). Kikapcsolt opciónál no-op.
 */
export function installUrlPassthrough(): void {
  if (installed || !trackingConfig.urlPassthrough || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
  document.addEventListener('submit', onSubmit, true);
}
