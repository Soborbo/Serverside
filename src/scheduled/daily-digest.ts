import type { Env } from '../env';
import { sendAdminEmail } from '../lib/notify';
import { countSiteConfigs, listConfiguredSiteIds, listMonitoredSiteConfigs } from '../lib/config';
import {
  fetchDatasetEmq,
  collectKeyCoverage,
  detectCoverageDrops,
  type EmqEventScore,
  type CoverageStats,
  type KeyCoverage
} from '../lib/emq';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import { logStructured } from '../types';
import {
  fingerprintConfig,
  diffManifest,
  type SiteManifest,
  type DriftEntry
} from '../lib/site-manifest';
import siteManifest from '../site-manifest.json';

/**
 * Site-onkénti elfogadott (ledger-be írt) event-szám az elmúlt 24 órából, a
 * konfigurált site-okkal összevetve. A visszaadott `zeroSites` = konfigurált,
 * de 0 elfogadott konverziójú site-ok — pont az a néma-kiesés jelzés, ami a
 * 2026-06-28→07-13 incidensnél hetekig hiányzott. LEDGER binding nélkül üres
 * eredményt ad (nincs mire riasztani).
 *
 * FONTOS: a napi szintetikus smoke-lead (`smoke-<site>-YYYYMMDD`) KI VAN ZÁRVA a
 * számból (event_id NOT LIKE 'smoke-%'). Enélkül minden SMOKE_SITES-site-nak lenne
 * legalább 1 „konverziója" (maga a smoke), így a zero-riasztás SOHA nem szólalna
 * meg pont a monitorozott site-okon — a smoke elrejtené azt a valós-nulla kiesést,
 * ami ellen az egész riasztás épült (a pipeline-egészséget a collectSmokeStatus méri).
 */
export async function collectAcceptedCounts(
  env: Env
): Promise<{ counts: Map<string, number>; zeroSites: string[] }> {
  const counts = new Map<string, number>();
  const zeroSites: string[] = [];
  if (!env.LEDGER) return { counts, zeroSites };

  const configured = await listConfiguredSiteIds(env);
  if (configured.size === 0) return { counts, zeroSites };

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await env.LEDGER.prepare(
      "SELECT site_id, COUNT(*) AS cnt FROM events_raw WHERE received_at >= ? AND event_id NOT LIKE 'smoke-%' GROUP BY site_id"
    )
      .bind(since)
      .all<{ site_id: string; cnt: number }>();
    for (const row of rows.results ?? []) {
      counts.set(row.site_id, row.cnt);
    }
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: ledger accepted-count query failed',
      error: err instanceof Error ? err.message : String(err)
    });
    // Lekérdezési hiba → ne riasszunk fals "0 konverzió"-t minden site-ra.
    return { counts, zeroSites };
  }

  for (const siteId of configured) {
    if (!counts.has(siteId)) zeroSites.push(siteId);
  }
  zeroSites.sort();
  return { counts, zeroSites };
}

/** Miért bukott el egy elvárt platform lába a füstteszten. Mind CRITICAL. */
export type SmokeFailureReason =
  | 'missing'
  | 'skipped'
  | 'rejected'
  | 'accepted_without_http_status';

export interface SmokePlatformFailure {
  site: string;
  platform: string;
  reason: SmokeFailureReason;
  error_code: string | null;
  /**
   * Honnan jött az elvárás. 'config' = a SiteConfig explicit
   * `expected_platforms.smoke`-ja; 'history' = a platform KORÁBBAN accepted volt
   * ezen a site-on, tehát a mostani kiesés regresszió.
   */
  expectation: 'config' | 'history';
}

export interface SmokeStatus {
  /** Az SMOKE_SITES-ban elvárt site-ok. Üres → a check kikapcsolt. */
  expected: string[];
  /** Elvárt site, aminek EGYETLEN smoke-sora sincs az elmúlt 24 órából. */
  missing: string[];
  /** Platform-szintű bukások az elvárt lábakon. */
  failures: SmokePlatformFailure[];
}

