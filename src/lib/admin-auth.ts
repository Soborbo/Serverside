import type { Env } from '../env';
import type { SiteConfig } from './config';
import { sha256Hex } from './hash';

/**
 * Admin authentication for debug endpoints (/api/event/oauth-debug,
 * /api/event/debug-ga4). The Worker secret ADMIN_API_TOKEN must match the
 * `X-Admin-Token` header. If ADMIN_API_TOKEN is unset (test deploy), the
 * routes are disabled entirely (return 404).
 *
 * Comparison uses constant-time equality to prevent timing attacks.
 */
export function authenticateAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_TOKEN) return false;
  const provided = request.headers.get('X-Admin-Token');
  if (!provided) return false;
  return timingSafeEqual(provided, env.ADMIN_API_TOKEN);
}

/**
 * Per-site CRM offline-loop auth for /lead-status. Tenant-isolating:
 *  - Ha a site-nak van saját `crm_token_sha256`-ja: az `X-Admin-Token`-t hash-eljük
 *    és KIZÁRÓLAG ahhoz a hash-hez hasonlítjuk (constant-time) — a globális token
 *    NEM ad hozzáférést. Egy szivárgott token így csak EZT az egy site-ot érinti.
 *  - Egyébként (még-nem-kiadott site) → visszaesés a globális ADMIN_API_TOKEN-re.
 * Bármely hiányzó token → false. A site-feloldás MINDIG a hívás előtt megtörténik,
 * így nincs cross-tenant: rossz site tokenjével a hash-compare bukik (401).
 */
export async function authenticateLeadStatus(
  request: Request,
  env: Env,
  site: SiteConfig
): Promise<boolean> {
  if (!site.crm_token_sha256) return authenticateAdmin(request, env);
  const provided = request.headers.get('X-Admin-Token');
  if (!provided) return false;
  const providedHash = await sha256Hex(provided);
  return siteTokenMatches(providedHash, site.crm_token_sha256);
}

/**
 * Szerver-szerver ingress auth a /api/event/conversion-höz.
 *
 * Ez a Turnstile ALTERNATÍVÁJA: egy megbízható szerver (a site saját Astro
 * backendje) a lead-endpointjából közvetlenül küldi a konverziót, ahol nincs és
 * nem is lehet Turnstile-token (nincs böngésző a hurokban).
 *
 * Szándékos ELTÉRÉS az authenticateLeadStatus-tól: itt NINCS visszaesés a
 * globális ADMIN_API_TOKEN-re. A /lead-status-nál a fallback operator-default a
 * még-nem-kiadott site-okhoz; itt viszont a fallback azt jelentené, hogy EGY
 * globális token az ÖSSZES site Turnstile-kapuját megnyitja — pontosan az a
 * blast-radius, amit a per-site modell kizár. Ha a site-nak nincs saját
 * `crm_token_sha256`-ja, a szerver-ingress egyszerűen nem létezik rá.
 *
 * Háromállapotú szándékosan: az 'invalid' (jelen lévő, de rossz token) NEM esik
 * vissza a Turnstile-ágra — az elnyelné a misconfigot (rossz secret → csendben
 * 403 „bot" néven). Külön 401-et adunk, hogy a hiba látható legyen.
 */
export type ServerIngressAuth = 'absent' | 'valid' | 'invalid';

export async function authenticateServerIngress(
  request: Request,
  site: SiteConfig
): Promise<ServerIngressAuth> {
  const provided = request.headers.get('X-Admin-Token');
  if (provided === null) return 'absent';
  // Header jelen van, de a site-nak nincs kiadott tokenje → invalid (NEM absent):
  // a hívó szerver-ingresst szándékozott, csak a site nincs provisionálva. Ezt
  // 401-gyel jelezzük, nem némán Turnstile-ra ejtjük.
  if (!site.crm_token_sha256) return 'invalid';
  const providedHash = await sha256Hex(provided);
  return siteTokenMatches(providedHash, site.crm_token_sha256) ? 'valid' : 'invalid';
}

/**
 * Pure constant-time hex-hash összehasonlítás (unit-tesztelt). Mindkét oldal a
 * provided/expected token SHA-256 hex-e — sosem a nyers token.
 */
export function siteTokenMatches(providedHashHex: string, expectedHashHex: string): boolean {
  return timingSafeEqual(providedHashHex, expectedHashHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  // A hossz-különbséget az akkumulátorba hajtjuk (nem korai return-nel), és
  // mindig `a.length` iterációt futunk — így a „rossz hossz" és a „jó hossz,
  // rossz bájt" eset nem különböztethető meg időzítésből.
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i < b.length ? i : 0);
  }
  return mismatch === 0;
}
