/**
 * §15 — FUTÁSIDEJŰ error-code lefedettség-mérés.
 *
 * A brief azt kéri, hogy minden hibakód „legalább egy tesztben ténylegesen
 * KIVÁLTÓDJON". A statikus „hivatkozik-e rá teszt" mérés erre gyenge: a
 * tesztjeink java a finding NEVÉRE állít (`offline_zero_delivery`), nem a
 * kódra — az a mérés tehát valóban lefedett kódokat is fedetlennek mondana,
 * és a hamis riasztás megtanítja az embert figyelmen kívül hagyni a jelzést.
 *
 * MIÉRT A `logStructured`-ET FIGYELJÜK, ÉS NEM A KONZOLT. Kézenfekvő lenne a
 * `console.*` becsomagolása, de a tesztek java `vi.spyOn(console, 'warn')
 * .mockImplementation(() => {})`-t használ a zaj elnyomására — az a mock
 * LECSERÉLNÉ a mi burkolónkat, és pont a legtöbbet logoló teszteket
 * veszítenénk el a mérésből. A `logStructured` viszont az EGYETLEN kapu,
 * amelyen minden strukturált hiba kimegy.
 *
 * A hook SZÁNDÉKOSAN passzív: továbbhív az eredetire, tehát egy teszt
 * viselkedése egy bittel sem változik attól, hogy mérünk.
 *
 * A vitest fájlonként külön workerben fut, ezért mindegyik a saját fájljába ír;
 * a `scripts/check-error-code-emission.mjs` olvassa össze őket a suite után.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, vi } from 'vitest';

const OUT_DIR =
  process.env.ERROR_CODE_EMISSION_DIR ?? path.join(process.cwd(), '.error-code-emission');

const seen = new Set<string>();

vi.mock('../../src/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/types')>();
  return {
    ...actual,
    logStructured: (log: { error_code?: string }) => {
      if (typeof log?.error_code === 'string' && log.error_code.startsWith('TRK-')) {
        seen.add(log.error_code);
      }
      return actual.logStructured(log as Parameters<typeof actual.logStructured>[0]);
    }
  };
});

afterAll(() => {
  if (seen.size === 0) return;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // Worker-egyedi fájlnév: a párhuzamos írás különben egymást csonkítaná.
    const name = `${process.pid}-${Math.random().toString(36).slice(2)}.json`;
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify([...seen]), 'utf8');
  } catch {
    /* a mérés SOHA nem buktathat el egy tesztet */
  }
});
