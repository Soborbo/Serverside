/**
 * P5.2 — fetch/XHR submit-út: `submit → backend → siker-kontraktus → commit`,
 * mind UGYANABBAN a dokumentumban.
 *
 * MIÉRT EGYSZERŰBB, MINT A NAVIGÁCIÓS ÚT. Itt van „siker utáni pillanat":
 * megvárjuk a backend válaszát, és csak akkor tüzelünk. Nem kell aláírt token,
 * mert nem hagyjuk el a dokumentumot — a commitot ugyanaz a kódfolyam indítja,
 * amelyik a választ olvasta, tehát nincs mit hamisítani. (A klasszikus, 303-as
 * PRG úton VAN mit: ott a `server/conversion-token.ts` a szerződés.)
 *
 * A SIKER-KONTRAKTUS. A backendnek 2xx-szel ezt kell adnia:
 *
 *   { "ok": true, "event_id": "<a rejtett mezőből kapott id>", "redirect": "/koszonjuk" }
 *
 * A `redirect` opcionális. Az `event_id`-nek EGYEZNIE kell azzal, amit a
 * böngésző letett — a backend a form rejtett mezőjéből kapta, tehát ha mást ad
 * vissza, az szerződésszegés, és a Meta Pixel↔CAPI dedup törne.
 *
 * MINDEN NEM-SIKER ÁG FAIL-CLOSED. Nem-2xx, hálózati hiba, időtúllépés,
 * értelmezhetetlen válasz, `ok:false`, eltérő `event_id` → **nincs commit**, és
 * mindegyiknek saját kódja van (TRK-5003/5004/5005). „Majd csak sikerült"
 * ág nincs: pontosan az termelné újra a fantom-konverziót, amiért a P5 készült.
 */

import { commitPendingConversion, type ConversionIdentity, type CommitOutcome } from './conversion-commit';
import { report, type TrackingCode } from './observability';

/** Alapértelmezett időtúllépés. Egy örökké függő fetch a formot is befagyasztaná. */
export const SUBMIT_TIMEOUT_MS = 15_000;

export interface AsyncSubmitOptions {
  /** A form, amelynek mezőit elküldjük. */
  form: HTMLFormElement;
  /** A böngésző által mintázott, LETETT event_id (a rejtett mező értéke). */
  eventId: string;
  /** Enhanced-Conversions identity — memóriában marad, tárba nem kerül. */
  identity?: ConversionIdentity;
  /** Felülírja a `form.action`-t. */
  action?: string;
  /** Felülírja a `form.method`-ot. */
  method?: string;
  timeoutMs?: number;
  /** Tesztelhetőség. */
  fetchImpl?: typeof fetch;
}

export type AsyncSubmitResult =
  | { ok: true; eventId: string; outcome: CommitOutcome; redirect?: string }
  | { ok: false; code: TrackingCode; status?: number };

interface SuccessBody {
  ok?: unknown;
  event_id?: unknown;
  redirect?: unknown;
}

/**
 * Elküldi a formot fetch-csel, és CSAK a szerződés szerinti sikerre commitol.
 * A hívó dolga a navigáció (`result.redirect`), hogy a commit biztosan megtörténjen,
 * mielőtt a lap elhagyja a dokumentumot.
 */
export async function submitTrackedFormAsync(opts: AsyncSubmitOptions): Promise<AsyncSubmitResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const action = opts.action ?? opts.form.action;
  const method = (opts.method ?? opts.form.method ?? 'POST').toUpperCase();
  const timeoutMs = opts.timeoutMs ?? SUBMIT_TIMEOUT_MS;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  let response: Response;
  try {
    response = await doFetch(action, {
      method,
      body: new FormData(opts.form),
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (err) {
    report('CONVERSION_SUBMIT_FAILED', { reason: 'network_or_timeout', error: String(err) });
    return { ok: false, code: 'TRK-5004' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (!response.ok) {
    report('CONVERSION_SUBMIT_FAILED', { reason: 'http_status', status: response.status });
    return { ok: false, code: 'TRK-5004', status: response.status };
  }

  let body: SuccessBody;
  try {
    body = (await response.json()) as SuccessBody;
  } catch {
    // Egy 2xx HTML-lel (pl. a köszönő-oldal maga) NEM siker-igazolás: a
    // szerződés JSON-t ír elő, és értelmezhetetlen válaszból nem következtetünk.
    report('CONVERSION_SUBMIT_RESPONSE_INVALID', { reason: 'not_json', status: response.status });
    return { ok: false, code: 'TRK-5003', status: response.status };
  }

  if (body === null || typeof body !== 'object') {
    report('CONVERSION_SUBMIT_RESPONSE_INVALID', { reason: 'not_an_object', status: response.status });
    return { ok: false, code: 'TRK-5003', status: response.status };
  }

  // Explicit üzleti elutasítás 2xx-szel — ez FAIL, nem formátumhiba.
  if (body.ok === false) {
    report('CONVERSION_SUBMIT_FAILED', { reason: 'business_rejected', status: response.status });
    return { ok: false, code: 'TRK-5004', status: response.status };
  }

  if (body.ok !== true || typeof body.event_id !== 'string' || body.event_id.length === 0) {
    report('CONVERSION_SUBMIT_RESPONSE_INVALID', {
      reason: 'missing_ok_or_event_id',
      status: response.status,
    });
    return { ok: false, code: 'TRK-5003', status: response.status };
  }

  if (body.event_id !== opts.eventId) {
    report('CONVERSION_SUBMIT_EVENT_ID_MISMATCH', {
      staged: opts.eventId,
      confirmed: body.event_id,
    });
    return { ok: false, code: 'TRK-5005', status: response.status };
  }

  const outcome = commitPendingConversion(body.event_id, opts.identity);
  const redirect = typeof body.redirect === 'string' && body.redirect.length > 0 ? body.redirect : undefined;
  return { ok: true, eventId: body.event_id, outcome, ...(redirect ? { redirect } : {}) };
}
