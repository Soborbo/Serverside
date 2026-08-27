import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectKeyCoverage, detectCoverageDrops, type CoverageStats } from '../src/lib/emq';

/**
 * A ct/zp/country LEFEDETTSÉGE MÉRHETŐ (M5).
 *
 * ── Miért kellett ────────────────────────────────────────────────────────────
 * A ledger négy jelenlét-flaget írt (`em`, `ph`, `fbc`, `fbp`), és az
 * EMQ-proxy metrika is csak ezt a négyet nézte. Ha egy site abbahagyta a
 * `city`/`postal_code`/`country` küldését, az a napi digestben és a
 * coverage-riasztásban LÁTHATATLAN maradt — csak a Meta Events Managerben,
 * késleltetve.
 *
 * Ez nem elméleti hiány volt: a painless böngésző-lába hónapokig `postal_code`
 * NÉLKÜL küldött (D1), és semmi nem jelezte. Egy mezőkészlet-szerződés, amit
 * nem mérünk, a következő regressziónál is csendes lesz.
 *
 * ── A degradáció szabálya ────────────────────────────────────────────────────
 * A cím-flagek KÜLÖN lekérdezésben jönnek. Ha a 0009-es migráció még nem futott
 * le azon a D1-en, a cím-kulcsok kimaradnak — de a NÉGY meglévő kulcs mérése
 * ettől NEM állhat le. Egy monitoring-vakfolt rosszabb, mint egy hiányzó sor.
 */

const MIGRATION = fileURLToPath(new URL('../migrations/0009_events_raw_address_flags.sql', import.meta.url));

/** Minimál D1-utánzat: az első SELECT-re az `core`, a másodikra az `addr` sort adja. */
function fakeLedger(rows: Array<Record<string, number> | Error>) {
  let call = 0;
  return {
    LEDGER: {
      prepare() {
        const row = rows[call++];
        return {
          bind() {
            return {
              first: async () => {
                if (row instanceof Error) throw row;
                return row;
              },
            };
          },
        };
      },
    },
  } as unknown as { LEDGER: D1Database };
}

const CORE = {
  n24: 100, em24: 90, ph24: 80, fbc24: 40, fbp24: 70,
  n7: 200, em7: 180, ph7: 160, fbc7: 80, fbp7: 140,
};
const ADDR = {
  n24: 100, ct24: 0, zp24: 95, country24: 100,
  n7: 200, ct7: 0, zp7: 10, country7: 200,
};

describe('a 0009-es migráció', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('mind a három cím-flaget felveszi, NOT NULL DEFAULT 0-val', () => {
    for (const col of ['ct_present', 'zp_present', 'country_present']) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`));
    }
  });
});

describe('collectKeyCoverage — a cím-kulcsok a metrikában', () => {
  it('a hét kulcsot adja vissza, a cím-kulcsokkal együtt', async () => {
    const stats = await collectKeyCoverage(fakeLedger([CORE, ADDR]), 'painless');
    expect(stats?.keys.map((k) => k.key)).toEqual(['em', 'ph', 'fbc', 'fbp', 'ct', 'zp', 'country']);
  });

  it('a százalékok a saját ablakukból számolnak', async () => {
    const stats = await collectKeyCoverage(fakeLedger([CORE, ADDR]), 'painless');
    const zp = stats!.keys.find((k) => k.key === 'zp')!;
    expect(zp.pct24h).toBe(95); // a D1 után a böngésző-láb is küldi
    expect(zp.pct7d).toBe(5); // a baseline még a zp nélküli időszaké
  });

  it('HA a 0009 még nem futott le: a NÉGY meglévő kulcs mérése MEGMARAD', async () => {
    // Ez a lényeg. Egy közös SELECT-ben a hiányzó oszlop az EGÉSZ lekérdezést
    // eldobná, és a digest némán „n/a"-ra váltana MINDEN kulcsra — pont a
    // meglévő őröket veszítenénk el egy bővítés miatt.
    const stats = await collectKeyCoverage(
      fakeLedger([CORE, new Error('no such column: zp_present')]),
      'painless',
    );
    expect(stats?.keys.map((k) => k.key)).toEqual(['em', 'ph', 'fbc', 'fbp']);
    expect(stats?.events24h).toBe(100);
  });
});

describe('detectCoverageDrops — a cím-kulcsokra ugyanaz a küszöb', () => {
  const base = (keys: CoverageStats['keys']): CoverageStats => ({
    events24h: 100,
    events7d: 200,
    keys,
  });

  it('a zp beesése ugyanúgy riaszt, mint az em-é', () => {
    const drops = detectCoverageDrops(base([{ key: 'zp', pct24h: 10, pct7d: 95 }]));
    expect(drops.map((d) => d.key)).toEqual(['zp']);
  });

  it('a SOSEM küldött `ct` nem ad fals riasztást (baseline < 30%)', () => {
    // A painless AddressData-jában nincs strukturált város (D1), tehát a `ct`
    // tartósan 0% — ez nem regresszió, és nem is szabad annak látszania.
    const drops = detectCoverageDrops(base([{ key: 'ct', pct24h: 0, pct7d: 0 }]));
    expect(drops).toEqual([]);
  });

  it('a zp FELFUTÁSA (D1) nem riasztás — csak az esés az', () => {
    const drops = detectCoverageDrops(base([{ key: 'zp', pct24h: 95, pct7d: 5 }]));
    expect(drops).toEqual([]);
  });
});
