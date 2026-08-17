import type { Env } from '../env';
import { logStructured } from '../types';
import { sendAdminEmail, escapeHtml } from '../lib/notify';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';
import {
  runConsentCrossCheck,
  type ConsentCrossCheckSummary
} from '../lib/consent-crosscheck';

/**
 * Fázis D · S3 — napi consent-keresztellenőrzés (cron), a reconciliation mintájára.
 *
 * A TEGNAPI teljes UTC-napot nézi (a mai nap még nem zárt le, és a fél napból
 * számolt arány a baseline-hoz képest hamis elmozdulást adna).
 *
 * Riasztás: GRANTED-consent melletti skip (bármennyi), a `source_consistent=0`
 * arány elmozdulása a 7 napos átlaghoz képest, vagy elbukott lekérdezés-láb.
 * Egyébként NINCS levél — a napi „minden rendben" email két hét alatt zajjá
 * válna, és pont a jelet fedné el. A teljes összefoglaló MINDIG megy a
 * strukturált logba (Cloudflare felszedi), tehát a trend levél nélkül is látszik.
 */
export async function handleConsentCrossCheck(env: Env): Promise<void> {
  if (!env.LEDGER) {
    logStructured({
      level: 'info',
      message: 'Consent cross-check skipped — no D1 LEDGER binding'
    });
    return;
  }

  const date = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let summary: ConsentCrossCheckSummary | null = null;
  try {
    summary = await runConsentCrossCheck(env, date);
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.CONSENT_CROSS_CHECK_FAILED,
      message: 'Consent cross-check threw',
      date,
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }
  if (!summary) return;

  logStructured({
    level: summary.alert ? 'warn' : 'info',
    message: 'Consent cross-check completed',
    date,
    granted_but_skipped: summary.granted_but_skipped_total,
    inconsistent_rate: summary.inconsistent_rate,
    baseline_inconsistent_rate: summary.baseline_inconsistent_rate,
    inconsistent_rate_delta: summary.inconsistent_rate_delta,
    finding_counts: summary.finding_counts,
    null_sources: summary.null_sources,
    consent_debug_rows: summary.debug_rows,
    failed_legs: summary.failed_legs
  });

  // A 9-es rejtély minden egyes új darabja külön, kereshető sort kap.
  for (const row of summary.granted_skip_breakdown) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.CONSENT_GRANTED_BUT_SKIPPED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.CONSENT_GRANTED_BUT_SKIPPED],
      date,
      site_id: row.site_id,
      platform: row.platform,
      skip_reason: row.skip_reason,
      total: row.total
    });
  }

  if (!summary.alert) return;

  await sendAdminEmail(
    env,
    `Consent cross-check (${date}): ${summary.granted_but_skipped_total} GRANTED-but-skipped, source_consistent=0 rate ${fmtRate(summary.inconsistent_rate)}`,
    buildConsentEmail(date, summary),
    summary.granted_but_skipped_total > 0 ? 'critical' : 'warning'
  );
}

function fmtRate(r: number | null): string {
  return r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p>—</p>';
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table border="1" cellpadding="6" cellspacing="0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function buildConsentEmail(date: string, s: ConsentCrossCheckSummary): string {
  const reasons = s.alert_reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  return `
    <h2>Soborbo Tracking — Consent cross-check (Fázis D)</h2>
    <p><strong>Nap (UTC):</strong> ${escapeHtml(date)}</p>
    <h3>Miért szól</h3>
    <ul>${reasons}</ul>

    <h3>1. GRANTED consent melletti skipek</h3>
    <p>Ilyen sornak nem szabadna léteznie — ez a 9-es rejtély követése.
       A <code>(unnamed)</code> ok a 0004 migráció előtti sorokat jelöli.</p>
    ${table(
      ['Site', 'Platform', 'Skip reason', 'Darab'],
      s.granted_skip_breakdown.map((r) => [r.site_id, r.platform, r.skip_reason, String(r.total)])
    )}

    <h3>2. TRK-910 megállapítások (site × client_lib_version)</h3>
    <p>Ha a -003/-005/-006 dominál, a saját bekötéseink csúsznak szét (A kimenetel:
       nem épül CMP). Ha a süti maga hordoz rossz állapotot konzisztens lib mellett,
       az a B kimenetel.</p>
    ${table(
      ['Kód', 'Site', 'client_lib_version', 'Darab'],
      s.finding_counts.map((r) => [r.error_code, r.site_id, r.client_lib_version, String(r.total)])
    )}

    <h3>3. Forrás-konzisztencia</h3>
    <p>Ma: <strong>${fmtRate(s.inconsistent_rate)}</strong> ·
       7 napos átlag: ${fmtRate(s.baseline_inconsistent_rate)} ·
       eltérés: ${s.inconsistent_rate_delta === null ? 'n/a' : (s.inconsistent_rate_delta * 100).toFixed(1) + ' pp'}</p>

    <h3>4. NULL-forrás mintázat (betöltési verseny trendje)</h3>
    <p>A NULL azt jelenti, hogy az a forrás NEM VOLT ELÉRHETŐ. Ha az API-oszlop
       tartósan magas a süti mellett, az a betöltési verseny.</p>
    ${table(
      ['Site', 'cookie NULL', 'api NULL', 'server NULL', 'Összes receipt'],
      s.null_sources.map((r) => [
        r.site_id,
        String(r.cookie_null),
        String(r.api_null),
        String(r.server_null),
        String(r.total)
      ])
    )}

    <h3>5. consent_debug</h3>
    <p>${s.debug_rows} sor (14 nap után purge-ölődik).</p>
    ${
      s.failed_legs.length > 0
        ? `<p><strong>⚠️ Elbukott lekérdezés-lábak: ${escapeHtml(s.failed_legs.join(', '))} — ez VAKFOLT, nem „nincs jel".</strong></p>`
        : ''
    }
    <p><em>Runbook: docs/error-codes.md (TRK-910-*).</em></p>
  `;
}
