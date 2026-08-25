#!/usr/bin/env node
/**
 * §15 / §23 — a TELJES error-code katalógus generálása.
 *
 * MIÉRT GENERÁLT. A `docs/error-codes.md` kézzel írt runbook, és pontosan úgy
 * sodródott el, ahogy a kézzel írt doksik szoktak: a 2026-08-25-i audit szerint
 * 131 kódból 65 szerepelt benne — a teljes TRK-840-es Data Manager sáv, vagyis
 * az AKTUÁLIS money-path, runbook-bejegyzés NÉLKÜL. Egy második, kézzel
 * karbantartott igazságforrás garantáltan hazudni fog; ezért ez a tábla a
 * kódból készül, és a CI ellenőrzi, hogy szinkronban van-e.
 *
 * A prózai runbook (`docs/error-codes.md`) MEGMARAD: ott az „mit csinálj vele"
 * tudás él, amit generálni nem lehet. Ez a fájl a TELJESSÉGET garantálja.
 *
 * A `Trigger` és a `Test` oszlop STATIKUS kereséssel készül (`TrackingErrorCode.X`
 * előfordulása a forrásban / a tesztekben). Ez nem futásidejű bizonyíték — de
 * pont az árva kódokat fogja meg: azt, ami definiálva van, de sehol nem
 * keletkezik, illetve amit egyetlen teszt sem érint.
 *
 * Használat:
 *   node --experimental-transform-types scripts/gen-error-code-table.mjs
 *   node --experimental-transform-types scripts/gen-error-code-table.mjs --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'vnext-error-codes.md');

// Windowson egy abszolút út (`D:\…`) NEM érvényes ESM-specifier — a `d:` sémának
// nézne ki. `pathToFileURL` nélkül a generátor csak Linuxon futna, és pont a
// fejlesztői gépen (ahol a legtöbbször hívjuk) hasalna el.
const { allErrorCodes, errorCodeRecord } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'lib', 'error-codes.ts')).href
);

/**
 * NEM-AKTÍV KÓDOK — deklarálva, indoklással.
 *
 * A 2026-08-25-i átvilágítás szerint 131 kódból 23 sehol nem keletkezik a
 * forrásban. Két rossz válasz van erre: (a) elhallgatni, és a katalógust
 * teljesnek hazudni; (b) örökre pirosan hagyni a CI-t. Mindkettő azt tanítaná,
 * hogy a jelzést figyelmen kívül kell hagyni.
 *
 * A harmadik válasz ez a regiszter: minden nem-aktív kód KAP EGY OKOT, és a
 * teszt megköveteli, hogy egy ÚJ kód vagy tényleg keletkezzen valahol, vagy
 * ide bekerüljön. Így a lista magától nem nőhet csendben.
 */
