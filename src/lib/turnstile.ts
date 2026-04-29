import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  valid: boolean;
  errorCodes?: string[];
}

export async function validateTurnstile(
  token: string | undefined,
  remoteIp: string | undefined,
  env: Env
): Promise<TurnstileResult> {
  if (!token) {
    return { valid: false, errorCodes: ['missing_token'] };
  }

  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  if (remoteIp) {
    formData.append('remoteip', remoteIp);
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      logStructured({
        level: 'warn',
        error_code: TrackingErrorCode.TURNSTILE_API_UNAVAILABLE,
        message: ERROR_DESCRIPTIONS[TrackingErrorCode.TURNSTILE_API_UNAVAILABLE],
        status: response.status
      });
      return failOpenOrClosed(env);
    }

    const result = (await response.json()) as { success: boolean; 'error-codes'?: string[] };
    return {
      valid: result.success === true,
      errorCodes: result['error-codes'] || []
    };
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.TURNSTILE_API_UNAVAILABLE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.TURNSTILE_API_UNAVAILABLE],
      error: err instanceof Error ? err.message : String(err)
    });
    return failOpenOrClosed(env);
  }
}

function failOpenOrClosed(env: Env): TurnstileResult {
  if (env.TURNSTILE_FAILOPEN === '1') {
    return { valid: true, errorCodes: ['service_unavailable_failopen'] };
  }
  return { valid: false, errorCodes: ['service_unavailable'] };
}
