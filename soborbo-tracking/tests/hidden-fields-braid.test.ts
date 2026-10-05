import { describe, it, expect, beforeEach } from 'vitest';
import { populateHiddenFields, attachEventIdToForm, trackLeadSubmit } from '../lib/index';
import { captureUrlParams, persistTrackingParams } from '../lib/persistence';
import { resetAll, setCkyConsent, setUrl } from './helpers';

/**
 * gbraid / wbraid a rejtett form-mezőkben — regressziós őr.
 *
 * iOS-forgalomnál a Google Ads `gclid` HELYETT `gbraid`-et vagy `wbraid`-et ad.
 * A gateway-attribúció és a Data Manager-feltöltés ezeket már kezelte, de a
 * rejtett mezők (→ site-backend → CRM / gateway) csak a `gclid`-et vitték:
 * az iOS-kattintásból jött lead a backend felé azonosító nélkül ment.
 */

beforeEach(() => {
  resetAll();
  setCkyConsent({ analytics: true, marketing: true });
});

function form(): HTMLFormElement {
  const f = document.createElement('form');
  document.body.appendChild(f);
  return f;
}
const val = (f: HTMLFormElement, n: string) =>
  f.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.value ?? null;

function land(query: string): void {
  setUrl(`/${query}`);
  captureUrlParams();
  persistTrackingParams();
}

describe('populateHiddenFields — gbraid/wbraid ugyanúgy, mint a gclid', () => {
  it('?gbraid= → a gbraid mezőbe kerül, gclid és wbraid üres', () => {
    land('?gbraid=B-123');
    const f = form();
    populateHiddenFields(f, trackLeadSubmit({ email: 'a@b.hu' }));
    expect(val(f, 'gbraid')).toBe('B-123');
    expect(val(f, 'gclid')).toBe('');
    expect(val(f, 'wbraid')).toBe('');
  });

  it('?wbraid= → a wbraid mezőbe kerül', () => {
    land('?wbraid=W-456');
    const f = form();
    populateHiddenFields(f, trackLeadSubmit({ email: 'a@b.hu' }));
    expect(val(f, 'wbraid')).toBe('W-456');
    expect(val(f, 'gclid')).toBe('');
    expect(val(f, 'gbraid')).toBe('');
  });

  it('tárolt gbraid (másik oldalon konvertál) → a mezőbe kerül', () => {
    land('?gbraid=B-stored');
    setUrl('/ajanlatkeres');
    const f = form();
    populateHiddenFields(f, trackLeadSubmit({ email: 'a@b.hu' }));
    expect(val(f, 'gbraid')).toBe('B-stored');
  });

  it('gclid mellett NEM megy gbraid/wbraid (kölcsönös kizárás)', () => {
    land('?gclid=G-1&gbraid=B-1&wbraid=W-1');
    const f = form();
    populateHiddenFields(f, trackLeadSubmit({ email: 'a@b.hu' }));
    expect(val(f, 'gclid')).toBe('G-1');
    expect(val(f, 'gbraid')).toBe('');
    expect(val(f, 'wbraid')).toBe('');
  });
});

describe('attachEventIdToForm (CTA-folyamat) — gbraid/wbraid', () => {
  it('?gbraid= → a CTA-form is megkapja', () => {
    land('?gbraid=B-cta');
    const f = form();
    attachEventIdToForm(f, 'evt-1');
    expect(val(f, 'event_id')).toBe('evt-1');
    expect(val(f, 'gbraid')).toBe('B-cta');
    expect(val(f, 'gclid')).toBe('');
  });

  it('?gclid= → gbraid/wbraid üres', () => {
    land('?gclid=G-cta');
    const f = form();
    attachEventIdToForm(f, 'evt-2');
    expect(val(f, 'gclid')).toBe('G-cta');
    expect(val(f, 'gbraid')).toBe('');
    expect(val(f, 'wbraid')).toBe('');
  });
});

describe('TrackedForm.astro — statikus rejtett mezők', () => {
  const RAW = (import.meta as unknown as {
    glob: (p: string, o: unknown) => Record<string, string>;
  }).glob('../components/TrackedForm.astro', { query: '?raw', eager: true, import: 'default' });
  const src = Object.values(RAW)[0]!;
  it.each(['gclid', 'gbraid', 'wbraid'])('van <input type="hidden" name="%s">', (n) => {
    expect(src).toContain(`<input type="hidden" name="${n}" />`);
  });
});
