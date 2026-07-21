import type { Env } from '../env';
import { logStructured } from '../types';
import { authenticateAdmin } from '../lib/admin-auth';
import { getSiteConfig } from '../lib/config';
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

  // Defense-in-depth a token brute-force ellen: IP-kulcsos throttle az auth
  // ELŐTT, hogy egy próbálkozó ne tudjon korlátlan tokent végigpróbálni. Külön
  // ADMIN_LIMITER budget, fallback INGEST_LIMITER; binding nélkül kimarad.
  // Fail-open: limiter-hiba nem zárhatja ki a legitim admin-műveletet.
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

  return json({ error: 'not_found' }, 404);
}

// ── POST /admin/test-alert ───────────────────────────────────────────────────
/**
 * Kiküld egy próba-riasztást az ADMIN_EMAIL bindingen. Azért van, mert a
 * riasztási lánc a legcsendesebben romló dolog az egész rendszerben: a
 * `sendAdminEmail` MINDEN hibát elnyel (catch + log), tehát egy rossz FROM-cím
 * vagy egy nem verifikált destination úgy néz ki, mintha minden rendben lenne —
 * egészen addig, amíg egy VALÓDI incidensnél nem érkezik meg a levél.
 * (Pontosan ez állt fenn: a FROM `@soborbo.com` volt, ami nincs is a fiókon.)
 *
 * Ez a végpont teszi a láncot bármikor ellenőrizhetővé, deploy nélkül.
 */
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

  // A binding elutasítása (nem verifikált destination, rossz MIME) NEM mehet
  // `sent: true`-ként vissza — pont ez a csendes hiba, amit ez a végpont keres.
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
  // „Átvéve", nem „kézbesítve" — a végső bizonyíték továbbra is a beérkezett levél.
  return json({ sent: true, at: stamp, note: 'Binding accepted it. Confirm arrival in the inbox.' }, 200);
}

