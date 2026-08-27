import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A `user_data` MEZŐKÉSZLET-SZERZŐDÉS ŐRE (D1).
 *
 * ── Miért kell ───────────────────────────────────────────────────────────────
 * A kliens-csomag transport-típusa (`UserData`) és a Worker elfogadó típusa
 * (`PlainUserDataPayload`) UGYANANNAK a HTTP-body-nak a két oldala. Semmi nem
 * kötötte őket össze: a `street` évekig ott állt a transport-típusban, a Worker
 * meg sosem ismerte. A hívó típushelyesen küldte, a gateway némán eldobta —
 * se hiba, se log, se metrika. Ez a teszt pont ezt a némaságot szünteti meg.
 *
 * ── Miért szövegből olvas, és nem típusból ───────────────────────────────────
 * A TypeScript-típusok futásidőben nem léteznek, tehát futásidőben nem is
 * hasonlíthatók össze. A két interface FORRÁSA viszont igen — és ez a
 * megközelítés a repóban már bevált (`vendored-integrity`, `contract-lock`).
 *
 * HA EZ A TESZT BUKIK: ne a listát igazítsd a kódhoz. Döntsd el, MELYIK oldal
 * téved — egy mező, amit a transport hirdet, de a Worker nem fogad, néma
 * adatvesztés; egy mező, amit a Worker fogad, de a transport nem hirdet,
 * elérhetetlen funkció.
 */

const TRANSPORT = fileURLToPath(new URL('../soborbo-tracking/lib/gateway.ts', import.meta.url));
const WORKER = fileURLToPath(new URL('../src/types.ts', import.meta.url));

/**
 * Egy megnevezett `export interface` mezőneveit adja vissza.
 * Szándékosan szigorú: a nyitó sortól az első záró `}`-ig olvas, és csak a
 * `név?:` / `név:` alakú sorokat veszi mezőnek (a kommentek kiesnek).
 */
function interfaceFields(file: string, name: string): string[] {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`nincs ilyen interface: ${name} (${file})`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`nem záródik az interface: ${name} (${file})`);
  const body = src.slice(start, end);
  return body
    .split('\n')
    .slice(1)
    .map((line) => /^\s{2}([a-z_][a-z0-9_]*)\??:/i.exec(line)?.[1])
    .filter((f): f is string => Boolean(f))
    .sort();
}

describe('user_data mezőkészlet — transport ↔ Worker-elfogadás', () => {
  const transport = interfaceFields(TRANSPORT, 'UserData');
  const worker = interfaceFields(WORKER, 'PlainUserDataPayload');

  it('a mérőműszer maga nem üres (mindkét interface-t megtalálta)', () => {
    expect(transport.length).toBeGreaterThan(4);
    expect(worker.length).toBeGreaterThan(4);
  });

  it('a transport nem hirdet olyan mezőt, amit a Worker NEM fogad (néma adatvesztés)', () => {
    const orphans = transport.filter((f) => !worker.includes(f));
    expect(orphans).toEqual([]);
  });

  it('a Worker nem fogad olyan mezőt, amit a transport nem tud küldeni (elérhetetlen funkció)', () => {
    const unreachable = worker.filter((f) => !transport.includes(f));
    expect(unreachable).toEqual([]);
  });

  it('a D1 mezőkészlet mind a két oldalon megvan', () => {
    // A D1-döntés magva: em + ph + fn + ln + zp + country. A `city` opcionális
    // (CSAK valódi strukturált forrásból), az `external_id` DEFERRED (D5) — de
    // amíg a típusban van, mindkét oldalon ott a helye.
    for (const field of ['email', 'phone_number', 'first_name', 'last_name', 'postal_code', 'country']) {
      expect(transport).toContain(field);
      expect(worker).toContain(field);
    }
  });

  it('a `street` egyik oldalon SINCS — a Worker sosem fogadta, a transport némán eldobatta', () => {
    expect(transport).not.toContain('street');
    expect(worker).not.toContain('street');
  });
});
