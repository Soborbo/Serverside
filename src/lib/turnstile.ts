import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';
import { sha256Hex } from './hash';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// A pozitív verdikt cache-TTL-je. A Turnstile token ~300s-ig él; a kliens 4 percig
// használja újra. 300s biztonságos: a kliens a token lejárta előtt úgyis frisset kér.
const VERDICT_TTL_SECONDS = 300;
// A definitív-invalid verdikt rövid TTL-je (spam-token újraellenőrzés elkerülése).
const INVALID_TTL_SECONDS = 60;
const VERDICT_PREFIX = 'tsv:';

export interface TurnstileResult {
  valid: boolean;
  errorCodes?: string[];
}

/**
 * Turnstile validáció token-verdikt cache-sel (TASK 1).
 *
 * A Turnstile token a /siteverify-nél SINGLE-USE: a 2. beváltás
 * `timeout-or-duplicate`-tal bukik. A kliens viszont 4 percig ÚJRAHASZNÁLJA
 * ugyanazt a tokent több dispatch-en át (calculator→form, phone→form). Ezért a
 * verdiktet tokenenként KV-be cache-eljük: az első kérés siteverify-ol és
 * elmenti a verdiktet, a többi a cache-ből szolgál ki → nincs 403, nincs
 * konverzió-vesztés.
 *
 * Bot-védelem: minden token PONTOSAN egyszer ellenőrződik Cloudflare-nél, és csak
 * a SAJÁT korábban validált tokenjeinket fogadjuk el újra. A maradék eset a
 * `timeout-or-duplicate` cache-MISS-en (KV-késés/cross-colo): default lenient
 * (elfogadjuk — a "duplicate" bizonyítja, hogy a token valódi volt), `TURNSTILE_STRICT=1`
 * esetén elutasítjuk. Lásd env.ts.
 *
 * Cache binding (`TURNSTILE_CACHE`) nélkül a régi per-request viselkedés marad.
 */
export async function validateTurnstile(
  token: string | undefined,
  remoteIp: string | undefined,
  env: Env
): Promise<TurnstileResult> {
  if (!token) {
    return { valid: false, errorCodes: ['missing_token'] };
  }

  const cache = env.TURNSTILE_CACHE;
  let key: string | undefined;
  if (cache) {
    key = VERDICT_PREFIX + (await sha256Hex(token)).slice(0, 40);
    try {
      const cached = await cache.get(key);
      if (cached === 'valid') return { valid: true, errorCodes: ['cache_hit'] };
      if (cached === 'invalid') return { valid: false, errorCodes: ['cache_hit_invalid'] };
    } catch {
      // KV-olvasási hiba → cache-miss-ként kezeljük (siteverify dönt).
    }
  }

  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  if (remoteIp) {
    formData.append('remoteip', remoteIp);
  }

  let result: { success: boolean; 'error-codes'?: string[] };
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

    result = (await response.json()) as { success: boolean; 'error-codes'?: string[] };
  } catch (err) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.TURNSTILE_API_UNAVAILABLE,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.TURNSTILE_API_UNAVAILABLE],
      error: err instanceof Error ? err.message : String(err)
    });
    return failOpenOrClosed(env);
  }

  const codes = result['error-codes'] || [];

  if (result.success === true) {
    await cacheVerdict(cache, key, 'valid', VERDICT_TTL_SECONDS);
    return { valid: true, errorCodes: codes };
  }

  // success:false — definitív Cloudflare-elutasítás.
  const duplicate = codes.includes('timeout-or-duplicate');
  if (duplicate && env.TURNSTILE_STRICT !== '1') {
    // Lenient (default): a token valódi volt, csak már beváltották (legit
    // újrahasználat, amit a cache KV-késés miatt nem fogott el). Elfogadjuk és
    // cache-eljük, hogy a további újrahasználat gyors legyen.
    await cacheVerdict(cache, key, 'valid', VERDICT_TTL_SECONDS);
    logStructured({
      level: 'info',
      message: 'Turnstile token reused (timeout-or-duplicate) accepted — lenient posture',
      cache_present: Boolean(cache)
    });
    return { valid: true, errorCodes: ['reused_token_accepted'] };
  }

  // Nem cache-eljük invalidként a duplicate-et (lehet, hogy egy racing legit
  // kérés tokenje); csak a tényleges, nem-duplicate elutasítást.
  if (!duplicate) {
    await cacheVerdict(cache, key, 'invalid', INVALID_TTL_SECONDS);
  }
  return { valid: false, errorCodes: codes };
}

async function cacheVerdict(
  cache: KVNamespace | undefined,
  key: string | undefined,
  verdict: 'valid' | 'invalid',
  ttl: number
): Promise<void> {
  if (!cache || !key) return;
  try {
    await cache.put(key, verdict, { expirationTtl: ttl });
  } catch {
    // A cache-írás best-effort; hiba esetén a validáció eredménye nem változik.
  }
}

function failOpenOrClosed(env: Env): TurnstileResult {
  if (env.TURNSTILE_FAILOPEN === '1') {
    return { valid: true, errorCodes: ['service_unavailable_failopen'] };
  }
  return { valid: false, errorCodes: ['service_unavailable'] };
}
