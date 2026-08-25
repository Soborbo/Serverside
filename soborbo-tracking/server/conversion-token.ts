/**
 * P5.3 — ALÁÍRT, EGYSZER-HASZNÁLATOS conversion-commit token (site backend).
 *
 * MIT ZÁR. A P5 első köre a böngésző-konverziót a siker-oldalra tolta, de a
 * siker BIZONYÍTÉKA egy sima query-paraméter volt (`?e=<event_id>`). Az
 * `event_id` a form rejtett mezőjében ott van a DOM-ban, tehát bárki kiolvassa,
 * elküldi a formot, és ha a backend ELUTASÍTJA, kézzel megnyitja a
 * `/koszonjuk?e=<ugyanaz>` címet — a konverzió elég. Vagyis az INV-001
 * („business FAILED → conversion = 0") csak a jóhiszemű útvonalon állt.
 *
 * A MEGOLDÁS. A siker-tokent a BACKEND állítja ki, MIUTÁN az üzleti írás
 * megtörtént, és HMAC-SHA256-tal aláírja egy csak a szerver által ismert
 * titokkal. A siker-oldal (szerver-oldali render) ellenőrzi ÉS elhasználja.
 * A böngésző így nem tud olyan tokent előállítani, amit a szerver elfogad.
 *
 * A TOKENBEN NINCS PII (INV-002). Se e-mail, se telefon, se név, se hash —
 * csak: séma-verzió, site-azonosító, event-név, event_id, egyedi jti, lejárat.
 * A token URL-be kerül (303 redirect), tehát bármi, ami benne van, bekerül a
 * szerver-logokba és a referrerbe is; ezért itt a „nincs PII" nem stílus,
 * hanem kötelezettség.
 *
 * MIÉRT EGYSZER HASZNÁLATOS. A köszönő-oldal újratöltése, a back/forward
 * navigáció és a megosztott link mind ugyanazt a tokent hozná vissza. Az
 * „exactly ONE conversion" csak akkor tartható, ha az első beváltás után a
 * token halott. A beváltást a `CommitTokenStore` végzi.
 *
 * FAIL-CLOSED. Ha a store nem elérhető, NEM commitolunk (TRK-510-009). Egy
 * store-kiesés így elveszíthet egy valódi konverziót — de a másik irány
 * (fail-open) duplikátumot enged, és pont a duplikátum torzítja a biddinget,
 * amiért az egész P5 készült. A hiba mindkét irányban HANGOS.
 *
 * HASZNÁLAT — a form-endpointban, az üzleti írás UTÁN:
 *
 *   const lead = await createLead(...);           // ← ez a business truth
 *   const token = await mintConversionCommitToken({
 *     secret: env.CONVERSION_COMMIT_SECRET,
 *     siteId: 'painlessremovals.com',
 *     eventName: 'quote_calculator_submitted',
 *     eventId: form.get('event_id'),              // a böngésző mintázta
 *   });
 *   return Response.redirect(`/koszonjuk?ct=${token}`, 303);
 *
 * …és a köszönő-oldalon (szerver-oldali render):
 *
 *   const r = await consumeConversionCommitToken(Astro.url.searchParams.get('ct'), {
 *     secret: env.CONVERSION_COMMIT_SECRET,
 *     siteId: 'painlessremovals.com',
 *     store: kvCommitTokenStore(env.COMMIT_TOKENS),
 *   });
 *   // r.ok === true → <ConversionCommit eventId={r.eventId} />
 */

export const CONVERSION_TOKEN_VERSION = 1;

/** A titok minimális hossza. Rövid HMAC-kulcs brute-force-olható. */
export const MIN_SECRET_LENGTH = 32;

/** Alapértelmezett élettartam: a form és a köszönő-oldal közti út percek, nem órák. */
export const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;

/** Felső korlát — egy „örök" siker-token replay-ablakot nyitna. */
export const MAX_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Stabil hibakódok. NEM cseréljük fel és nem értelmezzük át őket — a site-ok
 * logjai és a fleet-riasztások ezekre a stringekre állnak rá.
 */
