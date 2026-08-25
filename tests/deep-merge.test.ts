import { describe, expect, it } from 'vitest';
// @ts-expect-error — ESM script modul, típus nélkül
import { deepMerge } from '../scripts/deep-merge.mjs';

// RED-bizonyíték: az egy-szintű merge a nested map-et LECSERÉLTE (2026-08-25, painless:
// 5 offline conversion action tűnt el egy lead_qualified beírásakor).
describe('patch-site-config deepMerge', () => {
  const current = {
    site_id: 'painless',
    meta: { pixel_id: '1', access_token: 'SECRET' },
    gads: { customer_id: '4886655031', conversion_actions: { a: '1', b: '2' } },
  };

  it('adds a key inside a nested map without dropping its siblings', () => {
    const out = deepMerge(current, { gads: { conversion_actions: { lead_qualified: '9' } } });
    expect(out.gads.conversion_actions).toEqual({ a: '1', b: '2', lead_qualified: '9' });
    expect(out.gads.customer_id).toBe('4886655031');
    expect(out.meta.access_token).toBe('SECRET');
  });

  it('null deletes at any depth', () => {
    const out = deepMerge(current, { gads: { conversion_actions: { a: null } }, meta: { test_event_code: null } });
    expect(out.gads.conversion_actions).toEqual({ b: '2' });
    expect('test_event_code' in out.meta).toBe(false);
  });

  it('scalars and arrays replace, unknown parents are created', () => {
    const out = deepMerge(current, { consent: { provider: 'sbo' }, site_id: 'x', list: [1] });
    expect(out.consent).toEqual({ provider: 'sbo' });
    expect(out.site_id).toBe('x');
    expect(out.list).toEqual([1]);
  });

  it('does not mutate the input', () => {
    deepMerge(current, { gads: { conversion_actions: { z: '0' } } });
    expect(current.gads.conversion_actions).toEqual({ a: '1', b: '2' });
  });
});
