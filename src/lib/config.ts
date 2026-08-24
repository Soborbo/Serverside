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
  // OPCIONÁLIS — mint a `meta` és a `ga4`. A KV JSON vakon SiteConfig-ra castolódik
  // (lookupSiteConfig), tehát a típus nem garancia: egy kézzel írt vagy migrációs
  // config `gads` blokk NÉLKÜL is beérkezhet. Amíg ez kötelezőnek volt deklarálva,
  // a típus HAZUDOTT, és a hívók egy része (lead-status pénz-útja, datamanager,
  // cross-check) guard nélkül olvasta — egy ilyen config ott TypeError → 500-at
  // adott volna a CRM-nek, determinisztikusan, amíg a config olyan marad. Az
  // admin health-check már optional chaininggel védte magát (ott ki is derült a
  // probléma); most a TÍPUS kényszeríti ki ugyanezt minden hívási ponton.
  gads?: {
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

  // Fázis D (2026-08) — fail-closed BIZONYTALAN consent esetén. Default: FALSE.
  //
  // `false` (default): a TRK-910-002/003/005 kódok naplózódnak és a receiptre
  //   kerülnek, a kézbesítés a MAI szabályok szerint megy tovább. NULLA
  //   viselkedésváltozás — ezt teszt bizonyítja (tests/consent-strict-parity).
  // `true`: bizonytalan consent (parse-olhatatlan / a források ellentmondanak /
  //   a jelek belül inkonzisztensek) → az ad-platformok kimaradnak,
  //   `consent_uncertain_failclosed` okkal. Bizonytalanból soha nem lesz GRANTED.
  //
  // MIÉRT NEM ALAPÉRTELMEZETTEN TRUE: ha a mismatch gyakori (a betöltési verseny
  // hipotézis szerint lehet az), az azonnali fail-closed egy éjszaka alatt levinné
  // a konverziós volument — pontosan az a csendes hibaosztály, ami ellen az egész
  // terv szól. A kapcsoló site-onként állítandó true-ra a volumen megfigyelése
  // után, NAPOKON belül: tartósan false-ként hagyva új legacy fail-open ág lesz belőle.
  consent_strict?: boolean;

  // Soborbo CMP (Fázis 1, 2026-08) — MELYIK consent-rendszer fut ezen a site-on.
  //
  // A mező HIÁNYA és a `'cookieyes'` UGYANAZT jelenti, és minden site ebben az
  // állapotban van: a Fázis 1 merge önmagában NULLA viselkedésváltozás. A pilot
  // átállítása EGYETLEN KV-flag, amit EMBER csinál — nem a kód, nem egy migráció.
  //
  //   'cookieyes' (default) → a mai szabályok, bitre. A GA4 a mai módon megy, a
  //                           /api/consent végpont 403-at ad (a site nem a saját
  //                           CMP-nkkel fut, tehát tőle nem fogadunk el döntést).
  //   'sbo'                 → a saját CMP. A `consent_log` írása engedélyezett, és
  //                           a GA4 `analytics_storage='GRANTED'`-hez kötött (a
  //                           jogi audit 2. prioritása: a DUAA statisztikai
  //                           kivétel a GA4-et NEM menti meg, mert a Google saját
  //                           célra újrahasznosítja az adatot).
  //
  // MIÉRT FLAG MÖGÖTT A GA4-KAPU: ez viselkedésváltozás. Flag nélkül a merge az
  // egész flottán elvágná a GA4-et, egyetlen mérés nélkül — pontosan az a néma,
  // egy éjszaka alatti volumenesés, ami ellen az egész terv szól.
  consent?: {
    provider?: 'cookieyes' | 'sbo';
    /**
     * basic | advanced (v4 terv, 8. függelék). A default `basic`: az advanced
     * pre-consent cookieless pingjei EEA-ban vitatottak, és a portfólió fele HU.
     * A `consent_log.consent_mode` ezt rögzíti minden döntésnél.
     */
    mode?: 'basic' | 'advanced';
  };

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

  // A site-tól ELVÁRT platform-lábak — a füstteszt sikerkritériuma (daily-digest).
  // Létezésének oka: a smoke korábban CSAK a `rejected` Meta-lábra riasztott, a
  // `skipped`-et OK-nak vette („szándékosan meta-nélküli site"). Emiatt amikor a
  // lomtalan `meta` blokkja 2026-07-15-én KIESETT a KV-ből, a fan-out némán
  // skip-re váltott, a napi füstteszt pedig ÖT NAPON ÁT zöld maradt. Egy hiányzó
  // config és egy szándékos kihagyás a delivery-sorból nézve azonos — ezért az
  // elvárást KÜLÖN, explicit módon kell rögzíteni, nem a config meglétéből
  // levezetni (a levezetés pont a törlést nem venné észre).
  //
  //   smoke:   a napi synthetic lead körében accepted-nek KELL lennie.
  //   offline: a CRM lifecycle-ág (lead-status → Google Ads) elvárt platformjai.
  //            SZÁNDÉKOSAN nem a böngésző-smoke ellenőrzi — annak külön
  //            hitelesített offline synthetic teszt / OAuth health check kell.
  //
  // Hiányzó blokk → a digest a MEGFIGYELT előzményre esik vissza (ami korábban
  // accepted volt, annak accepted-nek kell maradnia), tehát a regresszió akkor
  // is kiderül, ha ide még nem került be semmi.
  expected_platforms?: {
    smoke?: string[];
    offline?: string[];
  };

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
/**
 * A monitorozott site-configok + AZ, HOGY A LISTA TELJES-E.
 *
 * MIÉRT KELL A `complete` (2026-08-24 review, HIGH): a KV-listázás lapozás közben
 * elbukhat, és ilyenkor az addig összegyűjtött RÉSZLISTA jön vissza. Aki ezt teljesnek
 * hiszi és EXCLUSION FILTERKÉNT használja, az a hiányzó site-okat NÉMÁN kizárja a
 * mérésből: 15 site-ból 8 után elbukó listázás mellett a maradék 7 offline sorai
 * kiszűrődnek, finding nem keletkezik, és a monitor tisztának látszik. Ez pontosan az
 * a hibaosztály, ami ellen az egész riasztási lánc épült.
 *
 * A `complete: false` NEM azt jelenti, hogy a lista használhatatlan — azt, hogy
 * NEGATÍV következtetést (,,ez a site nincs a listán, tehát hagyjuk ki") nem szabad
 * belőle levonni.
 */
export interface MonitoredSiteConfigs {
  configs: SiteConfig[];
  complete: boolean;
}

export async function listMonitoredSiteConfigsWithCompleteness(
  env: Env
): Promise<MonitoredSiteConfigs> {
  const bySiteId = new Map<string, SiteConfig>();
  let complete = true;
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
    // A részlista NEM dobódik el (a digest-oldali pozitív használat továbbra is
    // értelmes rajta) — de a hiányosságot MEGJELÖLJÜK.
    complete = false;
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.KV_READ_FAILED],
      partial_site_configs: bySiteId.size,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return { configs: [...bySiteId.values()], complete };
}