export const CONVERSION_TOKEN_CODES = {
  MISSING: 'TRK-510-001',
  MALFORMED: 'TRK-510-002',
  BAD_SIGNATURE: 'TRK-510-003',
  UNSUPPORTED_VERSION: 'TRK-510-004',
  EXPIRED: 'TRK-510-005',
  WRONG_SITE: 'TRK-510-006',
  WRONG_EVENT: 'TRK-510-007',
  ALREADY_CONSUMED: 'TRK-510-008',
  STORE_UNAVAILABLE: 'TRK-510-009',
  SECRET_INVALID: 'TRK-510-010',
} as const;

export type ConversionTokenCode =
  (typeof CONVERSION_TOKEN_CODES)[keyof typeof CONVERSION_TOKEN_CODES];

/** Ember-olvasható magyarázat minden kódhoz (operátori üzenet, nem user-facing). */
export const CONVERSION_TOKEN_MESSAGES: Record<ConversionTokenCode, string> = {
  'TRK-510-001': 'No conversion-commit token supplied — the success page was reached without one',
  'TRK-510-002': 'Conversion-commit token is malformed (structure / base64url / JSON)',
  'TRK-510-003': 'Conversion-commit token signature does not verify — forged or wrong secret',
  'TRK-510-004': 'Conversion-commit token schema version is not supported by this build',
  'TRK-510-005': 'Conversion-commit token expired',
  'TRK-510-006': 'Conversion-commit token was minted for a different site',
  'TRK-510-007': 'Conversion-commit token was minted for a different event',
  'TRK-510-008': 'Conversion-commit token was already consumed — replay, not a new conversion',
  'TRK-510-009': 'Conversion-commit token store unavailable — failing closed, no conversion committed',
  'TRK-510-010': `Conversion-commit secret missing or shorter than ${MIN_SECRET_LENGTH} characters`,
};

/** A token hasznos tartalma. PII-mentes — lásd a fájl fejlécét. */
export interface ConversionTokenPayload {
  /** Séma-verzió. */
  v: number;
  /** Site-azonosító (általában a hostname) — tenant-kötés. */
  sid: string;
  /** Kanonikus event-név — event-kötés. */
  evn: string;
  /** A böngésző által mintázott event_id — ez köti a tokent EHHEZ a konverzióhoz. */
  eid: string;
  /** Egyedi token-azonosító; ezen áll az egyszer-használat. */
  jti: string;
  /** Lejárat, Unix-másodperc. */
  exp: number;
}

export type ConversionTokenResult =
  | { ok: true; payload: ConversionTokenPayload; eventId: string; eventName: string }
  | { ok: false; code: ConversionTokenCode; message: string };

/**
 * Az egyszer-használat tárolója. A `claim` az ELSŐ hívásra `true`, minden
 * továbbira `false`. Hibát DOBHAT — a hívó ilyenkor fail-closed módon jár el.
 */
export interface CommitTokenStore {
  claim(jti: string, ttlSeconds: number): Promise<boolean>;
}

// ── base64url + konstans-idejű összehasonlítás ──────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  // A base64url ábécén kívüli karakter → hibás token, nem „majd a btoa eldönti".
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Konstans idejű bájt-összehasonlítás. Nem mikro-optimalizálás: egy korai
 * `return false` az első eltérő bájtnál időzítés-alapon kiszivárogtatja az
 * aláírás prefixét, és a tokent bájtonként kitalálhatóvá teszi.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function isUsableSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

// ── Mint ────────────────────────────────────────────────────────────

export interface MintOptions {
  secret: string;
  siteId: string;
  eventName: string;
  eventId: string;
  ttlSeconds?: number;
  /** Tesztelhetőség: befecskendezhető idő (Unix-másodperc). */
  nowSeconds?: number;
  /** Tesztelhetőség: befecskendezhető jti. */
  jti?: string;
}

export class ConversionTokenError extends Error {
  readonly code: ConversionTokenCode;
  constructor(code: ConversionTokenCode) {
    super(`${code} ${CONVERSION_TOKEN_MESSAGES[code]}`);
    this.name = 'ConversionTokenError';
    this.code = code;
  }
}

/**
 * Siker-token kiállítása. CSAK az üzleti írás UTÁN hívd — a token azt jelenti,
 * hogy „a business művelet sikerült", és a böngésző ez alapján fog konverziót
 * tüzelni. Ha a lead nem jött létre, ne állíts ki tokent.
 *
 * Hiányzó/gyenge titoknál DOB (TRK-510-010): a csendes „no token" ág azt
 * jelentené, hogy egy elrontott env-változó némán elveszi a site összes
 * böngésző-konverzióját.
 */
