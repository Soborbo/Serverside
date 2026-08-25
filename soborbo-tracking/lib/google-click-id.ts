/**
 * A GOOGLE KLIKK-AZONOSÍTÓ SZABÁLYA — EGY AUTHORITY.
 *
 * ── Miért külön modul ────────────────────────────────────────────────────────
 * Ez a szabály eddig HÁROM helyen élt: a kanonikus `gateway.ts`-ben, a painless
 * `utm-capture.ts`-ében, és implicit feltevésként a painless
 * `calculator-store.ts` kommentjében. A három példány már bizonyítottan
 * szétsodródott — a `_gcl_aw` cookie-fallback sorrendjét a painless #39
 * javította, a kanonikus mag nem, és az F9/3.4 delegálás vissza is hozta a
 * hibát a site-ra (Serverside #100 / 6.4.1).
 *
 * Ezért a szabály innentől PURE FÜGGVÉNY, DOM nélkül: bármelyik tároló-modell
 * (a gateway last-touch `localStorage`-a, a painless first-touch
 * `sessionStorage`-a) használhatja, anélkül hogy a döntést újraírná.
 *
 * ── A szabály maga ───────────────────────────────────────────────────────────
 * 1. KÖLCSÖNÖS KIZÁRÁS. Egy kattintás `gclid`-et VAGY `gbraid`-et VAGY
 *    `wbraid`-et ad, sosem többet. Ha mégis több van, determinisztikusan
 *    választunk: `gclid` > `gbraid` > `wbraid`.
 * 2. FORRÁS-SORREND. URL > `_gcl_aw` cookie > tároló. Az URL a MOSTANI
 *    kattintás; a cookie és a tároló egy KORÁBBIÉ. Fordított sorrendnél egy
 *    visszatérő fizetett látogatónál az elavult ID nyerne — pont ez volt a
 *    #100 hibája.
 * 3. A COOKIE CSAK VÉGSŐ MENTSVÁR AZ URL UTÁN. Nem azért, mert rosszabb, hanem
 *    mert a `_gcl_aw` mindig `gclid`-et hordoz: ha az URL `gbraid`-et hozott, a
 *    cookie gclid-je a prioritási sorrend miatt LEVERNÉ a frisset.
 *
 * ── Miért drága, ha elromlik ─────────────────────────────────────────────────
 * Az offline / Enhanced Conversions feltöltés ezekből köti a konverziót a
 * kattintáshoz. Rossz ID mellett a vendor a rossz kattintáshoz köt — némán, a
 * riportokban egészségesnek látszó módon.
 */

export const GOOGLE_CLICK_KEYS = ['gclid', 'gbraid', 'wbraid'] as const;

export type GoogleClickKey = (typeof GOOGLE_CLICK_KEYS)[number];

/** Melyik forrásból jött a győztes — a hívó telemetriájához, nem döntéshez. */
export type GoogleClickSource = 'url' | 'gcl_aw_cookie' | 'stored';

export interface ResolvedGoogleClickId {
  key: GoogleClickKey;
  value: string;
  source: GoogleClickSource;
}

/**
 * Egy olvasható kulcs-érték forrás. Szándékosan megengedő: `URLSearchParams`,
 * sima objektum (a tárolóból kiolvasott JSON), vagy függvény is lehet — a
 * hívónak nem kell a saját alakját a mienkre konvertálnia.
 */
export type ClickIdSource =
  | URLSearchParams
  | Record<string, string | null | undefined>
  | ((key: string) => string | null | undefined)
  | null
  | undefined;

function reader(source: ClickIdSource): (key: string) => string | undefined {
  if (!source) return () => undefined;
  if (typeof source === 'function') return (k) => source(k) || undefined;
  if (typeof URLSearchParams !== 'undefined' && source instanceof URLSearchParams) {
    return (k) => source.get(k) || undefined;
  }
  const obj = source as Record<string, string | null | undefined>;
  return (k) => obj[k] || undefined;
}

/**
 * A `_gcl_aw` süti gclid-je. Formátum: `GCL.<timestamp>.<gclid>` — a gclid maga
 * is tartalmazhat pontot, ezért a harmadik szegmenstől MINDENT visszaadunk.
 */
export function parseGclAwCookie(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split('.');
  return parts.length >= 3 ? parts.slice(2).join('.') || undefined : undefined;
}

/**
 * EGY forrásból a győztes klikk-ID (`gclid` > `gbraid` > `wbraid`).
 * Nem néz más forrásba — a forrás-sorrendet a `resolveGoogleClickId` intézi.
 */
export function pickGoogleClickId(
  source: ClickIdSource
): { key: GoogleClickKey; value: string } | undefined {
  const get = reader(source);
  for (const key of GOOGLE_CLICK_KEYS) {
    const value = get(key);
    if (value) return { key, value };
  }
  return undefined;
}

/**
 * A TELJES szabály: kölcsönös kizárás + forrás-sorrend.
 *
 * @param input.url    a mostani oldalbetöltés query-paraméterei (ha van hozzá jog)
 * @param input.stored a korábban eltárolt attribúció (bármilyen tároló-modell)
 * @param input.gclAw  a `_gcl_aw` süti NYERS értéke (`GCL.<ts>.<gclid>`)
 *
 * Egy forrást úgy zársz ki, hogy nem adod át — például consent hiányában az
 * `url`/`gclAw` elhagyásával a tárolt érték marad az egyetlen jelölt.
 */
export function resolveGoogleClickId(input: {
  url?: ClickIdSource;
  stored?: ClickIdSource;
  gclAw?: string | null;
}): ResolvedGoogleClickId | undefined {
  const fromUrl = pickGoogleClickId(input.url);
  if (fromUrl) return { ...fromUrl, source: 'url' };

  const fromCookie = parseGclAwCookie(input.gclAw);
  if (fromCookie) return { key: 'gclid', value: fromCookie, source: 'gcl_aw_cookie' };

  const fromStore = pickGoogleClickId(input.stored);
  if (fromStore) return { ...fromStore, source: 'stored' };

  return undefined;
}

/**
 * A megoldott ID beírása egy attribúció-objektumba úgy, hogy a TESTVÉREK
 * eltűnnek. Ez a tároló-oldali fele a szabálynak: enélkül a kulcsonkénti merge
 * két, egymásnak ellentmondó klikk-ID-t hagyna a rekordban.
 *
 * `resolved === undefined` → MINDEN Google klikk-ID törlődik. Ezért csak akkor
 * hívd így, ha tényleg nem szabad egyiknek sem maradnia (pl. consent-visszavonás);
 * ha csak „most nem jött friss jel", add át a tárolót `stored`-ként a
 * `resolveGoogleClickId`-nek, és az megőrzi a korábbit.
 */
export function applyGoogleClickId<T extends Record<string, unknown>>(
  target: T,
  resolved: ResolvedGoogleClickId | undefined
): T {
  for (const k of GOOGLE_CLICK_KEYS) {
    if (!resolved || k !== resolved.key) delete (target as Record<string, unknown>)[k];
  }
  if (resolved) (target as Record<string, unknown>)[resolved.key] = resolved.value;
  return target;
}
