/**
 * Daily synthetic-lead smoke test — proves the WHOLE server chain without a human:
 * site worker cron → service binding → gateway authenticated ingress
 * (/api/event/conversion-server) → hash → Meta CAPI (TEST stream) → D1 ledger.
 *
 * Copy into `src/lib/tracking/smoke.ts` UNCHANGED, set the `TRACKING_SITE_ID`
 * worker var to the gateway `site_id`, and export a `scheduled()` from the
 * worker entry (see worker.ts next to this file). Then register the site in the
 * gateway's `SMOKE_SITES` var — the gateway's daily digest alarms when an
 * expected site has no fresh `smoke-*` ledger row, or when Meta REJECTED the
 * smoke event. That closes the loop: a dead cron, a broken token, a wiped var,
 * a Meta credential expiry — all surface within 24h.
 *
 * WHY THE SITE ID IS AN ENV VAR AND NOT A CONSTANT (6.14.0): a `const SITE =
 * 'REPLACE_ME'` placeholder meant every vendored copy had to be edited, so no
 * site's copy could ever be byte-identical to the canonical file — the
 * dist-manifest / check-vendored-copy drift audit showed every site as
 * "drifted" on this file, and a forgotten placeholder shipped a
 * `smoke-REPLACE_ME_SITE_ID-…` event_id (audit 2026-07-21, K2-L13). Read from
 * the env, the file is vendorable as-is, and a missing id is REFUSED loudly.
 *
 * Safety guarantees:
 *  - REFUSES to run unless TRACKING_SITE_ID is set (and is a sane slug): the
 *    event_id and the digest's SMOKE_SITES match both hang on it. No id, no send
 *    — the skip is LOUD (console.error) and the digest's missing-row alarm still
 *    fires, so a misconfigured smoke cannot rot silently.
 *  - REFUSES to run unless TRACKING_TEST_LEAD_EMAIL + TRACKING_TEST_EVENT_CODE are
 *    configured and resolvable — otherwise the synthetic event would land in the
 *    PRODUCTION Meta stream (the class of two past production Meta leaks). Same
 *    loud skip.
 *  - Deterministic daily event_id (`smoke-<site>-YYYYMMDD`): a double-fired cron
 *    is absorbed by the gateway's idempotency — no duplicate event.
 *  - lead_id reuses the smoke key → the ledger's lead-trail path is exercised,
 *    and smoke rows filter out of any audit via the `smoke-` prefix.
 */
import {
  sendGatewayConversion,
  resolveTestEventCode,
  type GatewayEnv,
} from './gateway-dispatch';

/**
 * The gateway `site_id` shape the smoke key can carry: the gateway's event_id
 * rule is `[A-Za-z0-9_-]`, max 40 chars, and `smoke-` + `-YYYYMMDD` already use
 * 15 of them. A value outside this would not be "a site with a typo" but a
 * 400 from the gateway on every run — refuse up front instead.
 */
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,25}$/;

/** Resolves the smoke site id from the env, or `undefined` (with a loud log) when unusable. */
export function resolveSmokeSiteId(env: GatewayEnv): string | undefined {
  const site = env.TRACKING_SITE_ID?.trim();
  if (!site) {
    console.error(
      '[smoke] skipped — TRACKING_SITE_ID not configured; set it to the gateway site_id ' +
        '(the same value registered in the gateway SMOKE_SITES var). Refusing to send a ' +
        'synthetic lead with no site identity.',
    );
    return undefined;
  }
  if (!SITE_ID_RE.test(site)) {
    console.error(
      `[smoke] skipped — TRACKING_SITE_ID ${JSON.stringify(site)} is not a valid site slug ` +
        '([A-Za-z0-9_-], max 25 chars); the gateway would reject the smoke event_id. Fix the var.',
    );
    return undefined;
  }
  return site;
}

/** `smoke-<site>-YYYYMMDD` — the deterministic daily smoke key (event_id AND lead_id). */
export function smokeEventId(site: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `smoke-${site}-${day}`;
}

export async function runDailySmokeLead(env: GatewayEnv): Promise<void> {
  const site = resolveSmokeSiteId(env);
  if (!site) return;

  const email = env.TRACKING_TEST_LEAD_EMAIL;
  const testEventCode = resolveTestEventCode(env, email);
  if (!email || !testEventCode) {
    console.error(
      '[smoke] skipped — TRACKING_TEST_LEAD_EMAIL / TRACKING_TEST_EVENT_CODE not configured; ' +
        'refusing to send a synthetic event that would land in the PRODUCTION Meta stream',
    );
    return;
  }

  const eventId = smokeEventId(site);

  const res = await sendGatewayConversion(env, {
    eventName: 'contact_form_submitted',
    eventId,
    leadId: eventId,
    source: 'daily_smoke',
    // Synthetic test persona (the keyed test address) — not real PII.
    userData: { email },
    // Explicit GRANTED: the gateway's require_consent gate would otherwise skip
    // the Meta leg and the smoke test would prove nothing.
    consent: {
      ad_user_data: 'GRANTED',
      ad_personalization: 'GRANTED',
      ad_storage: 'GRANTED',
      analytics_storage: 'GRANTED',
    },
    eventSourceUrl: `${env.SITE_URL || 'https://example.com'}/__smoke`,
    testEventCode,
  });

  if (res.ok) {
    console.log(JSON.stringify({ level: 'info', message: '[smoke] daily synthetic lead dispatched', event_id: eventId, status: res.status }));
  } else {
    console.error(JSON.stringify({ level: 'error', message: '[smoke] daily synthetic lead FAILED', event_id: eventId, status: res.status, error: res.error, attempts: res.attempts }));
  }
}