export async function mintConversionCommitToken(opts: MintOptions): Promise<string> {
  if (!isUsableSecret(opts.secret)) throw new ConversionTokenError(CONVERSION_TOKEN_CODES.SECRET_INVALID);
  if (!opts.siteId || !opts.eventName || !opts.eventId) {
    throw new ConversionTokenError(CONVERSION_TOKEN_CODES.MALFORMED);
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const requested = opts.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  // A TTL-t befogjuk: egy elgépelt `ttlSeconds: 86400 * 30` hónapos replay-ablakot nyitna.
  const ttl = Math.max(30, Math.min(requested, MAX_TOKEN_TTL_SECONDS));

  const payload: ConversionTokenPayload = {
    v: CONVERSION_TOKEN_VERSION,
    sid: opts.siteId,
    evn: opts.eventName,
    eid: opts.eventId,
    jti: opts.jti ?? crypto.randomUUID(),
    exp: now + ttl,
  };

  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = toBase64Url(await hmac(opts.secret, body));
  return `${body}.${sig}`;
}

// ── Verify ──────────────────────────────────────────────────────────

export interface VerifyOptions {
  secret: string;
  /** Ha megadod, a token `sid`-jének egyeznie kell — tenant-kötés. */
  siteId?: string;
  /** Ha megadod, a token `evn`-jének egyeznie kell — event-kötés. */
  eventName?: string;
  nowSeconds?: number;
}

function fail(code: ConversionTokenCode): ConversionTokenResult {
  return { ok: false, code, message: CONVERSION_TOKEN_MESSAGES[code] };
}

/**
 * Aláírás- és mező-ellenőrzés — beváltás NÉLKÜL. Önmagában NEM elég a
 * commithoz: egy érvényes token korlátlanul újrajátszható, amíg el nem
 * használódik. A commit-úton MINDIG a `consumeConversionCommitToken` a helyes
 * belépő; ez a függvény diagnosztikára és tesztre való.
 */
export async function verifyConversionCommitToken(
  token: string | null | undefined,
  opts: VerifyOptions,
): Promise<ConversionTokenResult> {
  if (!isUsableSecret(opts.secret)) return fail(CONVERSION_TOKEN_CODES.SECRET_INVALID);
  if (typeof token !== 'string' || token.length === 0) return fail(CONVERSION_TOKEN_CODES.MISSING);

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return fail(CONVERSION_TOKEN_CODES.MALFORMED);
  }
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  const providedSig = fromBase64Url(sigPart);
  if (!providedSig) return fail(CONVERSION_TOKEN_CODES.MALFORMED);

  // ELŐBB az aláírás, AZTÁN a tartalom. Fordítva egy hamisított payload
  // mezőhibái is kiszivárogtatnának információt a támadónak arról, milyen
  // alakú tokent fogadnánk el.
  const expectedSig = await hmac(opts.secret, body);
  if (!timingSafeEqual(providedSig, expectedSig)) return fail(CONVERSION_TOKEN_CODES.BAD_SIGNATURE);

  const bodyBytes = fromBase64Url(body);
  if (!bodyBytes) return fail(CONVERSION_TOKEN_CODES.MALFORMED);

  let payload: ConversionTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return fail(CONVERSION_TOKEN_CODES.MALFORMED);
  }

  if (!payload || typeof payload !== 'object') return fail(CONVERSION_TOKEN_CODES.MALFORMED);
  if (payload.v !== CONVERSION_TOKEN_VERSION) return fail(CONVERSION_TOKEN_CODES.UNSUPPORTED_VERSION);
  if (
    typeof payload.sid !== 'string' || typeof payload.evn !== 'string' ||
    typeof payload.eid !== 'string' || typeof payload.jti !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.sid === '' || payload.evn === '' || payload.eid === '' || payload.jti === ''
  ) {
    return fail(CONVERSION_TOKEN_CODES.MALFORMED);
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return fail(CONVERSION_TOKEN_CODES.EXPIRED);

  if (opts.siteId !== undefined && payload.sid !== opts.siteId) return fail(CONVERSION_TOKEN_CODES.WRONG_SITE);
  if (opts.eventName !== undefined && payload.evn !== opts.eventName) return fail(CONVERSION_TOKEN_CODES.WRONG_EVENT);

  return { ok: true, payload, eventId: payload.eid, eventName: payload.evn };
}

