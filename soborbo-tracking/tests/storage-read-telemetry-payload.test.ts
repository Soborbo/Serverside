import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendToWorker } from '../lib/gateway';
import { getFbp, resetStorageReadBlocked } from '../lib/persistence';
import { setCookie, setUrl, resetAll, setCkyConsent } from './helpers';

/**
 * A read-gate telemetriája a KONVERZIÓS PAYLOADBAN (2. brief · S2).
 *
 * Ez a mérőműszer: ha a `storage_read_blocked` gyakran `true` GRANTED consent
 * mellett, akkor a Fázis D betöltési-verseny hipotézise egy MÁSODIK, független
 * bizonyítékot kapott — és a read-gate sürgősebb, mint hittük.
 */

function ckyCookie(ad: boolean, an: boolean): void {
  setCookie(
    'cookieyes-consent',
    `consent:yes,necessary:yes,functional:yes,analytics:${an ? 'yes' : 'no'},advertisement:${ad ? 'yes' : 'no'},other:yes`,
  );
}

async function capturePayload(): Promise<Record<string, unknown>> {
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });
  const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetchMock);
  await sendToWorker({
    event_name: 'phone_number_clicked',
    event_id: 'E1',
    event_time: 1_700_000_000,
  });
  return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
}

beforeEach(() => { resetAll(); resetStorageReadBlocked(); });
afterEach(() => vi.unstubAllGlobals());

describe('sendToWorker — storage_read_blocked telemetria', () => {
  it('GRANTED consent: nincs blokk, és a Meta sütik VÁLTOZATLANUL utaznak', async () => {
    ckyCookie(true, true);
    setCkyConsent({ analytics: true, marketing: true });
    setCookie('_fbp', 'fb.1.100.200');
    setCookie('_fbc', 'fb.1.100.CLICK');
    setUrl('/');

    const body = await capturePayload();
    // Bitre a régi viselkedés: a payload ugyanazt a két süti-értéket hordozza.
    expect(body.fbp).toBe('fb.1.100.200');
    expect(body.fbc).toBe('fb.1.100.CLICK');
    expect(body.storage_read_blocked).toBe(false);
    expect(body.storage_read_blocked_keys).toEqual([]);
  });

  it('marketing megtagadva: nincs fbp/fbc a payloadban, és a blokk JELENTVE van', async () => {
    ckyCookie(false, true);
    setCkyConsent({ analytics: true, marketing: false });
    setCookie('_fbp', 'fb.1.100.200');
    setCookie('_fbc', 'fb.1.100.CLICK');
    setUrl('/');

    const body = await capturePayload();
    expect(body.fbp).toBeUndefined();
    expect(body.fbc).toBeUndefined();
    expect(body.storage_read_blocked).toBe(true);
    expect((body.storage_read_blocked_keys as string[]).sort()).toEqual(['_fbc', '_fbp']);
  });

  it('a payload csak KULCSNEVEKET hordoz, értéket soha', async () => {
    ckyCookie(false, true);
    setCkyConsent({ analytics: true, marketing: false });
    setCookie('_fbp', 'fb.1.100.SECRET');
    setUrl('/');
    getFbp();

    const body = await capturePayload();
    expect(JSON.stringify(body.storage_read_blocked_keys)).not.toContain('SECRET');
  });
});
