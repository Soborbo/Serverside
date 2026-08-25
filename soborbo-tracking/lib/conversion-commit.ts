/**
 * P5 — `commit-after-business-success`: a böngésző-konverzió a BACKEND SIKERE
 * után égjen el, ne előtte.
 *
 * A HIBA, AMIT ZÁR. Klasszikus (natív navigációs) form-submitnél a sorrend ma:
 *   validate → dataLayer push (a konverzió MEGTÖRTÉNT) → 600 ms → POST → backend
 * Ha a backend 500-at ad, szerver-oldali validáció bukik, vagy a hálózat elszáll,
 * a Meta már számolt egy Leadet, amihez SOHA nem érkezik CAPI-pár — fantom
 * konverzió, ami a dedup-partner hiánya miatt nem is tűnik el magától.
 *
 * MIÉRT NEM ELÉG „await a fetch-re". Natív form-submitnél a lap NAVIGÁL: nincs
 * „siker utáni" pillanat ugyanabban a dokumentumban. Ezért kétfázisú:
 *
 *   1. SUBMIT — `stagePendingConversion()`: a konverziót NEM tüzeljük, csak
 *      letesszük (event_id + a push-hoz kellő mezők). A rejtett `event_id` mező
 *      ugyanúgy megy a backendnek, tehát a SZERVER lába változatlan.
 *   2. SIKER-OLDAL — `commitPendingConversion(eventId)`: a szerver által
 *      VISSZAADOTT event_id-vel. Ez a kulcs: a siker a szerver ténye, ezért a
 *      commitnak a szervertől kapott azonosítóra kell hivatkoznia. Egy
 *      paraméter nélküli „commit()" azt jelentené, hogy minden oldalletöltés
 *      sikernek számít — vagyis semmit nem javítanánk.
 *
 * IDEMPOTENCIA. A köszönő-oldal újratöltése NEM tüzelhet másodszor: a commit egy
 * `committed` halmazt vezet, és a pending rekordot elveszi. Ugyanaz az elv, mint
 * a klikk-dedupnál.
 *
 * CONSENT. A staging már consent-kapuzott (a hívó csak akkor stage-el, ha van
 * marketing-hozzájárulás), a commit pedig ÚJRA ellenőrzi: a látogató a két
 * oldalletöltés között visszavonhatta, és akkor a konverzió nem éghet el.
 *
 * TÁROLÁS. `sessionStorage`, mert a lánc egyetlen látogatáson belül zárul, és a
 * pending rekord így nem él túl egy böngésző-bezárást. Nem PII: a payload a
 * form mezőiből származó identity — ugyanaz, ami a dataLayer pushba menne —,
 * ezért TTL-lel és darabszám-plafonnal korlátozzuk.
 */

import { hasMarketingConsent } from './consent';
import { pushLeadConversion, pushContactConversion } from './events';
import { report } from './observability';

const PENDING_KEY = 'sb_pending_conversion';
const COMMITTED_KEY = 'sb_committed_conversion';

/** Egy pending rekord ennél tovább nem érdekes: a form és a siker-oldal közti út percek. */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** Elszabadult kliens ne tölthesse tele a tárat. */
const PENDING_MAX = 5;
/** Ennyi commit-azonosítót őrzünk az újratöltés-védelemhez. */
const COMMITTED_MAX = 20;

export type ConversionKind = 'lead' | 'contact';

export interface PendingConversion {
  kind: ConversionKind;
  eventId: string;
  stagedAt: number;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  value?: number;
  currency?: string;
  gclid?: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown[]): void {
  try {
    if (value.length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / kvóta — a commit ilyenkor nem tud lefutni, ami a BIZTONSÁGOS irány */
  }
}

function readPending(now: number): PendingConversion[] {
  return readJson<PendingConversion[]>(PENDING_KEY, []).filter(
    (p) => p && typeof p.eventId === 'string' && now - p.stagedAt < PENDING_TTL_MS
  );
}

/**
 * A konverzió LETÉTELE tüzelés nélkül. A hívó felelőssége, hogy csak
 * marketing-hozzájárulás mellett hívja (a `trackLeadSubmit` szerződésével
 * egyezően) — a commit ezt még egyszer ellenőrzi.
 */
export function stagePendingConversion(entry: Omit<PendingConversion, 'stagedAt'>): void {
  const now = Date.now();
  const list = readPending(now).filter((p) => p.eventId !== entry.eventId);
  list.push({ ...entry, stagedAt: now });
  writeJson(PENDING_KEY, list.slice(-PENDING_MAX));
}

function alreadyCommitted(eventId: string): boolean {
  return readJson<string[]>(COMMITTED_KEY, []).includes(eventId);
}

function markCommitted(eventId: string): void {
  const list = readJson<string[]>(COMMITTED_KEY, []).filter((id) => id !== eventId);
  list.push(eventId);
  writeJson(COMMITTED_KEY, list.slice(-COMMITTED_MAX));
}

export type CommitOutcome =
  | 'committed'
  | 'no_pending'
  | 'already_committed'
  | 'consent_revoked'
  | 'invalid_event_id';

/**
 * A letett konverzió TÜZELÉSE — a siker-oldalon, a SZERVER által visszaadott
 * event_id-vel. A visszatérési érték megnevezi, mi történt: néma no-op nincs.
 */
export function commitPendingConversion(eventId: string): CommitOutcome {
  if (typeof eventId !== 'string' || eventId.length === 0) return 'invalid_event_id';
  if (typeof sessionStorage === 'undefined') return 'no_pending';

  if (alreadyCommitted(eventId)) return 'already_committed';

  const now = Date.now();
  const list = readPending(now);
  const entry = list.find((p) => p.eventId === eventId);
  if (!entry) return 'no_pending';

  // A látogató a form és a siker-oldal között visszavonhatta a hozzájárulást.
  // Ilyenkor a pending rekordot IS eldobjuk — nem tartunk életben olyan
  // konverziót, amire már nincs jogalap.
  if (!hasMarketingConsent()) {
    writeJson(PENDING_KEY, list.filter((p) => p.eventId !== eventId));
    report('CONVERSION_COMMIT_CONSENT_REVOKED', { eventId });
    return 'consent_revoked';
  }

  const data = {
    email: entry.email ?? '',
    phone: entry.phone,
    firstName: entry.firstName,
    lastName: entry.lastName,
    value: entry.value,
    currency: entry.currency,
    gclid: entry.gclid,
    eventId: entry.eventId
  };

  if (entry.kind === 'contact') pushContactConversion(data);
  else pushLeadConversion(data);

  // Előbb a jelölés, aztán a takarítás: ha az írás félúton elhasal, inkább
  // maradjon egy pending rekord (ami TTL-lel elévül), mint hogy egy újratöltés
  // másodszor is tüzeljen.
  markCommitted(eventId);
  writeJson(PENDING_KEY, list.filter((p) => p.eventId !== eventId));
  report('CONVERSION_COMMITTED', { eventId, kind: entry.kind });
  return 'committed';
}

/** Teszt/diagnosztika: mi vár commitra. */
export function peekPendingConversions(): PendingConversion[] {
  return readPending(Date.now());
}
