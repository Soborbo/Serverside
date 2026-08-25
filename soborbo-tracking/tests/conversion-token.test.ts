import { describe, it, expect } from 'vitest';

import {
  mintConversionCommitToken,
  verifyConversionCommitToken,
  consumeConversionCommitToken,
  memoryCommitTokenStore,
  kvCommitTokenStore,
  d1CommitTokenStore,
  ConversionTokenError,
  CONVERSION_TOKEN_CODES,
  CONVERSION_TOKEN_MESSAGES,
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  MIN_SECRET_LENGTH,
  type CommitTokenStore,
} from '../server/conversion-token';

/**
 * P5.3 — az ALÁÍRT, EGYSZER-HASZNÁLATOS siker-token.
 *
 * A HIBAOSZTÁLY, amit zár: a P5 első köre a böngésző-konverziót a
 * köszönő-oldalra tolta, de a siker bizonyítéka egy nyílt `?e=<event_id>`
 * paraméter volt. Az event_id a form REJTETT MEZŐJÉBEN van, tehát bárki
 * kiolvassa: elküldi a formot, a backend elutasítja, majd kézzel megnyitja a
 * köszönő-oldalt ugyanazzal az id-vel — és a konverzió elég. Vagyis az INV-001
 * („business FAILED → conversion = 0") csak a jóhiszemű útvonalon állt.
 *
 * Az alábbi tesztek pontosan ezt a támadást és minden szomszédos negatív ágat
 * rögzítik. Ha az aláírás-ellenőrzést vagy a beváltást bárki kiveszi, ezek
 * PIROSAK lesznek.
 */

const SECRET = 'x'.repeat(MIN_SECRET_LENGTH);
const SITE = 'painlessremovals.com';
const EVENT = 'quote_calculator_submitted';
const EVENT_ID = 'b3f1c2d4e5f60718293a4b5c6d7e8f90';

const mint = (over: Partial<Parameters<typeof mintConversionCommitToken>[0]> = {}) =>
  mintConversionCommitToken({
    secret: SECRET, siteId: SITE, eventName: EVENT, eventId: EVENT_ID, ...over,
  });

