import type { Env } from '../env';

export type MetricPlatform = 'meta' | 'ga4' | 'gads';

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
      blobs: [data.site_id, data.event_name, data.platform, data.error_code || 'none'],
      doubles: [data.success ? 1 : 0, data.duration_ms],
      indexes: [data.site_id]
    });
  } catch (err) {
    console.warn('Failed to record fan-out metric', err);
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
      blobs: [data.site_id, data.hostname, data.event_name, data.error_code || 'none'],
      doubles: [data.accepted ? 1 : 0, data.total_duration_ms],
      indexes: ['conversion_total']
    });
  } catch (err) {
    console.warn('Failed to record conversion metric', err);
  }
}
