import { describe, it, expect } from 'vitest';
import {
  readGa4IdsFromCookie,
  buildGatewayPayload
} from '../soborbo-tracking/server/backend/gateway-dispatch';

const MEASUREMENT_ID = 'G-5M0YZ8WPPK';

describe('readGa4IdsFromCookie', () => {
  it('extracts the client_id from the _ga cookie', () => {
    const { clientId } = readGa4IdsFromCookie('_ga=GA1.1.1234567890.1714400000', MEASUREMENT_ID);
    expect(clientId).toBe('1234567890.1714400000');
  });

  it('extracts the session_id from the _ga_<container> cookie', () => {
    const cookie = '_ga=GA1.1.111.222; _ga_5M0YZ8WPPK=GS1.1.1714400123.3.1.1714400200.60.0.0';
    const { clientId, sessionId } = readGa4IdsFromCookie(cookie, MEASUREMENT_ID);
    expect(clientId).toBe('111.222');
    expect(sessionId).toBe('1714400123');
  });

  it('handles the 2-segment _ga variant gtag mints on some domains', () => {
    // GA1.<scope>.<random>.<timestamp> where scope itself has a dot (GA1.2.1)
    const { clientId } = readGa4IdsFromCookie('_ga=GA1.2.1.987654321.1700000000', MEASUREMENT_ID);
    expect(clientId).toBe('987654321.1700000000');
  });

  // Ez a teszt a lényeg: a HIÁNY nem pótolható. Egy szintetikus id minden hitnek
  // új GA4 usert nyitna, és a "(not set)" fantom-session vinné a key eventeket
  // (Painless audit 2026-08, P0-A). Üres eredmény → a hívó kihagyja az MP-lábat.
  it('returns nothing rather than guessing when the cookie is absent', () => {
    expect(readGa4IdsFromCookie(null, MEASUREMENT_ID)).toEqual({});
    expect(readGa4IdsFromCookie('', MEASUREMENT_ID)).toEqual({});
    expect(readGa4IdsFromCookie('other=1; cookieyes-consent=analytics:yes', MEASUREMENT_ID)).toEqual(
      { clientId: undefined, sessionId: undefined }
    );
  });

  it('rejects malformed _ga values instead of passing junk downstream', () => {
    expect(readGa4IdsFromCookie('_ga=GA1.1.abc.def', MEASUREMENT_ID).clientId).toBeUndefined();
    expect(readGa4IdsFromCookie('_ga=nonsense', MEASUREMENT_ID).clientId).toBeUndefined();
  });

  it('yields no session_id when the measurement id is unknown', () => {
    const cookie = '_ga=GA1.1.111.222; _ga_5M0YZ8WPPK=GS1.1.1714400123.3.1';
    expect(readGa4IdsFromCookie(cookie, undefined).sessionId).toBeUndefined();
  });

  it('ignores a session cookie belonging to a different container', () => {
    const cookie = '_ga=GA1.1.111.222; _ga_OTHERPROP=GS1.1.999.1.1';
    expect(readGa4IdsFromCookie(cookie, MEASUREMENT_ID).sessionId).toBeUndefined();
  });
});

describe('buildGatewayPayload — GA4 stitching ids', () => {
  const base = { eventName: 'purchase' as const, eventId: 'evt-1' };

  it('forwards client_id and session_id when the site resolved them', () => {
    const payload = buildGatewayPayload({
      ...base,
      ga4ClientId: '1234567890.1714400000',
      ga4SessionId: '1714400123'
    });
    expect(payload.client_id).toBe('1234567890.1714400000');
    expect(payload.session_id).toBe('1714400123');
  });

  it('omits both keys entirely when there was no cookie', () => {
    const payload = buildGatewayPayload(base);
    expect('client_id' in payload).toBe(false);
    expect('session_id' in payload).toBe(false);
  });

  it('still refuses to ship value without a currency (contract #4)', () => {
    const payload = buildGatewayPayload({ ...base, value: 0, currency: 'HUF' });
    expect('value' in payload).toBe(false);
    expect('currency' in payload).toBe(false);
  });
});
