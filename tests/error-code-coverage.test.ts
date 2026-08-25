import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  TrackingErrorCode,
  ERROR_DESCRIPTIONS,
  ERROR_SEVERITY,
  ERROR_RETRYABILITY,
  allErrorCodes,
  errorCodeRecord,
  componentForCode,
  alertPolicyForCode
} from '../src/lib/error-codes';

/**
 * §15 — az error-code rendszer STRUKTURÁLIS invariánsai.
 *
 * A futásidejű „tényleg kiváltódik-e" mérés NEM itt lakik: azt a
 * `tests/setup/record-error-codes.ts` gyűjti a suite alatt, és a
 * `scripts/check-error-code-emission.mjs` értékeli utána — mert egy vitest-fájl
 * nem láthatja a többi fájl futásának eredményét, és egy hamis „mind lefedett"
 * rosszabb volna, mint semmi.
 *
 * Itt az van, ami statikusan eldönthető, és amit MOST kell megfogni:
 * egyediség, teljes metaadat, katalógus-szinkron, és hogy egyetlen hibaág se
 * kerülje meg a katalógust.
 */

const ROOT = path.resolve(__dirname, '..');

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, exts, acc);
    } else if (exts.some((e) => entry.name.endsWith(e))) acc.push(p);
  }
  return acc;
}

const SRC_FILES = walk(path.join(ROOT, 'src'), ['.ts']);
const CODES = allErrorCodes();

describe('katalógus — egyediség és teljesség', () => {
  it('minden kód egyedi (nincs két szimbólum ugyanarra a számra)', () => {
    const seen = new Map<string, string[]>();
    for (const [symbol, code] of Object.entries(TrackingErrorCode)) {
      if (!seen.has(code as string)) seen.set(code as string, []);
      seen.get(code as string)!.push(symbol);
    }
    const dupes = [...seen].filter(([, symbols]) => symbols.length > 1);
    expect(dupes, `duplikált kód(ok): ${JSON.stringify(dupes)}`).toEqual([]);
  });

  it('minden kódnak van leírása, súlya ÉS retryability-je', () => {
    const missing: string[] = [];
    for (const c of CODES) {
      if (!ERROR_DESCRIPTIONS[c]) missing.push(`${c}: description`);
      if (!ERROR_SEVERITY[c]) missing.push(`${c}: severity`);
      if (!ERROR_RETRYABILITY[c]) missing.push(`${c}: retryability`);
    }
    expect(missing).toEqual([]);
  });

  it('a leírás nem placeholder és elég konkrét ahhoz, hogy operátori üzenet legyen', () => {
    for (const c of CODES) {
      const d = ERROR_DESCRIPTIONS[c];
      expect(d.length, `${c} leírása túl rövid`).toBeGreaterThan(15);
      expect(d.toLowerCase(), `${c} placeholder-leírás`).not.toMatch(/^(todo|tbd|fixme|n\/a)/);
    }
  });

  it('a kód alakja kötött (TRK-<sáv>-<szám>)', () => {
    for (const c of CODES) expect(c, c).toMatch(/^TRK-[A-Z0-9]{3,4}-\d{3}$/);
  });

  it('minden kód rendelkezik értelmezhető komponenssel (a sáv ismert)', () => {
    const unknown = CODES.filter((c) => componentForCode(c) === 'unknown');
    expect(unknown, `ismeretlen névtér: ${unknown.join(', ')}`).toEqual([]);
  });

  it('a teljes rekord minden mezője kitöltött (§15 szerinti alak)', () => {
    for (const c of CODES) {
      const r = errorCodeRecord(c);
      for (const field of [
        'code', 'symbolic_name', 'severity', 'component',
        'retryability', 'user_safe_message', 'operator_message', 'alert_policy'
      ] as const) {
        expect(r[field], `${c}.${field}`).toBeTruthy();
      }
      expect(r.symbolic_name).not.toBe('UNKNOWN_SYMBOL');
    }
  });

  it('a felhasználónak szánt üzenet SOHA nem szivárogtat belső kódot vagy vendor-részletet', () => {
    for (const c of CODES) {
      const msg = errorCodeRecord(c).user_safe_message;
      expect(msg).not.toContain('TRK-');
      expect(msg.toLowerCase()).not.toContain('google');
      expect(msg.toLowerCase()).not.toContain('meta');
    }
  });

  it('a riasztási politika a súlyból következik, és minden súlyhoz tartozik', () => {
    for (const c of CODES) {
      const policy = alertPolicyForCode(c);
      if (ERROR_SEVERITY[c] === 'critical') expect(policy).toContain('immediate');
      else expect(policy).not.toContain('immediate');
    }
  });
});