// ── Consume (verify + egyszer-használat) ────────────────────────────

export interface ConsumeOptions extends VerifyOptions {
  store: CommitTokenStore;
}

/**
 * A commit-út EGYETLEN helyes belépője: ellenőriz ÉS elhasznál. Sikeres
 * visszatérés után a token halott — az újratöltés `TRK-510-008`-at kap, nem
 * második konverziót.
 */
export async function consumeConversionCommitToken(
  token: string | null | undefined,
  opts: ConsumeOptions,
): Promise<ConversionTokenResult> {
  const verified = await verifyConversionCommitToken(token, opts);
  if (!verified.ok) return verified;

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  // A beváltás-nyomot a token LEJÁRATÁIG kell őrizni — ha korábban törölnénk,
  // egy még érvényes token újra beváltható lenne.
  const remaining = Math.max(60, verified.payload.exp - now);

  let claimed: boolean;
  try {
    claimed = await opts.store.claim(verified.payload.jti, remaining);
  } catch {
    // Fail-closed: ismeretlen állapotból nem csinálunk konverziót.
    return fail(CONVERSION_TOKEN_CODES.STORE_UNAVAILABLE);
  }

  if (!claimed) return fail(CONVERSION_TOKEN_CODES.ALREADY_CONSUMED);
  return verified;
}

// ── Store-implementációk ────────────────────────────────────────────

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * KV-alapú store. FIGYELEM: a KV-nek nincs atomi „put if absent"-je, tehát két
 * EGYSZERRE érkező kérés (pl. két megnyitott tabfül) mindkettő `true`-t kaphat.
 * A gyakorlatban a köszönő-oldal-újratöltés másodpercekkel később jön, amit ez
 * megfog; ahol a szigorú „exactly once" kell, ott a D1-változatot használd.
 */
export function kvCommitTokenStore(kv: KvLike): CommitTokenStore {
  return {
    async claim(jti, ttlSeconds) {
      const key = `commit_token:${jti}`;
      const existing = await kv.get(key);
      if (existing !== null) return false;
      await kv.put(key, '1', { expirationTtl: Math.max(60, ttlSeconds) });
      return true;
    },
  };
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
}

/**
 * D1-alapú store — ATOMI. A `jti` elsődleges kulcs, tehát a második INSERT
 * kényszer-sértéssel elszáll, és ezt vesszük „már elhasznált"-nak.
 *
 * Szükséges séma a site D1-jében:
 *
 *   CREATE TABLE conversion_commit_tokens (
 *     jti        TEXT PRIMARY KEY,
 *     expires_at INTEGER NOT NULL
 *   );
 *   CREATE INDEX idx_cct_expires ON conversion_commit_tokens(expires_at);
 *
 * A lejárt sorokat takarítsa egy cron: `DELETE FROM conversion_commit_tokens
 * WHERE expires_at < unixepoch()`.
 */
export function d1CommitTokenStore(db: D1Like, nowSeconds?: () => number): CommitTokenStore {
  return {
    async claim(jti, ttlSeconds) {
      const now = nowSeconds ? nowSeconds() : Math.floor(Date.now() / 1000);
      try {
        await db
          .prepare('INSERT INTO conversion_commit_tokens (jti, expires_at) VALUES (?, ?)')
          .bind(jti, now + ttlSeconds)
          .run();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // CSAK a kulcsütközés jelent „már elhasznált"-at. Minden más D1-hiba
        // (tábla hiányzik, kapcsolat elszállt) TOVÁBBDOBÓDIK, hogy fail-closed
        // ágra kerüljön — különben egy hiányzó tábla némán minden tokent
        // „friss"-nek mutatna, és pont az egyszer-használat veszne el.
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) return false;
        throw err;
      }
    },
  };
}

/** Memória-store — TESZTHEZ és egyetlen-izolátumos fejlesztéshez. Nem éles. */
export function memoryCommitTokenStore(): CommitTokenStore & { size(): number } {
  const seen = new Map<string, number>();
  return {
    async claim(jti, ttlSeconds) {
      const now = Date.now();
      for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
      if (seen.has(jti)) return false;
      seen.set(jti, now + ttlSeconds * 1000);
      return true;
    },
    size() {
      return seen.size;
    },
  };
}
