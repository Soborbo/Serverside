/**
 * URL-passthrough — a Consent Mode `url_passthrough` saját párja (OPT-IN,
 * `PUBLIC_TRACKING_URL_PASSTHROUGH=1`, csak `consentProvider='sbo'` alatt).
 *
 * A probléma: döntés előtt a klikk-ID-k/UTM-ek csak memóriában élnek
 * (`captureUrlParams`). Ha a látogató a banner elfogadása ELŐTT egy másik oldalra
 * lép, a kattintás elveszik. Megoldás: amíg NINCS döntés, a belső link-navigáció
 * (és a belső GET-form) URL-jére — csak arra az egy navigációra — átírjuk a
 * jelenlegi URL jeleit, ha a cél még semmilyen jelet nem hoz — a következő
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
import { TOUCH_CLICK_KEYS, UTM_KEYS, urlTrackingParams } from './persistence';

/** Dekorálható jelek — `null`, ha a passthrough nem aktív, van döntés, vagy nincs jel. */
function passthroughParams(): Record<string, string> | null {
  if (!trackingConfig.urlPassthrough || !isSboConsentProvider()) return null;
  if (readSboConsent(trackingConfig.policyVersion)) return null;
  return urlTrackingParams() as Record<string, string> | null;
}

const SIGNAL_KEYS: readonly string[] = [...TOUCH_CLICK_KEYS, ...UTM_KEYS];

/** A cél már hoz-e bármely jelet (klikk-ID vagy UTM) — akkor is, ha a jelenlegi URL-en nincs olyan. */
function hasAny(has: (k: string) => boolean): boolean {
  return SIGNAL_KEYS.some(has);
}

function isInternal(u: URL): boolean {
  // Az `origin` a tel:/mailto:/javascript:-re 'null' — azok így maguktól kiesnek.
  return u.origin === window.location.origin;
}

/**
 * A dekoráció csak az adott kattintásé/beküldésé: a böngésző a navigációt az
 * eseménykezelés UTÁN, ugyanabban a taskban indítja (és a router is szinkron
 * olvassa a href-et), így a következő taskban visszaállítunk. Megszakított
 * kattintás/beküldés után így nem marad dekorált link vagy rejtett mező, ami egy
 * későbbi elutasítás után is elvinné a jeleket (Codex #166).
 */
const later = (fn: () => void): void => { setTimeout(fn, 0); };

const OWNED = 'data-sbo-passthrough';

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
  // Egy érintés, egy csoport: ha a cél bármely jelet hozza, a sajátja marad egésze
  // (kulcsonkénti merge soha nem létezett kampányt gyártana, Codex #166).
  if (hasAny((k) => u.searchParams.has(k))) return;
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  const original = a.getAttribute('href')!;
  a.href = u.href;
  later(() => { if (a.href === u.href) a.setAttribute('href', original); });
}

function onSubmit(e: Event): void {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  // Korábbi (pl. megszakított) beküldés maradéka — döntés előtt mindig takarítunk.
  f.querySelectorAll(`input[${OWNED}]`).forEach((el) => el.remove());
  const p = passthroughParams();
  if (!p) return;
  // A beküldő gomb `formaction`/`formmethod`-ja felülírja a form sajátját.
  const s = (e as SubmitEvent).submitter;
  const method = (s?.getAttribute('formmethod') ?? f.method).toLowerCase();
  const action = s?.getAttribute('formaction') ?? f.action;
  if (method !== 'get') return;
  let u: URL;
  try { u = new URL(action, window.location.href); } catch { return; }
  if (!isInternal(u)) return;
  // GET-formnál az action query-jét a mezők felülírják — a cél jelei a mezők.
  // Egy csoport: ha a form bármely jelet már hoz, nem keverünk bele.
  if (hasAny((k) => !!f.elements.namedItem(k))) return;
  const added: HTMLInputElement[] = [];
  for (const [k, v] of Object.entries(p)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v;
    input.setAttribute(OWNED, '');
    f.appendChild(input);
    added.push(input);
  }
  later(() => added.forEach((el) => el.remove()));
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
