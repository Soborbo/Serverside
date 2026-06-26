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

  logStructured({
    level: 'info',
    message: 'Reconciliation completed',
    sites_checked: summary.sites_checked,
    warning_count: summary.warning_count,
    critical_count: summary.critical_count,
    worst: summary.worst
  });

  if (summary.findings.length > 0) {
    await sendAdminEmail(
      env,
      `Reconciliation drift: ${summary.critical_count} critical, ${summary.warning_count} warning`,
      buildDriftEmail(summary.findings, since),
      summary.worst === 'critical' ? 'critical' : 'warning'
    );
  }
}

function buildDriftEmail(findings: DriftFinding[], since: string): string {
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
  return `
    <h2>Soborbo Tracking — Reconciliation Drift</h2>
    <p><strong>Window:</strong> last ${WINDOW_HOURS}h (since ${escapeHtml(since)})</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Site</th><th>Platform</th><th>Kind</th><th>Severity</th><th>Detail</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p><em>Runbook: docs/error-codes.md (TRK-950-*). Metrics: Analytics Engine index "reconciliation".</em></p>
  `;
}
