/**
 * Observability — STABLE diagnostic codes.
 *
 * Tracking fails silently and expensively: a broken dispatch or a leaked PII key
 * is invisible until conversions quietly drop days later. So every notable
 * condition is reported with a stable code, three ways:
 *   1. console (error/warn always; info only in diag-debug) — visible in the browser
 *   2. a ring buffer at `window.__sbTrackingDiag` (last 50) — scrape it from a probe
 *   3. a DOM CustomEvent `sb-tracking-diagnostic` — forward to your error pipeline
 *      (e.g. the `error-pipeline` skill → Tail Worker → throttled email)
 *
 * If a future change breaks a leg, the matching code fires and you SEE it.
 */

export type DiagSeverity = 'info' | 'warn' | 'error';

interface CodeDef { code: string; severity: DiagSeverity; message: string }

export const TRACKING_CODES = {
  // 1xxx — gateway / worker connection.
  // TRK-1001/1004 (Turnstile skip / degraded token-less) and the whole TRK-2xxx
  // Turnstile block are RETIRED: the gateway no longer validates Turnstile, and
  // the client never gates a dispatch on a token. Do not reuse the numbers.
  GATEWAY_OK:              { code: 'TRK-1000', severity: 'info',  message: 'Gateway dispatch sent' },
  GATEWAY_NETWORK_FAIL:    { code: 'TRK-1002', severity: 'error', message: 'Gateway POST failed (network/transport)' },
  GATEWAY_BEACON_FALLBACK: { code: 'TRK-1003', severity: 'info',  message: 'sendBeacon unavailable/failed; used fetch keepalive' },
  GATEWAY_SERVER_ONLY_EVENT: { code: 'TRK-1005', severity: 'error', message: 'Server-ingress-only event blocked from browser dispatch — the site BACKEND must send it via /api/event/conversion-server' },
  GATEWAY_REJECTED:        { code: 'TRK-1006', severity: 'error', message: 'Gateway rejected the dispatch (non-2xx HTTP status) — the conversion did NOT land' },
  // 3xxx — data integrity
  PII_IN_DATALAYER:        { code: 'TRK-3001', severity: 'error', message: 'PII-shaped key blocked from a dataLayer push' },
  // 4xxx — saját CMP (Fázis 2). A consent-POST kudarca SOSEM néma: a kliens az
  // egyetlen őrzője a döntésnek, amíg a gateway 204-gyel nem igazolta a tárolást.
  CONSENT_STORED:          { code: 'TRK-4000', severity: 'info',  message: 'Consent decision stored by the gateway (204)' },
  CONSENT_POST_RETRYABLE:  { code: 'TRK-4001', severity: 'warn',  message: 'Consent POST not stored (429/5xx/network) — decision kept pending, resent later with the SAME consent_event_id' },
  CONSENT_POST_REJECTED:   { code: 'TRK-4002', severity: 'error', message: 'Consent POST rejected (4xx) — dropped from the pending queue; the cookie state still applies locally' },
  // INV-008 — ISMERETLEN consent mellett engedtünk, mert a site EXPLICIT kérte a
  // dev-kényelmet. Prodban ez sosem fordulhat elő (DEV=false); ha mégis látod
  // éles logban, a build rossz flaggel készült.
  CONSENT_DEV_FALLBACK_ALLOW: { code: 'TRK-4003', severity: 'warn', message: 'Unknown consent ALLOWED by the explicit dev fallback (PUBLIC_TRACKING_DEV_CONSENT_ALLOW=1) — must never happen in production' },
  // 5xxx — P5 `commit-after-business-success`. A böngésző-konverzió a backend
  // SIKERE után ég el; ezek a kódok mondják meg, mi lett a letett konverzióval.
  CONVERSION_COMMITTED:    { code: 'TRK-5000', severity: 'info',  message: 'Staged browser conversion committed after backend success' },
  CONVERSION_COMMIT_CONSENT_REVOKED: { code: 'TRK-5001', severity: 'warn', message: 'Staged conversion dropped: marketing consent was withdrawn between submit and success page' },
  // A konverzió elmegy, de Enhanced-Conversions identity nélkül — gyengébb
  // match-rate. Navigációs (PRG) úton ez azt jelenti, hogy a siker-oldal nem
  // adott át identityt a szerver-oldali renderből. NEM néma degradáció.
  CONVERSION_COMMIT_WITHOUT_IDENTITY: { code: 'TRK-5002', severity: 'warn', message: 'Conversion committed without Enhanced-Conversions identity — weaker match; the success page passed no identity' },
  // fetch-út: a backend válaszát nem lehetett a siker-kontraktus szerint
  // értelmezni. Fail-closed: NEM commitolunk. Egy „majd csak sikerült" ág itt
  // pontosan azt a fantom-konverziót termelné újra, amiért a P5 készült.
  CONVERSION_SUBMIT_RESPONSE_INVALID: { code: 'TRK-5003', severity: 'error', message: 'Form submit response did not match the success contract ({ok:true,event_id}) — no conversion committed' },
  // fetch-út: a backend elutasított vagy a hálózat elszállt.
  CONVERSION_SUBMIT_FAILED: { code: 'TRK-5004', severity: 'warn',  message: 'Form submit failed (non-2xx or network) — no conversion committed' },
  // fetch-út: a backend MÁS event_id-t igazolt vissza, mint amit a böngésző
  // letett. Ez szerződésszegés (a backendnek a rejtett mező id-jét kell
  // visszaadnia), és dedup-törést jelentene — nem commitolunk.
  CONVERSION_SUBMIT_EVENT_ID_MISMATCH: { code: 'TRK-5005', severity: 'error', message: 'Backend confirmed a different event_id than the browser staged — Meta dedup would break; no conversion committed' },
} as const satisfies Record<string, CodeDef>;

