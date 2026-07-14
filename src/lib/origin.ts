import type { SiteConfig } from './config';

/**
 * Origin allow-list a böngésző-ág konverziós ingressére.
 *
 * MIÉRT LETT EZ KRITIKUS. Amíg a Turnstile-kapu állt, az `Origin` fejlécet csak a
 * CORS VÁLASZ-fejléc kiszámítására használtuk (worker.ts) — a kérést sosem
 * utasítottuk el miatta. A Turnstile eltávolításával ez lett a böngésző-ág
 * ELSŐDLEGES kontrollja, tehát mostantól KÉNYSZERÍTJÜK is.
 *
 * MIT VÉD ÉS MIT NEM — fontos, hogy ne áltassuk magunkat:
 *  - VÉDI: egy idegen weboldal nem tud a látogatói böngészőjéből konverziót
 *    lőni a mi endpointunkra (a böngésző kötelezően ráteszi a valódi Origin-t,
 *    és azt nem lehet JS-ből hamisítani). A `sendBeacon` / `fetch(no-cors)` is
 *    ELINDUL CORS nélkül, tehát szerver-oldali ellenőrzés nélkül ez nyitva állna.
 *  - NEM VÉDI: a curl/script forgalmat. Egy nem-böngésző kliens tetszőleges
 *    Origin-t hazudhat. Ezt a rate limit + az idempotencia + az AE-riasztás fogja,
 *    NEM ez a modul. Lásd a PR residual-risk szakaszát.
 *
 * FAIL-CLOSED a hiányzó Origin-re. A Fetch-spec szerint minden nem-GET/HEAD kérés
 * hordoz Origin-t (a sendBeacon POST is), tehát a valódi böngésző-forgalom mindig
 * átmegy. Ha az „Origin hiányzik → engedd" ág megmaradna, a teljes kontroll egy
 * kihagyott fejléccel megkerülhető lenne. (Precedens: a Painless saját
 * `requireAllowedOrigin`-ja ugyanígy fail-closed, és élesben működik.)
 *
 * A SZERVER-SZERVER ingress (per-site token) NEM megy át ezen: ott nincs böngésző,
 * tehát nincs Origin sem — a hitelesítést a token adja. Lásd routes/conversion.ts.
 */

/** `https://example.com` → `example.com`; érvénytelen/`null` → undefined. */
function originHost(origin: string): string | undefined {
  try {
    const u = new URL(origin);
    // Csak https (és a workers.dev-teszthez http localhost nem kell — a gateway
    // production-only). Egy `http://` origin a mi domainjeinken downgrade-jel.
    if (u.protocol !== 'https:') return undefined;
    return u.hostname;
  } catch {
    return undefined;
  }
}

/** `www.example.com` ↔ `example.com` — a másik variáns. */
function sibling(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}

/**
 * A site-hoz engedélyezett Origin-hostok. Alap: a KÉRÉS hostja + az apex/www
 * testvére — a kliens-lib relatív útra POST-ol (`/api/event/conversion`), tehát a
 * valódi Origin MINDIG a site saját originje. A `SiteConfig.allowed_origins`
 * ehhez ad hozzá (nem helyettesíti), ha egy site több hostról is küld.
 */
export function allowedOriginHosts(hostname: string, site: SiteConfig): Set<string> {
  const hosts = new Set<string>([hostname, sibling(hostname)]);
  for (const extra of site.allowed_origins ?? []) {
    const h = originHost(extra) ?? extra.trim().toLowerCase();
    if (h) hosts.add(h);
  }
  return hosts;
}

export type OriginVerdict = 'allowed' | 'missing' | 'forbidden';

export function checkOrigin(
  origin: string | null,
  hostname: string,
  site: SiteConfig
): OriginVerdict {
  // A workers.dev teszt-tenant szándékosan nyitott (curl-tesztek, smoke).
  // Production hostnév SOSEM végződik így, tehát ez nem tágít éles site-ot.
  if (hostname.endsWith('.workers.dev')) return 'allowed';

  if (!origin || origin === 'null') return 'missing';

  const host = originHost(origin);
  if (!host) return 'forbidden';

  return allowedOriginHosts(hostname, site).has(host) ? 'allowed' : 'forbidden';
}
