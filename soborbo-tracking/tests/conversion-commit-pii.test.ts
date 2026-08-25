import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import {
  stageLeadSubmit,
  stageContactSubmit,
  commitPendingConversion,
  peekPendingConversions,
  discardPendingConversions,
  hasBufferedIdentity,
  getDiagnostics,
  clearDiagnostics,
} from '../lib';
import { setCkyConsent, resetAll } from './helpers';

/**
 * INV-002 — PII SOHA nem kerül `sessionStorage`-be.
 *
 * A P5 első köre ezt megsértette: a letett konverzió rekordja NYERS e-mailt,
 * telefont és nevet tett a `sb_pending_conversion` kulcsba, és a fájl fejléce
 * ezt tévesen „nem PII"-nek nevezte. Az F12-es bámészkodó és bármelyik
 * third-party szkript olvashatta.
 *
 * A javítás: a TÁROLT rekord PII-mentes; az Enhanced-Conversions identity egy
 * MODUL-PRIVÁT memóriapufferben él, ami a dokumentummal együtt elszáll.
 *
 * RED: a javítás visszavonásával (identity vissza a tárolt rekordba) az alábbi
 * első három teszt AZONNAL PIROS.
 */

const LEAD = {
  email: 'jane.doe@example.hu',
  phone: '+36301112233',
  firstName: 'Jane',
  lastName: 'Doe',
  value: 120,
  currency: 'HUF',
};

const rawStore = () => sessionStorage.getItem('sb_pending_conversion') ?? '';

beforeEach(() => {
  resetAll();
  clearDiagnostics();
  setCkyConsent({ analytics: true, marketing: true });
});

describe('INV-002 — a sessionStorage PII-mentes', () => {
  it('a letett lead-rekord NEM tartalmaz e-mailt, telefont, se nevet', () => {
    stageLeadSubmit(LEAD);
    const raw = rawStore();

    expect(raw).not.toContain('jane.doe@example.hu');
    expect(raw).not.toContain('example.hu');
    expect(raw).not.toContain('+36301112233');
    expect(raw).not.toContain('Jane');
    expect(raw).not.toContain('Doe');
    // …miközben a technikai/üzleti mezők ott vannak: a rekord használható marad.
    expect(raw).toContain('"kind":"lead"');
    expect(raw).toContain('"value":120');
    expect(raw).toContain('"currency":"HUF"');
  });

  it('a contact-út is PII-mentesen tárol', () => {
    stageContactSubmit({ email: 'jane.doe@example.hu', phone: '+36301112233' });
    const raw = rawStore();
    expect(raw).not.toContain('jane.doe@example.hu');
    expect(raw).not.toContain('+36301112233');
    expect(raw).toContain('"kind":"contact"');
  });

  it('a peek() sem szivárogtat: a visszaadott rekord kulcsai kötöttek', () => {
    stageLeadSubmit(LEAD);
    const [p] = peekPendingConversions();
    expect(Object.keys(p!).sort()).toEqual(['currency', 'eventId', 'kind', 'stagedAt', 'value']);
  });

  it('az identity a MEMÓRIÁBAN van, nem a tárban — és a commit használja', () => {
    const r = stageLeadSubmit(LEAD);
    expect(hasBufferedIdentity(r.eventId)).toBe(true);
    expect(rawStore()).not.toContain('jane.doe@example.hu');

    expect(commitPendingConversion(r.eventId)).toBe('committed');
    // A side-channel (events.ts) megkapta az EC-adatot — ez a dataLayeren KÍVÜL van.
    const ud = (window as unknown as { __sbUserData?: Record<string, string> }).__sbUserData;
    expect(ud?.email).toBe('jane.doe@example.hu');
  });

  it('commit után a memóriapuffer is ürül (nem él tovább a dokumentum végéig)', () => {
    const r = stageLeadSubmit(LEAD);
    commitPendingConversion(r.eventId);
    expect(hasBufferedIdentity(r.eventId)).toBe(false);
  });

  it('consent-visszavonás a memóriapuffert IS üríti, nem csak a tárat', () => {
    const r = stageLeadSubmit(LEAD);
    discardPendingConversions();
    expect(hasBufferedIdentity(r.eventId)).toBe(false);
    expect(rawStore()).toBe('');
  });

  it('a darabszám-plafon fölött kieső rekordok identityje sem marad bent', () => {
    const ids = Array.from({ length: 7 }, (_, i) =>
      stageLeadSubmit({ ...LEAD, email: `u${i}@example.hu` }).eventId,
    );
    // PENDING_MAX = 5 → az első kettő kiesett a tárból ÉS a pufferből is.
    expect(hasBufferedIdentity(ids[0]!)).toBe(false);
    expect(hasBufferedIdentity(ids[1]!)).toBe(false);
    expect(hasBufferedIdentity(ids[6]!)).toBe(true);
  });
});

describe('identity a siker-oldalról (navigációs út)', () => {
  it('navigáció után a puffer üres → az EXPLICIT identity szolgálja ki az EC-t', () => {
    const r = stageLeadSubmit(LEAD);
    // Navigáció szimulálása: a modul memóriája elszáll, a sessionStorage marad.
    discardPendingIdentityOnly(r.eventId);

    expect(commitPendingConversion(r.eventId, { email: 'from-server@example.hu' })).toBe('committed');
    const ud = (window as unknown as { __sbUserData?: Record<string, string> }).__sbUserData;
    expect(ud?.email).toBe('from-server@example.hu');
  });

  it('az EXPLICIT identity ÜT a pufferelten (a business rekord az erősebb forrás)', () => {
    const r = stageLeadSubmit(LEAD);
    commitPendingConversion(r.eventId, { email: 'authoritative@example.hu' });
    const ud = (window as unknown as { __sbUserData?: Record<string, string> }).__sbUserData;
    expect(ud?.email).toBe('authoritative@example.hu');
  });

  it('identity NÉLKÜL is elmegy a konverzió, de TRK-5002-vel — nem néma degradáció', () => {
    const r = stageLeadSubmit(LEAD);
    discardPendingIdentityOnly(r.eventId);

    expect(commitPendingConversion(r.eventId)).toBe('committed');
    const codes = getDiagnostics().map((d) => d.code);
    expect(codes).toContain('TRK-5002');
  });
});

/**
 * A navigáció szimulálása: a modul-privát puffert nem tudjuk kívülről törölni
 * (ez a lényege), ezért a tárolt rekordot változatlanul hagyva egy ÚJ, azonos
 * event_id-jű stage-eléssel írjuk felül identity nélkül — pontosan azt az
 * állapotot előállítva, amit egy friss dokumentum lát.
 */
function discardPendingIdentityOnly(eventId: string): void {
  const raw = JSON.parse(sessionStorage.getItem('sb_pending_conversion') ?? '[]');
  const entry = raw.find((p: { eventId: string }) => p.eventId === eventId);
  discardPendingConversions();
  if (entry) sessionStorage.setItem('sb_pending_conversion', JSON.stringify([entry]));
}