/**
 * Back-compat burkoló azoknak a hívóknak, akik a listát csak POZITÍV irányban
 * használják (végigiterálnak rajta). Aki NEGATÍV következtetést von le belőle
 * (kizárás/szűrés), az KÖTELEZŐEN a `…WithCompleteness` változatot használja.
 */
export async function listMonitoredSiteConfigs(env: Env): Promise<SiteConfig[]> {
  return (await listMonitoredSiteConfigsWithCompleteness(env)).configs;
}

/**
 * A konfigurált site_id-k halmaza (www/apex dedup a config JSON `site_id`-ján).
 * A daily-digest zero-accepted ellenőrzése használja.
 */
export async function listConfiguredSiteIds(env: Env): Promise<Set<string>> {
  const configs = await listMonitoredSiteConfigs(env);
  return new Set(configs.map((c) => c.site_id));
}

/**
 * Site-feloldás eredménye, ami SZÉTVÁLASZTJA a két, gyökeresen eltérő okot:
 *
 * - `config: null, unavailable: false` → tényleg nincs ilyen host (permanens → 404).
 * - `config: null, unavailable: true`  → a KV-olvasás HIBÁZOTT (tranziens → 503).
 *
 * MIÉRT KELL: korábban mindkettő ugyanazt a `null`-t adta, így egy másodperces
 * KV-blip ugyanúgy 404-et eredményezett, mint egy nem létező site. A CRM outbox a
 * 404-et VÉGLEGESNEK osztályozza (failed_permanent) — vagyis a kiesés ablakában
 * érkező valódi konverziók visszavonhatatlanul elvesztek volna, retry nélkül.
 */
