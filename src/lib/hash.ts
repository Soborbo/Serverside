/**
 * User data normalization and hashing for Meta CAPI, GA4, Google Ads.
 *
 * KRITIKUS: A hash specifikáció a CLAUDE.md-ben részletezett.
 * Ne térj el tőle. Egyetlen hibás normalizáció Meta-nál EMQ-csökkenést,
 * Google-nál EC match rate-csökkenést okoz.
 */

export type CountryCode = 'GB' | 'HU' | 'EU' | 'US' | 'DE' | 'FR' | 'IT' | 'ES';

export interface PlainUserData {
  email?: string | null;
  phone_number?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  external_id?: string | null;
}

export interface HashedUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  zp?: string;
  country?: string;
  // Meta external_id (SHA-256). Meta a hash-elt változatot is elfogadja és
  // ajánlja; emeli az EMQ-t. Google Ads/GA4 NEM használja.
  external_id?: string;
}

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeEmail(email: string | null | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@')) return undefined;
  return trimmed;
}

// Domains where Google's user-data formatting spec requires stripping dots and
// the plus-suffix from the local part BEFORE hashing.
const GOOGLE_DOTLESS_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * Google-specific email normalization for the Data Manager API (Google Ads /
 * GA4 ingestion). DIFFERS from {@link normalizeEmail} (which is Meta's rule).
 *
 * Per the Data Manager "Format user data" spec: for gmail.com / googlemail.com
 * addresses, remove all dots and everything from the first `+` in the local
 * part. For every other domain, leave dots/plus untouched. Then lowercase+trim
 * (inherited from normalizeEmail) and SHA-256.
 *
 * CLAUDE.md Rule 1 forbids this stripping — but Rule 1 is the *Meta* rule
 * (Meta hashes the literal string). Google matches against the canonical Gmail
 * address, so reusing the Meta hash here would silently lower the Google EC
 * match rate for Gmail users with dots/plus in their address.
 */
export function normalizeEmailForGoogle(email: string | null | undefined): string | undefined {
  const base = normalizeEmail(email);
  if (!base) return undefined;
  const atIdx = base.lastIndexOf('@');
  const local = base.slice(0, atIdx);
  const domain = base.slice(atIdx + 1);
  if (!GOOGLE_DOTLESS_DOMAINS.has(domain)) return base;

  let localNorm = local;
  const plusIdx = localNorm.indexOf('+');
  if (plusIdx !== -1) localNorm = localNorm.slice(0, plusIdx);
  localNorm = localNorm.replace(/\./g, '');
  // Safety: a local part of only dots/plus would collapse to '' → don't emit a
  // domain-only '@gmail.com'; fall back to the un-stripped address.
  if (localNorm.length === 0) return base;
  return `${localNorm}@${domain}`;
}

// Country dialing-codes that use a leading `0` as a national trunk prefix.
// When the international `+CC` prefix is already present, the trunk `0` must
// be dropped (e.g. `+44 (0)7123 456 789` → `+447123456789`).
//
// IMPORTANT: only countries that ACTUALLY use a trunk-0 in their national
// numbering plan are listed here. Italy, Spain, Czechia, Slovakia, Poland
// keep their leading 0 in international format (or have no trunk 0 at all),
// so they MUST NOT be in this list.
const TRUNK_PREFIX_COUNTRIES: Record<string, string> = {
  '44': 'gb',
  '36': 'hu',
  '49': 'de',
  '33': 'fr',
  '31': 'nl',
  '32': 'be',
  '43': 'at',
  '41': 'ch',
  '40': 'ro'
};

export function normalizePhone(
  phone: string | null | undefined,
  countryCode: CountryCode = 'GB'
): string | undefined {
  if (typeof phone !== 'string') return undefined;
  let cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.length === 0) return undefined;

  if (cleaned.startsWith('+')) {
    // Generalized trunk-prefix repair: if `+CC0` matches a known dialing
    // code that uses a trunk `0`, strip the trunk. Covers UK, HU, DE, FR
    // and other EU countries that share this convention.
    cleaned = stripTrunkPrefix(cleaned);
    if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
    return undefined;
  }

  if (countryCode === 'GB') {
    if (cleaned.startsWith('0')) {
      cleaned = '+44' + cleaned.slice(1);
    } else if (cleaned.startsWith('44')) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+44' + cleaned;
    }
  } else if (countryCode === 'HU') {
    if (cleaned.startsWith('06')) {
      cleaned = '+36' + cleaned.slice(2);
    } else if (cleaned.startsWith('0')) {
      cleaned = '+36' + cleaned.slice(1);
    } else if (cleaned.startsWith('36')) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+36' + cleaned;
    }
  } else if (countryCode === 'US') {
    if (cleaned.startsWith('1')) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+1' + cleaned;
    }
  } else {
    // Ismeretlen országhoz (nem GB/HU/US) nincs hívókód-szabályunk. Egy NEMZETI
    // formátumú szám (trunk-`0`, pl. DE `0176…`) így `+0176…`-ként némán ROSSZ hash-t
    // adna, ami se a böngésző-Pixellel, se a Google EC-vel nem match-el. Csak a már
    // teljes nemzetközi (0-val NEM kezdődő) számot fogadjuk el; a nemzetit inkább
    // eldobjuk (a hiányzó telefon jobb, mint a megmérgezett — a match megy email/fbp-n).
    //
    // Az 'EU' SZÁNDÉKOSAN ide esik, NEM a GB-ágra. Korábban `GB || EU` volt egy
    // ágon, vagyis egy EU-generikus site NÉMET nemzeti száma (`0176…`) `+44176…`-ként
    // hash-elődött volna: szintaktikailag érvényes UK-szám, ami garantáltan senkivel
    // nem match-el, és semmilyen hibát nem jelez. Az 'EU' régió-kód (nem ország),
    // hívókódja nincs — a konzervatív ág a helyes viselkedés.
    if (cleaned.startsWith('0')) return undefined;
    cleaned = '+' + cleaned;
  }

  if (!/^\+\d{8,15}$/.test(cleaned)) return undefined;
  return cleaned;
}

