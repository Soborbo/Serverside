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
}

export interface HashedUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  zp?: string;
  country?: string;
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

export function normalizePhone(
  phone: string | null | undefined,
  countryCode: CountryCode = 'GB'
): string | undefined {
  if (typeof phone !== 'string') return undefined;
  let cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.length === 0) return undefined;

  if (cleaned.startsWith('+')) {
    // Drop UK trunk prefix `(0)` when the international code is already present
    // (e.g. `+44 (0)7123 456 789` strips to `+4407123456789`, which is invalid;
    // CLAUDE.md mandates the result to be `+447123456789`).
    if (cleaned.startsWith('+440')) {
      cleaned = '+44' + cleaned.slice(4);
    }
    if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
    return undefined;
  }

  if (countryCode === 'GB' || countryCode === 'EU') {
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
    cleaned = '+' + cleaned;
  }

  if (!/^\+\d{8,15}$/.test(cleaned)) return undefined;
  return cleaned;
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

export function normalizeCountry(country: string | null | undefined): string | undefined {
  if (typeof country !== 'string') return undefined;
  const trimmed = country.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  if (trimmed.length === 2 && /^[a-z]{2}$/.test(trimmed)) return trimmed;
  if (trimmed.length === 3 && /^[a-z]{3}$/.test(trimmed)) {
    return COUNTRY_3_TO_2[trimmed.toUpperCase()] || undefined;
  }
  return COUNTRY_NAME_TO_2[trimmed] || undefined;
}

export async function hashUserData(
  input: PlainUserData,
  countryCode: CountryCode = 'GB'
): Promise<HashedUserData> {
  const result: HashedUserData = {};

  const email = normalizeEmail(input.email);
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

  return result;
}
