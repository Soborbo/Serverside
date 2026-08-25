import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import {
  stageLeadSubmit,
  stageContactSubmit,
  trackLeadSubmit,
  commitPendingConversion,
  peekPendingConversions,
} from '../lib';
import { setCkyConsent, resetAll } from './helpers';

/**
 * P5 — `commit-after-business-success`.
 *
 * A HIBAOSZTÁLY: klasszikus form-submitnél a böngésző-konverzió a backend
 * válasza ELŐTT ég el. Ha a backend elbukik, a Meta számolt egy Leadet, amihez
 * SOHA nem érkezik CAPI-pár — fantom konverzió, dedup-partner nélkül.
 *
 * A staging/commit páros ezt zárja: a submit LETESZI, a siker-oldal TÜZELI, a
 * szervertől visszakapott event_id-vel. A commit paramétere nem kényelmi kérdés:
 * egy paraméter nélküli commit() minden oldalletöltést sikernek venne.
 */

const dataLayer = () => (window as unknown as { dataLayer: unknown[] }).dataLayer ?? [];
const conversionPushes = () =>
  dataLayer().filter(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      ['quote_calculator_submitted', 'contact_form_submitted'].includes(
        (e as { event?: string }).event ?? ''
      )
  );

const LEAD = { email: 'jane@test.hu', phone: '+36301112233', value: 120, currency: 'HUF' };

beforeEach(() => {
  resetAll();
  setCkyConsent({ analytics: true, marketing: true });
});

describe('staging — a submit NEM tüzel', () => {
  it('a mai (default) út azonnal tüzel — ez a kontroll', () => {
    trackLeadSubmit(LEAD);
    expect(conversionPushes()).toHaveLength(1);
  });

  it('a staging NEM push-ol a dataLayerbe, de ad event_id-t a rejtett mezőhöz', () => {
    const r = stageLeadSubmit(LEAD);
    expect(r.success).toBe(true);
    expect(r.eventId).toMatch(/.+/);
    expect(conversionPushes()).toHaveLength(0);
    expect(peekPendingConversions()).toHaveLength(1);
  });

  it('consent nélkül nem is kerül letételre (nincs mit commitolni)', () => {
    setCkyConsent({ analytics: false, marketing: false });
    const r = stageLeadSubmit(LEAD);
    expect(r.consentBlocked).toBe(true);
    expect(peekPendingConversions()).toHaveLength(0);
  });
});

describe('commit — a siker-oldalon, a SZERVER event_id-jével', () => {
  it('a letett konverzió a commitkor ég el, ugyanazzal az event_id-vel', () => {
    const r = stageLeadSubmit(LEAD);
    expect(conversionPushes()).toHaveLength(0);

    expect(commitPendingConversion(r.eventId)).toBe('committed');

    const pushes = conversionPushes();
    expect(pushes).toHaveLength(1);
    expect((pushes[0] as { event: string }).event).toBe('quote_calculator_submitted');
    expect(JSON.stringify(pushes[0])).toContain(r.eventId);
  });

  it('a contact-út a saját eseménynevét tüzeli', () => {
    const r = stageContactSubmit({ email: 'jane@test.hu', phone: '+36301112233' });
    expect(commitPendingConversion(r.eventId)).toBe('committed');
    expect((conversionPushes()[0] as { event: string }).event).toBe('contact_form_submitted');
  });

  it('IDEMPOTENS: a köszönő-oldal újratöltése nem tüzel másodszor', () => {
    const r = stageLeadSubmit(LEAD);
    expect(commitPendingConversion(r.eventId)).toBe('committed');
    expect(commitPendingConversion(r.eventId)).toBe('already_committed');
    expect(conversionPushes()).toHaveLength(1);
  });

  it('IDEGEN event_id-re nem tüzel — a siker a szerver ténye, nem az oldalletöltésé', () => {
    stageLeadSubmit(LEAD);
    expect(commitPendingConversion('valaki-mas-event-idje')).toBe('no_pending');
    expect(conversionPushes()).toHaveLength(0);
  });

  it('üres/hiányzó event_id nem tüzel', () => {
    stageLeadSubmit(LEAD);
    expect(commitPendingConversion('')).toBe('invalid_event_id');
    expect(conversionPushes()).toHaveLength(0);
  });

  it('a backend BUKÁSA = nincs commit → nincs fantom konverzió', () => {
    // Ez a teljes hibaosztály egy tesztben: a látogató elküldi a formot, a
    // backend elhasal, tehát a siker-oldal SOSEM töltődik be és nem hív commitot.
    stageLeadSubmit(LEAD);
    expect(conversionPushes()).toHaveLength(0);
    expect(peekPendingConversions()).toHaveLength(1);
  });
});

describe('commit — consent a két oldalletöltés között', () => {
  it('visszavont marketing-consent mellett nem tüzel, és a letett rekordot is eldobja', () => {
    const r = stageLeadSubmit(LEAD);
    setCkyConsent({ analytics: true, marketing: false });

    expect(commitPendingConversion(r.eventId)).toBe('consent_revoked');
    expect(conversionPushes()).toHaveLength(0);
    expect(peekPendingConversions()).toHaveLength(0);
  });
});
