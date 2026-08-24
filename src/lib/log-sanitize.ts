/**
 * Strips PII patterns from upstream API error messages before logging.
 * Per CLAUDE.md rule 13: NEVER log user_data, even after hashing.
 * Meta and Google Ads sometimes echo submitted values in error responses.
 *
 * Másodlagos védvonal (defense-in-depth): az ELSŐDLEGES szabály, hogy a hívók ne
 * logoljanak nyers vendor-body-t. Név/város szabad szöveg, regexszel nem fogható
 * megbízhatóan — ezeknél a structured log mezőkre (error_code + status) kell
 * hagyatkozni, nem erre a sanitizerre.
 */
/** Rövid, ember által olvasható hibaüzenet felső határa (alapértelmezés). */
export const ERROR_MESSAGE_MAX_LEN = 200;

/**
 * Strukturált vendor-hibarészlet (pl. Data Manager `error.details[]`) felső
 * határa. A 200 karakteres alapérték pont a hasznos rész ELŐTT vágott: a
 * Data Manager a `fieldViolations` tömbben mondja meg, MELYIK mező rossz, és
 * az a generikus "There was a problem with the request." + ErrorInfo-fejléc
 * után kezdődik. 10 db trapezlemezes `INVALID_ARGUMENT` volt így
 * diagnosztizálhatatlan (2026-08-11).
 */
export const VENDOR_DETAIL_MAX_LEN = 4000;

/**
 * Vendor-hibaüzenetek OBJEKTUM-AZONOSÍTÓ pozíciói. Az itt kiemelt számsor NEM PII:
 * a Meta Graph API a SAJÁT pixel/dataset ID-jét visszhangozza, nem a beküldött
 * user_data-t. Viszont 15–16 jegyű, tehát a lenti telefon-regex megeszi.
 *
 * MIÉRT KELL: 2026-07-27 és 08-11 között az agykontroll Meta-lába 43× bukott
 * TRK-600-005-tel, és a ledgerben MINDEN sor így nézett ki:
 *
 *   Unsupported post request. Object with ID '[phone]' does not exist, ...
 *
 * A `[phone]` a SAJÁT sanitizerünk kimenete volt, nem a kimenő érték — a Meta
 * eredeti üzenete a valódi (hibás) pixel ID-t tartalmazta. A maszk pont azt a
 * mezőt tüntette el, amiért a rekord létrejött: a hiba „be nem helyettesített
 * template-változónak" látszott, és a vizsgálat a gateway kódját kereste egy
 * KV-config hiba helyett. Egy diagnosztikai mező, ami elrejti a diagnózist,
 * rosszabb, mintha ott sem lenne.
 *
 * A kiemelés SZŰK és kontextushoz kötött: csak az alábbi, szó szerinti
 * vendor-frázisokban álló számsor marad meg. Ezekben a pozíciókban a Graph API
 * objektum-ID-t ad vissza, nem felhasználói adatot. A `.replace()` a globális
 * regexet minden híváskor lastIndex=0-ról indítja, így a modul-szintű megosztás
 * biztonságos (ellentétben a `.test()`-tel).
 */
const OBJECT_ID_CONTEXTS: readonly RegExp[] = [
  // Meta: ismeretlen vagy nem jogosult pixel/dataset ID — a 400-as fő ága.
  /\bObject with ID '(\d{5,20})'/g,
  // Meta (#803): alias-feloldási hiba, szintén objektum-ID-t sorol fel.
  /\baliases you requested do not exist: (\d{5,20})/g
];

// Sentinel a védett azonosítók helyére. NUL-lal határolt, hogy valós vendor-
// üzenetben ne fordulhasson elő, és szándékosan nem tartalmaz 9+ jegyű számsort,
// `@`-ot vagy 32+ hex karaktert — így a lenti maszkok nem nyúlnak hozzá.
const SENTINEL_OPEN = '\u0000OBJID';
const SENTINEL_CLOSE = '\u0000';
const SENTINEL_PATTERN = new RegExp(`${SENTINEL_OPEN}(\\d+)${SENTINEL_CLOSE}`, 'g');

export function sanitizeErrorMessage(
  msg: string | undefined,
  maxLen: number = ERROR_MESSAGE_MAX_LEN
): string {
  if (!msg) return 'unknown';

  const preserved: string[] = [];
  let out = msg;

  for (const context of OBJECT_ID_CONTEXTS) {
    out = out.replace(context, (match, id: string) => {
      const token = `${SENTINEL_OPEN}${preserved.length}${SENTINEL_CLOSE}`;
      preserved.push(id);
      // Csak a befogott azonosítót cseréljük, a körülötte lévő frázist nem — az
      // marad olvasható. A prefix („Object with ID '…") nem tartalmaz számjegyet,
      // így az első előfordulás biztosan maga az ID.
      return match.replace(id, token);
    });
  }

  out = out
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,18}\d/g, '[phone]')
    // Echo-zott SHA-256 (vagy más hosszú hex) is user_data — a #13 a hashed
    // értéket is tiltja logolni. 32+ hex karakter → [hash].
    // FIGYELEM: ez a maszkolás a nagyobb maxLen mellett is fut — a
    // fieldViolations mezőnevek és leírások megmaradnak, a hashelt
    // identifierek nem.
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hash]');

  // A visszacserélés a vágás ELŐTT fut: egy félbevágott sentinel olvashatatlan
  // NUL-szemétként ülne a ledger vendor_message mezőjében.
  out = out.replace(SENTINEL_PATTERN, (_match, index: string) => preserved[Number(index)] ?? '');

  return out.slice(0, maxLen);
}
