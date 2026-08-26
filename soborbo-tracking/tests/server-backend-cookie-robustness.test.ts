import { describe, it, expect } from 'vitest';
import {
  readConsentFromCookie,
  readSboConsentCookieHeader,
  buildConsentSources,
  readMetaCookies,
} from '../server/backend/gateway-dispatch';

/**
 * A SITE-BACKEND SÜTI-OLVASÓINAK ROBUSZTUSSÁGA.
 *
 * ── Honnan jött ez a teszt ───────────────────────────────────────────────────
 * Az F9/3.4 szerver-szelet paritás-futásából. A painless fork ezeket az eseteket
 * kezelte, a kanonikus mag NEM — tehát a migráció, ha vakon megy át, REGRESSZIÓT
 * hozott volna a site-ra. Az irány szokatlan: itt nem a fork maradt el a csomag
 * mögött, hanem a csomag a fork mögött.
 *
 * ── Miért nem „csak telemetria" ──────────────────────────────────────────────
 * Ezek a függvények a LEAD-ÚTVONALON futnak: a site API-route-ja a konverzió
 * összeállítása közben hívja őket (`consent:`/`consentSources:` a
 * deliverGatewayConversion bemenetén). Egy dobás ott nem hiányzó mérés, hanem
 * 500-as válasz a beküldött űrlapra. Az ügyfél leadje veszne el egy hibás süti
 * miatt, amit nem is ő írt.
 */

const MALFORMED = 'cookieyes-consent=%E0%A4%A; other=1';

describe('hibás percent-kódolás a lead-útvonalon', () => {
  it('readConsentFromCookie: nem dob, hanem „nincs jelzés" — nem találgat, de nem is ejti el a leadet', () => {
    expect(() => readConsentFromCookie(MALFORMED)).not.toThrow();
    expect(readConsentFromCookie(MALFORMED)).toBeUndefined();
  });

  it('readSboConsentCookieHeader: ugyanaz a saját CMP sütijére', () => {
    const h = 'sbo_consent=%E0%A4%A; a=1';
    expect(() => readSboConsentCookieHeader(h)).not.toThrow();
    expect(readSboConsentCookieHeader(h)).toBeNull();
  });

  it('buildConsentSources: a telemetria sem 500-azhat a lead-útvonalon', () => {
    expect(() => buildConsentSources(MALFORMED)).not.toThrow();
    const out = buildConsentSources(MALFORMED);
    expect(out.source_used).toBe('none');
    expect(out.cookie).toEqual({ analytics: null, marketing: null });
  });
});

describe('raw_cookie — adatminimalizálás', () => {
  it('a receiptre CSONKÍTVA kerül, sosem teljes egészében', () => {
    const long = 'consentid:' + 'x'.repeat(600) + ',advertisement:yes,analytics:yes';
    const out = buildConsentSources(`cookieyes-consent=${encodeURIComponent(long)}`);
    expect(out.raw_cookie).toBeDefined();
    expect(out.raw_cookie!.length).toBeLessThanOrEqual(200);
  });

  it('nincs raw_cookie, ha a süti nem hordoz jelzést (nem írunk üres bizonyítékot)', () => {
    expect(buildConsentSources(null).raw_cookie).toBeUndefined();
  });
});

describe('readMetaCookies — hiányzó kulcs HIÁNYZIK, nem undefined', () => {
  it('csak a ténylegesen meglévő klikk-ID-t adja vissza', () => {
    const out = readMetaCookies('_fbp=fb.1.1700000000000.1234567890; x=1');
    expect(out.fbp).toBe('fb.1.1700000000000.1234567890');
    // Egy `{ fbc: undefined }` alak igazat adna egy `'fbc' in out` ellenőrzésre,
    // és a gateway `fbclid → fbc` rekonstrukciója épp ilyenkor maradna ki.
    expect(out).not.toHaveProperty('fbc');
    expect(Object.keys(out)).toEqual(['fbp']);
  });

  it('süti nélkül üres objektum, sosem szintetizált érték', () => {
    expect(readMetaCookies(null)).toEqual({});
  });
});
