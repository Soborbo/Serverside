import type { Env } from '../env';
import { logStructured } from '../types';
import { sendAdminEmail, escapeHtml } from '../lib/notify';
import { recordReconciliationMetric } from '../lib/metrics';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import {
  fetchReconInputs,
  summarize,
  collectOfflineReports,
  DEFAULT_THRESHOLDS,
  type DriftKind,
  type DriftFinding,
  type OfflineLegReport
} from '../lib/reconciliation';
import {
  runCrossPlatformCheck,
  type CrossCheckFinding,
  type CrossCheckOutcome
} from '../lib/cross-check';
import { listMonitoredSiteConfigsWithCompleteness } from '../lib/config';
import {
  fetchBusinessSourceFindings,
  type BusinessSourceFinding
} from '../lib/business-counts';
import type { MetricPlatform } from '../lib/metrics';

const WINDOW_HOURS = 24;

const KIND_ERROR_CODE: Record<DriftKind, TrackingErrorCode> = {
  vendor_failure_rate: TrackingErrorCode.RECON_VENDOR_FAILURE_RATE,
  coverage_drift: TrackingErrorCode.RECON_COVERAGE_DRIFT,
  // P1.1 business-leg (CRM lifecycle → Google Ads offline / Data Manager)
  offline_zero_delivery: TrackingErrorCode.RECON_OFFLINE_ZERO_DELIVERY,
  offline_coverage_drift: TrackingErrorCode.RECON_OFFLINE_COVERAGE_DRIFT,
  offline_vendor_failure: TrackingErrorCode.RECON_OFFLINE_VENDOR_FAILURE
};

/**
 * Napi reconciliation (#11) — a D1 ledger fölött drift-detektálás + alerting.
 * A daily-digest MELLETT fut (külön cron), önállóan tesztelhető pure maggal
 * (lib/reconciliation.ts). LEDGER binding nélkül no-op (a recon a ledgerre épül).
 *
 * Minden drift-finding → strukturált log (error_code-dal, Cloudflare felszedi)
 * + Analytics Engine metrika (trend/alert). Email CSAK ha van finding (no-noise).
 */