export const CODE_STATUS = {
  // ── RETIRED — a funkció TÖRÖLVE, nem szabad visszaépíteni ──────────
  // A Turnstile-validáció eltűnt a gateway-ből: a secret a Cloudflare
  // teszt-kulcsa volt (minden tokenre `success: true`), miközben valódi
  // konverziókat nyelt el. CLAUDE.md 10.
  'TRK-400-003': { status: 'retired', reason: 'Turnstile-validáció törölve a gateway-ből (CLAUDE.md 10.)' },
  'TRK-400-004': { status: 'retired', reason: 'Turnstile-validáció törölve a gateway-ből (CLAUDE.md 10.)' },
  'TRK-400-005': { status: 'retired', reason: 'Turnstile-validáció törölve a gateway-ből (CLAUDE.md 10.)' },
  'TRK-400-008': { status: 'retired', reason: 'a degradált tokenless mód a Turnstile-lel együtt megszűnt' },
  'TRK-400-009': { status: 'retired', reason: 'a degradált rate limiter a Turnstile-lel együtt megszűnt' },
  'TRK-400-010': { status: 'retired', reason: 'a Turnstile secret-ellenőrzés megszűnt' },

  // ── DORMANT — a transport/láb létezett, ma nem fut ─────────────────
  // A legacy Google Ads `uploadClickConversions` transport 2026-08-16-án
  // TÖRÖLVE (a `gads.ts` már csak típusokat tartalmaz); a Google offline út a
  // Data Manager API (TRK-840 sáv). A kódok jelentése rögzítve marad, mert
  // RÉGI ledger-sorok hivatkoznak rájuk.
  'TRK-800-002': { status: 'dormant', reason: 'a legacy uploadClickConversions transport törölve 2026-08-16; a Google út a TRK-840 sáv' },
  'TRK-800-004': { status: 'dormant', reason: 'a legacy uploadClickConversions transport törölve 2026-08-16' },
  'TRK-800-005': { status: 'dormant', reason: 'a legacy uploadClickConversions transport törölve 2026-08-16' },
  'TRK-800-007': { status: 'dormant', reason: 'a Data Manager API NEM kér developer tokent' },
  'TRK-800-008': { status: 'dormant', reason: 'a legacy uploadClickConversions transport törölve 2026-08-16' },
  'TRK-800-010': { status: 'dormant', reason: 'a legacy uploadClickConversions transport törölve 2026-08-16' },
  // A Microsoft Ads forwarder modul létezik (`src/lib/msads.ts`), de saját
  // hibakódot nem könyvel — a hibái a közös fan-out úton jelennek meg.
  'TRK-810-001': { status: 'dormant', reason: 'a msads forwarder nem könyvel saját hibakódot; a fan-out közös útján jelenik meg' },
  'TRK-810-002': { status: 'dormant', reason: 'a msads forwarder nem könyvel saját timeout-kódot' },

  // ── SUPERSEDED — konkrétabb kód vette át ──────────────────────────
  'TRK-800-001': { status: 'superseded', reason: 'az OAuth-okokat a TRK-800-011…016 vitte el; ez maradék-gyűjtővé vált' },
  'TRK-500-002': { status: 'superseded', reason: 'a hiányzó platform-config a PLATFORM_NOT_CONFIGURED (TRK-900-008) ágon skippel' },
  'TRK-500-003': { status: 'superseded', reason: 'a hiányzó Meta access_token szintén a PLATFORM_NOT_CONFIGURED (TRK-900-008) skip-ágon jelenik meg' },
  'TRK-500-004': { status: 'superseded', reason: 'lásd TRK-900-008 (a szerver amúgy sem küld on-site GA4-et)' },
  'TRK-500-005': { status: 'superseded', reason: 'a hiányzó Google Ads customer_id szintén a PLATFORM_NOT_CONFIGURED (TRK-900-008) skip-ágon jelenik meg' },
  'TRK-700-004': { status: 'superseded', reason: 'a GA4 MP-hibák a TRK-700-003 validációs ágon jelennek meg' },
  'TRK-700-005': { status: 'superseded', reason: 'a GA4 MP-hibák a TRK-700-003 validációs ágon jelennek meg' },
  'TRK-000-003': { status: 'superseded', reason: 'a KV-írás hibáit a hívó saját, beszédesebb kódja könyveli' },
  'TRK-000-004': { status: 'superseded', reason: 'az R2-olvasás hibáit a DLQ-sáv (TRK-900-002) könyveli' },
  'TRK-000-005': { status: 'superseded', reason: 'az R2-írás hibáit a DLQ-sáv (TRK-900-001) könyveli' },
  'TRK-000-006': { status: 'superseded', reason: 'nincs Durable Object a jelenlegi architektúrában' },

  // ── PLANNED — deklarált őr, még nincs bekötve ─────────────────────
  // Ezek NEM „majd valamikor": nevesített, nyitott tételek. Amíg nincsenek
  // bekötve, a katalógus KIMONDJA, hogy nem védenek semmit.
  'TRK-500-007': { status: 'planned', reason: 'a KV-config JSON-hibája ma a NO_SITE_CONFIG ágon esik ki; külön kód bekötése nyitott' },
  'TRK-GA4-002': { status: 'planned', reason: 'Model 2 őr: on-site GA4 fan-out tiltása — a P8 static-scan csomag köti be' },
  'TRK-META-002': { status: 'planned', reason: 'böngésző↔szerver Meta event-név paritás — a P7 live-GTM csomag köti be' },
  'TRK-CFG-002': { status: 'planned', reason: 'gads.customer_id mellett kötelező conversion_actions — a P6 EC hard gate köti be' }
};

