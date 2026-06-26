import type { Env } from '../env';
import { sendAdminEmail, sendCriticalSMS } from '../lib/notify';
import { countSiteConfigs } from '../lib/config';
import { logStructured } from '../types';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 10; // 10 × 1000 = 10K records sample window

function isDeadKey(key: string): boolean {
  const segments = key.split('/');
  return segments.length >= 4 && segments[2] === 'dead';
}

async function countDlqRecords(env: Env): Promise<{ pending: number; dead: number; truncated: boolean }> {
  let pending = 0;
  let dead = 0;
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const list = await env.DEAD_LETTER.list({ cursor, limit: PAGE_LIMIT });
    for (const obj of list.objects) {
      if (isDeadKey(obj.key)) dead++;
      else pending++;
    }
    if (!list.truncated) break;
    cursor = list.cursor;
    pages++;
  }
  if (pages >= MAX_PAGES) truncated = true;
  return { pending, dead, truncated };
}

export async function handleSloCheck(env: Env): Promise<void> {
  const siteCount = await countSiteConfigs(env);
  const { pending: pendingCount, dead: deadCount, truncated } = await countDlqRecords(env);

  const truncNote = truncated ? ` (≥${MAX_PAGES * PAGE_LIMIT} — list truncated)` : '';

  if (pendingCount > 500 || truncated) {
    await sendCriticalSMS(env, `DLQ critical: ${pendingCount}${truncNote} pending events`);
    await sendAdminEmail(
      env,
      `DLQ Critical: ${pendingCount}${truncNote} events`,
      `
        <h2>DLQ Critical</h2>
        <p>Pending DLQ records: ${pendingCount}${truncNote}</p>
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

  if (deadCount > 0) {
    await sendAdminEmail(
      env,
      `Dead records: ${deadCount}`,
      `
        <p>Records exceeded max retries: ${deadCount}</p>
        <p>Permanently lost unless manually reprocessed.</p>
      `,
      'warning'
    );
  }

  logStructured({
    level: 'info',
    message: 'SLO check completed',
    sites_count: siteCount,
    dlq_pending: pendingCount,
    dlq_dead: deadCount,
    dlq_list_truncated: truncated
  });
}
