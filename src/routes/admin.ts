import type { Env } from '../env';
import { logStructured } from '../types';
import { authenticateAdmin } from '../lib/admin-auth';
import { getSiteConfig, listMonitoredSiteConfigsWithCompleteness } from '../lib/config';
import { getAccessToken } from '../lib/gads-oauth';
import { getLeadTrail, isValidLeadId, markDoNotReplay } from '../lib/ledger';
import { fetchReconInputs, summarize, DEFAULT_THRESHOLDS } from '../lib/reconciliation';
import {
  listPendingRetries,
  deleteDeadLetter,
  type DeadLetterRecord
} from '../lib/deadletter';
import { retrySingle, isRealRetrySuccess, recordRetryDelivery } from '../scheduled/retry';
import { sendAdminEmail } from '../lib/notify';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from '../lib/error-codes';

/**
 * Admin read/ops API — a meglévő X-Admin-Token mögött. Ez a backend a korábban
 * elhalasztott P2 tételekhez (#4 replay, #18 admin UI, #19 onboarding validator),
 * és ez a réteg, amit egy esetleges ops-MCP vékonyan körbecsomagolhat.
 *
 * Útvonalak (mind /api/event/admin/* alatt — a meglévő zone-route lefedi):
 *   GET  /api/event/admin/reconciliation[?hours=24]
 *   GET  /api/event/admin/leads/:lead_id
 *   POST /api/event/admin/dlq/replay   { key? | site_id?, max?, discard? }
 *   GET  /api/event/admin/health-check
 *
 * Minden mutáló művelet (replay/discard) auditálható: a fan-out/retry a ledgerbe
 * ír, így bizonyítható, ki mit replay-elt. A health-check SOHA nem ad vissza
 * secret-értéket, csak jelenlét/hiány boolean-t.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname;

  const limiter = env.ADMIN_LIMITER || env.INGEST_LIMITER;
  if (limiter) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    try {
      const { success } = await limiter.limit({ key: `admin:${ip}` });
      if (!success) {
        logStructured({
          level: 'warn',
          error_code: TrackingErrorCode.ADMIN_UNAUTHORIZED,
          message: 'Admin API rate limited',
          hostname,
          path: url.pathname
        });
        return json({ error: 'rate_limited' }, 429);
      }
    } catch {
      // fail-open — a limiter hibája nem blokkolhatja az admin-ops-ot.
    }
  }

  if (!authenticateAdmin(request, env)) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.ADMIN_UNAUTHORIZED,
      message: 'Admin API request failed authentication',
      hostname,
      path: url.pathname
    });
    return json({ error: 'unauthorized' }, 401);
  }

  const path = url.pathname.replace(/^\/api\/event\/admin\//, '');

  if (request.method === 'GET' && path === 'reconciliation') {
    return handleReconReport(request, env);
  }
  if (request.method === 'GET' && path.startsWith('leads/')) {
    return handleLeadTrail(env, hostname, decodeURIComponent(path.slice('leads/'.length)));
  }
  if (request.method === 'POST' && path === 'dlq/replay') {
    return handleDlqReplay(request, env, ctx);
  }
  if (request.method === 'GET' && path === 'health-check') {
    return handleHealthCheck(env, hostname);
  }
  if (request.method === 'POST' && path === 'test-alert') {
    return handleTestAlert(env);
  }
  if (request.method === 'GET' && path === 'consent-stats') {
    return handleConsentStats(env, hostname);
  }

  return json({ error: 'not_found' }, 404);
}

// ── GET /admin/consent-stats ─────────────────────────────────────────────────
async function handleConsentStats(env: Env, hostname: string): Promise<Response> {
  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) return json({ error: 'no_site_config', hostname }, 404);
  if (!env.LEDGER) return json({ error: 'no_ledger_binding' }, 503);

  try {
    const [decisions, agreement, shown] = await Promise.all([
      env.LEDGER.prepare(
        `SELECT banner_version, decision, COUNT(*) AS n
           FROM consent_log
          WHERE site_id = ?1 AND server_received_at >= datetime('now', '-30 days')
          GROUP BY banner_version, decision
          ORDER BY banner_version, decision`
      )
        .bind(siteConfig.site_id)
        .all(),
      env.LEDGER.prepare(
        `SELECT COUNT(*) AS comparable,
                SUM(CASE WHEN cky_agreement = 1 THEN 1 ELSE 0 END) AS agreed
           FROM consent_log
          WHERE site_id = ?1 AND cky_agreement IS NOT NULL
            AND server_received_at >= datetime('now', '-30 days')`
      )
        .bind(siteConfig.site_id)
        .first<{ comparable: number; agreed: number }>(),
      env.LEDGER.prepare(
        `SELECT banner_version,
                COUNT(*) AS shown,
                SUM(CASE WHEN interaction_ms IS NOT NULL THEN 1 ELSE 0 END) AS decided,
                AVG(interaction_ms) AS avg_interaction_ms
           FROM consent_metrics
          WHERE site_id = ?1 AND shown_at >= datetime('now', '-30 days')
          GROUP BY banner_version`
      )
        .bind(siteConfig.site_id)
        .all()
    ]);

    const comparable = agreement?.comparable ?? 0;
    return json({
      site_id: siteConfig.site_id,
      window_days: 30,
      consent_provider: siteConfig.consent?.provider ?? 'cookieyes',
      decisions: decisions.results ?? [],
      cky_agreement: {
        comparable,
        agreed: agreement?.agreed ?? 0,
        rate: comparable > 0 ? (agreement!.agreed ?? 0) / comparable : null
      },
      banner_impressions: shown.results ?? []
    }, 200);
  } catch (err) {
    return json(
      { error: 'query_failed', detail: err instanceof Error ? err.message : String(err) },
      500
    );
  }
}

// ── POST /admin/test-alert ───────────────────────────────────────────────────
async function handleTestAlert(env: Env): Promise<Response> {
  if (!env.ADMIN_EMAIL) {
    return json({ error: 'no_email_binding', detail: 'ADMIN_EMAIL send_email binding not bound' }, 503);
  }
  const stamp = new Date().toISOString();
  const accepted = await sendAdminEmail(
    env,
    `Test alert — alerting chain is alive (${stamp})`,
    `<h2>Test alert</h2>
     <p>Ha ezt olvasod, a riasztási lánc <strong>működik</strong>: Worker →
     Cloudflare Email Routing → a postafiókod.</p>
     <p>Ugyanezen az úton érkezik a napi digest, a „zero conversions" riasztás és a
     konverzió-spike riasztás.</p>
     <p><em>Kiküldve: ${stamp}</em></p>`,
    'info'
  );

  if (!accepted) {
    return json(
      {
        sent: false,
        at: stamp,
        detail: 'send_email binding rejected the message — see Workers logs for the throw'
      },
      502
    );
  }
  return json({ sent: true, at: stamp, note: 'Binding accepted it. Confirm arrival in the inbox.' }, 200);
}

// ── GET /admin/reconciliation ────────────────────────────────────────────────
async function handleReconReport(request: Request, env: Env): Promise<Response> {
  const hoursRaw = parseInt(new URL(request.url).searchParams.get('hours') || '24', 10);
  const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 168) : 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let siteConfigs: Awaited<ReturnType<typeof listMonitoredSiteConfigsWithCompleteness>>['configs'] = [];
  let configsComplete = false;
  try {
    const listed = await listMonitoredSiteConfigsWithCompleteness(env);
    siteConfigs = listed.configs;
    configsComplete = listed.complete;
  } catch {
    // már logolva a config-rétegben
  }
  const inputs = await fetchReconInputs(env, since, siteConfigs, configsComplete);
  if (inputs === null) {
    return json({ error: 'ledger_unavailable', detail: 'No D1 LEDGER binding or query failed' }, 503);
  }
  const summary = summarize(inputs, DEFAULT_THRESHOLDS);
  return json(
    { window_hours: hours, since, config_enumeration_complete: configsComplete, summary, sites: inputs },
    200
  );
}

// ── GET /admin/leads/:lead_id ────────────────────────────────────────────────
async function handleLeadTrail(env: Env, hostname: string, leadId: string): Promise<Response> {
  if (!isValidLeadId(leadId)) {
    return json({ error: 'invalid_lead_id' }, 400);
  }
  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) return json({ error: 'not_configured' }, 404);

  const trail = await getLeadTrail(env, siteConfig.site_id, leadId);
  if (trail === null) {
    return json({ error: 'ledger_unavailable' }, 503);
  }
  const found = trail.events.length + trail.deliveries.length + trail.lead_status.length > 0;
  return json({ site_id: siteConfig.site_id, lead_id: leadId, found, trail }, 200);
}

// ── POST /admin/dlq/replay ───────────────────────────────────────────────────
interface DlqReplayBody {
  key?: string;
  site_id?: string;
  max?: number;
  discard?: boolean;
}

async function handleDlqReplay(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let body: DlqReplayBody;
  try {
    body = (await request.json()) as DlqReplayBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (typeof body.key === 'string') {
    const key = body.key;
    if (body.discard === true) {
      const obj = await env.DEAD_LETTER.get(key);
      let flagged = false;
      if (obj) {
        try {
          const record = (await obj.json()) as DeadLetterRecord;
          flagged = await markDoNotReplay(
            env,
            record.site_id,
            String(record.event_payload.event_name ?? ''),
            String(record.event_payload.event_id ?? '')
          );
        } catch {
          // corrupt rekord → csak törlés
        }
      }
      await deleteDeadLetter(env, key);
      logStructured({
        level: 'info',
        message: 'Admin DLQ discard (do-not-replay)',
        r2_key: key,
        do_not_replay_flagged: flagged
      });
      return json({ action: 'discard', key, ok: true, do_not_replay_flagged: flagged }, 200);
    }

    const obj = await env.DEAD_LETTER.get(key);
    if (!obj) return json({ error: 'key_not_found', key }, 404);
    let record: DeadLetterRecord;
    try {
      record = (await obj.json()) as DeadLetterRecord;
    } catch {
      return json({ error: 'corrupt_record', key }, 422);
    }
    const result = await retrySingle(env, record);
    const ok = isRealRetrySuccess(result);
    if (ok) {
      await recordRetryDelivery(env, record, result);
      await deleteDeadLetter(env, key);
    }
    logStructured({
      level: 'info',
      message: 'Admin DLQ single replay',
      r2_key: key,
      platform: record.platform,
      site_id: record.site_id,
      success: ok,
      skipped: result.skipped === true
    });
    return json(
      { action: 'replay', key, replayed: ok ? 1 : 0, succeeded: ok, skipped: result.skipped === true },
      200
    );
  }

  const max = Number.isFinite(body.max as number)
    ? Math.min(Math.max(body.max as number, 1), 100)
    : 50;
  const sitePrefix = typeof body.site_id === 'string' && body.site_id ? `${body.site_id}/` : undefined;
  let pending: { key: string; record: DeadLetterRecord }[];
  try {
    ({ pending } = await listPendingRetries(env, sitePrefix, max));
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.DLQ_LIST_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.DLQ_LIST_FAILED],
      error: err instanceof Error ? err.message : String(err)
    });
    return json({ error: 'dlq_list_failed' }, 503);
  }

  let succeeded = 0;
  let failed = 0;
  for (const { key, record } of pending) {
    try {
      const result = await retrySingle(env, record);
      if (isRealRetrySuccess(result)) {
        await recordRetryDelivery(env, record, result);
        await deleteDeadLetter(env, key);
        succeeded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  logStructured({
    level: 'info',
    message: 'Admin DLQ bulk replay',
    site_id: body.site_id,
    attempted: pending.length,
    succeeded,
    failed
  });
  void ctx;
  return json({ action: 'replay', attempted: pending.length, succeeded, failed }, 200);
}

// ── GET /admin/health-check ──────────────────────────────────────────────────
type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

async function handleHealthCheck(env: Env, hostname: string): Promise<Response> {
  const siteConfig = await getSiteConfig(hostname, env);
  if (!siteConfig) {
    return json(
      { hostname, overall: 'FAIL', checks: [{ name: 'site_config', status: 'FAIL', detail: 'No KV config for hostname' }] },
      404
    );
  }

  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  add('site_config', 'PASS', `site_id=${siteConfig.site_id}, country=${siteConfig.country_code}`);

  const meta = siteConfig.meta;
  if (!meta) {
    add(
      'meta_config',
      'WARN',
      'no meta block — a Meta CAPI leg is SKIPPED (add pixel_id + access_token to KV to enable it; no redeploy needed)'
    );
  } else {
    add('meta_pixel_id', meta.pixel_id ? 'PASS' : 'FAIL', present(meta.pixel_id));
    add('meta_access_token', meta.access_token ? 'PASS' : 'FAIL', present(meta.access_token));
    add(
      'meta_test_event_code',
      meta.test_event_code ? 'WARN' : 'PASS',
      meta.test_event_code
        ? 'test_event_code SET — prod konverziók a Test stream-be mennek (CLAUDE.md 17)'
        : 'absent (correct for production)'
    );
  }

  add(
    'ga4_config',
    !siteConfig.ga4
      ? 'SKIP'
      : siteConfig.ga4.measurement_id && siteConfig.ga4.api_secret
        ? 'PASS'
        : 'FAIL',
    !siteConfig.ga4
      ? 'omitted — GA4 MP disabled for this site (browser GA4 only)'
      : `measurement_id=${present(siteConfig.ga4.measurement_id)}, api_secret=${present(siteConfig.ga4.api_secret)}`
  );

  // Az explicit elvárás a configtól FÜGGETLEN truth. Ha offline gads elvárt, a
  // customer_id eltűnése maga a money-path kiesés; nem lehet WARN csak azért, mert
  // a hiányzó config miatt a későbbi OAuth-ág már nem fut le.
  const offlineExplicitlyExpected =
    (siteConfig.expected_platforms?.offline ?? []).includes('gads');

  if (siteConfig.gads?.customer_id) {
    const actions = siteConfig.gads.conversion_actions;
    add(
      'gads_conversion_actions',
      actions && Object.keys(actions).length > 0 ? 'PASS' : 'WARN',
      actions ? `${Object.keys(actions).length} action(s) mapped` : 'no conversion_actions map'
    );

    const missingOAuthSecrets: string[] = [];
    if (!env.GADS_OAUTH_CLIENT_ID) missingOAuthSecrets.push('GADS_OAUTH_CLIENT_ID');
    if (!env.GADS_OAUTH_CLIENT_SECRET) missingOAuthSecrets.push('GADS_OAUTH_CLIENT_SECRET');

    const offlineExpected =
      Boolean(actions && Object.keys(actions).length > 0) || offlineExplicitlyExpected;
    const moneyPathNote = offlineExpected
      ? ' — OFFLINE MONEY PATH DOWN: ez a site vár Google Ads offline feltöltést'
      : '';

    add(
      'gads_oauth_secrets',
      missingOAuthSecrets.length === 0 ? 'PASS' : offlineExpected ? 'FAIL' : 'WARN',
      missingOAuthSecrets.length === 0
        ? 'GADS_OAUTH_CLIENT_ID + GADS_OAUTH_CLIENT_SECRET present'
        : `MISSING worker secret(s): ${missingOAuthSecrets.join(', ')}${moneyPathNote}. ` +
          'Re-running the OAuth flow does NOT fix this — set them on the worker first ' +
          '(client id: wrangler.toml [vars]; secret: `wrangler secret put GADS_OAUTH_CLIENT_SECRET`).' +
          (offlineExpected
            ? ''
            : ' NOT site-level RED: this site has no offline conversion action and does not list ' +
              "'gads' under expected_platforms.offline, so its Google Ads conversions are browser-owned " +
              '(AWCT/EC) and do not depend on the gateway OAuth. Only the reconciliation GAQL leg is affected.')
    );

    add(
      'gads_developer_token',
      env.GADS_DEVELOPER_TOKEN ? 'PASS' : 'WARN',
      env.GADS_DEVELOPER_TOKEN
        ? 'present (reconciliation GAQL leg enabled)'
        : 'MISSING — the Data Manager UPLOAD is unaffected (it sends no developer-token header), ' +
          'but the daily reconciliation GAQL leg is blind without it'
    );

    try {
      const token = await getAccessToken(siteConfig.gads.customer_id, env);
      add(
        'gads_oauth',
        token ? 'PASS' : offlineExpected ? 'FAIL' : 'WARN',
        token
          ? 'access token obtained'
          : missingOAuthSecrets.length > 0
            ? `no access token — CAUSE IS THE MISSING WORKER SECRET (${missingOAuthSecrets.join(', ')}), not the customer's consent${moneyPathNote}`
            : `no access token — no refresh token stored for customer_id=${siteConfig.gads.customer_id}; run GET /api/event/oauth-init?customer_id=${siteConfig.gads.customer_id}${moneyPathNote}`
      );
    } catch (err) {
      logStructured({
        level: 'warn',
        message: 'health-check gads_oauth token fetch threw',
        site_id: siteConfig.site_id,
        error: err instanceof Error ? err.message : String(err)
      });
      add(
        'gads_oauth',
        offlineExpected ? 'FAIL' : 'WARN',
        `token fetch failed (see Worker logs)${moneyPathNote}`
      );
    }
  } else {
    add(
      'gads_customer_id',
      offlineExplicitlyExpected ? 'FAIL' : 'WARN',
      offlineExplicitlyExpected
        ? 'MISSING customer_id — OFFLINE MONEY PATH DOWN: expected_platforms.offline requires gads'
        : 'no customer_id — Google Ads offline dispatch is not configured for this site'
    );
  }

  add(
    'ledger_binding',
    env.LEDGER ? 'PASS' : 'WARN',
    env.LEDGER ? 'D1 LEDGER bound' : 'no D1 — ledger/idempotency/recon are no-op'
  );
  add(
    'require_consent',
    siteConfig.require_consent === true ? 'PASS' : 'WARN',
    siteConfig.require_consent === true
      ? 'fail-closed (EEA-safe)'
      : 'fail-open — EEA-site-on állítsd true-ra'
  );

  const overall: CheckStatus = checks.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.status === 'WARN')
      ? 'WARN'
      : 'PASS';

  return json({ site_id: siteConfig.site_id, hostname, overall, checks }, 200);
}

function present(v: unknown): string {
  return v ? 'present' : 'MISSING';
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