/** Visszafelé kompatibilis nézet: mely kódok nem aktívak. */
export const RETIRED_CODES = new Set(Object.keys(CODE_STATUS));

const STATUS_LABEL = {
  retired: 'nyugdíjazott',
  dormant: 'alvó',
  superseded: 'leváltva',
  planned: 'tervezett'
};

function walk(dir, exts, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, exts, acc);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      acc.push(p);
    }
  }
  return acc;
}

function indexUsage(files) {
  /** symbol → Set<relatív fájlút> */
  const bySymbol = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const m of text.matchAll(/TrackingErrorCode\.([A-Z0-9_]+)/g)) {
      if (!bySymbol.has(m[1])) bySymbol.set(m[1], new Set());
      bySymbol.get(m[1]).add(rel);
    }
    // A tesztek egy része a nyers kódstringre állít (pl. `'TRK-950-004'`).
    for (const m of text.matchAll(/'(TRK-[A-Z0-9]+-\d+)'/g)) {
      const key = `__literal__${m[1]}`;
      if (!bySymbol.has(key)) bySymbol.set(key, new Set());
      bySymbol.get(key).add(rel);
    }
  }
  return bySymbol;
}

/** Hol KELETKEZIK a kód (a definíciós fájlt nem számítva). */
export function emissionSites(usage, record) {
  const direct = usage.get(record.symbolic_name) ?? new Set();
  const literal = usage.get(`__literal__${record.code}`) ?? new Set();
  return [...new Set([...direct, ...literal])]
    .filter((f) => f !== 'src/lib/error-codes.ts' && f !== 'scripts/gen-error-code-table.mjs')
    .sort();
}

export function buildRows() {
  // A forrás NEM csak `src/`: a kontraktus-őrök (`TRK-EVT`, `TRK-CFG`, `TRK-GA4`,
  // `TRK-META`) build-időben, `.mjs` szkriptekben keletkeznek. Ha ezeket kihagynánk,
  // a teljességi ellenőrzés árvának mondaná a legszigorúbb kapuinkat.
  const srcUsage = indexUsage([
    ...walk(path.join(ROOT, 'src'), ['.ts']),
    ...walk(path.join(ROOT, 'scripts'), ['.mjs', '.ts']),
    ...walk(path.join(ROOT, 'server'), ['.mjs', '.ts'])
  ]);
  const testUsage = indexUsage(walk(path.join(ROOT, 'tests'), ['.ts']));

  return allErrorCodes().map((code) => {
    const record = errorCodeRecord(code);
    const triggers = emissionSites(srcUsage, record);
    const tests = emissionSites(testUsage, record);
    return { ...record, triggers, tests };
  });
}

function cell(v) {
  return String(v).replace(/\|/g, '\\|');
}

function shortList(files, max = 2) {
  if (files.length === 0) return '—';
  const shown = files.slice(0, max).map((f) => `\`${f.replace(/^(src|tests)\//, '')}\``);
  return files.length > max ? `${shown.join(', ')} +${files.length - max}` : shown.join(', ');
}

