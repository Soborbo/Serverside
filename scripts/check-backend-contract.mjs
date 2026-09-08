#!/usr/bin/env node
/**
 * A SITE SZERVER-LÁBÁNAK SZERZŐDÉS-ELLENŐRZÉSE.
 *
 * ── Mit mér, és miért NEM elég a meglévő őr ──────────────────────────────────
 * A `server/backend/gateway-dispatch.ts` ÖNÁLLÓAN másolódik a site repójába. Két
 * őrünk van rá, és egyik sem fogja meg azt, ami 2026-09-08-án KÉT site-on is ott
 * ült:
 *
 *   `check-package-version.mjs`  csak a KANONIKUS három helyet nézi — a site-ok
 *                                másolatait nem látja.
 *   `check-vendored-copy.mjs`    HASH-alapú. Egy vállalt forkon MINDEN fájl
 *                                „drifted", tehát kapuként használhatatlan: pont
 *                                azokon a site-okon néma, ahol a fork a norma.
 *
 * Ez a szkript ezért nem bájtot hasonlít, hanem SZERZŐDÉST: megvannak-e azok a
 * viselkedések, amelyek HIÁNYA némán konverziót vagy jogalapot veszít. Egy site
 * szabadon írhatja át a fájlt — ezeket a szabályokat viszont teljesítenie kell.
 *
 * ── A két eset, ami ezt kikényszerítette ─────────────────────────────────────
 *   olcso       a szerver-lába `v1` consent-sütit követelt, a böngészője `v2`-t
 *               ír. Az sbo-flip napján MINDEN valódi süti `null`-ra parse-olódott
 *               volna → „nincs döntés" → `require_consent` mellett fail-closed
 *               kihagyja a hirdetési platformokat, némán, minden konverzión.
 *   Beautyflow  a szerver-lába EGYÁLTALÁN nem ismert sbo-utat. Ugyanaz a néma
 *               kimenet, más okból — és a hash-őr itt sem szólt volna.
 *
 * Mindkettő LAPPANGÓ volt (a site-ok CookieYes-en futnak), és mindkettő puszta
 * env-flippel élesedett volna, kódváltozás nélkül.
 *
 * ── Amit SZÁNDÉKOSAN nem csinál ──────────────────────────────────────────────
 * Nem javít, és nem állítja, hogy a fájl „kanonikus". Azt állítja, hogy a
 * szerződést teljesíti. A kimenet szabályonként megmondja, MIT keresett — mert
 * egy forrás-mintára épülő őr csak akkor használható, ha a bukása érthető.
 *
 * ── MIÉRT FELTÉTELES AZ SBO-CSOPORT ─────────────────────────────────────────
 * A flotta felén NINCS saját CMP: a trapez, a lomtalan és az agykontroll repójában
 * egyetlen `consent-sbo-*` fájl sincs (git-fából mérve, nem kódkeresésből). Náluk a
 * hiányzó szerveroldali sbo-út nem hiba, hanem következetesség.
 *
 * Ha az sbo-szabályokat rájuk is ráolvasnánk, három EGÉSZSÉGES site-on kapnánk
 * örökké piros riportot — és „egy örökké piros riportot két hét alatt megtanulnánk
 * figyelmen kívül hagyni" (`check-vendored-copy.mjs`). Az őr ettől nem szigorúbb
 * lenne, hanem használhatatlan.
 *
 * A csoport ezért AKKOR él, ha a site böngésző-lába sbo-képes — mert pontosan az az
 * ASZIMMETRIA a hibaosztály: a böngésző ír `sbo_consent`-et, a szerver nem olvassa.
 * A feltételt a REPÓ bizonyítja (`--site-root`), nem a hívó állítja; ha a hívó
 * mégis állít (`--cmp`) és a repó mást mond, az HIBA — a bizonyíték nyer.
 *
 * Használat:
 *   node scripts/check-backend-contract.mjs <gateway-dispatch.ts>
 *        (--site-root=<repo-dir> | --cmp=sbo|cookieyes) [--site=<nev>] [--json]
 *
 * Példák:
 *   node scripts/check-backend-contract.mjs soborbo-tracking/server/backend/gateway-dispatch.ts --cmp=sbo
 *   node scripts/check-backend-contract.mjs d:/olcso/site/src/lib/tracking/gateway-dispatch.ts --site-root=d:/olcso/site
 *
 * Kilépési kód: 0 ha minden ÉLŐ szabály teljesül, 1 ha bármelyik bukik,
 * 2 használati hibára (beleértve a bizonyítéknak ellentmondó `--cmp`-t).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A verzió-címke ALSÓ HATÁRA. A `BACKEND_LIB_VERSION` base-verziója nem lehet
 * ennél régebbi: az azt jelentené, hogy a szerver-láb egy olyan kiadás
 * szerződését vallja, amelyik a mai consent-formátumot még nem ismerte.
 *
 * MIÉRT NEM a csomag AKTUÁLIS verziója a küszöb: egy vállalt fork jogosan áll
 * egy korábbi, de ÉLŐ szerződésen — a `6.6.4-<site>-fork` jelölés pont ezt
 * mondja ki. A padló azt tiltja, ami már NEM élő.
 */