describe('mint — a token PII-mentes és kötött', () => {
  it('a kiállított token dekódolható payloadja NEM tartalmaz PII-t', async () => {
    const token = await mint();
    const [body] = token.split('.');
    const json = atob(body!.replace(/-/g, '+').replace(/_/g, '/'));

    // A token URL-be kerül (303), tehát bemegy a szerver-logokba és a
    // referrerbe is. Bármi, ami itt PII, azonnal INV-002 sértés.
    for (const forbidden of ['@', 'email', 'phone', 'jane', '+3630', 'first', 'last', 'name']) {
      expect(json.toLowerCase()).not.toContain(forbidden);
    }
    const payload = JSON.parse(json);
    expect(Object.keys(payload).sort()).toEqual(['eid', 'evn', 'exp', 'jti', 'sid', 'v']);
  });

  it('minden kiállítás új jti-t kap — két token nem váltja be egymást', async () => {
    const a = await mint();
    const b = await mint();
    expect(a).not.toBe(b);
  });

  it('hiányzó/rövid titok esetén DOB, nem ad némán „nincs token"-t', async () => {
    // A csendes ág azt jelentené, hogy egy elgépelt env-változó némán elveszi
    // a site ÖSSZES böngésző-konverzióját, és minden mérőszám zöld marad.
    await expect(mint({ secret: '' })).rejects.toBeInstanceOf(ConversionTokenError);
    await expect(mint({ secret: 'rövid' })).rejects.toMatchObject({
      code: CONVERSION_TOKEN_CODES.SECRET_INVALID,
    });
  });

  it('hiányzó siteId/eventName/eventId esetén DOB', async () => {
    await expect(mint({ siteId: '' })).rejects.toMatchObject({ code: CONVERSION_TOKEN_CODES.MALFORMED });
    await expect(mint({ eventName: '' })).rejects.toMatchObject({ code: CONVERSION_TOKEN_CODES.MALFORMED });
    await expect(mint({ eventId: '' })).rejects.toMatchObject({ code: CONVERSION_TOKEN_CODES.MALFORMED });
  });

  it('a TTL-t befogja: egy elgépelt 30 napos érték nem nyit hónapos replay-ablakot', async () => {
    const now = 1_800_000_000;
    const token = await mint({ ttlSeconds: 86_400 * 30, nowSeconds: now });
    const payload = JSON.parse(atob(token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.exp).toBe(now + MAX_TOKEN_TTL_SECONDS);
  });

  it('alapértelmezett TTL 15 perc', async () => {
    const now = 1_800_000_000;
    const token = await mint({ nowSeconds: now });
    const payload = JSON.parse(atob(token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.exp).toBe(now + DEFAULT_TOKEN_TTL_SECONDS);
  });
});

describe('verify — a negatív ágak mind saját kódot kapnak', () => {
  it('érvényes token átmegy, és visszaadja az event_id-t + event-nevet', async () => {
    const r = await verifyConversionCommitToken(await mint(), { secret: SECRET, siteId: SITE, eventName: EVENT });
    expect(r).toMatchObject({ ok: true, eventId: EVENT_ID, eventName: EVENT });
  });

  it('hiányzó token → TRK-510-001', async () => {
    for (const t of [null, undefined, '']) {
      const r = await verifyConversionCommitToken(t, { secret: SECRET });
      expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.MISSING });
    }
  });

  it('alakilag hibás token → TRK-510-002', async () => {
    const bad = ['nincs-pont', '.csak-sig', 'csak-body.', 'a.b.c', '!!!.***', 'a.$$$'];
    for (const t of bad) {
      const r = await verifyConversionCommitToken(t, { secret: SECRET });
      expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.MALFORMED });
    }
  });

  it('MEGHAMISÍTOTT payload → TRK-510-003 (ez a támadás lényege)', async () => {
    const token = await mint();
    const [body, sig] = token.split('.');
    const payload = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/')));
    payload.eid = 'a-tamado-sajat-event-idje';
    const forged = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const r = await verifyConversionCommitToken(`${forged}.${sig}`, { secret: SECRET });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.BAD_SIGNATURE });
  });

  it('MÁS titokkal aláírt token → TRK-510-003', async () => {
    const token = await mintConversionCommitToken({
      secret: 'y'.repeat(MIN_SECRET_LENGTH), siteId: SITE, eventName: EVENT, eventId: EVENT_ID,
    });
    const r = await verifyConversionCommitToken(token, { secret: SECRET });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.BAD_SIGNATURE });
  });

  it('lejárt token → TRK-510-005', async () => {
    const now = 1_800_000_000;
    const token = await mint({ nowSeconds: now, ttlSeconds: 60 });
    const r = await verifyConversionCommitToken(token, { secret: SECRET, nowSeconds: now + 61 });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.EXPIRED });
  });

  it('MÁS site tokenje → TRK-510-006 (tenant-szivárgás ellen)', async () => {
    const r = await verifyConversionCommitToken(await mint(), { secret: SECRET, siteId: 'lomtalan.hu' });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.WRONG_SITE });
  });

  it('MÁS event tokenje → TRK-510-007 (olcsó eventtel nem lehet drágát commitolni)', async () => {
    const r = await verifyConversionCommitToken(await mint(), { secret: SECRET, eventName: 'purchase' });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.WRONG_EVENT });
  });

  it('ismeretlen séma-verzió → TRK-510-004', async () => {
    // Helyesen ALÁÍRT, de v:99 payload — a verzió-kapunak az aláírás UTÁN kell fognia.
    const payload = { v: 99, sid: SITE, evn: EVENT, eid: EVENT_ID, jti: 'j', exp: 9_999_999_999 };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    let bin = ''; for (const b of raw) bin += String.fromCharCode(b);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const r = await verifyConversionCommitToken(`${body}.${sig}`, { secret: SECRET });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.UNSUPPORTED_VERSION });
  });

  it('hiányzó titok az ellenőrzésnél → TRK-510-010, NEM „érvényes"', async () => {
    const r = await verifyConversionCommitToken(await mint(), { secret: '' });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.SECRET_INVALID });
  });

  it('minden kódhoz tartozik operátori üzenet', () => {
    for (const code of Object.values(CONVERSION_TOKEN_CODES)) {
      expect(CONVERSION_TOKEN_MESSAGES[code]).toBeTruthy();
    }
  });
});

