import type { Env } from '../env';

/**
 * Token-less degraded mode (TASK 2) — Turnstile-failure resilience.
 *
 * Ha a kliens nem tud Turnstile tokent szerezni (Turnstile lassú/blokkolt/CSP),
 * a konverzió (köztük a phone — a #1 lead-jelzés) elveszhet. A gateway ezért
 * elfogadja a TOKEN-NÉLKÜLI, ALACSONY-KOCKÁZATÚ eventeket (tel:/mailto:/whatsapp
 * kattintások) degradált, rate-limitelt módban — miközben a token-nélküli
 * form-submitet (spam-felület) továbbra is keményen elutasítja.
 *
 * Megjegyzés: a kliensnek KÜLDENIE kell ezeket token nélkül (jelenleg skip-eli) —
 * ez kliens-oldali változás, lásd a PR jelentését. Ez a modul a gateway-oldali
 * felét adja: ha megérkezik egy token-nélküli low-risk event, feldolgozzuk.
 */

// tel:/mailto:/whatsapp kattintások — user-kezdeményezett, alacsony spam-érték.
// Kanonikus nevek (az ingress már normalizált ide a turnstile-ellenőrzés előtt).
// A callback_request_submitted + contact_form_submitted SZÁNDÉKOSAN kimarad
// (form = spam-felület).
export const DEGRADED_LOW_RISK_EVENTS: ReadonlySet<string> = new Set([
  'phone_number_clicked',
  'email_address_clicked',
  'whatsapp_button_clicked'
]);

/**
 * Eldönti, hogy egy sikertelen Turnstile-eredmény degradált elfogadásra
 * jogosult-e: csak ha az event low-risk ÉS a hiba token-szerzési hiba
 * (missing_token) VAGY a Turnstile-verify nem volt elérhető (service_unavailable).
 * Egy JELEN LÉVŐ, de érvénytelen token (invalid-input-response, bad-request) NEM
 * jogosít — az bot-jel, keményen elutasítjuk. Pure → tesztelhető.
 */
export function isTokenlessLowRiskAcceptable(
  turnstileCodes: string[] | undefined,
  eventName: string
): boolean {
  if (!DEGRADED_LOW_RISK_EVENTS.has(eventName)) return false;
  const codes = turnstileCodes || [];
  return codes.includes('missing_token') || codes.includes('service_unavailable');
}

/**
 * Degradált-módú rate limit. A DEGRADED_LIMITER bindinget használja (ajánlott
 * szűk budget, pl. 10/60s IP+host kulcsra); ha nincs bekötve, a felső szintű
 * INGEST_LIMITER-re támaszkodik (true-t ad vissza). Hiba esetén fail-open.
 */
export async function degradedRateLimit(env: Env, key: string): Promise<boolean> {
  const limiter = env.DEGRADED_LIMITER;
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}
