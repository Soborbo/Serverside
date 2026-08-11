import { describe, it, expect } from 'vitest';
import { parseEcommerce } from '../src/lib/ecommerce';

describe('parseEcommerce — catalog params for webshop tenants', () => {
  it('returns empty params for a lead-gen payload (no ecommerce fields)', () => {
    const { params, dropped } = parseEcommerce({});
    expect(params).toEqual({});
    expect(dropped).toEqual([]);
  });

  it('parses a well-formed contents array and defaults content_type to product', () => {
    const { params, dropped } = parseEcommerce({
      contents: [
        { id: 'T18-ANTRACIT', quantity: 12, item_price: 4990 },
        { id: 'CSAVAR-WOOD', quantity: 200, item_price: 39 }
      ]
    });
    expect(params.contents).toEqual([
      { id: 'T18-ANTRACIT', quantity: 12, item_price: 4990 },
      { id: 'CSAVAR-WOOD', quantity: 200, item_price: 39 }
    ]);
    expect(params.content_type).toBe('product');
    expect(dropped).toEqual([]);
  });

  it('keeps item_price: 0 (a genuinely free line item) but drops quantity: 0', () => {
    const { params } = parseEcommerce({ contents: [{ id: 'X', quantity: 0, item_price: 0 }] });
    expect(params.contents).toEqual([{ id: 'X', item_price: 0 }]);
  });

  // A formahibás katalógus-mező a MEZŐT viszi el, nem a konverziót — ugyanaz a
  // szabály, mint a lead_id-nál. Ezt a teszt tartja életben.
  it('drops malformed items but keeps the valid ones', () => {
    const { params, dropped } = parseEcommerce({
      contents: [
        { id: 'GOOD', quantity: 1 },
        { quantity: 5 }, // id nélkül értelmetlen
        'not-an-object',
        { id: '   ' }
      ]
    });
    expect(params.contents).toEqual([{ id: 'GOOD', quantity: 1 }]);
    expect(dropped).toContain('contents:3_malformed_items');
  });

  it('reports when every item was malformed instead of silently sending nothing', () => {
    const { params, dropped } = parseEcommerce({ contents: [{ quantity: 1 }] });
    expect(params.contents).toBeUndefined();
    expect(dropped).toContain('contents:empty_after_parse');
  });

  it('rejects a non-array contents without touching the rest of the payload', () => {
    const { params, dropped } = parseEcommerce({ contents: { id: 'X' }, order_id: 'ORD-1' });
    expect(params.contents).toBeUndefined();
    expect(params.order_id).toBe('ORD-1');
    expect(dropped).toContain('contents');
  });

  it('truncates oversized arrays and says so', () => {
    const contents = Array.from({ length: 150 }, (_, i) => ({ id: `SKU-${i}` }));
    const { params, dropped } = parseEcommerce({ contents });
    expect(params.contents).toHaveLength(100);
    expect(dropped).toContain('contents:truncated');
  });

  it('accepts flat content_ids as the fallback form', () => {
    const { params } = parseEcommerce({ content_ids: ['A', 'B', '  C  '] });
    expect(params.content_ids).toEqual(['A', 'B', 'C']);
    expect(params.content_type).toBe('product');
  });

  it('only allows the two content_type values Meta understands', () => {
    expect(parseEcommerce({ content_type: 'product_group' }).params.content_type).toBe(
      'product_group'
    );
    const bogus = parseEcommerce({ content_ids: ['A'], content_type: 'widget' });
    // Érvénytelen típus → eldobva, majd a default lép be (van mit típusozni).
    expect(bogus.params.content_type).toBe('product');
    expect(bogus.dropped).toContain('content_type');
  });

  it('validates order_id charset and length', () => {
    expect(parseEcommerce({ order_id: 'TLZ_2026-0001' }).params.order_id).toBe('TLZ_2026-0001');
    expect(parseEcommerce({ order_id: 'bad id!' }).dropped).toContain('order_id');
    expect(parseEcommerce({ order_id: 'x'.repeat(65) }).dropped).toContain('order_id');
  });

  it('requires num_items to be a positive integer', () => {
    expect(parseEcommerce({ num_items: 3 }).params.num_items).toBe(3);
    expect(parseEcommerce({ num_items: 2.5 }).dropped).toContain('num_items');
    expect(parseEcommerce({ num_items: 0 }).dropped).toContain('num_items');
    expect(parseEcommerce({ num_items: -1 }).dropped).toContain('num_items');
  });

  it('does not invent a content_type when there is nothing to type', () => {
    const { params } = parseEcommerce({ order_id: 'ORD-9' });
    expect(params.content_type).toBeUndefined();
  });
});
