import type { SiteConfig } from './config';
import type { SkipReason } from './skip-reason';
import type { HashedUserData } from './hash';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sanitizeErrorMessage } from './log-sanitize';

/**
 * LinkedIn Conversions API forwarder (TASK 3) — li_fat_id + hashed email.
 *
 * Endpoint: POST https://api.linkedin.com/rest/conversionEvents
 * Headers: Authorization Bearer, LinkedIn-Version, X-Restli-Protocol-Version 2.0.0.
 * Body: { conversion:<rule URN>, conversionHappenedAt:<ms>, conversionValue?,
 *   user:{ userIds:[ {idType:'SHA256_EMAIL',idValue}, {idType:'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID',idValue:li_fat_id} ] } }
 *
 * Consent: csak adAllowed esetén hívva. PII: SHA-256 email a HashedUserData-ból.
 * Config (access_token + az event_name-hez tartozó conversion rule) nélkül no-op.
 *
 * TODO(live): a payload a LinkedIn Conversions API doksi szerint épül, de élesben
 * NEM tesztelt (nincs access token). Élesítés előtt verifikáld a Campaign Manager
 * conversion-tracking nézetében.
 */

const LINKEDIN_URL = 'https://api.linkedin.com/rest/conversionEvents';
const LINKEDIN_TIMEOUT_MS = 5000;
const DEFAULT_VERSION = '202401';

export interface LinkedInPayload {
  event_name: string;
  event_time: number; // unix seconds
  value?: number;
  currency?: string;
  li_fat_id?: string;
  // Megosztott event_id (CLAUDE.md #16) → LinkedIn `eventId` dedup-kulcs. Enélkül
  // egy DLQ-retry egy kétes kimenetelű (timeout utáni) hívás után duplán számolna.
  event_id?: string;
}

export interface LinkedInResult {
  success: boolean;
  error?: string;
  error_code?: TrackingErrorCode;
  status?: number;
  skipped?: boolean;
  // Miért maradt ki — lásd lib/skip-reason.ts. A fan-out ez alapján dönt DLQ-ról.
  skip_reason?: SkipReason;
}

export async function sendToLinkedIn(
  siteConfig: SiteConfig,
  payload: LinkedInPayload,
  hashedUserData: HashedUserData
): Promise<LinkedInResult> {
  const cfg = siteConfig.linkedin;
  const conversionUrn = cfg?.conversion_rules?.[payload.event_name];
  if (!cfg || !cfg.access_token || !conversionUrn) {
    return { success: true, skipped: true, skip_reason: 'not_configured' };
  }

  const userIds: Record<string, string>[] = [];
  if (hashedUserData.em) userIds.push({ idType: 'SHA256_EMAIL', idValue: hashedUserData.em });
  if (payload.li_fat_id) {
    userIds.push({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: payload.li_fat_id });
  }
  if (userIds.length === 0) {
    // Nincs egyetlen matchelhető azonosító sem → ne küldjünk üres konverziót.
    return { success: true, skipped: true };
  }

  const body: Record<string, unknown> = {
    conversion: conversionUrn,
    conversionHappenedAt: payload.event_time * 1000, // ms
    user: { userIds }
  };
  // Idempotency: a LinkedIn az eventId-n dedup-ol — retry-biztos újraküldés.
  if (payload.event_id) body.eventId = payload.event_id;
  if (typeof payload.value === 'number' && payload.value > 0 && payload.currency) {
    body.conversionValue = { currencyCode: payload.currency, amount: payload.value.toFixed(2) };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LINKEDIN_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    // TODO(live): UNVERIFIED against the live LinkedIn API (no access token).
    const response = await fetch(LINKEDIN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.access_token}`,
        'LinkedIn-Version': cfg.api_version || DEFAULT_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const msg = sanitizeErrorMessage(text);
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.LINKEDIN_DISPATCH_FAILED,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.LINKEDIN_DISPATCH_FAILED],
        site_id: siteConfig.site_id,
        event_name: payload.event_name,
        status: response.status,
        linkedin_error: msg,
        duration_ms: Date.now() - startedAt
      });
      return { success: false, error_code: TrackingErrorCode.LINKEDIN_DISPATCH_FAILED, error: msg, status: response.status };
    }

    logStructured({
      level: 'info',
      message: 'LinkedIn conversion forwarded',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      duration_ms: Date.now() - startedAt
    });
    return { success: true, status: response.status };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorCode = isTimeout
      ? TrackingErrorCode.LINKEDIN_API_TIMEOUT
      : TrackingErrorCode.LINKEDIN_DISPATCH_FAILED;
    logStructured({
      level: 'warn',
      error_code: errorCode,
      message: ERROR_DESCRIPTIONS[errorCode],
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
      duration_ms: Date.now() - startedAt
    });
    return { success: false, error_code: errorCode, error: isTimeout ? 'timeout' : String(err) };
  }
}