// ── GET /admin/reconciliation ────────────────────────────────────────────────
async function handleReconReport(request: Request, env: Env): Promise<Response> {
  const hoursRaw = parseInt(new URL(request.url).searchParams.get('hours') || '24', 10);
  const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 168) : 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const inputs = await fetchReconInputs(env, since);
  if (inputs === null) {
    return json({ error: 'ledger_unavailable', detail: 'No D1 LEDGER binding or query failed' }, 503);
  }
  const summary = summarize(inputs, DEFAULT_THRESHOLDS);
  return json({ window_hours: hours, since, summary, sites: inputs }, 200);
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
  const found =
    trail.events.length + trail.deliveries.length + trail.lead_status.length > 0;
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

  // Egy konkrét record kulcs szerint: replay VAGY discard (= do-not-replay).
  if (typeof body.key === 'string') {
    const key = body.key;
    if (body.discard === true) {
      // A do_not_replay flag a D1 idempotency táblában a valós elnyomó — az R2
      // objektum törlése önmagában NEM akadályozná meg, hogy egy duplikátum vagy
      // re-ingest újra fan-outoljon. Előbb kiolvassuk a rekordot a flaghez.
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
          // corrupt rekord → csak törlés (nincs mit flagelni)
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
    // Skip-siker (épp hiányzó platform-config) NEM kézbesítés: a rekordot NEM
    // töröljük — különben a replay „sikere" az event egyetlen példányát
    // semmisítené meg, miközben vendor-hívás nem történt.
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

  // Bulk replay (opcionálisan site_id prefixre szűrve).
  const max = Number.isFinite(body.max as number) ? Math.min(Math.max(body.max as number, 1), 100) : 50;
  // Segment-prefix (`site_id/`), NEM substring — különben a `site_id: "a"`
  // minden olyan tenant rekordját listázná, amelynek id-je `a`-val kezdődik.
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

// ── GET /admin/health-check (onboarding validator #19) ───────────────────────
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
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  add('site_config', 'PASS', `site_id=${siteConfig.site_id}, country=${siteConfig.country_code}`);

  // Meta (opcionális blokk — a site be lehet kötve, mielőtt a CAPI access token
  // elkészül; ilyenkor a Meta-láb tisztán kimarad, lásd config.ts `meta?`).
  const meta = siteConfig.meta;
  if (!meta) {
    // WARN, nem FAIL: a cső él és a ledger mér, de a Metához NEM megy konverzió.
    // Ez pontosan az az állapot, amit nem szabad „zöldnek" hinni.
    add(
      'meta_config',
      'WARN',
      'no meta block — a Meta CAPI leg is SKIPPED (add pixel_id + access_token to KV to enable it; no redeploy needed)'
    );
  } else {
    add('meta_pixel_id', meta.pixel_id ? 'PASS' : 'FAIL', present(meta.pixel_id));
    add('meta_access_token', meta.access_token ? 'PASS' : 'FAIL', present(meta.access_token));
    // CLAUDE.md 17: test_event_code prod-ban Test stream-be küld → csendes hiba.
    add(
      'meta_test_event_code',
      meta.test_event_code ? 'WARN' : 'PASS',
      meta.test_event_code
        ? 'test_event_code SET — prod konverziók a Test stream-be mennek (CLAUDE.md 17)'
        : 'absent (correct for production)'
    );
  }

  // GA4 (optional — a migration site may omit the ga4 block; the gateway then
  // skips the MP leg so its browser GA4 isn't double-counted).
  add(
    'ga4_config',
    !siteConfig.ga4 ? 'SKIP' : (siteConfig.ga4.measurement_id && siteConfig.ga4.api_secret ? 'PASS' : 'FAIL'),
    !siteConfig.ga4
      ? 'omitted — GA4 MP disabled for this site (browser GA4 only)'
      : `measurement_id=${present(siteConfig.ga4.measurement_id)}, api_secret=${present(siteConfig.ga4.api_secret)}`
  );

  // Google Ads (opcionális — customer_id nélkül a gads no-op). A `gads` blokk maga
  // is hiányozhat egy kézzel írt/migrációs configból (a KV JSON vakon SiteConfig-ra
  // castolódik); optional chaining nélkül ez TypeError→500-at adna pont az onboarding-
  // health-checkben, ami az ilyen hiányos site-okat hivatott diagnosztizálni.
  if (siteConfig.gads?.customer_id) {
    const actions = siteConfig.gads.conversion_actions;
    add(
      'gads_conversion_actions',
      actions && Object.keys(actions).length > 0 ? 'PASS' : 'WARN',
      actions ? `${Object.keys(actions).length} action(s) mapped` : 'no conversion_actions map'
    );
    try {
      const token = await getAccessToken(siteConfig.gads.customer_id, env);
      add('gads_oauth', token ? 'PASS' : 'FAIL', token ? 'access token obtained' : 'no access token (run OAuth flow)');
    } catch (err) {
      // Ne szivárogtassunk OAuth-belső hibaüzenetet a válaszba — logba megy.
      logStructured({
        level: 'warn',
        message: 'health-check gads_oauth token fetch threw',
        site_id: siteConfig.site_id,
        error: err instanceof Error ? err.message : String(err)
      });
      add('gads_oauth', 'FAIL', 'token fetch failed (see Worker logs)');
    }
  } else {
    add('gads_customer_id', 'WARN', 'no customer_id — Google Ads dispatch is a no-op for this site');
  }

  // Ledger + consent posture
  add('ledger_binding', env.LEDGER ? 'PASS' : 'WARN', env.LEDGER ? 'D1 LEDGER bound' : 'no D1 — ledger/idempotency/recon are no-op');
  add(
    'require_consent',
    siteConfig.require_consent === true ? 'PASS' : 'WARN',
    siteConfig.require_consent === true ? 'fail-closed (EEA-safe)' : 'fail-open — EEA-site-on állítsd true-ra'
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
