/**
 * F8 · P12 — a fleet health view ADATGYŰJTŐ rétege.
 *
 * A döntési logika a `fleet-health.ts`-ben van (pure); ez a modul CSAK beszerzi
 * a bemenetet KV-ből és D1-ből.
 *
 * ── Két szabály, amitől ez a réteg nem hazudhat ──────────────────────────────
 *
 * 1. **MINDEN lekérdezés SAJÁT try/catch-csel fut, és hibánál `null`-t ad.** Nem
 *    közös try-blokk: egy elbukó consent-lekérdezés nem teheti UNKNOWN-ná a Meta
 *    lábat is (az „egy hiba mindent elsötétít" ugyanolyan rossz, mint az „egy
 *    hiba semmit nem sötétít el"). A `null` a pure magban UNKNOWN-ként landol.
 *
 * 2. **A `monitoring:false` site-ok SEM tűnhetnek el.** A digest jogosan hagyja ki
 *    őket a riasztásból, de egy FLOTTA-NÉZETBŐL kihagyni őket néma kizárás lenne:
 *    a nézet pont arra való, hogy lássuk, MI VAN a fiókban. Ezért itt saját
 *    felsorolás fut (nem a `listMonitoredSiteConfigs*`), a sor `monitoring:false`
 *    jelöléssel jelenik meg, és a flotta-rollupból marad ki.
 *
 * A `smoke-%` event_id-k MINDENHOL ki vannak zárva a valós forgalmi számokból: a
 * napi synthetic lead különben minden site-nak adna „legalább 1 konverziót", és a
 * nulla-forgalom detektor SOHA nem szólalna meg (ugyanaz a csapda, amit a
 * daily-digest `collectAcceptedCounts` doksija ír le).
 */

import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { paginateSiteConfigKeys, type SiteConfig } from './config';
import {
  fetchReconInputs,
  collectOfflineReports,
  type OfflineLegReport
} from './reconciliation';
import { collectSmokeStatus } from '../scheduled/daily-digest';
import {
  buildFleetReport,
  type FleetHealthReport,
  type FleetSiteInput,
  type PlatformDeliveryCounts
} from './fleet-health';

const DAY_MS = 86_400_000;

/**
 * Egy D1-lekérdezés hibatűrő futtatása. Hibánál `null` — ez a pure magban
 * UNKNOWN, SOHA nem nulla. A hívó dimenziója így méretlennek látszik, nem
 * egészségesnek.
 */
