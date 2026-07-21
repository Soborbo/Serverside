import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — .mjs script, nincs típusdeklarációja (szándékosan futtatható CLI is)
import { CONTRACT_PATH, LOCK_PATH, contractHash, normalizeContract } from '../scripts/contract-hash.mjs';

// ============================================================
// Contract sync-guard (F1-4).
//
// Az `src/events.json` VENDORED MÁSOLAT; a kanonikus otthon a
// Soborbo/claudeskills repo `soborbo-tracking/events.json`-ja. Egy itt kézzel
// beleírt sor némán szétvinné a két repót, és a drift csak akkor derülne ki,
// amikor egy event már rossz néven megy ki egy hirdetési platformra.
//
// Ez a teszt a meglévő CI-be kapcsolódik (`npm test`), nem kell külön workflow-lépés.
// ============================================================

const raw = () => readFileSync(CONTRACT_PATH, 'utf8');
const lock = () => JSON.parse(readFileSync(LOCK_PATH, 'utf8'));

describe('contract deliberate-edit lock', () => {
  it('a KANONIKUS events.json megegyezik a lock contract_hash-sel', () => {
    // Ha ez bukik: ez a KANONIKUS forrás, ITT szerkeszd. Módosítsd az events.json-t,
    // majd `contract-hash.mjs --update`, és re-vendorold a claudeskills-másolatot.
    expect(contractHash(raw())).toBe(lock().contract_hash);
  });

  it('a lock a Serverside-ot jelöli forrásnak, a claudeskills-t downstreamnek', () => {
    const l = lock();
    // Ez a repo a source of truth — a lock szerepe canonical-source, NEM vendored.
    expect(l.role).toBe('canonical-source');
    expect(l.contract_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A downstream fogyasztó (claudeskills) INNEN vendorol; a lock ezt dokumentálja.
    const consumers = l.downstream_consumers ?? [];
    expect(consumers.some((c: { repository?: string }) => c.repository === 'Soborbo/claudeskills')).toBe(true);
  });
});

describe('a hash determinisztikus — csak a szerződéstartalom számít', () => {
  const original = raw();

  it('a FORMÁZÁS nem számít (behúzás/whitespace)', () => {
    const reformatted = JSON.stringify(JSON.parse(original), null, 8);
    expect(contractHash(reformatted)).toBe(contractHash(original));
  });

  it('a KULCSSORREND nem számít', () => {
    const reversedKeys = JSON.parse(original).map((e: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(e).reverse()),
    );
    expect(contractHash(JSON.stringify(reversedKeys))).toBe(contractHash(original));
  });

  it('az ESEMÉNYEK SORRENDJE nem számít (a lista halmaz, nem sorozat)', () => {
    const shuffled = [...JSON.parse(original)].reverse();
    expect(contractHash(JSON.stringify(shuffled))).toBe(contractHash(original));
  });

  it('de a TARTALMI változás IGENIS számít', () => {
    const events = JSON.parse(original);
    events[0].meta = events[0].meta === 'Lead' ? 'Contact' : 'Lead';
    expect(contractHash(JSON.stringify(events))).not.toBe(contractHash(original));
  });

  it('egy ÚJ esemény felvétele is számít', () => {
    const events = JSON.parse(original);
    events.push({ name: 'zzz_new_event', kind: 'conversion' });
    expect(contractHash(JSON.stringify(events))).not.toBe(contractHash(original));
  });

  it('egy esemény ÁTNEVEZÉSE is számít (a név a szerződés kulcsa)', () => {
    const events = JSON.parse(original);
    events[0].name = `${events[0].name}_renamed`;
    expect(contractHash(JSON.stringify(events))).not.toBe(contractHash(original));
  });

  it('nem-tömb gyökérnél beszédes hibát dob', () => {
    expect(() => normalizeContract('{"not":"an array"}')).toThrow(/tömböt vártam/);
  });
});