/** Meddig nézünk vissza az elvárás megfigyelt (history) alapjáért. */
const SMOKE_BASELINE_DAYS = 14;

/**
 * Napi synthetic-lead füstteszt ellenőrzése (#Run6 utó). A site workerek 04:4x
 * UTC-kor determinisztikus `smoke-<site>-YYYYMMDD` eventet tolnak át a teljes
 * szerver-láncon; itt (08:00) azt nézzük, hogy minden ELVÁRT platform-láb
 * ténylegesen `accepted` lett-e, vendor HTTP-státusszal együtt.
 *
 * A korábbi szabály CSAK a Meta `rejected`-re riasztott, a `skipped`-et OK-nak
 * vette. Emiatt a lomtalan `meta` blokkjának 2026-07-15-i KV-beli kiesése öt
 * napig zöld füsttesztként ment át: a fan-out némán skip-re váltott, a smoke
 * pedig pont azt nem nézte. A delivery-sorból nézve egy törölt config és egy
 * szándékos kihagyás azonos — ezért az elvárás két, egymást fedő forrásból jön:
 *
 *   1) SiteConfig.expected_platforms.smoke — explicit, verziókezelt szerződés;
 *   2) megfigyelt előzmény — ami a baseline-ablakban MÁR volt accepted, annak
 *      accepted-nek kell maradnia. Ez fogja meg azt az esetet, amikor (1) még
 *      nincs kitöltve, VAGY amikor a configgal együtt az elvárás is eltűnt.
 *
 * Nem elvárt platform `skipped`-je változatlanul OK (msads/tiktok/linkedin).
 * A Google Ads OFFLINE lába szándékosan nincs itt — azt a böngésző-smoke nem
 * érinti, külön hitelesített offline teszt / OAuth health check kell hozzá.
 * Query-hiba → üres eredmény (nem riasztunk falsot minden site-ra).
 */