export async function handleReconciliation(env: Env): Promise<void> {
  if (!env.LEDGER) {
    logStructured({
      level: 'info',
      message: 'Reconciliation skipped — no D1 LEDGER binding'
    });
    return;
  }

  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // EGYSZER olvassuk (a cross-check is ezt kapja lentebb): a P1.1 offline láb
  // dependency-állapotához (customer_id / conversion action / OAuth) config kell.
  // KV-hiba esetén üres lista jön vissza — akkor az offline láb NEM némul el,
  // csak a `blocked_by` marad feloldatlan (mérünk, nem hallgatunk).
  let siteConfigs: Awaited<ReturnType<typeof listMonitoredSiteConfigsWithCompleteness>>['configs'] = [];
  // A TELJESSÉG külön jel: a KV-listázás lapozás közben elbukhat, és a részlistát
  // exclusion filterként használva a hiányzó site-ok NÉMÁN kiesnének a mérésből
  // (2026-08-24 review, HIGH). Hiba esetén is `false`, nem csak throw-nál.
  let configsComplete = false;
  try {
    const listed = await listMonitoredSiteConfigsWithCompleteness(env);
    siteConfigs = listed.configs;
    configsComplete = listed.complete;
  } catch {
    // már logolva a config-rétegben
  }
  if (!configsComplete) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RECON_CONFIG_ENUMERATION_INCOMPLETE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CONFIG_ENUMERATION_INCOMPLETE],
      resolved_site_configs: siteConfigs.length
    });
  }

  const inputs = await fetchReconInputs(env, since, siteConfigs, configsComplete);
  if (inputs === null) return; // query failed (already logged)
  const summary = summarize(inputs, DEFAULT_THRESHOLDS);
  const offlineReports = collectOfflineReports(inputs);
  const blockedLegs = offlineReports.filter((r) => r.state === 'BLOCKED_DEPENDENCY');

  // Observability: minden finding → structured log + Analytics Engine metrika.
  for (const f of summary.findings) {
    logStructured({
      level: f.severity === 'critical' ? 'error' : 'warn',
      error_code: KIND_ERROR_CODE[f.kind],
      message: f.detail,
      site_id: f.site_id,
      platform: f.platform,
      drift_kind: f.kind,
      drift_value: f.value,
      drift_threshold: f.threshold,
      severity: f.severity,
      // P1.3 kötelező riasztás-mezők (offline lábon értelmezettek)
      event_name: f.event_name,
      expected: f.expected,
      delivered: f.delivered,
      failure_rate: f.failure_rate,
      last_successful_upload: f.last_successful_upload
    });
    recordReconciliationMetric(env, {
      site_id: f.site_id,
      platform: f.platform as MetricPlatform,
      kind: f.kind,
      severity: f.severity,
      value: f.value
    });
  }

  // P1.1 — a BLOKKOLT offline lábak. SZÁNDÉKOSAN nem drift-FINDINGEK: a hibájuk ISMERT
  // (hiányzó OAuth secret / refresh token / customer_id / conversion action), és a
  // health-check már jelzi — egy második CRITICAL ugyanarról csak zajt termel.
  //
  // PONTOSÍTÁS (2026-08-24 review): ez NEM jelenti azt, hogy a blokkolt láb nem generál
  // levelet. Generál — napi OPERATIONAL WARNING szinten —, és ez szándékos: a
  // health-check ON-DEMAND (valakinek le kell kérnie), az email viszont PUSH. Amit
  // elkerülünk, az a második *critical drift finding*, nem a láthatóság. Külön kód
  // (TRK-950-015), warning szinten, a critical/warning SZÁMLÁLÓKON KÍVÜL — az email
  // SÚLYÁT nem emeli, de a kimenetelét igen.
  for (const b of blockedLegs) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RECON_OFFLINE_BLOCKED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_OFFLINE_BLOCKED],
      site_id: b.site_id,
      event_name: b.event_name,
      platform: 'gads',
      offline_state: b.state,
      blocked_by: b.blocked_by,
      received: b.received,
      expected: b.expected,
      delivered: b.delivered
    });
  }

  // 3. ellenőrzés (2026-07-16 audit): ledger ↔ GA4 ↔ Google Ads kereszt-
  // egyeztetés a TEGNAPI teljes UTC-napra. A ledger-belső recon szerkezetileg
  // nem látja, ha a böngésző/GTM-ág romlik el (Modell 2) — ez a check pont azt
  // fogja meg. Hibatűrő: bármely leg query-hibája logolt skip, a cron nem dől el.
  let crossOutcome: CrossCheckOutcome = {
    findings: [],
    totalSites: 0,
    configuredSites: 0,
    skippedLegs: [],
    ledgerUnavailable: false
  };
  // Ha a cross-check ELDŐL (lejárt analytics.readonly scope, API 5xx, visszavont
  // token), az NEM „nincs drift" — a Modell-2 böngésző/GTM-vakfolt egyetlen monitora
  // sötétbe borul. Enélkül a flag nélkül egy tiszta ledger-nap mellett NEM ment volna
  // email, és a „Reconciliation completed" log cross_platform_findings:0-t írt volna —
  // megkülönböztethetetlenül a „minden rendben"-től.
  let crossCheckFailed = false;
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    crossOutcome = await runCrossPlatformCheck(env, siteConfigs, yesterday);
  } catch (err) {
    crossCheckFailed = true;
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
      message: 'Cross-platform reconciliation threw',
      error: err instanceof Error ? err.message : String(err)
    });
  }
  const crossFindings = crossOutcome.findings;

  // A THROW csak az egyik módja annak, hogy a monitor álljon. A csendesebb (és a
  // gyakorlatban valóságos) mód: a check LEFUT, de nincs mit néznie — egyetlen
  // site-on sincs `recon` blokk, vagy minden leg kimarad hiányzó property-id /
  // action-térkép / 403-as scope miatt. 2026-08-16-ig pontosan ez volt a helyzet,
  // és semmi nem jelezte. Innentől ez ugyanúgy riaszt, mint egy elbukott lekérdezés.
  const anyLegRan =
    crossOutcome.configuredSites > 0 &&
    !crossOutcome.ledgerUnavailable &&
    crossOutcome.skippedLegs.length < crossOutcome.configuredSites * 2;
  const crossCheckNotRunning = !crossCheckFailed && !anyLegRan;
  if (crossCheckNotRunning) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.RECON_CROSS_CHECK_NOT_RUNNING,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.RECON_CROSS_CHECK_NOT_RUNNING],
      total_sites: crossOutcome.totalSites,
      configured_sites: crossOutcome.configuredSites,
      ledger_unavailable: crossOutcome.ledgerUnavailable,
      skipped_legs: crossOutcome.skippedLegs
        .map((l) => `${l.site_id}/${l.platform}:${l.reason}`)
        .join(',')
    });
  } else if (crossOutcome.skippedLegs.length > 0) {
    // Részleges kimaradás: a check futott, de nem mindenhol. Nem riasztás-szintű,
    // de a riportban látszania kell, különben a hiányzó leg „tiszta"-ként olvasódik.
    logStructured({
      level: 'info',
      error_code: TrackingErrorCode.RECON_CROSS_CHECK_NOT_RUNNING,
      message: 'Cross-platform reconciliation ran with some legs skipped',
      skipped_legs: crossOutcome.skippedLegs
        .map((l) => `${l.site_id}/${l.platform}:${l.reason}`)
        .join(',')
    });
  }

  for (const f of crossFindings) {
    logStructured({
      level: f.severity === 'critical' ? 'error' : 'warn',
      error_code: TrackingErrorCode.RECON_CROSS_PLATFORM_DRIFT,
      message: f.detail,
      site_id: f.site_id,
      platform: f.platform,
      event_name: f.event_name,
      ledger_count: f.ledger_count,
      platform_count: f.platform_count,
      drift_kind: 'cross_platform_drift',
      drift_value: f.value,
      severity: f.severity
    });
    recordReconciliationMetric(env, {
      site_id: f.site_id,
      platform: f.platform as MetricPlatform,
      kind: 'cross_platform_drift',
      severity: f.severity,
      value: f.value
    });
  }

  // P1.2 — CRM business-source recon a TEGNAPI teljes UTC-napra (a mai nap még nyitott,
  // a CRM aggregátuma is csak a nap végén teljes). `null` = a lekérdezés elbukott VAGY
  // nincs LEDGER — ezt NEM keverjük össze a „nincs eltéréssel".
  const reconDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const priorSince = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const businessResult = await fetchBusinessSourceFindings(env, reconDay, priorSince);
  // `null` = a lekérdezés ELBUKOTT (vagy nincs LEDGER / nincs kint a 0007 migráció) —
  // ez NEM „nincs eltérés". `?? []`-vel a napi riport `business_source_findings: 0`-t
  // írna, az email-feltételből kiesne, és a monitor tisztának látszana, miközben EL SEM
  // INDULT. Pontosan az a néma-zöld osztály, ami ellen ez a láb megépült — ugyanaz a
  // kezelés jár neki, mint a cross-check `crossCheckFailed` ágának. (Codex-review, 2026-08-24.)
  const businessCheckFailed = businessResult === null;
  const businessFindings = businessResult ?? [];
  if (businessCheckFailed) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_QUERY_FAILED,
      message:
        'Business-source reconciliation did NOT run (query failed / no LEDGER / migration 0007 missing) — ' +
        'zero findings here does NOT mean zero drift',
      date: reconDay
    });
  }

  for (const f of businessFindings) {
    logStructured({
      level: f.severity === 'critical' ? 'error' : 'warn',
      error_code:
        f.kind === 'business_source_drift'
          ? TrackingErrorCode.RECON_BUSINESS_SOURCE_DRIFT
          : TrackingErrorCode.RECON_BUSINESS_SOURCE_MISSING,
      message: f.detail,
      site_id: f.site_id,
      event_name: f.event_name,
      date: f.date,
      crm_count: f.crm_count,
      gateway_count: f.gateway_count,
      drift_kind: f.kind,
      severity: f.severity
    });
  }
  const businessCritical = businessFindings.filter((f) => f.severity === 'critical').length;
  const businessWarning = businessFindings.length - businessCritical;

  const crossCritical = crossFindings.filter((f) => f.severity === 'critical').length;
  const crossWarning = crossFindings.length - crossCritical;

  logStructured({
    level: 'info',
    message: 'Reconciliation completed',
    sites_checked: summary.sites_checked,
    warning_count: summary.warning_count + crossWarning + businessWarning,
    critical_count: summary.critical_count + crossCritical + businessCritical,
    business_source_findings: businessFindings.length,
    // A puszta finding-szám félrevezet, ha a láb le sem futott — a kontextus MINDIG
    // ott van a napi log-sorban (ugyanaz az elv, mint a cross_check_not_running-nál).
    business_check_failed: businessCheckFailed,
    cross_platform_findings: crossFindings.length,
    // A puszta finding-szám félrevezet, ha a check nem is futott — a kontextus
    // mostantól MINDIG ott van a napi log-sorban.
    cross_check_configured_sites: crossOutcome.configuredSites,
    cross_check_total_sites: crossOutcome.totalSites,
    cross_check_skipped_legs: crossOutcome.skippedLegs.length,
    cross_check_not_running: crossCheckNotRunning,
    // DEGRADED: a config-feloldás nem volt teljes, tehát a `monitoring:false` szűrő
    // ki van kapcsolva, és a blocked_by feloldatlan maradhat. A riport ettől nem
    // hamis — csak kevésbé szűrt —, de a tényt látni kell.
    config_enumeration_complete: configsComplete,
    // P1.1 — az offline business-láb állapota MINDIG látszik a napi sorban, akkor is,
    // ha nem termelt findinget. A puszta finding-szám félrevezet, ha a láb blokkolt
    // vagy még nem élesedett (UNARMED) — ugyanaz a tanulság, mint a cross-checknél.
    offline_legs_total: offlineReports.length,
    offline_legs_armed: offlineReports.filter((r) => r.state === 'ARMED').length,
    offline_legs_unarmed: offlineReports.filter((r) => r.state === 'UNARMED').length,
    offline_legs_blocked: blockedLegs.length,
    worst: summary.worst
  });

  if (
    summary.findings.length + crossFindings.length + businessFindings.length > 0 ||
    crossCheckFailed ||
    crossCheckNotRunning ||
    businessCheckFailed ||
    !configsComplete ||
    blockedLegs.length > 0
  ) {
    const criticalCount = summary.critical_count + crossCritical + businessCritical;
    const warningCount = summary.warning_count + crossWarning + businessWarning;
    const failNote = crossCheckFailed
      ? '<p><strong>⚠️ A cross-platform check ELDŐLT — a GA4/Google-Ads vs ledger összevetés (a Modell-2 böngésző/GTM-vakfolt monitora) MA NEM futott le. Ellenőrizd az analytics.readonly tokent / az API-státuszt.</strong></p>'
      : '';
    const notRunningNote = crossCheckNotRunning
      ? `<p><strong>⚠️ A cross-platform check NEM FUT — a Modell-2 böngésző/GTM-ág monitorozatlan.</strong>
           ${crossOutcome.configuredSites} / ${crossOutcome.totalSites} site-on van <code>recon</code> blokk${
             crossOutcome.ledgerUnavailable ? ', és a ledger-lekérdezés is elbukott' : ''
           }. Ez NEM azt jelenti, hogy nincs drift — azt, hogy nem néztük meg.
           Teendő: <code>recon.ga4_property_id</code> (numerikus GA4 property ID) és/vagy
           <code>recon.gads_onsite_actions</code> felvétele a SITE_CONFIG KV-be, majd — ha a
           GA4-leg 403-mal skippel — re-consent az <code>/api/event/oauth-init</code>-en
           (az <code>analytics.readonly</code> scope-hoz).</p>`
      : '';
    const skipNote =
      !crossCheckNotRunning && crossOutcome.skippedLegs.length > 0
        ? `<p>ℹ️ Részlegesen kimaradt cross-check legek: ${escapeHtml(
            crossOutcome.skippedLegs.map((l) => `${l.site_id}/${l.platform} (${l.reason})`).join(', ')
          )}. Ezek a legek MA nem adtak jelet — a hiányuk nem „tiszta".</p>`
        : '';
    const degradedConfigNote = configsComplete
      ? ''
      : `<p><strong>⚠️ DEGRADED: a SITE_CONFIG felsorolás NEM volt teljes.</strong>
           ${siteConfigs.length} site-config oldódott fel. A reconciliation emiatt NEM szűrt a
           <code>monitoring</code> flagre (a részlistából negatív következtetést levonni azt
           jelentené, hogy a fel nem oldott site-ok némán kiesnek a mérésből), és az offline
           lábak <code>blocked_by</code> állapota feloldatlan maradhatott. A mai riport tehát
           bővebb és kevésbé pontos a szokásosnál — nem szűkebb.</p>`;
    const businessFailNote = businessCheckFailed
      ? `<p><strong>⚠️ A CRM business-source check MA NEM FUTOTT LE (${escapeHtml(reconDay)}).</strong>
           A lekérdezés elbukott, vagy nincs D1 LEDGER, vagy a <code>0007</code> migráció nincs kint
           az éles adatbázison. Ez NEM azt jelenti, hogy nincs eltérés — azt, hogy nem néztük meg.
           Teendő: <code>npx wrangler d1 migrations apply event-gateway-ledger --remote</code>,
           majd ellenőrzés, hogy a <code>business_counts</code> tábla létezik.</p>`
      : '';
    const subjectSuffix = [
      crossCheckFailed ? ' + cross-check FAILED' : '',
      crossCheckNotRunning ? ' + cross-check NOT RUNNING' : '',
      businessCheckFailed ? ' + business-source NOT RUNNING' : ''
    ].join('');
    await sendAdminEmail(
      env,
      `Reconciliation drift: ${criticalCount} critical, ${warningCount} warning${subjectSuffix}`,
      failNote +
        notRunningNote +
        degradedConfigNote +
        businessFailNote +
        skipNote +
        buildDriftEmail(summary.findings, crossFindings, since) +
        buildOfflineSection(offlineReports) +
        buildBusinessSourceSection(businessFindings, reconDay),
      criticalCount > 0 || crossCheckFailed || businessCheckFailed ? 'critical' : 'warning'
    );
  }
}

