import { describe, it, expect, beforeEach, vi } from 'vitest';

// A gateway-transzport mockolva: ezek a tesztek az index.ts VEZÉRLÉSÉT mérik —
// a két új helper CSAK a dataLayer-lábat tüzeli, a gateway-t soha.
vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import {
  getUserDataForEC, clearUserDataForEC, pushConsultationConversion, pushTrainingSignupConversion,
} from '../lib/events';
import {
  trackConsultationSubmit, trackTrainingSignupSubmit,
  stageConsultationSubmit, stageTrainingSignupSubmit,
  commitPendingConversion, peekPendingConversions,
  SERVER_INGRESS_ONLY_EVENTS,
} from '../lib/index';
import { sendToWorker } from '../lib/gateway';
import { setCkyConsent, resetAll, lastEvent, getDataLayer } from './helpers';

const mockSend = sendToWorker as unknown as ReturnType<typeof vi.fn>;

/**
 * 6.14.0 — `consultation_request_submitted` (Meta Schedule) és
 * `training_signup_submitted` (Meta CompleteRegistration) böngésző-oldali
 * segédjei. A két név a 6.13.1 óta kanonikus és server-ingress-only; a helper
 * szerződése BITRE a `trackContactSubmit`-é: dataLayer-láb PII nélkül, EC
 * rejtett csatorna, megosztott `event_id`, consent-kapu, nulla gateway-hívás.
 */

const PII = {
  email: 'Jane.Doe@Example.com',
  phone: '0620123456',
  firstName: 'Jane',
  lastName: 'Doe',
};

beforeEach(() => {
  resetAll();
  // Az EC-tár modul-privát (resetAll csak a window-tükröt üríti) — a
  // consent-blokk állítása csak tiszta tárral mér.
  clearUserDataForEC();
  mockSend.mockClear();
  setCkyConsent({ analytics: true, marketing: true });
});

describe('a két esemény a kanonikus szerződésben server-ingress-only', () => {
  it.each(['consultation_request_submitted', 'training_signup_submitted'])('%s', (name) => {
    expect(SERVER_INGRESS_ONLY_EVENTS.has(name)).toBe(true);
  });
});

describe('trackConsultationSubmit — BROWSER LEG ONLY (Meta Schedule)', () => {
  it('a dataLayer eseménye consultation_request_submitted, és NINCS gateway-hívás', () => {
    const r = trackConsultationSubmit({ ...PII, value: 15000 });
    expect(r.success).toBe(true);
    expect(r.consentBlocked).toBe(false);
    const e = lastEvent('consultation_request_submitted')!;
    expect(e).toBeTruthy();
    expect(e.event_id).toBe(r.eventId);
    expect(e.value).toBe(15000);
    // A piac alapértéke (a teszt-env HU → HUF), ha a hívó nem ad pénznemet.
    expect(e.currency).toBe('HUF');
    // A szerver-láb a site backendjéé — a böngésző-út 403-at adna (TRK-400-017).
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a MEGADOTT event_id-t használja (fetch-alapú folyamat, Pixel↔CAPI dedup)', () => {
    const r = trackConsultationSubmit({ ...PII, eventId: 'srv-consult-1' });
    expect(r.eventId).toBe('srv-consult-1');
    expect(lastEvent('consultation_request_submitted')!.event_id).toBe('srv-consult-1');
  });

  it('a PII az EC rejtett csatornájába megy, a dataLayerbe NEM', () => {
    trackConsultationSubmit(PII);
    const ud = getUserDataForEC()!;
    expect(ud.email).toBe('jane.doe@example.com');
    expect(ud.phone_number).toBe('+3620123456');
    expect(ud.first_name).toBe('Jane');
    expect(ud.last_name).toBe('Doe');
    const dl = JSON.stringify(getDataLayer());
    expect(dl).not.toContain('Jane');
    expect(dl).not.toContain('Doe');
    expect(dl).not.toContain('example.com');
    expect(dl).not.toContain('0620123456');
    expect(dl).not.toContain('+36201');
  });

  it('marketing consent nélkül: nincs push, nincs gateway, consentBlocked — de az id visszatér a rejtett mezőhöz', () => {
    setCkyConsent({ analytics: true, marketing: false });
    const r = trackConsultationSubmit({ ...PII, eventId: 'srv-consult-2' });
    expect(r.success).toBe(false);
    expect(r.consentBlocked).toBe(true);
    expect(r.eventId).toBe('srv-consult-2');
    expect(getDataLayer().some((e) => e.event === 'consultation_request_submitted')).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(getUserDataForEC()).toBeNull();
  });
});

