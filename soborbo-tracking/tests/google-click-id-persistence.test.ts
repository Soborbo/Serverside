import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureUrlParams, persistTrackingParams, getStoredData, getGclid, getAllTrackingData,
} from '../lib/persistence';
import { GOOGLE_CLICK_KEYS } from '../lib/google-click-id';
import { resetAll, setCkyConsent, setUrl } from './helpers';

/**
 * A KLIKK-ID KIZÁRÓLAGOSSÁG A PERSISTENCE-LÁBON IS.
 *
 * A szabály (`lib/google-click-id.ts`): egy kattintás `gclid`-et VAGY `gbraid`-et
 * VAGY `wbraid`-et ad, sosem többet — a Google offline/EC feltöltés a két-ID-s
 * sort ELUTASÍTJA, tehát a konverzió nem torzul, hanem ELVÉSZ.
 *
 * MIÉRT EZ A FÁJL. A primitívet eddig CSAK a `gateway.ts` (last-touch attribúció)
 * használta; a `persistence.ts` 90 napos `sb_tracking` blobja nem. A rés nem
 * elméleti: a `getGclid()` az `index.ts`-ből EGYENESEN a konverziós payloadba megy
 * (`sendToWorker`, hidden mezők), és a tárolt gclid-et akkor is visszaadta, ha az
 * aktuális URL MÁS Google-ID-t hozott. iOS-forgalomnál (`gbraid`) ez egy KORÁBBI
 * kattintás azonosítóját ragasztotta a mostani konverzióra.
 *
 * A hiányt a Beautyflow kit fork-migrációja hozta ki: ott a szabály MINDKÉT lábon
 * élt, és a kanonikus persistence behúzása 6 esetet pirosított. Vagyis ezen a
 * ponton a fork volt előrébb — ezért megy a javítás FELFELÉ, a magba.
 */

beforeEach(() => {
  resetAll();
  setCkyConsent({ analytics: true, marketing: true });
});

const TRACKING_KEY = 'sb_tracking';

/** Milyen Google-ID-k ülnek egy objektumban. */
function googleIdsIn(o: Partial<Record<(typeof GOOGLE_CLICK_KEYS)[number], unknown>> | null | undefined): string[] {
  return o ? GOOGLE_CLICK_KEYS.filter((k) => o[k]) : [];
}

function seedTracking(d: Record<string, unknown>): void {
  localStorage.setItem(TRACKING_KEY, JSON.stringify({ timestamp: Date.now(), landingPage: '/', ...d }));
}

describe('a 90 napos sb_tracking blob EGY Google-ID-t tárol', () => {
  it('az URL több Google-ID-jéből egy kerül a tárolóba (gclid nyer)', () => {
    setUrl('/?gclid=G1&gbraid=B1');
    captureUrlParams();
    persistTrackingParams();

    expect(googleIdsIn(getStoredData())).toEqual(['gclid']);
  });

  it('friss gbraid KIÜTI a tárolt gclid-et — két kattintás nem keveredhet', () => {
    seedTracking({ gclid: 'G-regi' });
    setUrl('/?gbraid=B-uj');
    captureUrlParams();
    persistTrackingParams();

    const d = getStoredData();
    expect(googleIdsIn(d)).toEqual(['gbraid']);
    expect(d?.gclid, 'a korábbi kattintás ID-je nem maradhat ott').toBeUndefined();
  });

  it('ép blobot (0 vagy 1 ID) nem bánt', () => {
    seedTracking({ gclid: 'G-egyedul' });
    expect(getStoredData()?.gclid).toBe('G-egyedul');
  });
});

describe('a hibás korszakból örökölt páros ÖNGYÓGYUL olvasáskor', () => {
  it('olvasáskor egy ID marad, és a blob vissza is íródik', () => {
    seedTracking({ gclid: 'G-regi', wbraid: 'W-regi' });

    expect(googleIdsIn(getStoredData())).toEqual(['gclid']);
    // A gyógyítás nem csak a visszaadott másolatra vonatkozik — különben minden
    // olvasás újra megfizetné, és a tárolt blob romlott maradna.
    expect(googleIdsIn(JSON.parse(localStorage.getItem(TRACKING_KEY) as string))).toEqual(['gclid']);
  });
});

describe('getGclid — a tárolt ID csak akkor érvényes, ha ehhez a kattintáshoz tartozik', () => {
  it('az URL gclid-je nyer a tárolt felett', () => {
    seedTracking({ gclid: 'G-tarolt' });
    setUrl('/?gclid=G-url');

    expect(getGclid()).toBe('G-url');
  });

  it('MÁS Google-ID az URL-ben → a tárolt gclid NEM adható ehhez a konverzióhoz', () => {
    // Ez a rés maga: iOS-forgalom gbraid-ot ad, tehát a tárolt gclid egy KORÁBBI
    // kattintásé. Visszaadva a konverzió két kattintásból állna össze.
    seedTracking({ gclid: 'G-korabbi-kattintas' });
    setUrl('/?gbraid=B-mostani');

    expect(getGclid()).toBeNull();
  });

  it('Google-ID nélküli URL-en a tárolt gclid érvényes', () => {
    seedTracking({ gclid: 'G-tarolt' });
    setUrl('/kapcsolat/');

    expect(getGclid()).toBe('G-tarolt');
  });
});

describe('getAllTrackingData — a hidden mezőkbe sem kerülhet két kattintás', () => {
  it('a friss URL-ID kiüti a tárolt testvéreit erre a hívásra is', () => {
    seedTracking({ gclid: 'G-korabbi' });
    setUrl('/?gbraid=B-mostani');

    expect(googleIdsIn(getAllTrackingData())).toEqual(['gbraid']);
  });

  it('Google-ID nélküli URL-en a tárolt ID átjön', () => {
    seedTracking({ gclid: 'G-tarolt' });
    setUrl('/kapcsolat/');

    expect(googleIdsIn(getAllTrackingData())).toEqual(['gclid']);
  });
});

describe('a két tároló-modell ÖSSZHANGJA', () => {
  it('ugyanaz az URL ugyanazt a Google-ID-t adja a blobban és a hidden mezőkben', () => {
    setUrl('/?gclid=G1&gbraid=B1');
    captureUrlParams();
    persistTrackingParams();

    expect(googleIdsIn(getStoredData())).toEqual(['gclid']);
    expect(googleIdsIn(getAllTrackingData())).toEqual(['gclid']);
  });
});