describe('consume — EGYSZER használatos', () => {
  it('első beváltás sikeres, a MÁSODIK TRK-510-008 (köszönő-oldal újratöltés / back-forward)', async () => {
    const store = memoryCommitTokenStore();
    const token = await mint();

    const first = await consumeConversionCommitToken(token, { secret: SECRET, siteId: SITE, store });
    expect(first).toMatchObject({ ok: true, eventId: EVENT_ID });

    const second = await consumeConversionCommitToken(token, { secret: SECRET, siteId: SITE, store });
    expect(second).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.ALREADY_CONSUMED });
  });

  it('a store hibája FAIL-CLOSED: TRK-510-009, nem „hát akkor legyen konverzió"', async () => {
    const broken: CommitTokenStore = { async claim() { throw new Error('KV down'); } };
    const r = await consumeConversionCommitToken(await mint(), { secret: SECRET, store: broken });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.STORE_UNAVAILABLE });
  });

  it('érvénytelen tokent el sem visz a store-ig (nem szemeteli tele hamis jti-kkel)', async () => {
    let claims = 0;
    const counting: CommitTokenStore = { async claim() { claims++; return true; } };
    await consumeConversionCommitToken('szemét.token', { secret: SECRET, store: counting });
    expect(claims).toBe(0);
  });

  it('a beváltás-nyom a token LEJÁRATÁIG él (különben egy még érvényes token újra beváltható lenne)', async () => {
    const now = 1_800_000_000;
    let seenTtl = -1;
    const store: CommitTokenStore = { async claim(_j, ttl) { seenTtl = ttl; return true; } };
    const token = await mint({ nowSeconds: now, ttlSeconds: 900 });
    await consumeConversionCommitToken(token, { secret: SECRET, store, nowSeconds: now + 100 });
    expect(seenTtl).toBe(800);
  });
});

describe('store-implementációk', () => {
  it('KV-store: első claim true, második false', async () => {
    const map = new Map<string, string>();
    const kv = {
      async get(k: string) { return map.get(k) ?? null; },
      async put(k: string, v: string) { map.set(k, v); },
    };
    const store = kvCommitTokenStore(kv);
    expect(await store.claim('j1', 600)).toBe(true);
    expect(await store.claim('j1', 600)).toBe(false);
    expect(await store.claim('j2', 600)).toBe(true);
  });

  it('D1-store: kulcsütközés = már elhasznált', async () => {
    const seen = new Set<string>();
    const db = {
      prepare() {
        return {
          bind(jti: unknown) {
            return {
              async run() {
                if (seen.has(String(jti))) throw new Error('UNIQUE constraint failed: conversion_commit_tokens.jti');
                seen.add(String(jti));
              },
            };
          },
        };
      },
    };
    const store = d1CommitTokenStore(db);
    expect(await store.claim('j1', 600)).toBe(true);
    expect(await store.claim('j1', 600)).toBe(false);
  });

  it('D1-store: NEM kulcsütközés (pl. hiányzó tábla) TOVÁBBDOBÓDIK → fail-closed', async () => {
    // Ha ezt „már elhasznált"-nak vennénk, egy hiányzó tábla némán MINDEN
    // tokent frissnek mutatna, és pont az egyszer-használat veszne el.
    const db = {
      prepare() {
        return { bind() { return { async run() { throw new Error('no such table: conversion_commit_tokens'); } }; } };
      },
    };
    await expect(d1CommitTokenStore(db).claim('j1', 600)).rejects.toThrow('no such table');

    const r = await consumeConversionCommitToken(await mint(), { secret: SECRET, store: d1CommitTokenStore(db) });
    expect(r).toMatchObject({ ok: false, code: CONVERSION_TOKEN_CODES.STORE_UNAVAILABLE });
  });
});

describe('RED TEST — a teljes támadási forgatókönyv', () => {
  it('a backend ELUTASÍT → a támadó a saját event_id-jével NEM tud commitolni', async () => {
    const store = memoryCommitTokenStore();
    // A backend elbukott, tehát tokent SEM állított ki. A támadó annyit tud,
    // amit a DOM-ból kiolvasott: az event_id-t. Bármit tesz vele a köszönő-oldal
    // URL-jébe, az nem lesz érvényes aláírás.
    const attempts = [
      EVENT_ID,
      `${EVENT_ID}.${EVENT_ID}`,
      btoa(JSON.stringify({ v: 1, sid: SITE, evn: EVENT, eid: EVENT_ID, jti: 'x', exp: 9_999_999_999 })) + '.sig',
    ];
    for (const t of attempts) {
      const r = await consumeConversionCommitToken(t, { secret: SECRET, siteId: SITE, store });
      expect(r.ok).toBe(false);
    }
  });

  it('a backend SIKERÜL → pontosan EGY beváltható token', async () => {
    const store = memoryCommitTokenStore();
    const token = await mint();
    const results = await Promise.all(
      [1, 2, 3].map(() => consumeConversionCommitToken(token, { secret: SECRET, siteId: SITE, store })),
    );
    // A memória-store szinkron, tehát a párhuzamos beváltásból is pontosan egy nyer.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
