/**
 * PECR read-gate telemetria (2. brief, S2) — a payload `storage_read_blocked` /
 * `storage_read_blocked_keys` mezőinek validálása.
 *
 * MIT MÉR: a kliens mostantól a storage OLVASÁSÁT is consent mögé zárja. Ha a
 * CookieYes JS API még nem töltött be, a kliens-kapu prod-ban deny-all-t ad —
 * vagyis egy BELEEGYEZŐ látogatónál is blokkolhatja a gclid/fbclid olvasását.
 * Ez csendes attribúcióvesztés lenne, ezért minden blokkolt olvasás jelez.
 *
 * KÜLÖN MODUL, szándékosan: a Fázis D `lib/consent.ts`-e és a `conversion.ts`
 * consent-kapuja érintetlen marad. Ez a mező nem consent-döntés, hanem
 * kliens-oldali megfigyelés.
 *
 * Sosem dob és sosem utasít el eventet: rossz forma → „nem jelentett" (NULL).
 */

/** Kulcsnév-korlátok. Kulcsokat tárolunk, sosem értékeket — PII nem kerülhet ide. */
const MAX_KEYS = 12;
const MAX_KEY_LEN = 32;
const KEY_RE = /^[A-Za-z0-9_.-]+$/;

export interface StorageReadTelemetry {
  /** 0/1 a receipten. */
  blocked: boolean;
  /** Vesszős kulcslista a receipten, vagy undefined, ha nincs egy sem. */
  keys?: string;
}

/**
 * `undefined` = a kliens NEM jelentett (régi lib, vagy szerver-ingress, ahol
 * nincs böngésző-storage). Ez NEM azonos a „jelentett, és nem volt blokk"
 * esettel — a receipten az egyik NULL, a másik 0.
 */
export function parseStorageReadTelemetry(
  rawBlocked: unknown,
  rawKeys: unknown
): StorageReadTelemetry | undefined {
  const hasBlocked = typeof rawBlocked === 'boolean';
  const keys = Array.isArray(rawKeys)
    ? rawKeys
        .filter((k): k is string => typeof k === 'string' && k.length > 0)
        .map((k) => k.slice(0, MAX_KEY_LEN))
        .filter((k) => KEY_RE.test(k))
        .slice(0, MAX_KEYS)
    : [];
  if (!hasBlocked && keys.length === 0) return undefined;
  return {
    // A kulcslista jelenléte önmagában is blokkot bizonyít — egy hiányzó/rossz
    // boolean mellett sem veszhet el a jel.
    blocked: rawBlocked === true || keys.length > 0,
    keys: keys.length > 0 ? keys.join(',') : undefined
  };
}
