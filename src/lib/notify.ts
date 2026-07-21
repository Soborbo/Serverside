import { EmailMessage } from 'cloudflare:email';
import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY } from './error-codes';

// FIGYELEM — mindkét cím `@soborbo.co.uk`, NEM `.com`. Két külön kényszer:
//
//  FROM: a Cloudflare `send_email` binding KIZÁRÓLAG a fiók ROUTING-domainjeiről
//    tud küldeni. A soborbo.co.uk ilyen (MX = route{1,2,3}.mx.cloudflare.net);
//    a soborbo.com nincs is ezen a Cloudflare-fiókon. A korábbi
//    `tracking-alerts@soborbo.com` FROM-mal minden riasztás CSENDBEN elbukott
//    volna (a send() dob, a catch lelogolja, és senki nem kap levelet).
//
//  TO: a binding `destination_address`-e ehhez a címhez van pinelve
//    (wrangler.toml), és a Cloudflare csak VERIFIKÁLT destination address-re
//    küld. Ha ezt átírod, a wrangler.toml-t is írd át — különben a send() dob.
const ALERT_FROM = 'tracking-alerts@soborbo.co.uk';
const ADMIN_EMAIL = 'laszlo@soborbo.co.uk';
const MESSAGE_ID_HOST = 'soborbo.co.uk';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// A fejléc-szekció RFC 5322 szerint CSAK ASCII lehet. A subject viszont hordozhat
// site-nevet és magyar hibaszöveget, ezért a nem-ASCII subject RFC 2047 encoded-word
// formában megy ki. Nyers 8-bites fejléctől a send() dob.
function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${toBase64(new TextEncoder().encode(s))}?=`;
}

// A törzs UTF-8, de a nyers 8-bites törzs nem legális 8BITMIME nélkül — base64-ben
// megy ki, 76 karakteres sorokra tördelve (RFC 2045).
function encodeBody(s: string): string {
  const b64 = toBase64(new TextEncoder().encode(s));
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

/**
 * @returns true, ha a binding elfogadta a levelet. FIGYELEM: ez „átvéve", nem
 * „kézbesítve" — de a false már biztosan baj. A hívók zöme figyelmen kívül hagyja
 * (egy elbukott riasztás ne döntse el a konverziós utat); a /admin/test-alert
 * viszont ezt jelenti vissza, hogy a lánc ne tudjon csendben hazudni.
 */
export async function sendAdminEmail(
  env: Env,
  subject: string,
  bodyHtml: string,
  level: 'critical' | 'warning' | 'info' = 'warning'
): Promise<boolean> {
  if (!env.ADMIN_EMAIL) {
    logStructured({
      level: 'warn',
      message: 'ADMIN_EMAIL binding not configured',
      subject
    });
    return false;
  }

  const fullSubject = `[${level.toUpperCase()}] ${subject}`;
  try {
    // A Cloudflare send_email binding teljes, RFC 5322-konform üzenetet vár. A
    // MIME-Version / Message-ID / Date hiánya miatt a send() dobott, a catch pedig
    // elnyelte — így MINDEN riasztás csendben elveszett.
    const raw = [
      `From: ${ALERT_FROM}`,
      `To: ${ADMIN_EMAIL}`,
      `Subject: ${encodeSubject(fullSubject)}`,
      `Message-ID: <${crypto.randomUUID()}@${MESSAGE_ID_HOST}>`,
      `Date: ${rfc5322Date(new Date())}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(bodyHtml)
    ].join('\r\n');

    const msg = new EmailMessage(ALERT_FROM, ADMIN_EMAIL, raw);
    await env.ADMIN_EMAIL.send(msg);

    logStructured({
      level: 'info',
      message: 'Admin email sent',
      subject: fullSubject
    });
    return true;
  } catch (err) {
    logStructured({
      level: 'error',
      message: 'Failed to send admin email',
      subject: fullSubject,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

export async function sendCriticalSMS(env: Env, message: string): Promise<void> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    logStructured({
      level: 'warn',
      message: 'Twilio not configured, skipping SMS alert'
    });
    return;
  }
  // A célszám secretből jön (wrangler secret put ADMIN_PHONE, E.164 formátum) —
  // a korábbi hardcoded placeholder (+447XXXXXXXXX) miatt MINDEN kritikus SMS
  // csendben elbukott a Twilio-nál, hiába voltak a Twilio-secretek beállítva.
  if (!env.ADMIN_PHONE) {
    logStructured({
      level: 'warn',
      message: 'ADMIN_PHONE not configured, skipping SMS alert'
    });
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const formData = new URLSearchParams();
    formData.set('From', env.TWILIO_FROM_NUMBER);
    formData.set('To', env.ADMIN_PHONE);
    formData.set('Body', message.slice(0, 160));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
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

/**
 * Riasztás-throttling: azonos (errorCode, site) riasztás legfeljebb ablakonként
 * egyszer megy ki. Enélkül egy TARTÓS hiba leadenként küldene emailt+SMS-t (egy
 * lejárt Meta-token minden konverzióra), az SLO-check pedig 30 percenként
 * újraküldené ugyanazt a „dead records" levelet — akár 90 napig, több ezer levél.
 *
 * A throttle-state a meglévő OAUTH_TOKENS KV-ben él (külön `alert-throttle:` prefix
 * + expirationTtl) — nincs új binding, nincs deploy-kockázat. KV-hiba/hiány esetén
 * NEM throttle-özünk: egy riasztást elküldeni akkor is jobb, mint némán elnyelni.
 * A get→put nem atomi (KV eventual consistency); egy burst elején átcsúszhat pár
 * duplikátum, de a leadenkénti több ezres áradatot néhány darabra vágja.
 */
const ALERT_THROTTLE_WINDOW_SEC = 3600; // 1 óra

/**
 * Throttle-primitív: `true` = MEHET (az adott kulcs nem szólalt meg az ablakban),
 * `false` = ELNYOMVA. A state a meglévő OAUTH_TOKENS KV-ben, `alert-throttle:`
 * prefixen. KV-hiba/hiány → `true` (inkább szóljon, mint hogy némán elnyeljük).
 * A get→put nem atomi (KV eventual consistency) — burst elején átcsúszhat pár
 * duplikátum, de a tartós áradatot ablakonként egyre vágja. A slo-check DLQ/dead
 * riasztásai is EZT hívják (azok sendAdminEmail-en mennek, nem sendAlert-en).
 */
export async function throttleOncePer(env: Env, key: string, windowSec: number): Promise<boolean> {
  const kv = env.OAUTH_TOKENS;
  if (!kv) return true;
  const k = `alert-throttle:${key}`;
  try {
    if (await kv.get(k)) return false;
    await kv.put(k, new Date().toISOString(), { expirationTtl: windowSec });
    return true;
  } catch {
    return true;
  }
}

async function alertThrottled(
  env: Env,
  errorCode: TrackingErrorCode,
  siteId: string
): Promise<boolean> {
  return !(await throttleOncePer(env, `${errorCode}:${siteId}`, ALERT_THROTTLE_WINDOW_SEC));
}

export async function sendAlert(
  env: Env,
  errorCode: TrackingErrorCode,
  context: Record<string, unknown> = {}
): Promise<void> {
  const severity = ERROR_SEVERITY[errorCode] || 'warning';
  const siteId = (context.site_id as string) || (context.hostname as string) || 'global';
  if (await alertThrottled(env, errorCode, siteId)) {
    logStructured({
      level: 'info',
      message: 'Alert suppressed — throttled (same errorCode+site within window)',
      error_code: errorCode,
      site_id: siteId
    });
    return;
  }
  const description = ERROR_DESCRIPTIONS[errorCode] || 'Unknown error';

  const subject = `${errorCode}: ${description.slice(0, 80)}`;
  const bodyHtml = `
    <h2>${errorCode}</h2>
    <p><strong>${description}</strong></p>
    <h3>Context</h3>
    <pre>${escapeHtml(JSON.stringify(context, null, 2))}</pre>
    <p><em>Severity: ${severity}</em></p>
    <p>Runbook: see docs/error-codes.md</p>
  `;

  await sendAdminEmail(env, subject, bodyHtml, severity);

  if (severity === 'critical') {
    const siteId = (context.site_id as string) || (context.hostname as string) || 'unknown';
    await sendCriticalSMS(env, `[${severity.toUpperCase()}] ${errorCode} on ${siteId}. Check email.`);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
