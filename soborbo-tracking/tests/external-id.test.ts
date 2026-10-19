/**
 * K2 (6.16.0) — Meta `external_id` végponttól végpontig: `sb_uid`.
 *
 * A szerződés:
 *  - LÉTREHOZÁS csak marketing-hozzájárulással;
 *  - OLVASÁS csak a marketing read-gate-en át (UNKNOWN/DENIED → null + telemetria);
 *  - a visszavonás és a `clearTrackingData` törli;
 *  - a böngésző-láb viszi (a hívó értéke nyer), hozzájárulás nélkül SOHA;
 *  - az advanced-mód süti nélküli pingjei azonosító-mentesek maradnak;
 *  - a szerver-láb PLAIN-ként továbbítja (a Worker hash-el, a kliens nem).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendToWorker } from '../lib/gateway';
import {
  getExternalId, purgeMarketingStorage, clearTrackingData,
  getStorageReadBlocked, resetStorageReadBlocked,
} from '../lib/persistence';
import { populateHiddenFields, attachEventIdToForm } from '../lib/index';
import { buildGatewayPayload } from '../server/backend/gateway-dispatch';
import { resetAll, setCkyConsent, setCookie, setUrl } from './helpers';

const KEY = 'sb_uid';

function grant(): void {
  setCkyConsent({ analytics: true, marketing: true });
  setCookie('cookieyes-consent', 'consent:yes,analytics:yes,advertisement:yes');
}
function deny(): void {
  setCkyConsent({ analytics: true, marketing: false });
  setCookie('cookieyes-consent', 'consent:yes,analytics:yes,advertisement:no');
}

async function capture(userData?: Record<string, string>): Promise<Record<string, unknown>> {
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });
  const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetchMock);
  await sendToWorker({
    event_name: 'phone_number_clicked', event_id: 'E1', event_time: 1_700_000_000,
    ...(userData ? { user_data: userData } : {}),
  });
  return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
}

beforeEach(() => { resetAll(); resetStorageReadBlocked(); setUrl('/'); });
afterEach(() => vi.unstubAllGlobals());

describe('getExternalId — létrehozás és olvasás', () => {
  it('GRANTED: UUID-t hoz létre, eltárolja, és utána ugyanazt adja vissza', () => {
    grant();
    const id = getExternalId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(localStorage.getItem(KEY)).toBe(id);
    expect(getExternalId()).toBe(id);
    expect(getStorageReadBlocked().blocked).toBe(false);
  });

  it('UNKNOWN (nincs CMP-döntés): nem hoz létre semmit, és a blokk jelentve', () => {
    expect(getExternalId()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getStorageReadBlocked().keys).toContain(KEY);
  });

  it('DENIED: nem hoz létre semmit, és a blokk jelentve', () => {
    deny();
    expect(getExternalId()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getStorageReadBlocked().keys).toContain(KEY);
  });

  it('egy korábbi grant alatt tárolt id-t hozzájárulás nélkül NEM olvas vissza (és nem is töröl)', () => {
    localStorage.setItem(KEY, '11111111-2222-4333-8444-555555555555');
    expect(getExternalId()).toBeNull();
    deny();
    expect(getExternalId()).toBeNull();
    // A törlés a purge dolga, nem az olvasásé (UNKNOWN nem törölhet).
    expect(localStorage.getItem(KEY)).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('egy idegen alakú tárolt értéket GRANTED alatt friss UUID-re cserél', () => {
    grant();
    localStorage.setItem(KEY, 'x'.repeat(300));
    const id = getExternalId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem(KEY)).toBe(id);
  });
});

describe('sb_uid törlése', () => {
  it('purgeMarketingStorage (visszavonás) törli', () => {
    grant();
    getExternalId();
    expect(localStorage.getItem(KEY)).not.toBeNull();
    purgeMarketingStorage();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('clearTrackingData törli', () => {
    grant();
    getExternalId();
    clearTrackingData();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('böngésző-láb (sendToWorker)', () => {
  it('GRANTED: a payload a saját sb_uid-t viszi, PLAIN (nem hash)', async () => {
    grant();
    const body = await capture({ email: 'a@b.hu' });
    const ud = body.user_data as Record<string, string>;
    expect(ud.email).toBe('a@b.hu');
    expect(ud.external_id).toBe(localStorage.getItem(KEY));
    expect(ud.external_id).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('GRANTED, user_data nélkül is: a payload kap user_data.external_id-t', async () => {
    grant();
    const body = await capture();
    expect((body.user_data as Record<string, string>).external_id).toBe(localStorage.getItem(KEY));
  });

  it('a hívó értéke nyer — és ilyenkor nem verünk saját sb_uid-t', async () => {
    grant();
    const body = await capture({ external_id: 'crm-42' });
    expect((body.user_data as Record<string, string>).external_id).toBe('crm-42');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('DENIED: semmilyen external_id nem megy ki — a hívóé sem', async () => {
    deny();
    localStorage.setItem(KEY, '11111111-2222-4333-8444-555555555555');
    const body = await capture({ email: 'a@b.hu', external_id: 'crm-42' });
    const ud = body.user_data as Record<string, string>;
    expect(ud.email).toBe('a@b.hu');
    expect(ud).not.toHaveProperty('external_id');
    expect(JSON.stringify(body)).not.toContain('11111111-2222');
  });

  it('UNKNOWN: nincs external_id, és user_data sem keletkezik a semmiből', async () => {
    const body = await capture();
    expect(body.user_data).toBeUndefined();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('advanced Consent Mode — süti nélküli ping', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('hozzájárulás nélkül a dataLayer-konverzió nem visz external_id-t, és sb_uid sem keletkezik', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_TRACKING_CONSENT_PROVIDER', 'sbo');
    vi.stubEnv('PUBLIC_TRACKING_CONSENT_MODE', 'advanced');
    const t = await import('../lib/index');
    localStorage.setItem(KEY, '11111111-2222-4333-8444-555555555555');
    const r = t.trackLeadSubmit({ email: 'a@b.hu', value: 1000, currency: 'HUF' });
    expect(r.consentBlocked).toBe(true);
    t.trackPhoneConversion({ phone: '+36301234567' });
    const dl = JSON.stringify((window as unknown as { dataLayer: unknown[] }).dataLayer);
    expect(dl).toContain('quote_calculator_submitted');
    expect(dl).not.toContain('external_id');
    expect(dl).not.toContain('11111111-2222');
    expect(t.getExternalId()).toBeNull();
  });
});

describe('rejtett mezők', () => {
  function form(withExternalId: boolean): HTMLFormElement {
    const f = document.createElement('form');
    if (withExternalId) f.innerHTML = '<input type="hidden" name="external_id" />';
    document.body.appendChild(f);
    return f;
  }
  const result = { success: true, consentBlocked: false, eventId: 'E1', gclid: null, fbclid: null };

  it('populateHiddenFields: kitölti az external_id mezőt, ha az űrlapon van', () => {
    grant();
    const f = form(true);
    populateHiddenFields(f, result);
    expect(f.querySelector<HTMLInputElement>('input[name="external_id"]')!.value).toBe(localStorage.getItem(KEY));
  });

  it('attachEventIdToForm: ugyanígy', () => {
    grant();
    const f = form(true);
    attachEventIdToForm(f, 'E2');
    expect(f.querySelector<HTMLInputElement>('input[name="external_id"]')!.value).toBe(localStorage.getItem(KEY));
  });

  it('ha nincs ilyen input, NEM hoz létre — és sb_uid sem keletkezik', () => {
    grant();
    const f = form(false);
    populateHiddenFields(f, result);
    expect(f.querySelector('input[name="external_id"]')).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('hozzájárulás nélkül a mező üres', () => {
    deny();
    localStorage.setItem(KEY, '11111111-2222-4333-8444-555555555555');
    const f = form(true);
    populateHiddenFields(f, result);
    expect(f.querySelector<HTMLInputElement>('input[name="external_id"]')!.value).toBe('');
  });
});

describe('szerver-láb (buildGatewayPayload)', () => {
  it('a user_data.external_id-t VÁLTOZATLANUL (plain) továbbítja', () => {
    const p = buildGatewayPayload({
      eventName: 'contact_form_submitted', eventId: 'E1',
      userData: { email: 'a@b.hu', external_id: '11111111-2222-4333-8444-555555555555' },
    });
    expect((p.user_data as Record<string, string>).external_id).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('üres external_id (consent nélküli rejtett mező) kimarad', () => {
    const p = buildGatewayPayload({
      eventName: 'contact_form_submitted', eventId: 'E1',
      userData: { email: 'a@b.hu', external_id: '' },
    });
    expect(p.user_data).not.toHaveProperty('external_id');
  });
});
