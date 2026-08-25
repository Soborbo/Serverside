import { describe, it, expect } from 'vitest';
import {
  GA4_RESERVED_CAMPAIGN_PARAMS,
  BASELINE,
  scanLibPushes,
  scanContainerParams
} from '../scripts/check-ga4-reserved-params.mjs';

/**
 * GA4 FOGLALT KAMPÁNY-PARAMÉTEREK — az őr őre.
 *
 * A GA4 a `source`/`medium`/`campaign` NEVŰ event-paramétert manuális
 * kampány-jelzésnek veszi: a címke a MUNKAMENET forrása lesz, és felülírja a
 * valódi akvizíciót — az egész munkamenetre, a benne lévő konverziókkal együtt.
 *
 * Mérve (painless GA4 413271735, 2026-08-25): `standalone / (not set)` 57,
 * `server / (not set)` 23, `after_calculator / (not set)` 9,
 * `email_click / (not set)` 4 munkamenet 90 nap alatt. A painless forkja
 * átnevezte a paramétert, és a napi bontás bizonyítja a hatást: 08-15 (5),
 * 08-16 (1), 08-17 (3), azóta NULLA.
 */

describe('a szkennerek tényleg látják, amit keresnek', () => {
  it('a spread-objektumos push-törzsben IS megtalálja a foglalt kulcsot', () => {
    // Ez a fixture a valódi `lib/gateway.ts` alakja. Egy nem-mohó „első `}`
    // után `)`" minta MÁR AZ ELSŐ spreadnél lezárult volna, és a `source`
    // kimaradt volna a vizsgált törzsből — az őr csendben átengedte volna azt
    // az egy előfordulást, amiért megszületett. (Az első változatom pontosan
    // így bukott: „az alapvonal elavult, nincs meg".)
    const src = `
    window.dataLayer.push({
      event: eventName,
      event_id: eventId,
      ...(params.value !== undefined && { value: params.value }),
      ...(params.source && { source: params.source }),
      ...(params.service && { service: params.service })
    });`;
    expect(scanLibPushes(src)).toContain('source');
  });

  it('az `utm_source` NEM találat — az legitim mező, nem foglalt paraméternév', () => {
    const src = `
    window.dataLayer.push({
      event: 'x',
      utm_source: t.utm_source,
      first_utm_source: t.first_utm_source
    });`;
    expect(scanLibPushes(src)).toEqual([]);
  });

  it('a push-on KÍVÜLI `source:` mező nem találat (csak a dataLayer számít)', () => {
    const src = `const cfg = { source: 'x' };\nsendToWorker({ source: params.source });`;
    expect(scanLibPushes(src)).toEqual([]);
  });

  it('a GTM-konténerben a GA4 event-paraméter NEVÉT nézi, nem az értékét', () => {
    const container = {
      containerVersion: {
        tag: [
          {
            parameter: [
              {
                type: 'LIST',
                list: [
                  { type: 'MAP', map: [{ key: 'name', value: 'source' }, { key: 'value', value: '{{DLV - source}}' }] },
                  { type: 'MAP', map: [{ key: 'name', value: 'service' }, { key: 'value', value: '{{DLV - service}}' }] }
                ]
              }
            ]
          }
        ]
      }
    };
    expect(scanContainerParams(container)).toEqual(['source']);
  });
});

describe('az alapvonal fegyelme', () => {
  it('minden kivétel mellett ott van, MI kell a megszüntetéséhez', () => {
    // Indoklás nélküli kivétel örökre itt maradna, és a racsni önmagát ürítené ki.
    for (const [key, entry] of Object.entries(BASELINE)) {
      expect(entry.where, `${key}: nincs megadva a hely`).toBeTruthy();
      expect(entry.fix, `${key}: nincs megadva a megszüntetés módja`).toBeTruthy();
      expect(entry.evidence, `${key}: nincs bizonyíték`).toBeTruthy();
    }
  });

  it('a `term` és a `content` is foglalt — a utm-párjaik ugyanabba futnak', () => {
    expect(GA4_RESERVED_CAMPAIGN_PARAMS).toEqual(
      expect.arrayContaining(['source', 'medium', 'campaign', 'term', 'content'])
    );
  });

  it('az alapvonal PONTOSAN a két ismert előfordulást tartalmazza — se többet, se kevesebbet', () => {
    // Ha ez a lista nő, valaki új foglalt nevet vett fel kivételként; ha fogy,
    // a javítás megtörtént és a racsnit szűkíteni kell.
    expect(Object.keys(BASELINE).sort()).toEqual(['container.json:source', 'gateway.ts:source']);
  });
});