describe('a katalógus MEGKERÜLÉSE tilos', () => {
  /**
   * Egy nyers `error_code: 'TRK-…'` string azt jelenti, hogy valaki kódot
   * emittál a katalóguson KÍVÜL: nem kap leírást, súlyt, retryability-t, és a
   * generált tábla sem tud róla. Pontosan így keletkeznek a „félig létező"
   * kódok, amiket aztán senki nem tud értelmezni a ledgerben.
   */
  it('a forrásban nincs katalógust megkerülő nyers error_code string', () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      if (file.endsWith(path.join('lib', 'error-codes.ts'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/error_code\s*:\s*['"`](TRK-[^'"`]+)['"`]/g)) {
        offenders.push(`${path.relative(ROOT, file)} → ${m[1]}`);
      }
    }
    expect(offenders, `használd a TrackingErrorCode enumot: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * §13 — „minden runtime error-log rendelkezzen error_code-dal".
   *
   * A `logStructured` hívások szövegét nézzük: ahol `level: 'error'` van, ott
   * ugyanabban a hívásban `error_code`-nak is lennie kell. Enélkül a Cloudflare
   * logban egy hibasor csak egy mondat — nem lehet rá riasztást vagy runbookot
   * kötni, és nem lehet megszámolni.
   */
  it("minden `level: 'error'` strukturált log hordoz error_code-ot", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const text = fs.readFileSync(file, 'utf8');
      // A logStructured hívás argumentum-objektuma az első záró `});`-ig tart.
      for (const m of text.matchAll(/logStructured\(\{([\s\S]*?)\n\s*\}\)/g)) {
        const body = m[1]!;
        if (!/level:\s*'error'/.test(body)) continue;
        if (/error_code/.test(body)) continue;
        const line = text.slice(0, m.index!).split('\n').length;
        offenders.push(`${path.relative(ROOT, file)}:${line}`);
      }
    }
    expect(offenders, `error-log kód nélkül: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('a generált katalógus szinkronban van', () => {
  const TABLE = path.join(ROOT, 'docs', 'vnext-error-codes.md');

  it('a generált tábla létezik', () => {
    expect(fs.existsSync(TABLE), 'futtasd: npm run gen:error-codes').toBe(true);
  });

  it('MINDEN kód szerepel benne — nincs dokumentálatlan kód', () => {
    const table = fs.readFileSync(TABLE, 'utf8');
    const missing = CODES.filter((c) => !table.includes(`\`${c}\``));
    expect(missing, `hiányzik a katalógusból: ${missing.join(', ')}`).toEqual([]);
  });

  it('nincs árva bejegyzés — a táblában nem szerepel nem létező kód', () => {
    const table = fs.readFileSync(TABLE, 'utf8');
    const known = new Set<string>(CODES);
    const orphans = [...new Set([...table.matchAll(/`(TRK-[A-Z0-9]{3,4}-\d{3})`/g)].map((m) => m[1]!))]
      .filter((c) => !known.has(c));
    expect(orphans, `a tábla ismeretlen kódot említ: ${orphans.join(', ')}`).toEqual([]);
  });

  it('a kódok darabszáma egyezik a fejlécben deklarálttal', () => {
    const table = fs.readFileSync(TABLE, 'utf8');
    expect(table).toContain(`**Kódok száma:** ${CODES.length}`);
  });
});

describe('a nem-aktív kódok DEKLARÁLTAK, nem elhallgatottak', () => {
  it('minden kód vagy keletkezik a forrásban, vagy szerepel a státusz-regiszterben indoklással', async () => {
    // A regiszter a generátor mellett él (az .mjs-t a CI is futtatja).
    const gen = await import('../scripts/gen-error-code-table.mjs' as string);
    const CODE_STATUS = gen.CODE_STATUS as Record<string, { status: string; reason: string }>;

    const emitted = new Set<string>();
    for (const file of [...SRC_FILES, ...walk(path.join(ROOT, 'scripts'), ['.mjs']), ...walk(path.join(ROOT, 'server'), ['.mjs'])]) {
      if (file.endsWith(path.join('lib', 'error-codes.ts'))) continue;
      if (file.endsWith('gen-error-code-table.mjs')) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/TrackingErrorCode\.([A-Z0-9_]+)/g)) {
        const code = (TrackingErrorCode as Record<string, string>)[m[1]!];
        if (code) emitted.add(code);
      }
      for (const m of text.matchAll(/'(TRK-[A-Z0-9]{3,4}-\d{3})'/g)) emitted.add(m[1]!);
    }

    const undeclared = CODES.filter((c) => !emitted.has(c) && !CODE_STATUS[c]);
    expect(
      undeclared,
      `sehol nem keletkező, DE nem deklarált kód — vedd fel a CODE_STATUS regiszterbe: ${undeclared.join(', ')}`
    ).toEqual([]);
  });

  it('minden státusz-bejegyzés valódi kódra mutat és van indoklása', async () => {
    const gen = await import('../scripts/gen-error-code-table.mjs' as string);
    const CODE_STATUS = gen.CODE_STATUS as Record<string, { status: string; reason: string }>;
    const known = new Set<string>(CODES);
    for (const [code, entry] of Object.entries(CODE_STATUS)) {
      expect(known.has(code), `a regiszter ismeretlen kódot említ: ${code}`).toBe(true);
      expect(['retired', 'dormant', 'superseded', 'planned']).toContain(entry.status);
      expect(entry.reason.length, `${code} indoklása túl rövid`).toBeGreaterThan(20);
    }
  });
});

describe('a futásidejű mérés bekötése ÉL', () => {
  /**
   * §17 — a monitor saját hibája nem lehet zöld. Ha a setup-hook kiesik a
   * vitest-konfigból, a futásidejű lefedettség-mérés némán nullát mérne, és a
   * `check-error-code-emission` „nincs adat" ágra futna. Ez a teszt azt őrzi,
   * hogy a bekötés egyáltalán ott van.
   */
  it('a vitest-konfig betölti az emisszió-rögzítőt', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(cfg).toContain('tests/setup/record-error-codes.ts');
  });

  it('az alapvonal-fájl létezik és értelmezhető', () => {
    const p = path.join(ROOT, 'tests', 'error-code-emission-baseline.json');
    expect(fs.existsSync(p), 'hiányzik az emisszió-alapvonal').toBe(true);
    const b = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(Array.isArray(b.uncovered)).toBe(true);
    // Az alapvonal csak VALÓDI kódokat tartalmazhat — különben egy átnevezett
    // kód örökre „lefedetlenként" ülne benne, és a racsni értelmét vesztené.
    const known = new Set<string>(CODES);
    const stale = (b.uncovered as string[]).filter((c) => !known.has(c));
    expect(stale, `az alapvonal nem létező kódot említ: ${stale.join(', ')}`).toEqual([]);
  });
});
