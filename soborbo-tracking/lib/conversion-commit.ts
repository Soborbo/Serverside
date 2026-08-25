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
 *      letesszük. A rejtett `event_id` mező ugyanúgy megy a backendnek, tehát a
 *      SZERVER lába változatlan.
 *   2. SIKER-OLDAL — `commitPendingConversion(eventId)`: a szerver által
 *      IGAZOLT event_id-vel. Ez a kulcs: a siker a szerver ténye, ezért a
 *      commitnak a szervertől kapott azonosítóra kell hivatkoznia.
 *
 * ⚠️ AZ event_id ÖNMAGÁBAN NEM BIZONYÍTÉK. A rejtett mező a DOM-ban van, tehát
 * bárki kiolvassa: elküldi a formot, a backend elutasítja, majd kézzel megnyitja
 * a köszönő-oldalt ugyanazzal az id-vel. Ezért az `eventId`-t a siker-oldalnak
 * ALÁÍRT, EGYSZER-HASZNÁLATOS TOKENBŐL kell kinyernie, szerver-oldalon
 * (`server/conversion-token.ts`). Ez a modul a token-ellenőrzés UTÁNI lépés.
 *
 * IDEMPOTENCIA — KÉT RÉTEG. (1) szerver: a token beváltás után halott;
 * (2) böngésző: a commit `committed` halmazt vezet, és elveszi a pending
 * rekordot. A második réteg akkor is véd, ha a site még a token nélküli,
 * átmeneti integrációt használja.
 *
 * CONSENT. A staging már consent-kapuzott, a commit pedig ÚJRA ellenőrzi: a
 * látogató a két oldalletöltés között visszavonhatta.
 *
 * TÁROLÁS ÉS PII (INV-002). A `sessionStorage`-ba tett rekord **nem tartalmaz
 * PII-t**: se e-mailt, se telefont, se nevet. Az Enhanced-Conversions identity
 * egy MODUL-PRIVÁT, memóriabeli pufferben él, ami a dokumentummal együtt
 * elszáll. Navigációs (PRG) útnál tehát a siker-oldalnak MAGÁNAK kell átadnia
 * az identityt (szerver-oldali renderből, a saját üzleti rekordjából) — vagy
 * identity nélkül commitolunk, és ezt HANGOSAN jelezzük (TRK-5002), mert az
 * gyengébb EC-match, nem hiba. Korábban itt nyers e-mail/telefon/név feküdt a
 * `sessionStorage`-ban; az INV-002 sértése volt.
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

/**
 * Az Enhanced-Conversions identity. SOHA nem kerül `sessionStorage`-ba,
 * `localStorage`-ba, URL-be, dataLayerbe vagy logba — csak a memóriabeli
 * pufferbe, illetve onnan az `events.ts` side-channeljébe.
 */