export interface SiteConfigLookup {
  config: SiteConfig | null;
  unavailable: boolean;
}

export async function lookupSiteConfig(hostname: string, env: Env): Promise<SiteConfigLookup> {
  if (negativeCacheHit(hostname)) {
    return { config: null, unavailable: false };
  }

  try {
    const raw = await env.SITE_CONFIG.get(hostname, {
      type: 'json',
      cacheTtl: CONFIG_CACHE_TTL_SECONDS
    });
    if (!raw) {
      negativeCachePut(hostname);
      return { config: null, unavailable: false };
    }
    return { config: raw as SiteConfig, unavailable: false };
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.KV_READ_FAILED],
      hostname,
      error: err instanceof Error ? err.message : String(err)
    });
    // A KV-hibát SOHA nem tesszük a negatív cache-be: különben egy múló blip
    // percekre „nincs ilyen site"-tá merevedne az összes további kérésre is.
    return { config: null, unavailable: true };
  }
}

/**
 * Kompatibilis alak azoknak a hívóknak, ahol a tranziens és a permanens hiány
 * kimenete úgyis azonos (admin-felület, cron-segédek). A PÉNZ-UTAKON
 * (`/conversion`, `/conversion-server`, `/lead-status`) használd helyette a
 * `lookupSiteConfig`-ot, hogy a KV-hiba retry-olható 503-at kapjon.
 */
export async function getSiteConfig(hostname: string, env: Env): Promise<SiteConfig | null> {
  return (await lookupSiteConfig(hostname, env)).config;
}

/**
 * Elvárt-e ez a platform a site-on (a böngésző-ingress fan-outja szempontjából)?
 *
 * Forrás: `expected_platforms.smoke` — ugyanaz a lista, amit a napi digest
 * smoke-őre használ. SZÁNDÉKOSAN nem az `offline` lista: az a CRM lifecycle-ág
 * (lead-status → Google Ads) elvárásait rögzíti, ami nem ezen az úton fut.
 *
 * FONTOS, hogy ez NE a config meglétéből legyen levezetve: pont a config
 * eltűnését (lomtalan Meta, 2026-07-15) kell észrevennie. Egy „van config →
 * elvárt" szabály a törlés pillanatában maga is eltűnne.
 *
 * Hiányzó `expected_platforms` blokk → `false`, azaz a config-hiányos skip
 * terminális marad. Ez tudatos fail-safe: az elvárást explicit módon kell
 * felvenni (B-2), különben minden be nem kötött platform DLQ-rekordot gyártana
 * minden eventre, minden site-on.
 */
export function isExpectedPlatform(siteConfig: SiteConfig, platform: string): boolean {
  return siteConfig.expected_platforms?.smoke?.includes(platform) === true;
}

/**
 * Elvárt-e ez a platform a site OFFLINE lifecycle-lábán (lead-status → Google Ads
 * Enhanced Conversions)? Forrás: `expected_platforms.offline` — a browser-fan-out
 * `smoke` listájától KÜLÖN, mert a két út más platform-halmazt vár.
 *
 * Ez zárja be a lomtalan-osztályú néma kiesést a PÉNZ-lábon: ha egy site offline
 * gads-t vár, de a `gads.customer_id` eltűnt a configból, a lead-status enélkül
 * csendben `uploaded_to_gads:false`-t írna (se DLQ, se riasztás). A helper explicit
 * elvárás nélkül `false`-t ad (fail-safe: nem gyárt riasztást be nem kötött lábra).
 */
export function isExpectedOfflinePlatform(siteConfig: SiteConfig, platform: string): boolean {
  return siteConfig.expected_platforms?.offline?.includes(platform) === true;
}
