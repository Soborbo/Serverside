import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A KÖZZÉTEENDŐ süti-tábla ↔ a VALÓDI purge-kód kétirányú paritása.
 *
 * A HIBAOSZTÁLY. Egy kézzel írt süti-tábla mindig elcsúszik a kódtól, és a
 * csúszás MINDKÉT iránya jogi hiba:
 *
 *  - **kód → tábla:** kiírunk (majd törlünk) egy azonosítót, amit soha nem
 *    írtunk le a tájékoztatóban → GDPR Art 13(1)(e) / PECR reg. 6 hiány.
 *  - **tábla → kód:** a tájékoztatóban megígérjük, hogy a visszavonás törli,
 *    de a kód nem törli → a CMP ígérete valótlan. Pont ezt találta a
 *    2026-08-25-i jogi átvilágítás: a `purgeMarketingStorage` akkor csak
 *    `_fbp`/`_fbc`-t vitt, a `_ga` (2 év) és a `_gcl_au` (90 nap) maradt.
 *
 * Ezért ez a teszt NEM egy táblát hasonlít egy másik táblához: a
 * `lib/persistence.ts` FORRÁSÁBÓL olvassa ki, mit purge-öl a kód ténylegesen.
 *
 * ⚠️ A PARSER HORGONYA A KÉT PURGE-BELÉPŐPONT, NEM A `VENDOR_COOKIES` LITERÁL.
 * Az első változatom a literálból gyűjtött, és emiatt VAK volt: mutációs
 * próbában kivettem a `matchingCookieNames(VENDOR_COOKIES.*)` sorokat a
 * purge-függvényekből — vagyis pontosan a 2026-08-25-i valódi hibát állítottam
 * elő —, és a teszt diadalmasan zöld maradt. A tábla ott volt, a kód nem
 * használta. Most a `purgeMarketingStorage()` / `purgeAnalyticsStorage()`
 * TÖRZSÉBŐL indulunk ki, és csak azt számoljuk, amit onnan tényleg elérünk.
 *
 * A táblában szerepelhet olyan bejegyzés, amit a visszavonás NEM töröl
 * (`purged_on_withdrawal: false`) — de akkor a `why_not_purged` KÖTELEZŐ.
 * Egy nem törölt süti lehet védhető; kimondatlan nem lehet.
 */

const PERSISTENCE = fileURLToPath(new URL('../soborbo-tracking/lib/persistence.ts', import.meta.url));
const CONSENT_STATE = fileURLToPath(new URL('../soborbo-tracking/lib/consent-sbo-state.ts', import.meta.url));
const INVENTORY = fileURLToPath(new URL('../soborbo-tracking/consent-texts/cookie-inventory.json', import.meta.url));

type Storage = 'cookie' | 'localStorage' | 'sessionStorage';
type Entry = {
  name: string;
  match: 'exact' | 'prefix';
  storage: Storage;
  category: 'necessary' | 'analytics' | 'marketing';
  issuer: string;
  lifetime: string;
  transfer: string | null;
  purged_on_withdrawal: boolean;
  why_not_purged?: string;
  purpose: { hu: string; en: string };
};

const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8')) as { version: string; entries: Entry[] };
const persistenceSrc = readFileSync(PERSISTENCE, 'utf8');
const consentStateSrc = readFileSync(CONSENT_STATE, 'utf8');

/** `const X = 'value'` / `export const X = 'value'` → { X: 'value' } */
function stringConstants(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1]] = m[2];
  return out;
}

/** Egy függvény törzse név szerint (egyszintű, elég a mi kódunkhoz). */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`nincs ilyen függvény a forrásban: ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`nem záródik a törzse: ${name}`);
}

/** A `VENDOR_COOKIES` literál egyik ágának exact/prefix listái. */
function vendorCookies(group: string): string[] {
  const body = persistenceSrc.match(new RegExp(`${group}:\\s*\\{([^}]*)\\}`))?.[1];
  if (!body) throw new Error(`nincs VENDOR_COOKIES.${group} a forrásban`);
  const list = (key: string) => {
    const raw = body.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`))?.[1] ?? '';
    return [...raw.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  return [...list('exact'), ...list('prefixes')];
}

const CONSTS = stringConstants(persistenceSrc);

function resolveConst(name: string): string {
  const value = CONSTS[name];
  if (!value) throw new Error(`a(z) ${name} konstans nem oldható fel a persistence.ts-ből`);
  return value;
}

/**
 * Egy purge-belépőpont törzsét bejárva összegyűjti, mit töröl TÉNYLEGESEN.
 * A `depth` a segédfüggvény-hívásokat követi (`removeMarketingLocalStorage()`,
 * `resetSession()`), de körkörös hívásba nem esik bele.
 */
