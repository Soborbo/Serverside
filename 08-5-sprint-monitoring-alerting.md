# Sprint 8.5 — Monitoring, SLO mérés, automatikus admin email/SMS alerting

**Cél:** Cloudflare Workers Analytics Engine + Grafana Cloud dashboard + email/SMS alerts. SLO-k konkrét számokkal. Daily digest email.

**Idő Claude Code-dal:** 10-15 óra. **MIELŐTT** a Sprint 9 (Painless production) deploy.

## SLO definíciók

| SLO | Cél | Window |
|---|---|---|
| Worker availability | 99.9% | 30 nap |
| Conversion fan-out success per platform | ≥98% | 24 óra |
| End-to-end latency p95 | <250 ms | 1 óra |
| DLQ growth rate (normál működés) | <5 events/óra | 1 óra |
| OAuth token refresh success | 100% | 24 óra |
| Painless conversion volume drop | <50% drop vs 7d-rolling | 30 perc |

## Mielőtt nekiállsz

### 1. Wrangler config

```toml
[[analytics_engine_datasets]]
binding = "TRACKING_METRICS"

[[send_email]]
name = "ADMIN_EMAIL"
destination_address = "laszlo@soborbo.com"

[triggers]
crons = [
  "0 8 * * *",        # Daily digest at 8 AM GMT
  "*/30 * * * *",     # SLO check every 30 min
  "0 * * * *"         # DLQ retry every hour (Sprint 8)
]
```

### 2. Cloudflare Email Routing

Cloudflare dashboard → Email → Email Routing → Add destination → `laszlo@soborbo.com`.

### 3. Twilio (opcionális, kritikus SMS-ekhez)

```bash
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_FROM_NUMBER
```

### 4. Grafana Cloud

grafana.com → Free tier signup. Connect Cloudflare Analytics Engine data source.

## Új fájl: `src/lib/metrics.ts`

```typescript
import type { Env } from '../env';

export function recordFanoutMetric(
  env: Env,
  data: {
    site_id: string;
    event_name: string;
    platform: 'meta' | 'ga4' | 'gads';
    success: boolean;
    duration_ms: number;
    error_code?: string;
  }
): void {
  try {
    env.TRACKING_METRICS.writeDataPoint({
      blobs: [data.site_id, data.event_name, data.platform, data.error_code || 'none'],
      doubles: [data.success ? 1 : 0, data.duration_ms],
      indexes: [data.site_id]
    });
  } catch (err) {
    console.warn('Failed to record metric', err);
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
  try {
    env.TRACKING_METRICS.writeDataPoint({
      blobs: [data.site_id, data.hostname, data.event_name, data.error_code || 'none'],
      doubles: [data.accepted ? 1 : 0, data.total_duration_ms],
      indexes: ['conversion_total']
    });
  } catch (err) {
    console.warn('Failed to record metric', err);
  }
}
```

## Új fájl: `src/lib/notify.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY } from './error-codes';

const ALERT_FROM = 'tracking-alerts@soborbo.com';
const ADMIN_EMAIL = 'laszlo@soborbo.com';
const ADMIN_PHONE = '+447XXXXXXXXX';