/**
 * Az OFFLINE business-láb állapottáblája. Akkor is kimegy, ha nincs finding — a
 * blokkolt és a még nem élesedett (UNARMED) láb ugyanúgy „nulla konverzió", mint a
 * halott, csak MÁS a teendő. Enélkül a napi riport üres finding-listája
 * megkülönböztethetetlen lenne a „minden rendben"-től.
 */
/**
 * P1.2 — CRM business-source eltérések. Ezt a gateway-ledger SZERKEZETILEG nem tudja
 * kimutatni: ha a CRM→gateway hívás el sem indul, a ledgerben nulla elvárás mellett a
 * nulla kézbesítés egészségesnek látszik.
 */
function buildBusinessSourceSection(findings: BusinessSourceFinding[], date: string): string {
  if (findings.length === 0) return '';
  const rows = findings
    .map(
      (f) => `
      <tr>
        <td>${escapeHtml(f.site_id)}</td>
        <td>${escapeHtml(f.event_name)}</td>
        <td>${escapeHtml(f.kind)}</td>
        <td>${f.crm_count}</td>
        <td>${f.gateway_count}</td>
        <td><strong>${escapeHtml(f.severity)}</strong></td>
        <td>${escapeHtml(f.detail)}</td>
      </tr>`
    )
    .join('');
  return `
    <h3>CRM business-source (${escapeHtml(date)})</h3>
    <p>A CRM napi aggregátuma (PII-mentes darabszám) vs. a gateway-be TÉNYLEGESEN
       beérkezett lifecycle-státuszok. Az eltérés azt jelenti, hogy a CRM→gateway hívás
       el sem indult — ezt a ledger önmagában nem látja.
       A <code>business_source_missing</code> sor pedig azt, hogy MAGA a CRM-cron állt le.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Site</th><th>Event</th><th>Kind</th><th>CRM</th><th>Gateway</th>
            <th>Severity</th><th>Detail</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildOfflineSection(reports: OfflineLegReport[]): string {
  if (reports.length === 0) return '';
  const rows = reports
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.site_id)}</td>
        <td>${escapeHtml(r.event_name)}</td>
        <td><strong>${escapeHtml(r.state)}</strong>${r.blocked_by ? ` (${escapeHtml(r.blocked_by)})` : ''}</td>
        <td>${r.received}</td>
        <td>${r.expected}</td>
        <td>${r.delivered}</td>
        <td>${r.rejected}</td>
        <td>${r.last_successful_upload ? escapeHtml(r.last_successful_upload) : '—'}</td>
      </tr>`
    )
    .join('');
  return `
    <h3>Offline business-láb (CRM lifecycle → Google Ads / Data Manager)</h3>
    <p><strong>Expected</strong> = beérkezett − legitim policy-skip (consent-tiltás/visszavonás,
       nem-elvárt platform, régiós szabály, dedup). A config-/adatminőség-/transport-hibából
       eredő skip NEM vonódik le — az veszteség.</p>
    <p><strong>BLOCKED_DEPENDENCY</strong>: hiányzó előfeltétel (OAuth secret / refresh token /
       customer_id / conversion action) — a teendőt a health-check mondja meg, ezért innen
       NEM megy külön riasztás. <strong>UNARMED</strong>: még nincs bizonyított sikeres
       feltöltés, ezért a 24 órás regresszió-detektor nem alkalmazható (a 7 napos abszolút
       igen). <strong>ARMED</strong>: van bizonyított feltöltés, minden detektor él.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Site</th><th>Event</th><th>Állapot</th><th>Received</th><th>Expected</th>
            <th>Delivered</th><th>Rejected</th><th>Utolsó sikeres feltöltés</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildDriftEmail(
  findings: DriftFinding[],
  crossFindings: CrossCheckFinding[],
  since: string
): string {
  const rows = findings
    .map(
      (f) => `
      <tr>
        <td>${escapeHtml(f.site_id)}</td>
        <td>${escapeHtml(f.platform)}</td>
        <td>${escapeHtml(f.kind)}</td>
        <td><strong>${escapeHtml(f.severity)}</strong></td>
        <td>${escapeHtml(f.detail)}</td>
      </tr>`
    )
    .join('');
  const ledgerTable =
    findings.length > 0
      ? `
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Site</th><th>Platform</th><th>Kind</th><th>Severity</th><th>Detail</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
      : '<p>No ledger-internal drift.</p>';

  const crossRows = crossFindings
    .map(
      (f) => `
      <tr>
        <td>${escapeHtml(f.site_id)}</td>
        <td>${escapeHtml(f.platform)}</td>
        <td>${escapeHtml(f.event_name)}</td>
        <td>${f.ledger_count}</td>
        <td>${f.platform_count}</td>
        <td><strong>${escapeHtml(f.severity)}</strong></td>
      </tr>`
    )
    .join('');
  const crossTable =
    crossFindings.length > 0
      ? `
    <h3>Cross-platform (ledger vs GA4 / Google Ads, previous UTC day)</h3>
    <p>A böngésző/GTM-ág és a gateway más-más számot mér — valamelyik némán romlik.
       Időzóna- és consent-eredetű ±1-2 darabos zaj lehetséges; a nagy/ismétlődő eltérés a jel.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Site</th><th>Platform</th><th>Event</th><th>Ledger</th><th>Platform</th><th>Severity</th></tr>
      </thead>
      <tbody>${crossRows}</tbody>
    </table>`
      : '';

  return `
    <h2>Soborbo Tracking — Reconciliation Drift</h2>
    <p><strong>Window:</strong> last ${WINDOW_HOURS}h (since ${escapeHtml(since)})</p>
    ${ledgerTable}
    ${crossTable}
    <p><em>Runbook: docs/error-codes.md (TRK-950-*). Metrics: Analytics Engine index "reconciliation".</em></p>
  `;
}