describe('trackTrainingSignupSubmit — BROWSER LEG ONLY (Meta CompleteRegistration)', () => {
  it('a dataLayer eseménye training_signup_submitted, és NINCS gateway-hívás', () => {
    const r = trackTrainingSignupSubmit(PII);
    expect(r.success).toBe(true);
    const e = lastEvent('training_signup_submitted')!;
    expect(e).toBeTruthy();
    expect(e.event_id).toBe(r.eventId);
    // Nincs érték → nincs value/currency (0-érték sem mehet ki).
    expect(e.value).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a MEGADOTT event_id-t használja', () => {
    const r = trackTrainingSignupSubmit({ email: PII.email, eventId: 'srv-train-1' });
    expect(r.eventId).toBe('srv-train-1');
    expect(lastEvent('training_signup_submitted')!.event_id).toBe('srv-train-1');
  });

  it('a PII az EC rejtett csatornájába megy, a dataLayerbe NEM', () => {
    trackTrainingSignupSubmit(PII);
    const ud = getUserDataForEC()!;
    expect(ud.email).toBe('jane.doe@example.com');
    expect(ud.phone_number).toBe('+3620123456');
    const dl = JSON.stringify(getDataLayer());
    expect(dl).not.toContain('example.com');
    expect(dl).not.toContain('Jane');
  });

  it('marketing consent nélkül: nincs push, nincs gateway, consentBlocked', () => {
    setCkyConsent({ analytics: false, marketing: false });
    const r = trackTrainingSignupSubmit(PII);
    expect(r.consentBlocked).toBe(true);
    expect(r.eventId).toBeTruthy();
    expect(getDataLayer()).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('a push-helperek dataLayer-payloadja PII-mentes (CLAUDE.md §15)', () => {
  it.each([
    ['consultation_request_submitted', pushConsultationConversion],
    ['training_signup_submitted', pushTrainingSignupConversion],
  ] as const)('%s', (name, push) => {
    push({ ...PII, value: 0, currency: 'HUF', eventId: 'E-push' });
    const e = lastEvent(name)!;
    expect(e.event_id).toBe('E-push');
    expect(e.value).toBeUndefined(); // 0 → kihagyva
    expect(e.email).toBeUndefined();
    expect(e.phone_number).toBeUndefined();
    expect(e.first_name).toBeUndefined();
    expect(e.user_data).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('example.com');
  });
});

describe('P5 staging-párok — a submit NEM tüzel, a commit a kanonikus nevet tüzeli', () => {
  it('stageConsultationSubmit → commit → consultation_request_submitted a szerver event_id-jével', () => {
    const r = stageConsultationSubmit({ ...PII, value: 15000 });
    expect(r.success).toBe(true);
    expect(getDataLayer().some((e) => e.event === 'consultation_request_submitted')).toBe(false);
    expect(peekPendingConversions()[0]).toMatchObject({ kind: 'consultation', eventId: r.eventId, value: 15000, currency: 'HUF' });
    // A tárolt rekord PII-mentes (INV-002).
    expect(JSON.stringify(sessionStorage.getItem('sb_pending_conversion'))).not.toContain('example.com');

    expect(commitPendingConversion(r.eventId)).toBe('committed');
    const e = lastEvent('consultation_request_submitted')!;
    expect(e.event_id).toBe(r.eventId);
    expect(e.value).toBe(15000);
    expect(getUserDataForEC()!.email).toBe('jane.doe@example.com');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('stageTrainingSignupSubmit → commit → training_signup_submitted', () => {
    const r = stageTrainingSignupSubmit(PII);
    expect(getDataLayer()).toHaveLength(0);
    expect(peekPendingConversions()[0]).toMatchObject({ kind: 'training', eventId: r.eventId });

    expect(commitPendingConversion(r.eventId)).toBe('committed');
    expect(lastEvent('training_signup_submitted')!.event_id).toBe(r.eventId);
    expect(getDataLayer().some((e) => e.event === 'contact_form_submitted')).toBe(false);
    expect(getDataLayer().some((e) => e.event === 'quote_calculator_submitted')).toBe(false);
  });

  it('staging marketing consent nélkül: nincs pending rekord, consentBlocked', () => {
    setCkyConsent({ analytics: true, marketing: false });
    expect(stageConsultationSubmit(PII).consentBlocked).toBe(true);
    expect(stageTrainingSignupSubmit(PII).consentBlocked).toBe(true);
    expect(peekPendingConversions()).toHaveLength(0);
  });
});
