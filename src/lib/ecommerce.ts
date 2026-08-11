/**
 * E-kereskedelmi katalógus-paraméterek (webshop tenantok).
 *
 * A fleet első nyolc site-ja lead-gen volt: a konverzió maga a lead, nincs mögötte
 * termék. Egy webshopnál (trapezlemezes.hu) a `purchase` / `order_request_submitted`
 * event ENÉLKÜL is megérkezik a Metához, csak épp nem köthető katalógus-tételhez —
 * a dinamikus remarketing (Advantage+ katalógus) és a termékszintű ROAS így némán
 * üres marad. Nem hibát dob: egyszerűen nincs adat, ami a legrosszabb hibafajta.
 *
 * PARSE-OLÁS, NEM ELUTASÍTÁS. Ugyanaz a szabály, mint a `lead_id`-nál és a
 * `lead_provenance`-nél: ha a katalógus-mező formája rossz, a MEZŐT dobjuk el, nem
 * a konverziót. Egy elrontott `contents` tömb miatt elveszíteni egy valódi
 * purchase-t nagyságrendekkel drágább, mint elveszíteni a termék-attribúciót.
 *
 * NEM PII: cikkszám, darabszám, egységár. A user_data-tól teljesen külön úton megy.
 */

/** Egy katalógus-tétel a Meta `contents` tömbjében. */
export interface EcommerceContent {
  /** A katalógus `retailer_id`-ja. Ha nem egyezik, a Meta nem találja meg a terméket. */
  id: string;
  quantity?: number;
  item_price?: number;
}

export interface EcommerceParams {
  contents?: EcommerceContent[];
  content_ids?: string[];
  content_type?: 'product' | 'product_group';
  num_items?: number;
  order_id?: string;
}

// Bounds. A body-cap (MAX_BODY_BYTES) már véd az óriás payload ellen; ezek a
// korlátok a Meta felé menő tömb méretét fogják, és azt, hogy egy elszabadult
// kosár ne írjon 10 ezer soros custom_data-t.
const MAX_CONTENTS = 100;
const MAX_ID_LENGTH = 100;
const MAX_QUANTITY = 100_000;
const MAX_ITEM_PRICE = 1_000_000_000;
const MAX_ORDER_ID_LENGTH = 64;
const ORDER_ID_RE = /^[A-Za-z0-9_-]+$/;

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return trimmed;
}

/** Nemnegatív, véges szám a megadott felső korlátig; egyébként undefined. */
function boundedNumber(value: unknown, max: number, integer: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > max) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  return value;
}

/**
 * Kiszedi az érvényes katalógus-mezőket a nyers payloadból.
 *
 * A `dropped` a route strukturált warn-logjához kell: egy csendben eltűnő
 * `contents` ugyanolyan néma hiba, mint amit ez a modul elkerülni hivatott —
 * a kimaradásnak nyoma kell maradjon.
 */
export function parseEcommerce(payload: {
  contents?: unknown;
  content_ids?: unknown;
  content_type?: unknown;
  num_items?: unknown;
  order_id?: unknown;
}): { params: EcommerceParams; dropped: string[] } {
  const params: EcommerceParams = {};
  const dropped: string[] = [];

  if (payload.contents !== undefined) {
    if (!Array.isArray(payload.contents)) {
      dropped.push('contents');
    } else {
      const items: EcommerceContent[] = [];
      let malformed = 0;
      for (const raw of payload.contents.slice(0, MAX_CONTENTS)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          malformed++;
          continue;
        }
        const row = raw as Record<string, unknown>;
        const id = cleanId(row.id);
        // id nélkül a tétel értelmetlen a Metának — a quantity/item_price
        // önmagában nem köt semmit a katalógushoz.
        if (!id) {
          malformed++;
          continue;
        }
        const item: EcommerceContent = { id };
        const quantity = boundedNumber(row.quantity, MAX_QUANTITY, true);
        if (quantity !== undefined && quantity > 0) item.quantity = quantity;
        const itemPrice = boundedNumber(row.item_price, MAX_ITEM_PRICE, false);
        if (itemPrice !== undefined) item.item_price = itemPrice;
        items.push(item);
      }
      if (payload.contents.length > MAX_CONTENTS) dropped.push('contents:truncated');
      if (malformed > 0) dropped.push(`contents:${malformed}_malformed_items`);
      if (items.length > 0) params.contents = items;
      else if (payload.contents.length > 0) dropped.push('contents:empty_after_parse');
    }
  }

  if (payload.content_ids !== undefined) {
    if (!Array.isArray(payload.content_ids)) {
      dropped.push('content_ids');
    } else {
      const ids: string[] = [];
      for (const raw of payload.content_ids.slice(0, MAX_CONTENTS)) {
        const id = cleanId(raw);
        if (id) ids.push(id);
      }
      if (payload.content_ids.length > MAX_CONTENTS) dropped.push('content_ids:truncated');
      if (ids.length > 0) params.content_ids = ids;
      else if (payload.content_ids.length > 0) dropped.push('content_ids:empty_after_parse');
    }
  }

  if (payload.content_type !== undefined) {
    if (payload.content_type === 'product' || payload.content_type === 'product_group') {
      params.content_type = payload.content_type;
    } else {
      dropped.push('content_type');
    }
  }

  if (payload.num_items !== undefined) {
    const n = boundedNumber(payload.num_items, MAX_QUANTITY, true);
    if (n !== undefined && n > 0) params.num_items = n;
    else dropped.push('num_items');
  }

  if (payload.order_id !== undefined) {
    const oid = typeof payload.order_id === 'string' ? payload.order_id.trim() : '';
    if (oid && oid.length <= MAX_ORDER_ID_LENGTH && ORDER_ID_RE.test(oid)) {
      params.order_id = oid;
    } else {
      dropped.push('order_id');
    }
  }

  // `contents` jelen van, de `content_type` nincs → 'product' az értelmes default
  // (a Meta enélkül nem tudja, mit jelentenek az id-k). Csak akkor tesszük hozzá,
  // ha tényleg van mit típusozni.
  if ((params.contents || params.content_ids) && !params.content_type) {
    params.content_type = 'product';
  }

  return { params, dropped };
}