function purgedBy(entry: string, seen = new Set<string>()): { name: string; storage: Storage }[] {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const body = functionBody(persistenceSrc, entry);
  const out: { name: string; storage: Storage }[] = [];

  // Fix nevű süti: `expireCookie('_fbp')`
  for (const m of body.matchAll(/expireCookie\('([^']+)'\)/g)) out.push({ name: m[1], storage: 'cookie' });

  // Vendor-süti csoport: `matchingCookieNames(VENDOR_COOKIES.marketing)`
  for (const m of body.matchAll(/matchingCookieNames\(VENDOR_COOKIES\.([A-Za-z]+)\)/g)) {
    for (const n of vendorCookies(m[1])) out.push({ name: n, storage: 'cookie' });
  }

  // localStorage / sessionStorage kulcsok
  for (const m of body.matchAll(/lsRm\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
    out.push({ name: resolveConst(m[1]), storage: 'localStorage' });
  }
  for (const m of body.matchAll(/ssRm\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
    out.push({ name: resolveConst(m[1]), storage: 'sessionStorage' });
  }

  // Segédfüggvény-hívások követése (a purge több lépcsőben takarít).
  for (const m of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\(\);\s*$/gm)) {
    if (persistenceSrc.includes(`function ${m[1]}(`)) out.push(...purgedBy(m[1], seen));
  }

  return out;
}

/** Amit a visszavonás TÉNYLEGESEN kitöröl — a két belépőpontból kiindulva. */
function purgedByCode(): { name: string; storage: Storage }[] {
  return [...purgedBy('purgeMarketingStorage'), ...purgedBy('purgeAnalyticsStorage')];
}

const byName = new Map(inventory.entries.map((e) => [`${e.storage}:${e.name}`, e]));

describe('süti-tábla ↔ purge-kód paritás', () => {
  it('a mérés maga nem néma: a purge-belépőpontokból tényleges célokat olvasunk ki', () => {
    // Ha a `persistence.ts` átalakul és a parser semmit nem talál, ez a teszt
    // szól — különben a többi állítás ÜRES halmazon lenne diadalmasan zöld.
    const purged = purgedByCode();
    expect(purged.length).toBeGreaterThanOrEqual(7);
    expect(purged.some((p) => p.storage === 'cookie')).toBe(true);
    expect(purged.some((p) => p.storage === 'localStorage')).toBe(true);
    expect(purged.some((p) => p.storage === 'sessionStorage')).toBe(true);
    // Mindkét kategóriának el kell érnie a vendor-sütikig: pontosan ez volt a
    // 2026-08-25-i hiba (a purge megvolt, a Google-sütiket nem érte el).
    expect(purged.map((p) => p.name)).toContain('_gcl_');
    expect(purged.map((p) => p.name)).toContain('_ga');
  });

  it('kód → tábla: amit a visszavonás töröl, azt a tájékoztató is leírja', () => {
    const missing = purgedByCode().filter((p) => !byName.has(`${p.storage}:${p.name}`));
    expect(
      missing.map((m) => `${m.storage}:${m.name}`),
      'a kód törli, de a közzéteendő táblában nincs benne — GDPR Art 13(1)(e) hiány'
    ).toEqual([]);
  });

  it('tábla → kód: amit a tájékoztató töröltnek ígér, azt a kód tényleg törli', () => {
    const purged = new Set(purgedByCode().map((p) => `${p.storage}:${p.name}`));
    const broken = inventory.entries
      .filter((e) => e.purged_on_withdrawal)
      .filter((e) => !purged.has(`${e.storage}:${e.name}`))
      .map((e) => `${e.storage}:${e.name}`);
    expect(broken, 'a tábla törlést ígér, a kód nem törli — a CMP ígérete valótlan').toEqual([]);
  });

  it('a NEM törölt bejegyzések indoklása kötelező és nem lehet üres', () => {
    const unexplained = inventory.entries
      .filter((e) => !e.purged_on_withdrawal)
      .filter((e) => !e.why_not_purged || e.why_not_purged.trim().length < 20)
      .map((e) => e.name);
    expect(unexplained, 'egy nem törölt süti lehet védhető, de nem lehet kimondatlan').toEqual([]);
  });

  it('a SAJÁT CMP-sütink neve a kódból jön, és benne van a táblában', () => {
    // Harmadik forrás: ha a `sbo_consent` nevet valaha átnevezzük, a tájékoztató
    // ne maradjon csendben a régi néven.
    const name = stringConstants(consentStateSrc)['SBO_CONSENT_COOKIE'];
    expect(name, 'SBO_CONSENT_COOKIE nem olvasható ki a consent-sbo-state.ts-ből').toBeTruthy();
    expect(byName.has(`cookie:${name}`), `a ${name} süti nincs a közzéteendő táblában`).toBe(true);
  });

  it('minden bejegyzés kitölti a kötelező mezőket, MINDKÉT nyelven', () => {
    for (const e of inventory.entries) {
      expect(e.name, 'név').toBeTruthy();
      expect(['exact', 'prefix']).toContain(e.match);
      expect(['cookie', 'localStorage', 'sessionStorage']).toContain(e.storage);
      expect(['necessary', 'analytics', 'marketing']).toContain(e.category);
      expect(e.issuer, `${e.name}: kiállító`).toBeTruthy();
      expect(e.lifetime, `${e.name}: élettartam`).toBeTruthy();
      // A `transfer` LEHET null (nincs továbbítás) — de a mezőnek léteznie kell,
      // különben nem tudjuk, hogy „nincs" vagy „nem néztük meg".
      expect(e, `${e.name}: transfer mező`).toHaveProperty('transfer');
      expect(e.purpose?.hu?.length ?? 0, `${e.name}: magyar cél`).toBeGreaterThan(20);
      expect(e.purpose?.en?.length ?? 0, `${e.name}: angol cél`).toBeGreaterThan(20);
    }
  });

  it('nincs duplikált bejegyzés', () => {
    const keys = inventory.entries.map((e) => `${e.storage}:${e.name}`);
    expect(keys.length).toBe(new Set(keys).size);
  });
});
