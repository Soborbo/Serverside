import type { Env } from '../env';

export type MetricPlatform = 'meta' | 'ga4' | 'gads' | 'msads' | 'tiktok' | 'linkedin';

// Defensive clamp to prevent Analytics Engine cardinality explosion if any
// caller bypasses the upstream allowlist validation.
const MAX_BLOB_LENGTH = 64;

function clamp(s: string): string {
  return s.length > MAX_BLOB_LENGTH ? s.slice(0, MAX_BLOB_LENGTH) : s;
}

export function recordFanoutMetric(
  env: Env,
  data: {
    site_id: string;
    event_name: string;
    platform: MetricPlatform;
    success: boolean;
    duration_ms: number;
    error_code?: string;
  }
): void {
  if (!env.TRACKING_METRICS) return;
  try {
    env.TRACKING_METRICS.writeDataPoint({
      blobs: [clamp(data.site_id), clamp(data.event_name), data.platform, clamp(data.error_code || 'none')],
      doubles: [data.success ? 1 : 0, data.duration_ms],
      indexes: [clamp(data.site_id)]
    });
  } catch (err) {
    console.warn('Failed to record fan-out metric', err);
  }
}

/**
 * Reconciliation drift-finding observability-metrika. A napi recon-cron írja
 * minden drift-findinghez → Analytics Engine-ben lekérdezhető trend/alert
 * (site × platform × kind × severity), nem csak egyszeri email.
 */
export function recordReconciliationMetric(
  env: Env,
  data: {
    site_id: string;
    platform: MetricPlatform;
    kind: string;
    severity: 'warning' | 'critical';
    value: number;
  }
): void {
  if (!env.TRACKING_METRICS) return;
  try {
    env.TRACKING_METRICS.writeDataPoint({
      blobs: [clamp(data.site_id), data.platform, clamp(data.kind), data.severity],
      doubles: [data.severity === 'critical' ? 2 : 1, data.value],
      indexes: ['reconciliation']
    });
  } catch (err) {
    console.warn('Failed to record reconciliation metric', err);
  }
}

export function recordConversionMetric(
  env: Env,
  data: {
    hostname: string;
    site_id: string;
    event_name: string;
    accepted: boolean;
    error_code?: string;
    total_duration_ms: number;
  }
): void {
  if (!env.TRACKING_METRICS) return;
  try {
    env.TRACKING_METRICS.writeDataPoint({
      blobs: [clamp(data.site_id), clamp(data.hostname), clamp(data.event_name), clamp(data.error_code || 'none')],
      doubles: [data.accepted ? 1 : 0, data.total_duration_ms],
      indexes: ['conversion_total']
    });
  } catch (err) {
    console.warn('Failed to record conversion metric', err);
  }
}
