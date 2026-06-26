/**
 * Univerzális attribúciós réteg — minden bevett ad-platform click ID + UTM +
 * kontextus. Ez a payload-kontraktus "source of truth"-ja: a kliens ide gyűjt
 * mindent, a worker validál, és platformonként a megfelelő mezőket továbbítja.
 *
 * Továbbítás jelenleg: Google Ads (gclid/gbraid/wbraid), Meta (fbclid→fbc),
 * GA4 (utm_* → campaign params). A többi click ID (msclkid/ttclid/li_fat_id/
 * twclid/dclid) MOST elfogadott + validált + logolható, de még nincs hozzá
 * platform-integráció — ezek a jövőbeli TikTok/Microsoft/LinkedIn CAPI plug-in
 * pontjai. Bővítés: vegyél fel mezőt itt + a megfelelő platform-libben.
 */

export interface AttributionParams {
  // ── Google ──
  gclid?: string;
  gbraid?: string; // iOS app → web
  wbraid?: string; // iOS web
  gclsrc?: string;
  gad_source?: string;
  dclid?: string; // Display & Video 360 / Display
  // ── Meta ──
  fbclid?: string; // ebből épül az fbc, ha nincs _fbc cookie
  // ── Egyéb platformok (capture-only, még nincs forward) ──
  msclkid?: string; // Microsoft / Bing
  ttclid?: string; // TikTok
  li_fat_id?: string; // LinkedIn
  twclid?: string; // X / Twitter
  // ── UTM (GA4 standard + extended) ──
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  utm_id?: string;
  utm_source_platform?: string;
  utm_creative_format?: string;
  utm_marketing_tactic?: string;
  // ── Kontextus ──
  referrer?: string;
  landing_page?: string;
}

// Click ID-k: url-safe token charset, szigorúbb. Hossz-bound DoS ellen.
const TOKEN_FIELDS = [
  'gclid',
  'gbraid',
  'wbraid',
  'gclsrc',
  'gad_source',
  'dclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
  'twclid'
] as const;

// UTM + kontextus: szabad szöveg, de bound + control-char tiltás.
const TEXT_FIELDS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic',
  'referrer',
  'landing_page'
] as const;

const TOKEN_MAX = 1024;
const TEXT_MAX = 512;
// Click ID-k jellemzően [A-Za-z0-9._-] + esetenként URL-safe base64 (`~`, `%`).
const TOKEN_RE = /^[A-Za-z0-9._~%-]{1,1024}$/;

function cleanToken(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length === 0 || t.length > TOKEN_MAX) return undefined;
  return TOKEN_RE.test(t) ? t : undefined;
}

// Control karaktereket (kódpont < 32 vagy 127) eltávolít — szóközöket MEGTART.
// Regex-literál helyett char-code szűrés, hogy a forrásban ne legyen control byte.
function stripControlChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c !== 127) out += s[i];
  }
  return out;
}

// URL-mezők: csak az origin+path marad, a query string + fragment LEKERÜL —
// ezek tartalmazhatnak PII-t (?email=, ?phone=), és ezt at-rest tároljuk
// (DO + R2 DLQ). Adatminimalizálás (GDPR Art. 5).
const URL_FIELDS: ReadonlySet<string> = new Set(['referrer', 'landing_page']);

function cleanText(v: unknown, key: string): string | undefined {
  if (typeof v !== 'string') return undefined;
  let t = stripControlChars(v).trim();
  if (t.length === 0) return undefined;
  if (URL_FIELDS.has(key)) {
    const cut = t.search(/[?#]/);
    if (cut >= 0) t = t.slice(0, cut);
  }
  return t.slice(0, TEXT_MAX);
}

/**
 * Validál + normalizál egy nyers attribution objektumot a payloadból.
 * Ismeretlen kulcsokat eldob; minden mezőt bound-ol. undefined-et ad, ha üres.
 */
export function parseAttribution(raw: unknown): AttributionParams | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, string> = {};

  for (const k of TOKEN_FIELDS) {
    const v = cleanToken(r[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of TEXT_FIELDS) {
    const v = cleanText(r[k], k);
    if (v !== undefined) out[k] = v;
  }

  return Object.keys(out).length > 0 ? (out as AttributionParams) : undefined;
}

/**
 * Meta `fbc` előállítása fbclid-ből, ha nincs `_fbc` cookie.
 * Formátum: `fb.1.<unix_ms>.<fbclid>` (Meta hivatalos).
 */
export function buildFbcFromFbclid(
  fbclid: string | undefined,
  eventTimeSec: number
): string | undefined {
  if (!fbclid) return undefined;
  const ms = Math.floor(eventTimeSec * 1000);
  return `fb.1.${ms}.${fbclid}`;
}
