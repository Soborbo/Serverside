import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendToMetaCAPI } from '../src/lib/meta';
import type { SiteConfig } from '../src/lib/config';

/**
 * Egy site bekötése MEGELŐZI a Meta CAPI access tokent: a tokent kézzel állítják ki
 * az Events Managerben, tehát mindig késik a huzalozáshoz képest (lomtalan, 2026-07).
 *
 * A `meta` blokk ezért opcionális. A helyettesítő megoldás — placeholder token — aktívan
 * káros: minden konverzió 401-et kapna a Metától, DLQ-t töltene és riasztana, vagyis a
 * site ROMLOTTNAK látszana ahelyett, hogy egyszerűen „még nincs kész".
 */
const base: SiteConfig = {
  site_id: 'lomtalan',
  country_code: 'HU',
  currency: 'HUF',
  gads: { customer_id: null, login_customer_id: null }
} as unknown as SiteConfig;

afterEach(() => vi.restoreAllMocks());

describe('Meta CAPI — opcionális `meta` blokk', () => {
  it('meta nélkül SKIP: nincs hálózati hívás, és NEM hiba (nincs DLQ/riasztás)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await sendToMetaCAPI(base, {
      event_name: 'contact_form_submitted',
      event_id: 'evt-1',
      event_time: Math.floor(Date.now() / 1000)
    }, {});

    // A siker itt „tisztán kimaradt"-at jelent — a fan-out ettől nem ír DLQ-t.
    // A `skipped: true` kötelező: a ledger e nélkül 'accepted'-et írna http_status
    // nélkül (a lomtalan 2026-07-14-i hamis-siker esete).
    expect(res.success).toBe(true);
    expect(res.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('meta blokkal viszont TÉNYLEG hív (a skip nem nyeli el az igazi konfigot)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'x' }), { status: 200 })
    );

    const withMeta = {
      ...base,
      meta: { pixel_id: '1703109317460682', access_token: 'tok' }
    } as unknown as SiteConfig;

    const res = await sendToMetaCAPI(withMeta, {
      event_name: 'contact_form_submitted',
      event_id: 'evt-2',
      event_time: Math.floor(Date.now() / 1000)
    }, {});

    expect(res.success).toBe(true);
    expect(res.events_received).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('1703109317460682');
  });
});
