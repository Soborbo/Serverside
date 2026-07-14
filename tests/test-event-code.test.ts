import { describe, it, expect } from 'vitest';
import { isValidConversionPayload } from '../src/types';

/**
 * A per-request `test_event_code` a szintetikus proof-eventek EGYETLEN biztonságos
 * útja. A KV `meta.test_event_code` nem az: a site-config edge-cache-elt (300s),
 * tehát a „beírom KV-be → azonnal lövök" minta egy még régi configot látó PoP-on a
 * PRODUCTION stream-be viszi a teszt-eventet (így szivárgott 2 szintetikus event a
 * Painless prodba), a kivétele után pedig még percekig VALÓDI leadek mehetnek a
 * Test stream-be.
 *
 * A route-szintű kapu (csak `serverAuth === 'valid'` esetén megy tovább) a
 * conversion-route tesztekben él; itt a payload-kontraktus van leszögezve.
 */
function base() {
  return {
    event_name: 'quote_calculator_submitted',
    event_id: 'evt-123',
    event_time: Math.floor(Date.now() / 1000)
  };
}

describe('test_event_code — payload-kontraktus', () => {
  it('elfogadja a Meta-formátumú kódot', () => {
    expect(isValidConversionPayload({ ...base(), test_event_code: 'TEST12345' })).toBe(true);
  });

  it('opcionális — a hiánya nem érvényteleníti a payloadot', () => {
    expect(isValidConversionPayload(base())).toBe(true);
  });

  it('elutasítja a nem-string / üres / túl hosszú kódot', () => {
    expect(isValidConversionPayload({ ...base(), test_event_code: 123 })).toBe(false);
    expect(isValidConversionPayload({ ...base(), test_event_code: '' })).toBe(false);
    expect(isValidConversionPayload({ ...base(), test_event_code: 'A'.repeat(41) })).toBe(false);
  });

  it('elutasítja a charseten kívüli kódot (injection-felület zárva)', () => {
    expect(isValidConversionPayload({ ...base(), test_event_code: 'TEST 123' })).toBe(false);
    expect(isValidConversionPayload({ ...base(), test_event_code: 'TEST"123' })).toBe(false);
  });
});
