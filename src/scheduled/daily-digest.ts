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
    totalDlqRecords = dlqList.objects.filter((o) => !o.key.includes('/dead/')).length;
    totalDeadRecords = dlqList.objects.filter((o) => o.key.includes('/dead/')).length;
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
    ${
      totalDeadRecords > 0
        ? `<p><strong>⚠️ ${totalDeadRecords} dead records require manual intervention.</strong></p>`
        : `<p>✓ No dead records.</p>`
    }
    ${totalDlqRecords > 50 ? `<p><strong>⚠️ DLQ pending records elevated.</strong></p>` : ''}

    <p><em>For detailed metrics: Grafana dashboard</em></p>
  `;

  await sendAdminEmail(env, 'Daily Digest', html, 'info');
}