export type TrackingCodeKey = keyof typeof TRACKING_CODES;
export type TrackingCode = (typeof TRACKING_CODES)[TrackingCodeKey]['code'];

export interface TrackingDiagnostic {
  code: TrackingCode;
  severity: DiagSeverity;
  message: string;
  context?: Record<string, unknown>;
  ts: number;
}

const RING_MAX = 50;
const DIAG_EVENT = 'sb-tracking-diagnostic';
let diagDebug = false;

/** Turn on info-level console output for diagnostics (enabled by ?debugTracking=1). */
export function enableDiagDebug(): void { diagDebug = true; }

function ring(): TrackingDiagnostic[] {
  const w = window as unknown as { __sbTrackingDiag?: TrackingDiagnostic[] };
  if (!w.__sbTrackingDiag) w.__sbTrackingDiag = [];
  return w.__sbTrackingDiag;
}

/** Emit a coded diagnostic. Returns the record (handy in tests). */
export function report(key: TrackingCodeKey, context?: Record<string, unknown>): TrackingDiagnostic {
  const def = TRACKING_CODES[key];
  // Widen: the current code table happens to contain no 'warn' entries, but the
  // severity contract stays three-level for future codes. (The cast defeats TS's
  // const-initializer narrowing, which would otherwise flag the 'warn' branch.)
  const severity = def.severity as DiagSeverity;
  const diag: TrackingDiagnostic = {
    code: def.code, severity, message: def.message, context,
    ts: typeof Date !== 'undefined' ? Date.now() : 0,
  };

  // 1) console — errors/warnings always; info only under diag-debug.
  const line = `[tracking] ${def.code} ${def.message}`;
  if (severity === 'error') console.error(line, context ?? '');
  else if (severity === 'warn') console.warn(line, context ?? '');
  else if (diagDebug) console.log(line, context ?? '');

  if (typeof window !== 'undefined') {
    // 2) ring buffer (bounded)
    const buf = ring();
    buf.push(diag);
    if (buf.length > RING_MAX) buf.splice(0, buf.length - RING_MAX);
    // 3) CustomEvent for the site's error pipeline — only for real problems
    //    (info is throughput heartbeat; don't spam the pipeline with it).
    if (def.severity !== 'info') {
      try { window.dispatchEvent(new CustomEvent(DIAG_EVENT, { detail: diag })); } catch { /* */ }
    }
  }
  return diag;
}

/** Read the recent diagnostics ring (newest last). */
export function getDiagnostics(): TrackingDiagnostic[] {
  return typeof window !== 'undefined' ? [...ring()] : [];
}

/** Clear the diagnostics ring. */
export function clearDiagnostics(): void {
  if (typeof window !== 'undefined') (window as unknown as { __sbTrackingDiag?: TrackingDiagnostic[] }).__sbTrackingDiag = [];
}

// ── PII guard (data integrity) ──────────────────────────────────────
// Name-based guard: PII must never reach the dataLayer (it goes to the hidden
// side-channel instead). This is the defense-in-depth net behind events.ts —
// if a future change pushes a PII-shaped key, it's stripped AND reported (TRK-3001).
export const PII_DATALAYER_KEYS: ReadonlySet<string> = new Set([
  'email', 'phone', 'phone_number', 'user_provided_data', 'user_data',
  'first_name', 'last_name', 'name', 'street', 'city', 'postal_code', 'postcode',
  // Meta Advanced Matching short codes (a hash-elt user_data mezőnevei is)
  'em', 'ph', 'fn', 'ln', 'ct', 'zp', 'st', 'country', 'external_id',
]);

/** Delete any PII-shaped keys from `data` IN PLACE; return the names removed. */
export function redactPii(data: Record<string, unknown>): string[] {
  const leaked = Object.keys(data).filter((k) => PII_DATALAYER_KEYS.has(k));
  for (const k of leaked) delete data[k];
  return leaked;
}