export interface ConversionIdentity {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * A TÁROLT rekord. Szándékosan PII-mentes: minden mezője vagy technikai
 * azonosító, vagy üzleti szám. A `gclid` klikk-azonosító, nem személyes
 * kontaktadat, és a kanonikus lib amúgy is tárolja (`sb_tracking`).
 */
export interface PendingConversion {
  kind: ConversionKind;
  eventId: string;
  stagedAt: number;
  value?: number;
  currency?: string;
  gclid?: string;
}

/**
 * MODUL-PRIVÁT identity-puffer. Nem `window`-ra akasztott global (azt az F12-es
 * bámészkodó és bármelyik third-party szkript olvassa), és nem is perzisztens.
 * Ugyanabban a dokumentumban élő fetch-útnál ez hordozza az EC-adatot; navigáció
 * után üres — lásd a fájl fejlécét.
 */
const identityBuffer = new Map<string, ConversionIdentity>();

/** Az identity-puffer ürítése — consent-visszavonáskor és commit után. */
function forgetIdentity(eventId?: string): void {
  if (eventId === undefined) identityBuffer.clear();
  else identityBuffer.delete(eventId);
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

/**
 * A pending lista olvasása TTL-szűréssel. Ami lejárt (vagy hibás alakú), azt a
 * megritkított listával VISSZA IS ÍRJUK, és a hozzá tartozó memóriabeli
 * identityt is elfelejtjük — egy lejárt rekord identityje ne éljen tovább a
 * pufferben a dokumentum végéig.
 */
function readPending(now: number): PendingConversion[] {
  const raw = readJson<PendingConversion[]>(PENDING_KEY, []);
  const kept = raw.filter(
    (p) => p && typeof p.eventId === 'string' && now - p.stagedAt < PENDING_TTL_MS
  );
  if (kept.length !== raw.length) {
    const live = new Set(kept.map((p) => p.eventId));
    for (const id of [...identityBuffer.keys()]) if (!live.has(id)) forgetIdentity(id);
    writeJson(PENDING_KEY, kept);
  }
  return kept;
}

/**
 * Marketing-consent visszavonásakor a letett (még el nem sütött) konverziók
 * ELDOBÁSA — a tárból ÉS a memóriabeli identity-pufferből egyaránt.
 */
export function discardPendingConversions(): void {
  forgetIdentity();
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode / nincs sessionStorage — nincs mit törölni */
  }
}

/**
 * A konverzió LETÉTELE tüzelés nélkül. A hívó felelőssége, hogy csak
 * marketing-hozzájárulás mellett hívja — a commit ezt még egyszer ellenőrzi.
 *
 * Az `identity` OPCIONÁLIS, és NEM íródik tárba: csak a memóriabeli pufferbe
 * kerül, hogy az azonos dokumentumban záruló (fetch) út EC-adattal commitolhasson.
 */
export function stagePendingConversion(
  entry: Omit<PendingConversion, 'stagedAt'>,
  identity?: ConversionIdentity,
): void {
  const now = Date.now();
  const list = readPending(now).filter((p) => p.eventId !== entry.eventId);
  list.push({ ...entry, stagedAt: now });
  const kept = list.slice(-PENDING_MAX);
  // A plafon miatt kieső rekordok identityjét is elengedjük.
  const live = new Set(kept.map((p) => p.eventId));
  for (const id of [...identityBuffer.keys()]) if (!live.has(id)) forgetIdentity(id);
  writeJson(PENDING_KEY, kept);
  if (identity && hasAnyIdentityField(identity)) identityBuffer.set(entry.eventId, identity);
}

function hasAnyIdentityField(i: ConversionIdentity): boolean {
  return !!(i.email || i.phone || i.firstName || i.lastName);
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
 * A letett konverzió TÜZELÉSE — a siker-oldalon, a SZERVER által IGAZOLT
 * event_id-vel (lásd `server/conversion-token.ts`). A visszatérési érték
 * megnevezi, mi történt: néma no-op nincs.
 *
 * @param identity  Enhanced-Conversions adat a siker-oldal szerver-oldali
 *   renderjéből. Navigációs úton ez az EGYETLEN forrás (a memóriabeli puffer
 *   elszállt a dokumentummal). Ha nincs, a konverzió akkor is elmegy — csak
 *   gyengébb EC-match-csel, és ezt TRK-5002 jelzi.
 */
export function commitPendingConversion(
  eventId: string,
  identity?: ConversionIdentity,
): CommitOutcome {
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
    forgetIdentity(eventId);
    writeJson(PENDING_KEY, list.filter((p) => p.eventId !== eventId));
    report('CONVERSION_COMMIT_CONSENT_REVOKED', { eventId });
    return 'consent_revoked';
  }

  // Sorrend: az explicit (siker-oldali, szerver-rendered) identity ÜT, mert az
  // a business rekordból jön; a memóriabeli puffer csak az azonos dokumentumban
  // záruló fetch-útnál él.
  const id: ConversionIdentity = identity ?? identityBuffer.get(eventId) ?? {};
  if (!hasAnyIdentityField(id)) {
    report('CONVERSION_COMMIT_WITHOUT_IDENTITY', { eventId, kind: entry.kind });
  }

  const data = {
    email: id.email ?? '',
    phone: id.phone,
    firstName: id.firstName,
    lastName: id.lastName,
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
  forgetIdentity(eventId);
  writeJson(PENDING_KEY, list.filter((p) => p.eventId !== eventId));
  report('CONVERSION_COMMITTED', { eventId, kind: entry.kind });
  return 'committed';
}

/** Teszt/diagnosztika: mi vár commitra. A visszaadott rekordok PII-mentesek. */
export function peekPendingConversions(): PendingConversion[] {
  return readPending(Date.now());
}

/**
 * Teszt/diagnosztika: van-e memóriabeli EC-identity ehhez az event_id-hez.
 * Magát az adatot SZÁNDÉKOSAN nem adjuk vissza — a puffer modul-privát marad.
 */
export function hasBufferedIdentity(eventId: string): boolean {
  return identityBuffer.has(eventId);
}