async function safeQuery<T>(
  env: Env,
  label: string,
  run: () => Promise<T>
): Promise<T | null> {
  if (!env.LEDGER) return null;
  try {
    return await run();
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.FLEET_HEALTH_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.FLEET_HEALTH_QUERY_FAILED],
      query: label,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** MINDEN site-config a KV-ből, site_id-n dedupolva, a teljességi jelzéssel. */
async function listAllSiteConfigs(
  env: Env
): Promise<{ configs: SiteConfig[]; complete: boolean }> {
  const bySiteId = new Map<string, SiteConfig>();
  let complete = true;
  if (!env.SITE_CONFIG) return { configs: [], complete: false };
  try {
    const enumerated = await paginateSiteConfigKeys(env, async (keys) => {
      for (const k of keys) {
        const cfg = await env.SITE_CONFIG.get<SiteConfig>(k.name, { type: 'json' });
        if (cfg?.site_id && !bySiteId.has(cfg.site_id)) {
          bySiteId.set(cfg.site_id, { ...cfg, hostname: k.name } as SiteConfig & { hostname: string });
        }
      }
    });
    if (!enumerated) complete = false;
  } catch (err) {
    complete = false;
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.KV_READ_FAILED],
      context: 'fleet-health site enumeration',
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return { configs: [...bySiteId.values()], complete };
}

type CountMap = Map<string, number>;

async function eventCounts(env: Env, sinceIso: string, label: string): Promise<CountMap | null> {
  return safeQuery(env, label, async () => {
    const rows = await env.LEDGER!.prepare(
      "SELECT site_id, COUNT(*) AS cnt FROM events_raw WHERE received_at >= ?1 AND event_id NOT LIKE 'smoke-%' GROUP BY site_id"
    )
      .bind(sinceIso)
      .all<{ site_id: string; cnt: number }>();
    const m: CountMap = new Map();
    for (const r of rows.results ?? []) m.set(r.site_id, r.cnt);
    return m;
  });
}

async function platformDeliveries(
  env: Env,
  sinceIso: string
): Promise<Map<string, Record<string, PlatformDeliveryCounts>> | null> {
  return safeQuery(env, 'platform_deliveries_24h', async () => {
    const rows = await env.LEDGER!.prepare(
      `SELECT site_id, platform,
              COALESCE(SUM(status = 'accepted'), 0) AS accepted,
              COALESCE(SUM(status = 'rejected'), 0) AS rejected,
              COALESCE(SUM(status = 'skipped'), 0) AS skipped
         FROM deliveries
        WHERE created_at >= ?1 AND origin IN ('fanout', 'retry') AND event_id NOT LIKE 'smoke-%'
        GROUP BY site_id, platform`
    )
      .bind(sinceIso)
      .all<{ site_id: string; platform: string; accepted: number; rejected: number; skipped: number }>();
    const m = new Map<string, Record<string, PlatformDeliveryCounts>>();
    for (const r of rows.results ?? []) {
      const site = m.get(r.site_id) ?? {};
      site[r.platform] = { accepted: r.accepted, rejected: r.rejected, skipped: r.skipped };
      m.set(r.site_id, site);
    }
    return m;
  });
}

/**
 * A legutóbbi BIZONYÍTOTT kézbesítés: `accepted` ÉS van vendor HTTP-státusz.
 * A `http_status IS NOT NULL` nem kozmetika — a 2026-07-14-i lomtalan-eset épp
 * az volt, hogy egy config-nélküli skip `accepted|http_status=NULL` sort írt, és
 * a monitor zöldet mutatott nulla adat fölött (TRK-950-004).
 */
async function lastProvenDelivery(env: Env): Promise<Map<string, string> | null> {
  return safeQuery(env, 'last_proven_delivery', async () => {
    const rows = await env.LEDGER!.prepare(
      `SELECT site_id, MAX(created_at) AS last_at
         FROM deliveries
        WHERE status = 'accepted' AND http_status IS NOT NULL AND event_id NOT LIKE 'smoke-%'
        GROUP BY site_id`
    ).all<{ site_id: string; last_at: string }>();
    const m = new Map<string, string>();
    for (const r of rows.results ?? []) m.set(r.site_id, r.last_at);
    return m;
  });
}

async function consentDecisions(env: Env, sinceIso: string): Promise<CountMap | null> {
  return safeQuery(env, 'consent_decisions_7d', async () => {
    const rows = await env.LEDGER!.prepare(
      'SELECT site_id, COUNT(*) AS cnt FROM consent_log WHERE server_received_at >= ?1 GROUP BY site_id'
    )
      .bind(sinceIso)
      .all<{ site_id: string; cnt: number }>();
    const m: CountMap = new Map();
    for (const r of rows.results ?? []) m.set(r.site_id, r.cnt);
    return m;
  });
}

async function clientLibVersions(
  env: Env,
  sinceIso: string
): Promise<Map<string, string[]> | null> {
  return safeQuery(env, 'client_lib_versions_7d', async () => {
    const rows = await env.LEDGER!.prepare(
      `SELECT site_id, COALESCE(client_lib_version, '(none)') AS version, COUNT(*) AS cnt
         FROM consent_receipts
        WHERE created_at >= ?1
        GROUP BY site_id, version`
    )
      .bind(sinceIso)
      .all<{ site_id: string; version: string; cnt: number }>();
    const m = new Map<string, string[]>();
    for (const r of rows.results ?? []) {
      const list = m.get(r.site_id) ?? [];
      list.push(r.version);
      m.set(r.site_id, list);
    }
    return m;
  });
}

interface BusinessReportState {
  lastDate: string | null;
  everReported: boolean;
}

async function businessReports(env: Env): Promise<Map<string, BusinessReportState> | null> {
  return safeQuery(env, 'business_counts_last_report', async () => {
    const rows = await env.LEDGER!.prepare(
      'SELECT site_id, MAX(date) AS last_date FROM business_counts GROUP BY site_id'
    ).all<{ site_id: string; last_date: string }>();
    const m = new Map<string, BusinessReportState>();
    for (const r of rows.results ?? []) {
      m.set(r.site_id, { lastDate: r.last_date, everReported: true });
    }
    return m;
  });
}

/**
 * Offline lábak site-onként. A `fetchReconInputs` a null-t akkor adja, ha a
 * recon-lekérdezések MAGA bukott el — ilyenkor a dimenzió UNKNOWN, nem „nincs láb".
 */
async function offlineLegsBySite(
  env: Env,
  sinceIso: string,
  configs: SiteConfig[],
  complete: boolean
): Promise<Map<string, OfflineLegReport[]> | null> {
  const inputs = await safeQuery(env, 'offline_legs', () =>
    fetchReconInputs(env, sinceIso, configs, complete)
  );
  if (inputs === null) return null;
  const m = new Map<string, OfflineLegReport[]>();
  for (const report of collectOfflineReports(inputs)) {
    const list = m.get(report.site_id) ?? [];
    list.push(report);
    m.set(report.site_id, list);
  }
  // A `fetchReconInputs` végigfut MINDEN site-on; amelyiknek nincs lába, annak
  // üres tömb jár (= „lefutott a mérés, nincs bemenet"), NEM hiányzó kulcs.
  for (const i of inputs) if (!m.has(i.site_id)) m.set(i.site_id, []);
  return m;
}

/** A napi synthetic smoke eredménye site-onként (`daily-digest` gyűjtő újrahasznosítva). */
async function smokeBySite(
  env: Env
): Promise<{ expected: Set<string>; result: Map<string, 'pass' | 'fail' | 'missing'> } | null> {
  try {
    const status = await collectSmokeStatus(env);
    const expected = new Set(status.expected);
    const result = new Map<string, 'pass' | 'fail' | 'missing'>();
    for (const site of status.expected) result.set(site, 'pass');
    for (const site of status.missing) result.set(site, 'missing');
    for (const f of status.failures) result.set(f.site, 'fail');
    return { expected, result };
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.FLEET_HEALTH_QUERY_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.FLEET_HEALTH_QUERY_FAILED],
      query: 'smoke_status',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function collectFleetHealth(env: Env, nowMs: number): Promise<FleetHealthReport> {
  const since24h = new Date(nowMs - DAY_MS).toISOString();
  const since7d = new Date(nowMs - 7 * DAY_MS).toISOString();

  const { configs, complete } = await listAllSiteConfigs(env);

  const [
    events24,
    events7,
    deliveries,
    lastProven,
    decisions,
    versions,
    business,
    offline,
    smoke
  ] = await Promise.all([
    eventCounts(env, since24h, 'accepted_events_24h'),
    eventCounts(env, since7d, 'accepted_events_7d'),
    platformDeliveries(env, since24h),
    lastProvenDelivery(env),
    consentDecisions(env, since7d),
    clientLibVersions(env, since7d),
    businessReports(env),
    offlineLegsBySite(env, since24h, configs, complete),
    smokeBySite(env)
  ]);

  const inputs: FleetSiteInput[] = configs.map((cfg) => {
    const siteId = cfg.site_id;
    const businessState = business?.get(siteId);
    return {
      site_id: siteId,
      hostname: (cfg as SiteConfig & { hostname?: string }).hostname ?? siteId,
      monitoring: cfg.monitoring !== false,
      expected_smoke: cfg.expected_platforms?.smoke ?? [],
      expected_offline: cfg.expected_platforms?.offline ?? [],
      consent_provider: cfg.consent?.provider === 'sbo' ? 'sbo' : 'cookieyes',
      meta_configured: Boolean(cfg.meta?.pixel_id && cfg.meta?.access_token),
      gads_customer_id: cfg.gads?.customer_id ?? null,
      gads_conversion_action_count: Object.keys(cfg.gads?.conversion_actions ?? {}).length,
      accepted_events_24h: events24 === null ? null : (events24.get(siteId) ?? 0),
      accepted_events_7d: events7 === null ? null : (events7.get(siteId) ?? 0),
      platform_deliveries_24h: deliveries === null ? null : (deliveries.get(siteId) ?? {}),
      last_proven_delivery_at: lastProven?.get(siteId) ?? null,
      smoke_expected: smoke?.expected.has(siteId) ?? false,
      smoke_result: smoke === null ? null : (smoke.result.get(siteId) ?? null),
      consent_decisions_7d: decisions === null ? null : (decisions.get(siteId) ?? 0),
      client_lib_versions_7d: versions === null ? null : (versions.get(siteId) ?? []),
      offline_legs: offline === null ? null : (offline.get(siteId) ?? []),
      business_last_report_date: businessState?.lastDate ?? null,
      // `business === null` → nem futott le a lekérdezés. Ilyenkor NEM állíthatjuk,
      // hogy a site sosem jelentkezett: az `everReported: true` + `lastDate: null`
      // pár a pure magban UNKNOWN-t ad („a lekérdezés nem futott le"), nem RED-et.
      business_ever_reported: business === null ? true : Boolean(businessState?.everReported)
    };
  });

  return buildFleetReport(inputs, nowMs, complete, new Date(nowMs).toISOString());
}
