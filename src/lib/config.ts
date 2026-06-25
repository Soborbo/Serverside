import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

export interface SiteConfig {
  site_id: string;
  country_code: 'GB' | 'HU' | 'EU' | 'US';
  currency: string;
  meta: {
    pixel_id: string;
    access_token: string;
    test_event_code?: string | null;
  };
  ga4: {
    measurement_id: string;
    api_secret: string;
  };
  gads: {
    customer_id: string | null;
    login_customer_id: string | null;
    conversion_actions?: Record<string, string>;
  };
  // Ha true: explicit kliens-consent hiányában az ad-platform (Meta + Google
  // Ads) konverziók NEM mennek el (GDPR fail-closed). Default (hiányzó/false):
  // backward-compat, ad-platform engedett. EEA-site-okon ajánlott true-ra állítani.
  require_consent?: boolean;
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