function stripTrunkPrefix(plus: string): string {
  // Try 3-digit dialing codes first (longer match wins).
  for (const codeLen of [3, 2]) {
    const candidate = plus.slice(1, 1 + codeLen);
    if (
      TRUNK_PREFIX_COUNTRIES[candidate] !== undefined &&
      plus.length > 1 + codeLen &&
      plus[1 + codeLen] === '0'
    ) {
      return '+' + candidate + plus.slice(2 + codeLen);
    }
  }
  return plus;
}

export function normalizePostalCode(postal: string | null | undefined): string | undefined {
  if (typeof postal !== 'string') return undefined;
  const cleaned = postal.replace(/\s+/g, '').toUpperCase();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

export function normalizeCity(city: string | null | undefined): string | undefined {
  if (typeof city !== 'string') return undefined;
  const cleaned = city.trim().toLowerCase();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

export function normalizeName(name: string | null | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().toLowerCase();
  if (cleaned.length === 0) return undefined;
  return cleaned;
}

const COUNTRY_3_TO_2: Record<string, string> = {
  GBR: 'gb',
  HUN: 'hu',
  USA: 'us',
  DEU: 'de',
  FRA: 'fr',
  ITA: 'it',
  ESP: 'es',
  NLD: 'nl',
  BEL: 'be',
  AUT: 'at',
  CHE: 'ch',
  POL: 'pl',
  CZE: 'cz',
  SVK: 'sk',
  ROU: 'ro'
};

const COUNTRY_NAME_TO_2: Record<string, string> = {
  'united kingdom': 'gb',
  'great britain': 'gb',
  uk: 'gb',
  england: 'gb',
  hungary: 'hu',
  magyarország: 'hu',
  'united states': 'us',
  usa: 'us',
  america: 'us'
};

// Valós ISO 3166-1 alpha-2 kódok. Egy nyers 2-betűs input CSAK akkor megy át,
// ha ezen a listán van — különben pl. 'EU' (régió, nem ország) invalid 'eu'
// hash-ként/plain kódként szennyezné a Meta EMQ / Google Ads match-et (#3).
const ISO_3166_1_ALPHA2 = new Set<string>([
  'ad','ae','af','ag','ai','al','am','ao','aq','ar','as','at','au','aw','ax','az',
  'ba','bb','bd','be','bf','bg','bh','bi','bj','bl','bm','bn','bo','bq','br','bs','bt','bv','bw','by','bz',
  'ca','cc','cd','cf','cg','ch','ci','ck','cl','cm','cn','co','cr','cu','cv','cw','cx','cy','cz',
  'de','dj','dk','dm','do','dz','ec','ee','eg','eh','er','es','et','fi','fj','fk','fm','fo','fr',
  'ga','gb','gd','ge','gf','gg','gh','gi','gl','gm','gn','gp','gq','gr','gs','gt','gu','gw','gy',
  'hk','hm','hn','hr','ht','hu','id','ie','il','im','in','io','iq','ir','is','it',
  'je','jm','jo','jp','ke','kg','kh','ki','km','kn','kp','kr','kw','ky','kz',
  'la','lb','lc','li','lk','lr','ls','lt','lu','lv','ly','ma','mc','md','me','mf','mg','mh','mk','ml','mm','mn','mo','mp','mq','mr','ms','mt','mu','mv','mw','mx','my','mz',
  'na','nc','ne','nf','ng','ni','nl','no','np','nr','nu','nz','om','pa','pe','pf','pg','ph','pk','pl','pm','pn','pr','ps','pt','pw','py',
  'qa','re','ro','rs','ru','rw','sa','sb','sc','sd','se','sg','sh','si','sj','sk','sl','sm','sn','so','sr','ss','st','sv','sx','sy','sz',
  'tc','td','tf','tg','th','tj','tk','tl','tm','tn','to','tr','tt','tv','tw','tz',
  'ua','ug','um','us','uy','uz','va','vc','ve','vg','vi','vn','vu','wf','ws','ye','yt','za','zm','zw'
]);

export function normalizeCountry(country: string | null | undefined): string | undefined {
  if (typeof country !== 'string') return undefined;
  const trimmed = country.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  if (trimmed.length === 2 && ISO_3166_1_ALPHA2.has(trimmed)) return trimmed;
  if (trimmed.length === 3 && /^[a-z]{3}$/.test(trimmed)) {
    return COUNTRY_3_TO_2[trimmed.toUpperCase()] || undefined;
  }
  return COUNTRY_NAME_TO_2[trimmed] || undefined;
}

export interface HashUserDataOptions {
  // Override the email normalizer. Default = Meta's rule (normalizeEmail).
  // The Data Manager (Google) leg passes normalizeEmailForGoogle.
  emailNormalizer?: (email: string | null | undefined) => string | undefined;
}

export async function hashUserData(
  input: PlainUserData,
  countryCode: CountryCode = 'GB',
  opts?: HashUserDataOptions
): Promise<HashedUserData> {
  const result: HashedUserData = {};

  const normalizeEmailFn = opts?.emailNormalizer ?? normalizeEmail;
  const email = normalizeEmailFn(input.email);
  if (email) result.em = await sha256Hex(email);

  const phone = normalizePhone(input.phone_number, countryCode);
  if (phone) result.ph = await sha256Hex(phone);

  const firstName = normalizeName(input.first_name);
  if (firstName) result.fn = await sha256Hex(firstName);

  const lastName = normalizeName(input.last_name);
  if (lastName) result.ln = await sha256Hex(lastName);

  const city = normalizeCity(input.city);
  if (city) result.ct = await sha256Hex(city);

  const postal = normalizePostalCode(input.postal_code);
  if (postal) result.zp = await sha256Hex(postal);

  const country = normalizeCountry(input.country) || normalizeCountry(countryCode);
  if (country) result.country = await sha256Hex(country);

  // external_id: trim + lowercase, majd SHA-256. A kliens Pixelnek UGYANEZT a
  // hash-elt értéket kell küldenie a match/dedup-fallback működéséhez.
  // Hossz-korlát (256): ne hash-eljünk korlátlan attacker-stringet (DoS).
  const externalId =
    typeof input.external_id === 'string' ? input.external_id.trim().toLowerCase() : '';
  if (externalId.length > 0 && externalId.length <= 256) {
    result.external_id = await sha256Hex(externalId);
  }

  return result;
}

/**
 * Google-flavoured hashing for the Data Manager API leg. Identical to
 * {@link hashUserData} except the email uses {@link normalizeEmailForGoogle}
 * (Gmail dot/plus stripping). The hashed name fields (fn/ln) map to the
 * AddressInfo.givenName/familyName; the plain region/postal come from the
 * payload, not from here (see datamanager.ts).
 */
export async function hashUserDataForGoogle(
  input: PlainUserData,
  countryCode: CountryCode = 'GB'
): Promise<HashedUserData> {
  return hashUserData(input, countryCode, { emailNormalizer: normalizeEmailForGoogle });
}

// ── F3-A/2 · Prehashed PII contract ─────────────────────────────────────────
// The CRM outbox stores only SHA-256 hashes and sends them via `user_data_hashed`
// so the gateway does NOT re-hash (a double hash → the Meta match rate silently
// drops to zero). The CRM MUST run the SAME normalizer as hashUserData BEFORE
// hashing (email lowercase/trim, phone E.164, city keep-accents, postal
// uppercase-no-space, country ISO-2 lowercase) — else Pécs/pecs and +36/06 mismatch
// the browser Pixel's hashes and dedup/EMQ silently degrade.
const PREHASHED_FIELD_MAP: Record<string, keyof HashedUserData> = {
  sha256_email: 'em',
  sha256_phone: 'ph',
  sha256_first_name: 'fn',
  sha256_last_name: 'ln',
  sha256_city: 'ct',
  sha256_postal_code: 'zp',
  sha256_country: 'country',
  sha256_external_id: 'external_id'
};

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Validates + maps an already-hashed `user_data_hashed` input to {@link HashedUserData}.
 * Each present `sha256_*` field MUST be a 64-char lowercase hex SHA-256; anything else
 * fails loud with the offending field name (never a silent pass-through — a bad hash
 * would corrupt the match without any signal).
 *
 * UNKNOWN keys also fail loud (NOT ignored): a caller that sends the wrong key name
 * for an identity field (e.g. `email_sha256_google` instead of `sha256_email`) would
 * otherwise have that field SILENTLY dropped — the best match signal gone with zero
 * signal, worse than a 400. The contract is a fixed sha256_* key set; anything else
 * is a bug the caller must see. The gateway does NOT re-hash these values.
 */
export function mapPrehashedUserData(
  input: Record<string, unknown>
): { data: HashedUserData } | { invalidField: string } {
  const data: HashedUserData = {};
  for (const [inKey, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    const outKey = PREHASHED_FIELD_MAP[inKey];
    if (!outKey) return { invalidField: inKey };
    if (typeof v !== 'string' || !SHA256_HEX_RE.test(v)) {
      return { invalidField: inKey };
    }
    data[outKey] = v;
  }
  return { data };
}
