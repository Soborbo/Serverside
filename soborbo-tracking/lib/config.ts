/**
 * Per-site market config — makes the same skill work for HU and UK sites
 * (and any other market) by changing a few PUBLIC_ env vars.
 *
 *   PUBLIC_TRACKING_COUNTRY   GB | HU            (default GB)
 *   PUBLIC_TRACKING_CURRENCY  GBP | HUF | EUR…   (default GBP)
 *   PUBLIC_TRACKING_LOCALE    en | hu            (default en)
 *
 * `country` drives phone normalization for ambiguous numbers and PhoneLink
 * formatting; `currency` is the default conversion currency; `locale` is for
 * display strings. The gateway (server) uses the per-site KV `country_code` /
 * `currency` independently — keep them in sync with these.
 */

export type Market = 'GB' | 'HU';

export interface TrackingConfig {
  country: Market;
  currency: string;
  locale: 'en' | 'hu';
}

function readEnv(key: string): string | undefined {
  try {
    return (import.meta.env as Record<string, string | undefined> | undefined)?.[key];
  } catch {
    return undefined;
  }
}

/**
 * A csomag verziója, ahogy MINDEN kimenő payload jelenti (`consent_sources
 * .client_lib_version`). A gateway ebből tudja megmondani, MELYIK kliens-verzió
 * fordítja rosszul a consentet — enélkül a Fázis D diagnosztikája nem tudja
 * szétválasztani a „CookieYes küld rosszat" és a „mi fordítjuk rosszul" eseteket.
 *
 * KÉZZEL tartandó szinkronban a package.json `version` mezőjével (a lib
 * böngészőbe másolódik, nincs bundler-injektálás). A gateway minimuma:
 * Serverside `src/lib/consent.ts` MIN_CLIENT_LIB_VERSION.
 */
export const CLIENT_LIB_VERSION = '6.1.0';

export const trackingConfig: TrackingConfig = {
  country: (readEnv('PUBLIC_TRACKING_COUNTRY') as Market) || 'GB',
  currency: readEnv('PUBLIC_TRACKING_CURRENCY') || 'GBP',
  locale: (readEnv('PUBLIC_TRACKING_LOCALE') as 'en' | 'hu') || 'en',
};
