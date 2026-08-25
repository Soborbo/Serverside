import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import {
  stageLeadSubmit,
  submitTrackedFormAsync,
  peekPendingConversions,
  getDiagnostics,
  clearDiagnostics,
} from '../lib';
import { setCkyConsent, resetAll } from './helpers';

/**
 * P5.2 — fetch/XHR submit-út.
 *
 * AZ INVARIÁNS, amit ez a fájl őriz:
 *   business FAILED  → ZERO böngésző-money-konverzió
 *   business SUCCESS → PONTOSAN EGY
 *
 * Minden negatív ág külön esetként szerepel, mert a különbségük operatív:
 * a hálózati hiba retryolható, az értelmezhetetlen válasz szerződésszegés, az
 * eltérő event_id pedig dedup-törés. Egyetlen közös „hát nem sikerült" ág
 * eltakarná, melyiket kell javítani.
 */

const LEAD = { email: 'jane@test.hu', phone: '+36301112233', value: 120, currency: 'HUF' };

const conversionPushes = () =>
  ((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []).filter(
    (e) =>
      typeof e === 'object' && e !== null &&
      ['quote_calculator_submitted', 'contact_form_submitted'].includes((e as { event?: string }).event ?? ''),
  );

const codes = () => getDiagnostics().map((d) => d.code);

function makeForm(): HTMLFormElement {
  const form = document.createElement('form');
  form.action = 'https://example.hu/api/quote';
  form.method = 'POST';
  const input = document.createElement('input');
  input.name = 'email';
  input.value = LEAD.email;
  form.appendChild(input);
  document.body.appendChild(form);
  return form;
}

/** Minimális Response-utánzat: a modul csak `ok`, `status`, `json()`-t használ. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function textResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new SyntaxError(`Unexpected token in ${text}`); },
  } as unknown as Response;
}

beforeEach(() => {
  resetAll();
  clearDiagnostics();
  document.body.innerHTML = '';
  setCkyConsent({ analytics: true, marketing: true });
});

describe('SIKER — pontosan egy konverzió', () => {
  it('szerződés szerinti siker → commit, egyetlen dataLayer push', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);
    expect(conversionPushes()).toHaveLength(0);

    const r = await submitTrackedFormAsync({
      form, eventId: staged.eventId,
      fetchImpl: async () => jsonResponse({ ok: true, event_id: staged.eventId }),
    });

    expect(r).toMatchObject({ ok: true, outcome: 'committed', eventId: staged.eventId });
    expect(conversionPushes()).toHaveLength(1);
  });

  it('a `redirect` továbbadódik a hívónak (a navigálás az ő dolga, commit UTÁN)', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);
    const r = await submitTrackedFormAsync({
      form, eventId: staged.eventId,
      fetchImpl: async () => jsonResponse({ ok: true, event_id: staged.eventId, redirect: '/koszonjuk' }),
    });
    expect(r).toMatchObject({ ok: true, redirect: '/koszonjuk' });
  });

  it('DUPLA submit: a második már `already_committed`, a push nem duplázódik', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);
    const fetchImpl = async () => jsonResponse({ ok: true, event_id: staged.eventId });

    await submitTrackedFormAsync({ form, eventId: staged.eventId, fetchImpl });
    const second = await submitTrackedFormAsync({ form, eventId: staged.eventId, fetchImpl });

    expect(second).toMatchObject({ ok: true, outcome: 'already_committed' });
    expect(conversionPushes()).toHaveLength(1);
  });

  it('az EC-identity a memóriapufferből jön — a tárba nem került PII', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);
    await submitTrackedFormAsync({
      form, eventId: staged.eventId,
      fetchImpl: async () => jsonResponse({ ok: true, event_id: staged.eventId }),
    });
    const ud = (window as unknown as { __sbUserData?: Record<string, string> }).__sbUserData;
    expect(ud?.email).toBe(LEAD.email);
    expect(sessionStorage.getItem('sb_pending_conversion') ?? '').not.toContain(LEAD.email);
  });
});

describe('BUKÁS — minden ág nulla konverzió, saját kóddal', () => {
  const failures: Array<[string, () => Promise<Response>, string]> = [
    [
      'backend 500 (szerver-hiba)',
      async () => jsonResponse({ error: 'boom' }, 500),
      'TRK-5004',
    ],
    [
      'backend 400 (szerver-oldali validáció bukott)',
      async () => jsonResponse({ error: 'invalid' }, 400),
      'TRK-5004',
    ],
    [
      'backend 403 (anti-bot / jogosultság)',
      async () => jsonResponse({ error: 'forbidden' }, 403),
      'TRK-5004',
    ],
    [
      'backend 409 (duplikált beküldés)',
      async () => jsonResponse({ error: 'duplicate' }, 409),
      'TRK-5004',
    ],
    [
      'üzleti elutasítás 200-zal: { ok: false }',
      async () => jsonResponse({ ok: false, error: 'honeypot' }),
      'TRK-5004',
    ],
    [
      'hálózati hiba',
      async () => { throw new TypeError('Failed to fetch'); },
      'TRK-5004',
    ],
    [
      'időtúllépés (abort)',
      async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      'TRK-5004',
    ],
    [
      '2xx, de NEM JSON (pl. a köszönő-oldal HTML-je)',
      async () => textResponse('<!doctype html><title>Köszönjük</title>'),
      'TRK-5003',
    ],
    [
      '2xx JSON, de hiányzik az `ok`',
      async () => jsonResponse({ event_id: 'x' }),
      'TRK-5003',
    ],
    [
      '2xx JSON, de hiányzik az `event_id`',
      async () => jsonResponse({ ok: true }),
      'TRK-5003',
    ],
    [
      '2xx JSON, de az `event_id` üres',
      async () => jsonResponse({ ok: true, event_id: '' }),
      'TRK-5003',
    ],
    [
      '2xx JSON, de a törzs `null`',
      async () => jsonResponse(null),
      'TRK-5003',
    ],
    [
      '2xx JSON, de `ok: "true"` (string, nem boolean)',
      async () => jsonResponse({ ok: 'true', event_id: 'x' }),
      'TRK-5003',
    ],
  ];

  for (const [label, fetchImpl, expectedCode] of failures) {
    it(`${label} → nincs konverzió, ${expectedCode}`, async () => {
      const form = makeForm();
      const staged = stageLeadSubmit(LEAD);

      const r = await submitTrackedFormAsync({ form, eventId: staged.eventId, fetchImpl });

      expect(r.ok).toBe(false);
      expect(codes()).toContain(expectedCode);
      // AZ INVARIÁNS: nulla böngésző-money-konverzió.
      expect(conversionPushes()).toHaveLength(0);
      // …és a letett rekord MEGMARAD: a látogató javíthat és újraküldhet.
      expect(peekPendingConversions()).toHaveLength(1);
    });
  }

  it('a backend MÁS event_id-t igazol vissza → TRK-5005, nincs konverzió (dedup-védelem)', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);

    const r = await submitTrackedFormAsync({
      form, eventId: staged.eventId,
      fetchImpl: async () => jsonResponse({ ok: true, event_id: 'egy-teljesen-mas-id' }),
    });

    expect(r).toMatchObject({ ok: false, code: 'TRK-5005' });
    expect(codes()).toContain('TRK-5005');
    expect(conversionPushes()).toHaveLength(0);
  });

  it('consent-visszavonás a submit és a válasz KÖZÖTT → nincs konverzió', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);

    const r = await submitTrackedFormAsync({
      form, eventId: staged.eventId,
      fetchImpl: async () => {
        setCkyConsent({ analytics: true, marketing: false });
        return jsonResponse({ ok: true, event_id: staged.eventId });
      },
    });

    expect(r).toMatchObject({ ok: true, outcome: 'consent_revoked' });
    expect(conversionPushes()).toHaveLength(0);
  });
});

describe('RED TEST — a hibaosztály maga', () => {
  it('bukó backend mellett SEMMILYEN money-jel nem keletkezik', async () => {
    const form = makeForm();
    const staged = stageLeadSubmit(LEAD);

    await submitTrackedFormAsync({
      form, eventId: staged.eventId,
      fetchImpl: async () => jsonResponse({ error: 'db write failed' }, 500),
    });

    // A P5.4 elfogadási kritériuma: Google Ads = 0, Meta Pixel = 0, CAPI = 0.
    // A böngészőben mindhárom EGY dataLayer pusht jelent (GTM osztja szét), és
    // a szerver-láb a site backendjéé, ami épp elbukott — tehát nulla mindenhol.
    const dl = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
    expect(dl.filter((e) => JSON.stringify(e).includes('quote_calculator_submitted'))).toHaveLength(0);
    const ud = (window as unknown as { __sbUserData?: unknown }).__sbUserData;
    expect(ud).toBeUndefined();
  });
});
