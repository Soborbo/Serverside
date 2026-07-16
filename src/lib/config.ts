import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

export interface SiteConfig {
  site_id: string;
  // A hash.ts CountryCode-jával egyező unió — a generate-site.mjs DE/FR/IT/ES-t
  // is kibocsát, a szűkebb típus hazudott volna (a runtime cast eddig elfedte).
  country_code: 'GB' | 'HU' | 'EU' | 'US' | 'DE' | 'FR' | 'IT' | 'ES';
  currency: string;
  // Optional, exactly like `ga4` below: a site can be onboarded BEFORE its Meta CAPI
  // access token exists (the token is minted by hand in Events Manager, so it always
  // lags the wiring). Absent → the Meta CAPI leg is skipped cleanly.
  //
  // The alternative — a placeholder token — is actively harmful: every conversion
  // would 401 at Meta, fill the DLQ and fire alerts, i.e. a site that looks broken
  // rather than one that is simply not finished. With the block absent, the ledger
  // still measures that the pipe works end-to-end, and the Meta leg lights up the
  // moment the token is added to KV (no redeploy).
  meta?: {
    pixel_id: string;
    access_token: string;
    test_event_code?: string | null;
  };
  // Optional: a migration site may omit `ga4` so the gateway does NOT send GA4 MP
  // (its browser GA4 already fires via GTM; sending here too would double-count —
  // GA4 does not dedup on event_id). Absent → the GA4 MP leg is skipped. See ga4.ts.
  ga4?: {
    measurement_id: string;
    api_secret: string;
  };
  gads: {
    customer_id: string | null;
    login_customer_id: string | null;
    conversion_actions?: Record<string, string>;
  };
  // Opcionális extra platformok (TASK 3 — click-ID forwarderek). Mind nullable;
  // hiányzó/null blokk → az adott forwarder no-op (skip), nem hiba.
  // A blokk-kulcs a kliens SERVERSIDE-FOLLOWUP.md §2 szerződését követi:
  // microsoft_ads / tiktok / linkedin.
  microsoft_ads?: MsAdsConfig | null;
  tiktok?: TikTokConfig | null;
  linkedin?: LinkedInConfig | null;
  // Ha true: explicit kliens-consent hiányában az ad-platform (Meta + Google
  // Ads) konverziók NEM mennek el (GDPR fail-closed). Default (hiányzó/false):
  // backward-compat, ad-platform engedett. EEA-site-okon ajánlott true-ra állítani.
  require_consent?: boolean;

  // Extra engedélyezett böngésző-originek (`https://foo.example.com` vagy puszta
  // hostnév). A site SAJÁT hostja + az apex/www testvére MINDIG engedett — ez a
  // mező csak hozzáad. Csak akkor kell, ha a site egy MÁSIK hostról is küld
  // konverziót (pl. külön landing-domain). Lásd lib/origin.ts.
  allowed_origins?: string[];

  // Per-site CRM offline-loop token — a SAJÁT CRM-deployjának kiadott plaintext
  // token SHA-256 hex-e. Ha jelen van, a /lead-status az `X-Admin-Token`-t KIZÁRÓLAG
  // EHHEZ a hash-hez hasonlítja (constant-time) — a globális ADMIN_API_TOKEN NEM ad
  // hozzáférést ehhez a site-hoz. Ez a tenant-határ: egy szivárgott token blast-
  // radiusa 1 site, nem az egész flotta. Hash-elve tárolva → egy KV-olvasás SEM ad
  // használható tokent. Ha HIÁNYZIK: a route visszaesik a globális ADMIN_API_TOKEN-re
  // (operator-default a még-nem-kiadott site-okhoz). Lásd routes/lead-status.ts +
  // az onboarding generate-site.mjs token-generálását.
  crm_token_sha256?: string;

  // Napi cross-platform reconciliation (lib/cross-check.ts): a ledger event-
  // count-jait veti össze a GA4 Data API és a Google Ads API aznapi számaival.
  // Hiányzó blokk → a site kimarad a cross-checkből (a ledger-belső recon fut
  // tovább). Mindkét leg a `gads.customer_id`-hez tárolt OAuth-tokent használja.
  recon?: {
    // GA4 Data API NUMERIKUS property ID (pl. "453881143") — NEM a G-XXX
    // measurement id. Az analytics.readonly scope-ot a 2026-07-16 utáni
    // re-consent adja (oauth-init.ts); régi tokennel a leg logolt-skip.
    ga4_property_id?: string;
    // internal event_name → az ON-SITE (böngésző/GTM-gtag) Google Ads conversion
    // action NEVE, ahogy a fiókban látszik (pl. "Callback requested"). NEM
    // azonos a gads.conversion_actions-szel — az az OFFLINE (lead-status → Data
    // Manager) célok ID-térképe, ez a böngésző-ág auditjáé.
    gads_onsite_actions?: Record<string, string>;
  };

  // `false` → a site KIMARAD a napi digest / zero-conversion riasztásból (a fan-out
  // és a ledger változatlanul működik). Nem-produkciós configokhoz: deploy-smoke
  // dummy, félkész placeholder-pixeles site. Ezek sosem konvertálnak, tehát MINDEN
  // nap „0 konverzió" CRITICAL riasztást adnának — a riasztás-fáradtság pedig pont
  // azt a néma hibát fedné el, amiért a lánc létezik. Hiányzó/true → figyelve.
  monitoring?: boolean;
}