export function render(rows) {
  const lines = [];
  lines.push('# vNext — teljes error-code katalógus');
  lines.push('');
  lines.push('> **GENERÁLT FÁJL — ne szerkeszd kézzel.**');
  lines.push('> Forrás: `src/lib/error-codes.ts`. Újragenerálás: `npm run gen:error-codes`.');
  lines.push('> A CI a `npm run check:error-codes` lépéssel ellenőrzi, hogy szinkronban van-e.');
  lines.push('>');
  lines.push('> A prózai runbook (`docs/error-codes.md`) ettől külön él: ott a „mit csinálj');
  lines.push('> vele" tudás van, amit generálni nem lehet. Ez a tábla a TELJESSÉGET garantálja —');
  lines.push('> azt, hogy egyetlen kód se maradjon dokumentálatlanul.');
  lines.push('');
  lines.push(`**Kódok száma:** ${rows.length}`);
  lines.push('');

  // Retryability-összesítő — ez a tábla operatív haszna: megmondja, mennyi
  // hibaosztály oldható meg magától, és mennyihez kell ember.
  const byRetry = new Map();
  for (const r of rows) byRetry.set(r.retryability, (byRetry.get(r.retryability) ?? 0) + 1);
  lines.push('| Retryability | Kódok | Jelentés |');
  lines.push('|---|---|---|');
  const MEANING = {
    RETRYABLE: 'átmeneti — egy későbbi próbálkozás sikerülhet',
    TERMINAL: 'végleges — ugyanez a payload sosem megy át',
    POLICY_SKIP: 'szándékos kihagyás vagy informatív jel — nincs mit újrapróbálni',
    CONFIG_BLOCKED: 'a mi konfigurációnk hiányzik — deploy/KV-írás kell',
    OPERATOR_ACTION: 'emberi beavatkozás kell',
    UNKNOWN: 'az eredmény ismeretlen — nem „valószínűleg jó"'
  };
  for (const [k, v] of [...byRetry].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${k}\` | ${v} | ${MEANING[k] ?? ''} |`);
  }
  lines.push('');

  lines.push('| Code | Symbol | Component | Severity | Retryability | Trigger | User response | Operator action | Test |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const st = CODE_STATUS[r.code];
    const trigger = st ? `*${STATUS_LABEL[st.status]}*` : shortList(r.triggers);
    const test = st ? `*${STATUS_LABEL[st.status]}*` : shortList(r.tests);
    lines.push(
      `| \`${r.code}\` | \`${cell(r.symbolic_name)}\` | ${cell(r.component)} | ${cell(r.severity)} | \`${cell(r.retryability)}\` | ${trigger} | ${cell(r.user_safe_message)} | ${cell(r.operator_message)} | ${test} |`
    );
  }
  lines.push('');
  lines.push('## Nem-aktív kódok');
  lines.push('');
  lines.push('Ezek a kódok **nem keletkeznek** a jelenlegi forrásban. A jelentésük rögzítve marad');
  lines.push('(régi ledger-sorok és logok hivatkoznak rájuk), de a katalógus kimondja, hogy nem');
  lines.push('védenek semmit — egy „teljesnek" hazudott lista rosszabb, mint egy nevesített hiány.');
  lines.push('');
  lines.push('| Code | Symbol | Státusz | Miért |');
  lines.push('|---|---|---|---|');
  for (const code of Object.keys(CODE_STATUS)) {
    const row = rows.find((r) => r.code === code);
    const st = CODE_STATUS[code];
    lines.push(
      `| \`${code}\` | \`${row ? row.symbolic_name : '?'}\` | ${STATUS_LABEL[st.status]} | ${cell(st.reason)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

// A fájl KÖNYVTÁRKÉNT is szolgál (a `check-error-code-emission.mjs` importálja a
// CODE_STATUS regisztert). Import esetén NEM futhat le a generálás — különben egy
// ellenőrző szkript mellékhatásként ÍRNÁ a doksit, amit épp ellenőriznie kellene.
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) main();

function main() {
const isCheck = process.argv.includes('--check');
const rows = buildRows();
const content = render(rows);

if (isCheck) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing.replace(/\r\n/g, '\n') !== content) {
    console.error('ERROR_CODE_TABLE_DRIFT — docs/vnext-error-codes.md nincs szinkronban a kóddal.');
    console.error('Futtasd: npm run gen:error-codes');
    process.exit(1);
  }
  console.log(`✅ ERROR_CODE_TABLE_OK — ${rows.length} kód, a generált tábla szinkronban.`);
} else {
  fs.writeFileSync(OUT, content, 'utf8');
  console.log(`✅ docs/vnext-error-codes.md megírva — ${rows.length} kód.`);
}
}
