import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  initTracking,
  PENDING_TTL_MS,
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

describe('consent-visszavonás a letett rekordot azonnal törli (Codex #79)', () => {
  const emitConsentUpdate = (opts: { analytics: boolean; marketing: boolean }) => {
    setCkyConsent(opts);
    document.dispatchEvent(new Event('cookieyes_consent_update'));
  };

  it('stage → visszavonás → újra-engedélyezés → commit = no_pending, a tár üres', () => {
    initTracking();
    const r = stageLeadSubmit(LEAD);
    expect(sessionStorage.getItem('sb_pending_conversion')).not.toBeNull();

    emitConsentUpdate({ analytics: true, marketing: false });
    expect(sessionStorage.getItem('sb_pending_conversion')).toBeNull();

    emitConsentUpdate({ analytics: true, marketing: true });
    expect(commitPendingConversion(r.eventId)).toBe('no_pending');
    expect(conversionPushes()).toHaveLength(0);
  });
});

describe('TTL — a lejárt rekord fizikailag is eltűnik (Codex #79)', () => {
  afterEach(() => vi.useRealTimers());

  it('stage → TTL lejár → peek: a sessionStorage kulcs törlődik', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
    const r = stageLeadSubmit(LEAD);
    expect(sessionStorage.getItem('sb_pending_conversion')).toContain(r.eventId);

    vi.setSystemTime(new Date(Date.now() + PENDING_TTL_MS + 1000));
    expect(peekPendingConversions()).toHaveLength(0);
    expect(sessionStorage.getItem('sb_pending_conversion')).toBeNull();
  });

  it('stage → TTL lejár → commit = no_pending, és a rekord törlődik', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
    const r = stageLeadSubmit(LEAD);

    vi.setSystemTime(new Date(Date.now() + PENDING_TTL_MS + 1000));
    expect(commitPendingConversion(r.eventId)).toBe('no_pending');
    expect(sessionStorage.getItem('sb_pending_conversion')).toBeNull();
    expect(conversionPushes()).toHaveLength(0);
  });

  it('vegyes lista: csak a lejárt esik ki, a friss marad a tárban', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
    const old = stageLeadSubmit(LEAD);
    vi.setSystemTime(new Date(Date.now() + PENDING_TTL_MS + 1000));
    const fresh = stageLeadSubmit({ ...LEAD, email: 'fresh@test.hu' });

    const pending = peekPendingConversions();
    expect(pending.map((p) => p.eventId)).toEqual([fresh.eventId]);
    const raw = sessionStorage.getItem('sb_pending_conversion') ?? '';
    expect(raw).toContain(fresh.eventId);
    expect(raw).not.toContain(old.eventId);
  });
});
