import type { Env } from '../env';
import { sendAdminEmail, sendCriticalSMS } from '../lib/notify';
import { logStructured } from '../types';

export async function handleSloCheck(env: Env): Promise<void> {
  const sites = await env.SITE_CONFIG.list({ limit: 100 });
  const dlqList = await env.DEAD_LETTER.list({ limit: 1000 });

  const pendingCount = dlqList.objects.filter((o) => !o.key.includes('/dead/')).length;
  if (pendingCount > 500) {
    await sendCriticalSMS(env, `DLQ critical: ${pendingCount} pending events`);
    await sendAdminEmail(
      env,
      `DLQ Critical: ${pendingCount} events`,
      `
        <h2>DLQ Critical</h2>
        <p>Pending DLQ records: ${pendingCount}</p>
        <p>Suggests platform-wide failures. Investigate immediately.</p>
      `,
      'critical'
    );
  } else if (pendingCount > 100) {
    await sendAdminEmail(
      env,
      `DLQ Elevated: ${pendingCount} events`,
      `
        <p>Pending DLQ: ${pendingCount} (warning >100)</p>
        <p>Cron retry should clear in 1-2 hours.</p>
      `,
      'warning'
    );
  }

  const deadCount = dlqList.objects.filter((o) => o.key.includes('/dead/')).length;
  if (deadCount > 0) {
    await sendAdminEmail(
      env,
      `Dead records: ${deadCount}`,
      `
        <p>Records exceeded max retries: ${deadCount}</p>
        <p>Permanently lost unless manually reprocessed.</p>
        <p>Check: <code>wrangler r2 object list soborbo-tracking-dlq --prefix=*/[*]/dead/</code></p>
      `,
      'warning'
    );
  }

  logStructured({
    level: 'info',
    message: 'SLO check completed',
    sites_count: sites.keys.length,
    dlq_pending: pendingCount,
    dlq_dead: deadCount
  });
}
