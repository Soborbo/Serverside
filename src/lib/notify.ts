import { EmailMessage } from 'cloudflare:email';
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

export async function sendCriticalSMS(env: Env, message: string): Promise<void> {
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
