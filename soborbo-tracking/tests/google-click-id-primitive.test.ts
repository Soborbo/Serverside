import { describe, it, expect } from 'vitest';
import {
  GOOGLE_CLICK_KEYS,
  applyGoogleClickId,
  parseGclAwCookie,
  pickGoogleClickId,
  resolveGoogleClickId
} from '../lib/google-click-id';

/**
 * A PRIMITÍV MAGA — DOM nélkül, tároló-modell nélkül.
 *
 * A `collectAttribution` tesztjei (google-click-id-exclusivity.test.ts) a
 * gateway last-touch `localStorage`-modelljén keresztül mérik ugyanezt. Ez a
 * fájl a szabályt magát rögzíti, mert a painless `pr_tracking`
 * session-store-ja is ERRE fog delegálni — a szerződésnek a tároló-modelltől
 * függetlenül kell állnia.
 */

describe('parseGclAwCookie', () => {
  it('a GCL.<ts>.<gclid> harmadik szegmensétől mindent visszaad', () => {
    expect(parseGclAwCookie('GCL.1690000000.EAIaIQobChMI')).toBe('EAIaIQobChMI');
  });

  it('a gclid maga is tartalmazhat pontot — nem csonkítunk', () => {
    expect(parseGclAwCookie('GCL.1690000000.Cj0KCQ.abc.def')).toBe('Cj0KCQ.abc.def');
  });

  it('hiányzó/rövid/üres érték → undefined, nem féligkész string', () => {
    expect(parseGclAwCookie(undefined)).toBeUndefined();
    expect(parseGclAwCookie('')).toBeUndefined();
    expect(parseGclAwCookie('GCL.1690000000')).toBeUndefined();
    expect(parseGclAwCookie('GCL.1690000000.')).toBeUndefined();
  });
});

describe('pickGoogleClickId — kölcsönös kizárás EGY forráson belül', () => {
  it('a prioritás gclid > gbraid > wbraid', () => {
    expect(pickGoogleClickId({ gclid: 'A', gbraid: 'B', wbraid: 'C' })).toEqual({
      key: 'gclid',
      value: 'A'
    });
    expect(pickGoogleClickId({ gbraid: 'B', wbraid: 'C' })).toEqual({ key: 'gbraid', value: 'B' });
    expect(pickGoogleClickId({ wbraid: 'C' })).toEqual({ key: 'wbraid', value: 'C' });
  });

  it('üres string nem érték', () => {
    expect(pickGoogleClickId({ gclid: '', gbraid: 'B' })).toEqual({ key: 'gbraid', value: 'B' });
  });

  it('URLSearchParams, objektum és függvény forrás egyaránt', () => {
    expect(pickGoogleClickId(new URLSearchParams('?gbraid=B'))).toEqual({
      key: 'gbraid',
      value: 'B'
    });
    expect(pickGoogleClickId((k) => (k === 'wbraid' ? 'W' : undefined))).toEqual({
      key: 'wbraid',
      value: 'W'
    });
    expect(pickGoogleClickId(undefined)).toBeUndefined();
  });
});

describe('resolveGoogleClickId — forrás-sorrend', () => {
  it('URL > cookie: a friss gbraid veri az elavult _gcl_aw-gclid-et', () => {
    expect(
      resolveGoogleClickId({
        url: new URLSearchParams('?gbraid=UJ'),
        gclAw: 'GCL.1690000000.REGI',
        stored: { gclid: 'MEG-REGEBBI' }
      })
    ).toEqual({ key: 'gbraid', value: 'UJ', source: 'url' });
  });

  it('URL > tároló: a friss jel veri a korábbi kattintást', () => {
    expect(
      resolveGoogleClickId({ url: new URLSearchParams('?gclid=UJ'), stored: { gclid: 'REGI' } })
    ).toEqual({ key: 'gclid', value: 'UJ', source: 'url' });
  });

  it('cookie > tároló, ha az URL nem hozott jelet', () => {
    expect(
      resolveGoogleClickId({ url: new URLSearchParams(''), gclAw: 'GCL.1.C', stored: { gclid: 'S' } })
    ).toEqual({ key: 'gclid', value: 'C', source: 'gcl_aw_cookie' });
  });

  it('tároló a végső mentsvár — a belső oldalon konvertáló látogató', () => {
    expect(resolveGoogleClickId({ url: new URLSearchParams(''), stored: { gbraid: 'S' } })).toEqual({
      key: 'gbraid',
      value: 'S',
      source: 'stored'
    });
  });

  it('a legacy tároló TÖBB ID-ja gyógyul: a gclid marad', () => {
    expect(resolveGoogleClickId({ stored: { gclid: 'G', gbraid: 'B', wbraid: 'W' } })).toEqual({
      key: 'gclid',
      value: 'G',
      source: 'stored'
    });
  });

  it('egy forrás KIZÁRHATÓ azzal, hogy nem adjuk át (consent-kapu)', () => {
    // Ez a szerződés lényege az UNKNOWN-állapothoz: az URL/cookie kimarad, a
    // korábban tárolt érték viszont NEM vész el.
    expect(resolveGoogleClickId({ stored: { gclid: 'S' } })).toEqual({
      key: 'gclid',
      value: 'S',
      source: 'stored'
    });
    expect(resolveGoogleClickId({})).toBeUndefined();
  });
});

describe('applyGoogleClickId — a rekordban egy ID maradhat', () => {
  it('a testvérek eltűnnek, a nem-Google mezők érintetlenek', () => {
    const rec: Record<string, unknown> = {
      gclid: 'REGI',
      wbraid: 'REGEBBI',
      utm_source: 'google',
      fbclid: 'FB'
    };
    applyGoogleClickId(rec, { key: 'gbraid', value: 'UJ', source: 'url' });
    expect(rec).toEqual({ gbraid: 'UJ', utm_source: 'google', fbclid: 'FB' });
  });

  it('undefined → MINDEN Google klikk-ID törlődik (consent-visszavonás)', () => {
    const rec: Record<string, unknown> = { gclid: 'G', gbraid: 'B', utm_source: 'google' };
    applyGoogleClickId(rec, undefined);
    expect(rec).toEqual({ utm_source: 'google' });
  });

  it('a kulcslista teljes — ha új Google-ID jön, ez a teszt bukjon előbb', () => {
    expect([...GOOGLE_CLICK_KEYS]).toEqual(['gclid', 'gbraid', 'wbraid']);
  });
});