export async function collectSmokeStatus(env: Env): Promise<SmokeStatus> {
  const expected = (env.SMOKE_SITES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const status: SmokeStatus = { expected, missing: [], failures: [] };
  if (!env.LEDGER || expected.length === 0) return status;

  try {
    const now = Date.now();
    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const baselineFrom = new Date(now - SMOKE_BASELINE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const recent = await env.LEDGER.prepare(
      `SELECT site_id, platform, status, http_status, error_code FROM deliveries
       WHERE created_at >= ? AND event_id LIKE 'smoke-%'`
    )
      .bind(since)
      .all<{
        site_id: string;
        platform: string;
        status: string;
        http_status: number | null;
        error_code: string | null;
      }>();

    // Megfigyelt elvárás: a baseline-ablakban (a mai 24h ELŐTT) accepted lábak.
    const baseline = await env.LEDGER.prepare(
      `SELECT DISTINCT site_id, platform FROM deliveries
       WHERE created_at >= ? AND created_at < ? AND event_id LIKE 'smoke-%'
         AND status = 'accepted'`
    )
      .bind(baselineFrom, since)
      .all<{ site_id: string; platform: string }>();

    const recentBySitePlatform = new Map<
      string,
      { status: string; http_status: number | null; error_code: string | null }
    >();
    const sitesWithAnyRow = new Set<string>();
    for (const r of recent.results ?? []) {
      recentBySitePlatform.set(`${r.site_id}::${r.platform}`, r);
      sitesWithAnyRow.add(r.site_id);
    }

    const historical = new Map<string, Set<string>>();
    for (const r of baseline.results ?? []) {
      if (!historical.has(r.site_id)) historical.set(r.site_id, new Set());
      historical.get(r.site_id)!.add(r.platform);
    }

    const configBySiteId = new Map<string, string[]>();
    for (const cfg of await listMonitoredSiteConfigs(env)) {
      const smokePlatforms = cfg.expected_platforms?.smoke;
      if (smokePlatforms?.length) configBySiteId.set(cfg.site_id, smokePlatforms);
    }

    for (const site of expected) {
      // Egyetlen sor sincs → a site cron→gateway lánca nem futott le. Ilyenkor a
      // platform-szintű bontásnak nincs információtartalma: egy site-szintű
      // riasztás megy, nem N darab platform-'missing'.
      if (!sitesWithAnyRow.has(site)) {
        status.missing.push(site);
        continue;
      }

      const fromConfig = new Set(configBySiteId.get(site) ?? []);
      const fromHistory = historical.get(site) ?? new Set<string>();
      for (const platform of new Set([...fromConfig, ...fromHistory])) {
        const expectation: 'config' | 'history' = fromConfig.has(platform) ? 'config' : 'history';
        const row = recentBySitePlatform.get(`${site}::${platform}`);
        const fail = (reason: SmokeFailureReason, error_code: string | null = null) =>
          status.failures.push({ site, platform, reason, error_code, expectation });

        if (!row) fail('missing');
        else if (row.status === 'rejected') fail('rejected', row.error_code);
        else if (row.status !== 'accepted') fail('skipped', row.error_code);
        else if (row.http_status == null) fail('accepted_without_http_status', row.error_code);
      }
    }
    status.failures.sort(
      (a, b) => a.site.localeCompare(b.site) || a.platform.localeCompare(b.platform)
    );
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: smoke-status query failed',
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return status;
}

// ── Lifecycle-frissesség (CRM offline-loop) szekció ──────────────────────────

export interface LifecycleFreshness {
  /** A legutóbbi offline lifecycle-kézbesítés ISO-ideje, vagy null ha még sose volt. */
  lastEventAt: string | null;
  lastEventName?: string;
  lastSiteId?: string;
  /** Hány teljes nap telt el a legutóbbi lifecycle-esemény óta (null ha sose volt). */
  daysSince: number | null;
}

/**
 * F4-3 · Kalibrált lifecycle-jelzés. A CRM offline-loop (lead-status → Google Ads
 * Enhanced Conversions for Leads) eseményei a `deliveries` táblába `origin='offline'`
 * néven landolnak (lead_qualified / booking_confirmed / revenue_confirmed, stb.).
 * Itt CSAK a legutóbbi ilyen esemény frissességét jelentjük — **INFO szinten, SOHA
 * nem riasztásként**.
 *
 * Miért nem CRITICAL: ezen a volumenen a valódi lifecycle-események kezdetben
 * LEGITIM módon ritkák (a lead→minősítés→bevétel folyamat napokig-hetekig tart, és
 * az F3 outbox élesítése is fokozatos). Egy „X napja nincs lifecycle-esemény"
 * CRITICAL pontosan azt a riasztási fáradást okozná, ami ellen ez a lánc épült
 * (2026-07-14 tanulság). A digest ezért csak MEGMUTATJA a frissességet; ha a
 * lifecycle-volumen később beáll, egy külön (megfigyelt-baseline alapú) escaláció
 * teheti WARNING-gá — de az már nem F4-3.
 *
 * Query-hiba / LEDGER hiánya → üres (null) eredmény, nem buktatja a digestet.
 */
export async function collectLifecycleFreshness(env: Env): Promise<LifecycleFreshness> {
  const empty: LifecycleFreshness = { lastEventAt: null, daysSince: null };
  if (!env.LEDGER) return empty;
  try {
    // MEGJEGYZÉS a `NOT LIKE 'smoke-%'` szűrőről: az offline lábon ez SOSEM
    // illeszkedik, mert a lead-status determinisztikus orderId-t képez
    // (sha256(lead_id_status) 32 karakteres szelete), nem `smoke-` prefixű
    // event_id-t — szemben a böngésző-ág synthetic smoke-eseményeivel. A szűrő
    // ártalmatlan, és szándékosan BENT MARAD: ha valaha lesz hitelesített offline
    // synthetic füstteszt (ma nincs — lásd collectSmokeStatus doksija), az a
    // konvención `smoke-` prefixet kapna, és nem szabad, hogy a valódi lifecycle-
    // frissességet elfedje.
    const row = await env.LEDGER.prepare(
      `SELECT site_id, event_name, created_at FROM deliveries
       WHERE origin = 'offline' AND event_id NOT LIKE 'smoke-%'
       ORDER BY created_at DESC LIMIT 1`
    ).first<{ site_id: string; event_name: string; created_at: string }>();
    if (!row) return empty;
    const daysSince = Math.floor(
      (Date.now() - new Date(row.created_at).getTime()) / (24 * 60 * 60 * 1000)
    );
    return {
      lastEventAt: row.created_at,
      lastEventName: row.event_name,
      lastSiteId: row.site_id,
      daysSince
    };
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: lifecycle-freshness query failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return empty;
  }
}

function renderLifecycleSection(lifecycle: LifecycleFreshness): string {
  if (lifecycle.lastEventAt === null) {
    return `<p>ℹ️ No CRM offline-loop lifecycle events recorded yet — expected while the F3 outbox is not yet delivering in production. Informational only, not an alert.</p>`;
  }
  return `<p>ℹ️ Last lifecycle event: <strong>${lifecycle.lastEventName}</strong> on ${lifecycle.lastSiteId}, ${lifecycle.daysSince} day(s) ago (${lifecycle.lastEventAt}). At this volume sparse lifecycle events are normal — informational only, not an alert.</p>`;
}

// ── Site-manifest drift-check (F4-1) szekció ─────────────────────────────────

/**
 * F4-1 · A repóbeli `site-manifest.json` (nem-titkos fingerprint-map) összevetése a
 * LIVE KV site-configokkal. Ez a lomtalan-osztályú néma config-kiesés ÁLLANDÓ őre:
 * ha egy config eltér a source-of-truth-tól (meta-blokk eltűnik, pixel/token/consent
 * megváltozik, VAGY egy sose-commitolt config jelenik meg a KV-ben), a napi digest
 * jelzi — nem hetekkel később egy elveszett bevétel.
 *
 * `changed`/`missing` = valódi drift (a KV és a source-of-truth széttartott) →
 * riasztás (alarmBits). `unmanifested` = a KV-ben van egy config, ami a manifestből
 * hiányzik (jellemzően új site onboardingja a manifest-frissítés ELŐTT) → látható
 * tennivaló, de NEM riasztás (különben minden onboarding CRITICAL-t szülne).
 *
 * SITE_CONFIG hiánya / KV-hiba → üres eredmény (a digestet nem buktathatja).
 */
export async function collectManifestDrift(env: Env): Promise<DriftEntry[]> {
  if (!env.SITE_CONFIG) return [];
  try {
    const live = new Map<string, string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await env.SITE_CONFIG.list({ limit: 1000, cursor });
      for (const k of page.keys) {
        const cfg = await env.SITE_CONFIG.get(k.name, { type: 'json' });
        if (cfg) live.set(k.name, await fingerprintConfig(cfg));
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
    return diffManifest(siteManifest as SiteManifest, live);
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: site-manifest drift-check failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

/** Van-e VALÓDI drift (changed/missing) — ez az, ami riaszt (nem az unmanifested). */
function hasManifestAlarm(drift: DriftEntry[]): boolean {
  return drift.some((d) => d.kind === 'missing' || d.kind === 'changed');
}

function renderManifestSection(drift: DriftEntry[]): string {
  if (drift.length === 0) {
    return `<p>✓ all live KV site-configs match the committed manifest</p>`;
  }
  const label: Record<DriftEntry['kind'], string> = {
    missing: 'MISSING from KV (config vanished)',
    changed: 'CHANGED vs manifest (config drifted)',
    unmanifested: 'not in manifest (new site? run gen-site-manifest)'
  };
  const items = drift
    .map((d) => `<li>${d.hostname} → ${label[d.kind]}</li>`)
    .join('\n      ');
  const heading = hasManifestAlarm(drift)
    ? `<p><strong>⚠️ Site-config drift — the KV production config and the committed source-of-truth have diverged. A vanished/changed money-path config looks exactly like this before it silently loses revenue.</strong></p>`
    : `<p>ℹ️ New KV config(s) not yet in the manifest — onboarding follow-up (run gen-site-manifest), not an alert.</p>`;
  return `${heading}
    <ul>
      ${items}
    </ul>`;
}

// ── Meta EMQ (Event Match Quality) szekció ───────────────────────────────────

/** EMQ riasztási küszöb (0-10-es composite score). Meta ajánlás: a jó ≥ 7. */
const EMQ_ALERT_THRESHOLD = 7;

export interface EmqSiteStatus {
  site: string;
  /**
   * Az adatforrás: 'emq' = valódi Dataset Quality API score; 'proxy' = ledger
   * match-kulcs lefedettség (az EMQ API nem volt elérhető — pl. client system
   * user token inkompatibilitás, lásd lib/emq.ts); 'none' = egyik sem ("n/a").
   */
  source: 'emq' | 'proxy' | 'none';
  emqEvents?: EmqEventScore[];
  coverage?: CoverageStats;
  /** Riasztásra okot adó sorok (EMQ < küszöb vagy lefedettség-esés). */
  alerts: string[];
}

/**
 * Site-onkénti EMQ-státusz a Meta-configgal rendelkező, monitorozott site-okra.
 * Meta-config nélküli site (pl. lomtalan) hangtalan skip. Elsődleges forrás a
 * Dataset Quality API; BÁRMILYEN hibájánál a ledger-proxy (em/ph/fbc/fbp
 * jelenlét-lefedettség 24h vs 7 nap); ha az sincs → 'none'. Hibatűrő: soha nem
 * dob — a digestet EMQ-hiba nem buktathatja.
 */
export async function collectEmqStatus(env: Env): Promise<EmqSiteStatus[]> {
  const statuses: EmqSiteStatus[] = [];
  try {
    const configs = await listMonitoredSiteConfigs(env);
    for (const cfg of configs) {
      if (!cfg.meta) continue; // nincs CAPI-láb → nincs mit mérni (hangtalan skip)
      const status: EmqSiteStatus = { site: cfg.site_id, source: 'none', alerts: [] };

      const emq = await fetchDatasetEmq(cfg.site_id, cfg.meta.pixel_id, cfg.meta.access_token);
      if (emq.ok && emq.events.length > 0) {
        status.source = 'emq';
        status.emqEvents = emq.events;
        for (const ev of emq.events) {
          if (ev.score < EMQ_ALERT_THRESHOLD) {
            status.alerts.push(`${ev.event_name} EMQ ${ev.score.toFixed(1)} < ${EMQ_ALERT_THRESHOLD}`);
            logStructured({
              level: 'warn',
              error_code: TrackingErrorCode.EMQ_BELOW_THRESHOLD,
              message: ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_BELOW_THRESHOLD],
              site_id: cfg.site_id,
              event_name: ev.event_name,
              emq_score: ev.score
            });
          }
        }
      } else {
        // EMQ API nem elérhető (vagy üres) → proxy: match-kulcs lefedettség a
        // ledgerből. A hibát a lib már 'info'-n logolta (TRK-950-008).
        const coverage = await collectKeyCoverage(env, cfg.site_id);
        if (coverage) {
          status.source = 'proxy';
          status.coverage = coverage;
          for (const drop of detectCoverageDrops(coverage)) {
            status.alerts.push(
              `${drop.key} coverage ${drop.pct24h}% (7d avg ${drop.pct7d}%)`
            );
            logStructured({
              level: 'warn',
              error_code: TrackingErrorCode.EMQ_COVERAGE_DROP,
              message: ERROR_DESCRIPTIONS[TrackingErrorCode.EMQ_COVERAGE_DROP],
              site_id: cfg.site_id,
              match_key: drop.key,
              pct_24h: drop.pct24h,
              pct_7d: drop.pct7d
            });
          }
        }
      }
      statuses.push(status);
    }
  } catch (err) {
    // Defenzív: semmilyen EMQ-hiba nem buktathatja a digestet.
    logStructured({
      level: 'warn',
      message: 'Daily digest: EMQ section failed',
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return statuses;
}

function renderEmqLine(s: EmqSiteStatus): string {
  if (s.source === 'emq' && s.emqEvents) {
    const scores = s.emqEvents
      .map((e) => `${e.event_name} ${e.score.toFixed(1)}`)
      .join(', ');
    return `${s.site}: ${scores}`;
  }
  if (s.source === 'proxy' && s.coverage) {
    const keys = s.coverage.keys
      .map((k: KeyCoverage) => `${k.key} ${k.pct24h}%`)
      .join(' / ');
    return `${s.site}: proxy coverage 24h (${s.coverage.events24h} events) — ${keys}`;
  }
  return `${s.site}: n/a (EMQ API + ledger proxy unavailable)`;
}

export async function handleDailyDigest(env: Env): Promise<void> {
  const siteCount = await countSiteConfigs(env);
  const { counts: acceptedCounts, zeroSites } = await collectAcceptedCounts(env);
  const smoke = await collectSmokeStatus(env);
  const smokeAlarm = smoke.missing.length > 0 || smoke.failures.length > 0;
  const emqStatuses = await collectEmqStatus(env);
  const emqAlerts = emqStatuses.filter((s) => s.alerts.length > 0);
  // F4-3: tisztán informatív — SZÁNDÉKOSAN nem táplálja az alarmBits-et.
  const lifecycle = await collectLifecycleFreshness(env);
  // F4-1: KV↔manifest drift. changed/missing → riaszt; unmanifested → csak tennivaló.
  const manifestDrift = await collectManifestDrift(env);
  const manifestAlarm = hasManifestAlarm(manifestDrift);

  let totalDlqRecords = 0;
  let totalDeadRecords = 0;
  let truncated = false;
  try {
    let cursor: string | undefined;
    let pages = 0;
    const MAX_PAGES = 10;
    while (pages < MAX_PAGES) {
      const list = await env.DEAD_LETTER.list({ cursor, limit: 1000 });
      for (const obj of list.objects) {
        const segments = obj.key.split('/');
        if (segments.length >= 4 && segments[2] === 'dead') totalDeadRecords++;
        else totalDlqRecords++;
      }
      if (!list.truncated) break;
      cursor = list.cursor;
      pages++;
    }
    if (pages >= MAX_PAGES) truncated = true;
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: failed to count DLQ',
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const html = `
    <h2>Soborbo Tracking — Daily Digest</h2>
    <p><strong>Snapshot:</strong> ${new Date().toISOString()} (a DLQ-számok a teljes bucket pillanatképe, nem 24h-s ablak)</p>

    <h3>Active sites</h3>
    <p>${siteCount} sites configured</p>

    <h3>Accepted conversions (last 24h, D1 ledger)</h3>
    <ul>
      ${
        acceptedCounts.size > 0
          ? [...acceptedCounts.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([site, cnt]) => `<li>${site}: ${cnt}</li>`)
              .join('\n      ')
          : '<li>none</li>'
      }
    </ul>
    ${
      zeroSites.length > 0
        ? `<p><strong>⚠️ ZERO accepted conversions for configured site(s): ${zeroSites.join(', ')} — a silently dead server leg looks exactly like this. Check the client dispatch + Turnstile + Workers logs.</strong></p>`
        : ''
    }

    <h3>Synthetic smoke leads (last 24h)</h3>
    ${
      smoke.expected.length === 0
        ? '<p>check disabled (no SMOKE_SITES)</p>'
        : smokeAlarm
          ? `<p><strong>⚠️ ${
              smoke.missing.length > 0
                ? `NO smoke event from: ${smoke.missing.join(', ')} — the site cron→gateway chain did not run or did not land. `
                : ''
            }${
              smoke.failures.length > 0
                ? `Expected platform leg FAILED: ${smoke.failures
                    .map(
                      (f) =>
                        `${f.site}/${f.platform} → ${f.reason}${
                          f.error_code ? ` (${f.error_code})` : ''
                        } [expected by ${f.expectation}]`
                    )
                    .join(', ')}.`
                : ''
            }</strong></p>`
          : `<p>✓ all expected sites delivered (${smoke.expected.join(', ')})</p>`
    }

    <h3>Meta EMQ (Event Match Quality)</h3>
    ${
      emqStatuses.length === 0
        ? '<p>no sites with Meta config</p>'
        : `<ul>
      ${emqStatuses.map((s) => `<li>${renderEmqLine(s)}</li>`).join('\n      ')}
    </ul>`
    }
    ${
      emqAlerts.length > 0
        ? `<p><strong>⚠️ Match-quality alert: ${emqAlerts
            .map((s) => `${s.site} (${s.alerts.join('; ')})`)
            .join(' | ')} — a delivery-green pipeline with falling EMQ usually means broken fbc/fbp or em/ph forwarding.</strong></p>`
        : ''
    }

    <h3>Site-config manifest drift</h3>
    ${renderManifestSection(manifestDrift)}

    <h3>Lifecycle events (CRM offline loop)</h3>
    ${renderLifecycleSection(lifecycle)}

    <h3>Dead Letter Queue</h3>
    <ul>
      <li>Pending retries: ${totalDlqRecords}${truncated ? ' (≥10000 — list truncated)' : ''}</li>
      <li>Dead (max retries reached): ${totalDeadRecords}</li>
    </ul>

    <h3>Action items</h3>
    ${
      totalDeadRecords > 0
        ? `<p><strong>⚠️ ${totalDeadRecords} dead records require manual intervention.</strong></p>`
        : `<p>✓ No dead records.</p>`
    }
    ${totalDlqRecords > 50 ? `<p><strong>⚠️ DLQ pending records elevated.</strong></p>` : ''}

    <p><em>For detailed metrics: Grafana dashboard</em></p>
  `;

  if (zeroSites.length > 0) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: configured site(s) with ZERO accepted conversions in 24h',
      sites: zeroSites.join(',')
    });
  }
  if (smokeAlarm) {
    logStructured({
      level: 'error',
      message: 'Daily digest: synthetic smoke-lead check FAILED',
      missing: smoke.missing.join(','),
      failures: smoke.failures.map((f) => `${f.site}/${f.platform}:${f.reason}`).join(',')
    });
  }

  if (manifestAlarm) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.SITE_CONFIG_DRIFT,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.SITE_CONFIG_DRIFT],
      drift: manifestDrift
        .filter((d) => d.kind === 'missing' || d.kind === 'changed')
        .map((d) => `${d.hostname}:${d.kind}`)
        .join(',')
    });
  }

  const alarmBits = [
    ...(smokeAlarm
      ? [
          `smoke failed: ${[
            ...smoke.missing,
            ...smoke.failures.map((f) => `${f.site}/${f.platform} ${f.reason}`)
          ].join(', ')}`
        ]
      : []),
    ...(zeroSites.length > 0 ? [`zero conversions: ${zeroSites.join(', ')}`] : []),
    ...(emqAlerts.length > 0 ? [`EMQ alert: ${emqAlerts.map((s) => s.site).join(', ')}`] : []),
    ...(manifestAlarm
      ? [
          `config drift: ${manifestDrift
            .filter((d) => d.kind === 'missing' || d.kind === 'changed')
            .map((d) => `${d.hostname} ${d.kind}`)
            .join(', ')}`
        ]
      : [])
  ];
  await sendAdminEmail(
    env,
    alarmBits.length > 0 ? `Daily Digest — ⚠️ ${alarmBits.join(' | ')}` : 'Daily Digest',
    html,
    alarmBits.length > 0 ? 'warning' : 'info'
  );
}
