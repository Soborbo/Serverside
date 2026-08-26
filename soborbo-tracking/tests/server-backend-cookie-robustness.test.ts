import { describe, it, expect } from 'vitest';
import {
  readConsentFromCookie,
  readSboConsentCookieHeader,
  buildConsentSources,
  readMetaCookies,
  buildGatewayPayload,
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

/**
 * A „nem dob" MÉG NEM MONDJA MEG, MIRE DEGRADÁL — és a két hívó típusnak MÁS a
 * helyes válasza UGYANARRA a bemenetre. Ez a szétválás a Worker
 * `parseConsentCookieHeader`-ében és a painless forkban is így élt; egy közös
 * „adjunk undefined-et" helyer NÉMÁN elveszítené a mérést.
 *
 * A bemenet szándékosan olyan süti, amiben EGY hibás escape van, DE mellette
 * tökéletesen olvasható a döntés.
 */
describe('kapu vs telemetria — ugyanaz a bemenet, két helyes válasz', () => {
  const READABLE_BUT_MALFORMED = 'cookieyes-consent=consentid:abc%E0,advertisement:yes,analytics:yes';

  it('a KAPU fail closed: sérült stringből nem olvasunk ki jogalapot', () => {
    expect(readConsentFromCookie(READABLE_BUT_MALFORMED)).toBeUndefined();
  });

  it('a TELEMETRIA megőrzi a mérést: a nyers értékből a döntés még kiolvasható', () => {
    const out = buildConsentSources(READABLE_BUT_MALFORMED);
    expect(out.source_used).toBe('cookieyes_cookie');
    expect(out.cookie).toEqual({ analytics: true, marketing: true });
  });

  it('a bemenet tényleg dobna őrizetlenül — különben a teszt semmit sem bizonyít', () => {
    expect(() => decodeURIComponent('consentid:abc%E0,advertisement:yes,analytics:yes')).toThrow();
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

/**
 * A `service` MEZŐ KÉT LÁBON — a szerver-ingress ne veszítse el, amit a böngésző küld.
 *
 * A böngésző-láb (`lib/gateway.ts`) a `service`-t a dataLayerre ÉS a
 * `sendToWorker` body-jába is beteszi, a gateway pedig fogyasztja
 * (`src/lib/ga4.ts` → `params.service`). A szerver-láb payload-építőjéből
 * viszont hiányzott. Mivel a CLAUDE.md 10. pontja szerint MINDEN high-value
 * konverzió a szerver-ingressen jön, gyakorlatilag minden lead elvesztette a
 * címkét — miközben a low-risk klikk-eventek a böngésző-úton megtartották.
 */
describe('service — a két láb ugyanazt a mezőt küldi', () => {
  it('a szerver-payloadra rákerül, ha a hívó adja', () => {
    const p = buildGatewayPayload({
      eventName: 'quote_calculator_submitted',
      eventId: 'e1',
      service: 'removal',
    });
    expect(p.service).toBe('removal');
  });

  it('nincs kitalált érték, ha a hívó nem adja', () => {
    const p = buildGatewayPayload({ eventName: 'contact_form_submitted', eventId: 'e2' });
    expect(p).not.toHaveProperty('service');
  });
});
