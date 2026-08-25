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

/**
 * CMP Fázis 2: melyik CMP fut a site-on. A default MINDEN oldalon 'cookieyes' —
 * a `PUBLIC_TRACKING_CONSENT_PROVIDER=sbo` átállítása EMBERI, pilotonkénti
 * döntés (brief tiltólista #1). Bármely nem-'sbo' érték 'cookieyes'-ként
 * értelmeződik: egy elgépelt env-érték ne kapcsolhassa ki a futó CMP-t.
 */
export type ConsentProvider = 'cookieyes' | 'sbo';

export interface TrackingConfig {
  country: Market;
  currency: string;
  locale: 'en' | 'hu';
  consentProvider: ConsentProvider;
  /**
   * A site adatkezelési tájékoztatójának verziója (consent_log.policy_version).
   * A site állítja be (PUBLIC_TRACKING_POLICY_VERSION); a default szándékosan
   * kimondja, hogy NINCS beállítva — a pilot élesítési checklist része.
   */
  policyVersion: string;
  /** A consent-szabályrendszer címkéje (consent_log.ruleset). */
  ruleset: string;
  /**
   * INV-008 — szabad-e ISMERETLEN consent mellett engedni FEJLESZTŐI módban.
   *
   * Alapból NEM. A korábbi viselkedés az volt, hogy döntés hiányában a kapuk
   * `import.meta.env.DEV`-et adtak vissza, vagyis dev-buildben MINDENT
   * engedtek. Prodban ez deny volt, tehát nem szivárgott — de az implicit
   * „ismeretlen → engedd" szemantika pont az a hibaosztály, amit az egész
   * Fázis D vizsgált, és egy elrontott build-flag mellett csendben éles is
   * lehetne. Mostantól a dev-kényelem EXPLICIT opt-in:
   * `PUBLIC_TRACKING_DEV_CONSENT_ALLOW=1`, és minden bekapcsolása diagnosztikát
   * ír (TRK-4003) — nincs néma engedés.
   */
  devConsentAllow: boolean;
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
export const CLIENT_LIB_VERSION = '6.3.1';

export const trackingConfig: TrackingConfig = {
  country: (readEnv('PUBLIC_TRACKING_COUNTRY') as Market) || 'GB',
  currency: readEnv('PUBLIC_TRACKING_CURRENCY') || 'GBP',
  locale: (readEnv('PUBLIC_TRACKING_LOCALE') as 'en' | 'hu') || 'en',
  consentProvider: readEnv('PUBLIC_TRACKING_CONSENT_PROVIDER') === 'sbo' ? 'sbo' : 'cookieyes',
  policyVersion: readEnv('PUBLIC_TRACKING_POLICY_VERSION') || 'policy-unset',
  ruleset: readEnv('PUBLIC_TRACKING_RULESET') || 'eea_uk',
  devConsentAllow: readEnv('PUBLIC_TRACKING_DEV_CONSENT_ALLOW') === '1',
};

/** EGY helyen definiált provider-kérdés — ne szóródjon `=== 'sbo'` összehasonlítás. */
export function isSboConsentProvider(): boolean {
  return trackingConfig.consentProvider === 'sbo';
}