export async function sendAdminEmail(
  env: Env,
  subject: string,
  bodyHtml: string,
  level: 'critical' | 'warning' | 'info' = 'warning'
): Promise<void> {
  if (!env.ADMIN_EMAIL) {
    logStructured({
      level: 'warn',
      message: 'ADMIN_EMAIL binding not configured',
      subject
    });
    return;
  }

  try {
    const fullSubject = `[${level.toUpperCase()}] ${subject}`;
    const raw =
      `From: ${ALERT_FROM}\r\n` +
      `To: ${ADMIN_EMAIL}\r\n` +
      `Subject: ${fullSubject}\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
      bodyHtml;

    // @ts-ignore — EmailMessage is a Cloudflare Workers global
    const msg = new EmailMessage(ALERT_FROM, ADMIN_EMAIL, raw);
    await env.ADMIN_EMAIL.send(msg);

    logStructured({
      level: 'info',
      message: 'Admin email sent',
      subject: fullSubject
    });
  } catch (err) {
    logStructured({
      level: 'error',
      message: 'Failed to send admin email',
      subject,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function sendCriticalSMS(
  env: Env,
  message: string
): Promise<void> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    logStructured({
      level: 'warn',
      message: 'Twilio not configured, skipping SMS alert'
    });
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const formData = new URLSearchParams();
    formData.set('From', env.TWILIO_FROM_NUMBER);
    formData.set('To', ADMIN_PHONE);
    formData.set('Body', message.slice(0, 160));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    if (!response.ok) {
      throw new Error(`Twilio returned ${response.status}`);
    }
  } catch (err) {
    logStructured({
      level: 'error',
      message: 'Failed to send SMS alert',
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function sendAlert(
  env: Env,
  errorCode: TrackingErrorCode,
  context: Record<string, unknown> = {}
): Promise<void> {
  const severity = ERROR_SEVERITY[errorCode] || 'warning';
  const description = ERROR_DESCRIPTIONS[errorCode] || 'Unknown error';

  const subject = `${errorCode}: ${description.slice(0, 80)}`;
  const bodyHtml = `
    <h2>${errorCode}</h2>
    <p><strong>${description}</strong></p>
    <h3>Context</h3>
    <pre>${JSON.stringify(context, null, 2)}</pre>
    <p><em>Severity: ${severity}</em></p>
    <p>Runbook: <a href="https://github.com/Soborbo/claudeskills/blob/main/tracking-kit/docs/error-codes.md">View runbook</a></p>
  `;

  await sendAdminEmail(env, subject, bodyHtml, severity);

  if (severity === 'critical') {
    await sendCriticalSMS(env, `[${severity.toUpperCase()}] ${errorCode} on ${context.site_id || context.hostname || 'unknown'}. Check email.`);
  }
}
```

## Új fájl: `src/scheduled/daily-digest.ts`

```typescript
import type { Env } from '../env';
import { sendAdminEmail } from '../lib/notify';
import { logStructured } from '../types';

export async function handleDailyDigest(env: Env): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const sites = await env.SITE_CONFIG.list({ limit: 100 });

  let totalDlqRecords = 0;
  let totalDeadRecords = 0;
  try {
    const dlqList = await env.DEAD_LETTER.list({ limit: 1000 });
    totalDlqRecords = dlqList.objects.filter(o => !o.key.includes('/dead/')).length;
    totalDeadRecords = dlqList.objects.filter(o => o.key.includes('/dead/')).length;
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Daily digest: failed to count DLQ',
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const html = `
    <h2>Soborbo Tracking — Daily Digest</h2>
    <p><strong>Period:</strong> Last 24h (since ${since})</p>

    <h3>Active sites</h3>
    <p>${sites.keys.length} sites configured</p>

    <h3>Dead Letter Queue</h3>
    <ul>
      <li>Pending retries: ${totalDlqRecords}</li>
      <li>Dead (max retries reached): ${totalDeadRecords}</li>
    </ul>

    <h3>Action items</h3>
    ${totalDeadRecords > 0
      ? `<p><strong>⚠️ ${totalDeadRecords} dead records require manual intervention.</strong></p>`
      : `<p>✓ No dead records.</p>`
    }
    ${totalDlqRecords > 50
      ? `<p><strong>⚠️ DLQ pending records elevated.</strong></p>`
      : ''
    }

    <p><em>For detailed metrics: <a href="https://soborbo.grafana.net">Grafana dashboard</a></em></p>
  `;

  await sendAdminEmail(env, 'Daily Digest', html, 'info');
}
```

## Új fájl: `src/scheduled/slo-check.ts`

```typescript
import type { Env } from '../env';
import { sendAdminEmail, sendCriticalSMS } from '../lib/notify';
import { logStructured } from '../types';

export async function handleSloCheck(env: Env): Promise<void> {
  const sites = await env.SITE_CONFIG.list({ limit: 100 });
  const dlqList = await env.DEAD_LETTER.list({ limit: 1000 });

  // SLO 1: DLQ size
  const pendingCount = dlqList.objects.filter(o => !o.key.includes('/dead/')).length;
  if (pendingCount > 500) {
    await sendCriticalSMS(env, `DLQ critical: ${pendingCount} pending events`);
    await sendAdminEmail(env, `DLQ Critical: ${pendingCount} events`, `
      <h2>DLQ Critical</h2>
      <p>Pending DLQ records: ${pendingCount}</p>
      <p>Suggests platform-wide failures. Investigate immediately.</p>
    `, 'critical');
  } else if (pendingCount > 100) {
    await sendAdminEmail(env, `DLQ Elevated: ${pendingCount} events`, `
      <p>Pending DLQ: ${pendingCount} (warning >100)</p>
      <p>Cron retry should clear in 1-2 hours.</p>
    `, 'warning');
  }

  // SLO 2: dead/ count
  const deadCount = dlqList.objects.filter(o => o.key.includes('/dead/')).length;
  if (deadCount > 0) {
    await sendAdminEmail(env, `Dead records: ${deadCount}`, `
      <p>Records exceeded max retries: ${deadCount}</p>
      <p>Permanently lost unless manually reprocessed.</p>
      <p>Check: <code>wrangler r2 object list soborbo-tracking-dlq --prefix=*/[*]/dead/</code></p>
    `, 'warning');
  }

  logStructured({
    level: 'info',
    message: 'SLO check completed',
    sites_count: sites.keys.length,
    dlq_pending: pendingCount,
    dlq_dead: deadCount
  });
}
```

## Módosítandó fájlok

### `src/env.ts`

```typescript
export interface Env {
  // ... existing
  TRACKING_METRICS: AnalyticsEngineDataset;  // ÚJ
  ADMIN_EMAIL: SendEmail;                     // ÚJ

  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
}
```

### `src/worker.ts`

```typescript
import { handleScheduledRetry } from './scheduled/retry';
import { handleDailyDigest } from './scheduled/daily-digest';
import { handleSloCheck } from './scheduled/slo-check';

export default {
  async fetch(request, env, ctx) { /* ... */ },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    if (cron === '0 8 * * *') {
      ctx.waitUntil(handleDailyDigest(env));
    } else if (cron === '*/30 * * * *') {
      ctx.waitUntil(handleSloCheck(env));
    } else if (cron === '0 * * * *') {
      ctx.waitUntil(handleScheduledRetry(event, env));
    }
  }
};
```

### `src/routes/conversion.ts`

A fan-out kódot bővítjük metrics + alerting hívásokkal:

```typescript
import { recordFanoutMetric, recordConversionMetric } from '../lib/metrics';
import { sendAlert } from '../lib/notify';
import { TrackingErrorCode } from '../lib/error-codes';

// ... fan-out kód végén:

ctx.waitUntil(
  Promise.allSettled([metaPromise, ga4Promise, gadsPromise]).then(async (results) => {
    const [metaResult, ga4Result, gadsResult] = results;

    // Record metrics
    recordFanoutMetric(env, {
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      platform: 'meta',
      success: metaResult.status === 'fulfilled' && metaResult.value.success,
      duration_ms: metaDuration
    });
    // (same for ga4 and gads)

    // Critical alerts
    if (metaResult.status === 'fulfilled' && metaResult.value.error?.includes('Invalid OAuth')) {
      await sendAlert(env, TrackingErrorCode.META_INVALID_ACCESS_TOKEN, {
        site_id: siteConfig.site_id,
        event_name: payload.event_name
      });
    }
    if (gadsResult.status === 'fulfilled' && !gadsResult.value.success && gadsResult.value.status === 401) {
      await sendAlert(env, TrackingErrorCode.GADS_AUTH_REJECTED, {
        site_id: siteConfig.site_id,
        customer_id: siteConfig.gads.customer_id
      });
    }

    // ... DLQ writes ...
  })
);

recordConversionMetric(env, {
  hostname,
  site_id: siteConfig.site_id,
  event_name: payload.event_name,
  accepted: true,
  total_duration_ms: Date.now() - startedAt
});
```

## Grafana Cloud setup

Grafana Cloud-ban hozz létre dashboard panel-okat:

### Panel 1: Per-site fan-out success rate

```sql
SELECT
  blob1 AS site_id,
  blob3 AS platform,
  SUM(double1) / COUNT(*) AS success_rate
FROM TRACKING_METRICS
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY blob1, blob3
```

### Panel 2: Latency p50/p95/p99

```sql
SELECT
  blob3 AS platform,
  quantile(0.5)(double2) AS p50,
  quantile(0.95)(double2) AS p95,
  quantile(0.99)(double2) AS p99
FROM TRACKING_METRICS
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY blob3
```

### Panel 3: Conversion volume (line chart, 7d)

```sql
SELECT
  toDate(timestamp) AS day,
  blob1 AS site_id,
  COUNT(*) AS conversions
FROM TRACKING_METRICS
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND index1 = 'conversion_total'
GROUP BY day, site_id
```

### Panel 4: Top error codes

```sql
SELECT blob4 AS error_code, COUNT(*) AS count
FROM TRACKING_METRICS
WHERE blob4 != 'none' AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY error_code ORDER BY count DESC LIMIT 10
```

## Grafana Alert rules

| Alert | Trigger | Action |
|---|---|---|
| Meta success rate <95% | 5 perc folyamatos | Email |
| Google Ads success rate <95% | 5 perc folyamatos | Email |
| OAuth refresh failure | bármilyen | Email + SMS |
| Painless conversion drop >50% (vs 7d) | 30 perc | Email + SMS |
| Worker error rate >1% | 10 perc | Email |
| DLQ size >100 | 30 perc | Email |
| DLQ size >500 | bármilyen | Email + SMS |

## Manuális tesztelés

### A. Force critical error
1. KV-ban Painless `meta.access_token` = `INVALID_TOKEN`
2. Trigger conversion request
3. Email érkezik: `[CRITICAL] TRK-600-004 ...`
4. SMS érkezik (ha Twilio konfigurálva)

### B. Daily digest
```bash
wrangler triggers cron "0 8 * * *"
```
Email subject `[INFO] Daily Digest`.

### C. SLO check
Töltsd fel R2-be 150 fake DLQ recordot, várj 30 percet → email `[WARNING] DLQ Elevated`.

## Sprint 8.5 utáni státusz

- ✅ Cloudflare Workers Analytics Engine
- ✅ Email alert minden critical error-ra
- ✅ SMS alert (opcionális Twilio)
- ✅ Daily digest 8 GMT
- ✅ SLO check 30 percenként
- ✅ Grafana Cloud dashboard
- ✅ Runbook link minden alert-ben

## Mit KÉRDEZZ a usertől

1. Email Routing setup és destination beállítva?
2. Twilio account létrehozva (vagy SMS-t kihagyjuk)?
3. Grafana Cloud account regisztrálva, dashboard betöltve?
4. Force critical error tesztelve, email + SMS megérkezett?
5. Daily digest első trigger megérkezett?