/**
 * Microsoft Advertising offline conversions (msclkid). Az auth (OAuth refresh +
 * developer token) a Google Ads-hez hasonló; a live transport TODO (lásd lib/msads.ts).
 */
export interface MsAdsConfig {
  customer_id?: string | null;
  // internal event_name → Microsoft conversion goal NAME
  conversion_names?: Record<string, string>;
}

/** TikTok Events API 2.0 (ttclid). */
export interface TikTokConfig {
  pixel_code: string; // event_source_id
  access_token: string;
  // internal event_name → TikTok standard event (default map a lib-ben)
  event_names?: Record<string, string>;
}

/** LinkedIn Conversions API (li_fat_id + hashed email). */
export interface LinkedInConfig {
  access_token: string;
  // internal event_name → LinkedIn conversion rule URN
  conversion_rules: Record<string, string>;
  api_version?: string; // pl. "202401"
}

// KV edge-cache TTL másodpercben. A config a forró úton minden requesten olvas;
// a cacheTtl csökkenti a KV-olvasásokat és a latenciát. Trade-off: új/módosított
// config legfeljebb ennyi ideig propagál (a negatív cache 60s-en marad).
const CONFIG_CACHE_TTL_SECONDS = 300;

// LRU negative cache with TTL. Bounded size prevents memory growth from
// scanner traffic; TTL ensures newly-added sites are picked up within ~60s.
const NEGATIVE_CACHE_MAX_SIZE = 256;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const negativeCache = new Map<string, number>();

function negativeCacheHit(hostname: string): boolean {
  const expiresAt = negativeCache.get(hostname);
  if (expiresAt === undefined) return false;
  if (expiresAt < Date.now()) {
    negativeCache.delete(hostname);
    return false;
  }
  // Refresh LRU position
  negativeCache.delete(hostname);
  negativeCache.set(hostname, expiresAt);
  return true;
}

function negativeCachePut(hostname: string): void {
  if (negativeCache.size >= NEGATIVE_CACHE_MAX_SIZE) {
    const oldest = negativeCache.keys().next().value;
    if (oldest !== undefined) negativeCache.delete(oldest);
  }
  negativeCache.set(hostname, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

/**
 * A konfigurált site-ok (KV-kulcsok) számának teljes, lapozott megszámolása.
 * A sima `.list({ limit: 100 })` csendben csonkol 100 tenant fölött; ez cursor-loop
 * a `list_complete`-ig. Hibatűrő: hiba esetén az addig számolt értéket adja vissza.
 */
export async function countSiteConfigs(env: Env): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = await env.SITE_CONFIG.list({ limit: 1000, cursor });
      count += page.keys.length;
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.KV_READ_FAILED],
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return count;
}

/**
 * A monitorozott site-configok listája, site_id-n dedupolva (a www/apex kulcsok
 * ugyanarra a configra mutatnak — az első találat nyer). A daily-digest és a
 * cross-platform reconciliation használja. Hibatűrő: KV-hiba esetén az addig
 * összegyűjtött listát adja vissza (a riasztás inkább maradjon el, mint hogy
 * fals pozitívot adjon részleges lista miatt).
 */
export async function listMonitoredSiteConfigs(env: Env): Promise<SiteConfig[]> {
  const bySiteId = new Map<string, SiteConfig>();
  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await env.SITE_CONFIG.list({ limit: 1000, cursor });
      for (const k of page.keys) {
        const cfg = await env.SITE_CONFIG.get<SiteConfig>(k.name, { type: 'json' });
        // `monitoring: false` → kimarad a napi digest / zero-conversion riasztásból.
        // Ez NEM kozmetika: egy soha-nem-konvertáló config (placeholder pixel, deploy-
        // smoke dummy) MINDEN nap „0 konverzió" CRITICAL riasztást szülne, és két hét
        // alatt megtanulnánk figyelmen kívül hagyni a digestet — vagyis pont az a néma
        // hiba maradna észrevétlen, amiért az egész riasztási lánc létezik.
        if (cfg?.monitoring === false) continue;
        if (cfg?.site_id && !bySiteId.has(cfg.site_id)) bySiteId.set(cfg.site_id, cfg);
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.KV_READ_FAILED],
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return [...bySiteId.values()];
}

/**
 * A konfigurált site_id-k halmaza (www/apex dedup a config JSON `site_id`-ján).
 * A daily-digest zero-accepted ellenőrzése használja.
 */
export async function listConfiguredSiteIds(env: Env): Promise<Set<string>> {
  const configs = await listMonitoredSiteConfigs(env);
  return new Set(configs.map((c) => c.site_id));
}

export async function getSiteConfig(hostname: string, env: Env): Promise<SiteConfig | null> {
  if (negativeCacheHit(hostname)) {
    return null;
  }

  try {
    const raw = await env.SITE_CONFIG.get(hostname, {
      type: 'json',
      cacheTtl: CONFIG_CACHE_TTL_SECONDS
    });
    if (!raw) {
      negativeCachePut(hostname);
      return null;
    }
    return raw as SiteConfig;
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.KV_READ_FAILED],
      hostname,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
