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
    customer_id: string;
    login_customer_id: string | null;
    conversion_actions?: Record<string, string>;
  };
}

const negativeCache = new Set<string>();
const NEGATIVE_CACHE_MAX_SIZE = 1000;

export async function getSiteConfig(hostname: string, env: Env): Promise<SiteConfig | null> {
  if (negativeCache.has(hostname)) {
    return null;
  }

  try {
    const raw = await env.SITE_CONFIG.get(hostname, 'json');
    if (!raw) {
      if (negativeCache.size >= NEGATIVE_CACHE_MAX_SIZE) {
        negativeCache.clear();
      }
      negativeCache.add(hostname);
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