export const MIN_BACKEND_BASE_VERSION = '6.6.0';

/** `6.6.8` / `6.6.4-olcso-fork` → [6,6,8] / [6,6,4]. Nem-szám → null. */
export function parseBaseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-.][A-Za-z0-9_.-]+)?$/.exec(value ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isBelow(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * A szabályok. Mindegyik: `id`, emberi `title`, `why` (mi vész el a hiányától),
 * és egy `test(src)` ami `true`-t ad, ha a szerződés teljesül.
 *
 * A `looked_for` azért kötelező, mert forrás-mintára épülő őrnél a bukás akkor
 * ér valamit, ha a fejlesztő látja, MIT kerestünk — különben a következő
 * refaktor csendben kikapcsolja.
 */
export const RULES = [
  {
    id: 'VERSION_PRESENT',
    group: 'core',
    title: 'BACKEND_LIB_VERSION létezik',
    why: 'Enélkül a ledger `client_lib_version`-je NULL, és a site sodródása mérhetetlen.',
    looked_for: "export const BACKEND_LIB_VERSION = '…'",
    test: (src) => /export const BACKEND_LIB_VERSION\s*=\s*'[^']+'/.test(src)
  },
  {
    id: 'VERSION_SHAPE',
    group: 'core',
    title: 'a verzió-címke alakja elfogadható',
    why:
      'A gateway `VERSION_RE`-je nem engedi a `+`-t (a consent-log ágon ELDOBJA a ' +
      'bejegyzést), a `0.0.0-…` pedig MINDEN receiptre kilövi a TRK-910-006-ot.',
    looked_for: "X.Y.Z vagy X.Y.Z-<utotag>, `+` nelkul, nem 0.0.0",
    test: (src) => {
      const v = /export const BACKEND_LIB_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1];
      if (!v || v.includes('+')) return false;
      const base = parseBaseVersion(v);
      return Boolean(base) && !(base[0] === 0 && base[1] === 0 && base[2] === 0);
    }
  },
  {
    id: 'VERSION_NOT_STALE',
    group: 'core',
    title: `a verzió-címke nem régebbi, mint ${MIN_BACKEND_BASE_VERSION}`,
    why:
      'A címke azt állítja, ameddig a szerver-láb átvezetést kapott. Egy régi ' +
      'base azt jelenti, hogy a mai consent-szerződést a fájl nem is ismerheti.',
    looked_for: `base >= ${MIN_BACKEND_BASE_VERSION}`,
    test: (src) => {
      const v = /export const BACKEND_LIB_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1];
      const base = parseBaseVersion(v);
      return Boolean(base) && !isBelow(base, parseBaseVersion(MIN_BACKEND_BASE_VERSION));
    }
  },
  {
    id: 'SBO_READER_EXISTS',
    group: 'sbo',
    title: 'a saját sbo_consent sütinek VAN szerveroldali olvasója',
    why:
      'Hiánya = a Beautyflow-eset: sbo-flipnél a szerver a sütit észre sem veszi, ' +
      'semmilyen döntést nem talál, és fail-closed kihagyja a hirdetési platformokat.',
    looked_for: 'export function readSboConsentCookieHeader(',
    test: (src) => /export function readSboConsentCookieHeader\s*\(/.test(src)
  },
  {
    id: 'SBO_FORMAT_V2',
    group: 'sbo',
    title: 'a parser a v2 formátumot követeli (8 mező), nem a v1-et',
    why:
      'Ez az olcso-eset: a böngésző-lib v2-t ír. v1-et követelve MINDEN valódi ' +
      'süti `null` — és a v1-es sütit ELFOGADVA a divergencia a másik irányba áll.',
    looked_for: "p.length !== 8 || p[0] !== 'v2'",
    test: (src) => /p\.length\s*!==\s*8\s*\|\|\s*p\[0\]\s*!==\s*'v2'/.test(src)
  },
  {
    id: 'SBO_EXPIRY',
    group: 'sbo',
    title: 'a döntés LEJÁRATA érvényesül',
    why:
      'A max-age a böngészőben él; egy kézzel visszaírt vagy átvitt süti a ' +
      'szerveren attól még „frissnek" látszana. TRK-910-004 élesítve.',
    looked_for: 'SBO_CONSENT_MAX_AGE_S egy osszehasonlitasban',
    test: (src) => />\s*SBO_CONSENT_MAX_AGE_S/.test(src)
  },
  {
    id: 'SBO_POLICY_VERSION',
    group: 'sbo',
    title: 'a policy-verzió kapuja megvan',
    why:
      'Nélküle a szerver elfogadna egy KORÁBBI tájékoztató-szövegre adott „igen"-t, ' +
      'miközben a böngésző-láb ugyanattól a sütitől újrakérdez.',
    looked_for: 'expectedPolicyVersion osszehasonlitas',
    test: (src) => /expectedPolicyVersion[\s\S]{0,120}policyVersion\s*!==/.test(src)
  },
  {
    id: 'SBO_DECISION_CONSISTENCY',
    group: 'sbo',
    title: 'a decision↔kategória ellentmondás eldobja a sütit',
    why:
      'Egy `accept_all` döntés analytics-only kategóriákkal hamisított vagy sérült ' +
      'süti. A gateway 400-at ad rá — a szerver-láb ne fogadja el csendben.',
    looked_for: "matches / accept_all + 'custom' agak",
    test: (src) => /accept_all'\s*\?[\s\S]{0,200}'custom'\s*\?/.test(src)
  },
  {
    id: 'GATE_CONSULTS_SBO',
    group: 'sbo',
    title: 'a KAPU is olvassa az sbo sütit, nem csak a telemetria',
    why:
      'A Beautyflow-nál a telemetria-oldali kockázat le volt írva, a kapu-oldali ' +
      'fele viszont nyitva maradt. Egy félig kimondott kockázat nem kimondott.',
    looked_for: 'readConsentFromCookie -> readSboConsentCookieHeader',
    test: (src) => {
      const m = /export function readConsentFromCookie\s*\([\s\S]*?\n}/.exec(src);
      return Boolean(m) && /readSboConsentCookieHeader\s*\(/.test(m[0]);
    }
  },
  {
    id: 'COOKIEYES_ADVERTISEMENT_KEY',
    group: 'core',
    title: 'a CookieYes-ág az `advertisement` kulcsot olvassa',
    why:
      'A 2026-07-i flotta-hibaosztály: a CookieYes `advertisement`-et ad, nem ' +
      '`marketing`-et. Rossz kulccsal a hirdetési consent MINDIG hamis.',
    looked_for: 'map.advertisement',
    test: (src) => /\bmap\.advertisement\b/.test(src)
  }
];

/**
 * A site böngésző-lába sbo-képes-e — a REPÓ bizonyítéka alapján.
 *
 * Egyetlen `consent-sbo-state.ts` jelenléte elég: az a saját CMP süti-formátumának
 * kanonikus definíciója. Ha ez megvan, a böngésző ÍRHAT `sbo_consent`-et, tehát a
 * szerver-lábnak OLVASNIA kell — ez az aszimmetria a hibaosztály.
 */
export function detectSboCapable(siteRoot, walk = walkFiles) {
  return walk(siteRoot).some((f) => /(^|[\\/])consent-sbo-state\.ts$/.test(f));
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', 'build', '.wrangler']);

function walkFiles(dir, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkFiles(path.join(dir, e.name), acc, depth + 1);
    } else {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/**
 * @param {boolean} sboExpected A site böngésző-lába sbo-képes-e. Ha NEM, az
 *   sbo-csoport KIMARAD (nem bukik) — lásd a fejlécben, miért nem szigor kérdése.
 * @returns {{site: string, file: string, version: string|null, sbo_expected: boolean,
 *   rows: Array<object>, failed: number, skipped: number}}
 */
export function checkBackendContract(file, src, site = null, sboExpected = true) {
  const version = /export const BACKEND_LIB_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1] ?? null;
  const rows = RULES.map((r) => {
    const applies = r.group !== 'sbo' || sboExpected;
    return {
      id: r.id,
      group: r.group,
      title: r.title,
      why: r.why,
      looked_for: r.looked_for,
      applies,
      // A kihagyott szabályt is MEGMÉRJÜK, csak nem buktatunk vele. Így a riport
      // megmutatja, ha egy CookieYes-site szerver-lába mégis sbo-képes lett —
      // az ugyanis a jelzés, hogy a flip elkezdődött valahol.
      ok: Boolean(r.test(src))
    };
  });
  const live = rows.filter((r) => r.applies);
  return {
    site,
    file,
    version,
    sbo_expected: sboExpected,
    rows,
    failed: live.filter((r) => !r.ok).length,
    skipped: rows.length - live.length
  };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  const opt = (n) => new RegExp(`^--${n}=(.+)$`).exec(argv.find((a) => a.startsWith(`--${n}=`)) ?? '')?.[1] ?? null;
  const site = opt('site');
  const siteRoot = opt('site-root');
  const cmp = opt('cmp');

  const usage =
    'Hasznalat: node scripts/check-backend-contract.mjs <gateway-dispatch.ts>\n' +
    '           (--site-root=<repo-dir> | --cmp=sbo|cookieyes) [--site=<nev>] [--json]';

  if (args.length !== 1 || (!siteRoot && !cmp)) {
    console.error(usage);
    if (args.length === 1 && !siteRoot && !cmp) {
      console.error(
        '\nAz sbo-csoport CSAK akkor ervenyes, ha a site bongeszo-laba sbo-kepes.\n' +
          'Ezt nem talaljuk ki: add meg a repo gyokeret (--site-root), vagy mondd ki (--cmp).'
      );
    }
    process.exit(2);
  }
  if (cmp && !['sbo', 'cookieyes'].includes(cmp)) {
    console.error(`Ismeretlen --cmp ertek: ${cmp} (varhato: sbo | cookieyes)`);
    process.exit(2);
  }

  const file = path.resolve(ROOT, args[0]);
  if (!fs.existsSync(file)) {
    console.error(`A fajl nem talalhato: ${file}`);
    process.exit(2);
  }

  let sboExpected;
  let evidence;
  if (siteRoot) {
    const root = path.resolve(ROOT, siteRoot);
    if (!fs.existsSync(root)) {
      console.error(`A site-gyoker nem talalhato: ${root}`);
      process.exit(2);
    }
    sboExpected = detectSboCapable(root);
    evidence = `a repo bizonyiteka (${sboExpected ? 'VAN' : 'nincs'} consent-sbo-state.ts a ${siteRoot} alatt)`;
    // A hívó állítása NEM írhatja felül a bizonyítékot — ha ellentmond, az a
    // ROSSZ állítás, és pont az a fajta csendes felmentés, ami ellen ez az őr van.
    if (cmp && (cmp === 'sbo') !== sboExpected) {
      console.error(
        `\nELLENTMONDAS: a --cmp=${cmp} allitas szerint a site ${cmp === 'sbo' ? 'sbo-kepes' : 'NEM sbo-kepes'},\n` +
          `a repo viszont az ellenkezojet mutatja (${evidence}).\n` +
          'A bizonyitek nyer. Javitsd az allitast, vagy hagyd el a --cmp-t.\n'
      );
      process.exit(2);
    }
  } else {
    sboExpected = cmp === 'sbo';
    evidence = `a hivo allitasa (--cmp=${cmp}) — repo-bizonyitek nelkul`;
  }

  const result = checkBackendContract(
    path.relative(ROOT, file) || file,
    fs.readFileSync(file, 'utf8'),
    site,
    sboExpected
  );
  result.sbo_evidence = evidence;

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.failed > 0 ? 1 : 0);
  }

  const label = result.site ? `${result.site} — ` : '';
  console.log(`\n  ${label}${result.file}`);
  console.log(`  BACKEND_LIB_VERSION: ${result.version ?? '(HIANYZIK)'}`);
  console.log(`  sbo-csoport: ${result.sbo_expected ? 'ERVENYES' : 'KIMARAD'} — ${result.sbo_evidence}\n`);
  for (const r of result.rows) {
    const mark = !r.applies ? 'kihagy' : r.ok ? ' ok  ' : 'BUKIK';
    console.log(`   ${mark}  ${r.id}  ${r.title}`);
    if (r.applies && !r.ok) {
      console.log(`          keresve: ${r.looked_for}`);
      console.log(`          miert:   ${r.why}`);
    }
    // A kihagyott, de TELJESÜLŐ sbo-szabály hír: valaki elkezdte a flipet.
    if (!r.applies && r.ok) {
      console.log('          megjegyzes: a szabaly teljesul, pedig a site-ot nem sbo-kepesnek merjuk');
    }
  }
  const live = result.rows.length - result.skipped;
  console.log(
    result.failed === 0
      ? `\n  ✓ A szerver-lab teljesiti a szerzodest (${live}/${live}${result.skipped ? `, ${result.skipped} kihagyva` : ''}).\n`
      : `\n  ✗ ${result.failed} szabaly bukik a ${live} ervenyesbol${result.skipped ? ` (${result.skipped} kihagyva)` : ''}.\n`
  );
  process.exit(result.failed > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-backend-contract.mjs')) {
  main(process.argv.slice(2));
}
