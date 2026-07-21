import type { Env } from '../env';
import { logStructured } from '../types';
import { sendAdminEmail, escapeHtml } from '../lib/notify';
import { recordReconciliationMetric } from '../lib/metrics';
import { TrackingErrorCode } from '../lib/error-codes';
import {
  fetchReconInputs,
  summarize,
  DEFAULT_THRESHOLDS,
  type DriftKind,
  type DriftFinding
} from '../lib/reconciliation';
import { runCrossPlatformCheck, type CrossCheckFinding } from '../lib/cross-check';
import { listMonitoredSiteConfigs } from '../lib/config';
import type { MetricPlatform } from '../lib/metrics';

const WINDOW_HOURS = 24;

const KIND_ERROR_CODE: Record<DriftKind, TrackingErrorCode> = {
  vendor_failure_rate: TrackingErrorCode.RECON_VENDOR_FAILURE_RATE,
  coverage_drift: TrackingErrorCode.RECON_COVERAGE_DRIFT
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

  const inputs = await fetchReconInputs(env, since);
  if (inputs === null) return; // query failed (already logged)
  const summary = summarize(inputs, DEFAULT_THRESHOLDS);

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
      severity: f.severity
    });
    recordReconciliationMetric(env, {
      site_id: f.site_id,
      platform: f.platform as MetricPlatform,
      kind: f.kind,
      severity: f.severity,
      value: f.value
    });
  }

  // 3. ellenőrzés (2026-07-16 audit): ledger ↔ GA4 ↔ Google Ads kereszt-
  // egyeztetés a TEGNAPI teljes UTC-napra. A ledger-belső recon szerkezetileg
  // nem látja, ha a böngésző/GTM-ág romlik el (Modell 2) — ez a check pont azt
  // fogja meg. Hibatűrő: bármely leg query-hibája logolt skip, a cron nem dől el.
  let crossFindings: CrossCheckFinding[] = [];
  // Ha a cross-check ELDŐL (lejárt analytics.readonly scope, API 5xx, visszavont
  // token), az NEM „nincs drift" — a Modell-2 böngésző/GTM-vakfolt egyetlen monitora
  // sötétbe borul. Enélkül a flag nélkül egy tiszta ledger-nap mellett NEM ment volna
  // email, és a „Reconciliation completed" log cross_platform_findings:0-t írt volna —
  // megkülönböztethetetlenül a „minden rendben"-től.
  let crossCheckFailed = false;
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const siteConfigs = await listMonitoredSiteConfigs(env);
    crossFindings = await runCrossPlatformCheck(env, siteConfigs, yesterday);
  } catch (err) {
    crossCheckFailed = true;
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_CROSS_QUERY_FAILED,
      message: 'Cross-platform reconciliation threw',
      error: err instanceof Error ? err.message : String(err)
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

  const crossCritical = crossFindings.filter((f) => f.severity === 'critical').length;
  const crossWarning = crossFindings.length - crossCritical;

  logStructured({
    level: 'info',
    message: 'Reconciliation completed',
    sites_checked: summary.sites_checked,
    warning_count: summary.warning_count + crossWarning,
    critical_count: summary.critical_count + crossCritical,
    cross_platform_findings: crossFindings.length,
    worst: summary.worst
  });

  if (summary.findings.length + crossFindings.length > 0 || crossCheckFailed) {
    const criticalCount = summary.critical_count + crossCritical;
    const warningCount = summary.warning_count + crossWarning;
    const failNote = crossCheckFailed
      ? '<p><strong>⚠️ A cross-platform check ELDŐLT — a GA4/Google-Ads vs ledger összevetés (a Modell-2 böngésző/GTM-vakfolt monitora) MA NEM futott le. Ellenőrizd az analytics.readonly tokent / az API-státuszt.</strong></p>'
      : '';
    await sendAdminEmail(
      env,
      `Reconciliation drift: ${criticalCount} critical, ${warningCount} warning${crossCheckFailed ? ' + cross-check FAILED' : ''}`,
      failNote + buildDriftEmail(summary.findings, crossFindings, since),
      criticalCount > 0 || crossCheckFailed ? 'critical' : 'warning'
    );
  }
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
