import type { Env } from '../env';
import { sendAdminEmail } from '../lib/notify';
import { countSiteConfigs, listConfiguredSiteIds } from '../lib/config';
import { logStructured } from '../types';

/**
 * Site-onkénti elfogadott (ledger-be írt) event-szám az elmúlt 24 órából, a
 * konfigurált site-okkal összevetve. A visszaadott `zeroSites` = konfigurált,
 * de 0 elfogadott konverziójú site-ok — pont az a néma-kiesés jelzés, ami a
 * 2026-06-28→07-13 incidensnél hetekig hiányzott. LEDGER binding nélkül üres
 * eredményt ad (nincs mire riasztani).
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
      'SELECT site_id, COUNT(*) AS cnt FROM events_raw WHERE received_at >= ? GROUP BY site_id'
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

export async function handleDailyDigest(env: Env): Promise<void> {
  const siteCount = await countSiteConfigs(env);
  const { counts: acceptedCounts, zeroSites } = await collectAcceptedCounts(env);

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

  await sendAdminEmail(
    env,
    zeroSites.length > 0 ? `Daily Digest — ⚠️ zero conversions: ${zeroSites.join(', ')}` : 'Daily Digest',
    html,
    zeroSites.length > 0 ? 'warning' : 'info'
  );
}
