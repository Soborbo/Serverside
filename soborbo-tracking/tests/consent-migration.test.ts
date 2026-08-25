import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('../lib/gateway', () => ({
  sendToWorker: vi.fn(() => Promise.resolve(true)),
  collectAttribution: vi.fn(() => ({})),
}));

import {
  LEGACY_CONSENT_MIGRATION_POLICY,
  mayDeriveConsentFromLegacyCmp
} from '../lib/consent-migration';
import { readSboConsent, hasAnalyticsConsent, hasMarketingConsent } from '../lib';
import { trackingConfig } from '../lib/config';
import { setCkyConsent, setCookie, resetAll } from './helpers';

/**
 * P3.1 — a CookieYes → sbo consent-migráció politikája.
 *
 * A DÖNTÉS `reconsent_all`, és ez NEM stílus-kérdés: a `consent_log` négy
 * verziómezőt követel bizonyítékként (GDPR Art. 7(1)), amiből egy CookieYes-
 * döntéshez EGY SINCS meg. A süti két booleant hordoz, időbélyeg és
 * szövegverzió nélkül; a kategória-taxonómia sem egyezik (5 vs 3); és a
 * flotta nyolc domainjéből egy szerepel a csatlakoztatott CookieYes-fiókban,
 * tehát a szövegek egyezése API-ból nem is auditálható.
 *
 * A VESZÉLY, amit ez a fájl őriz: egy „gyorsan átvesszük a régi döntést"
 * jellegű kényelmi javítás. Az ilyen implicit süti-másolás nem hagy nyomot,
 * nem bukik el sehol, és utólag megkülönböztethetetlen egy valódi
 * hozzájárulástól.
 */

// A lib NYERS forrásai — Vite-glob, mert a csomagban szándékosan nincs
// @types/node (böngésző-oldali kód).
const LIB_RAW = (import.meta as unknown as {
  glob: (p: string, o: unknown) => Record<string, string>;
}).glob('../lib/*.ts', { query: '?raw', eager: true, import: 'default' });

function libSource(name: string): string {
  const key = Object.keys(LIB_RAW).find((k) => k.endsWith(`/${name}`));
  if (!key) throw new Error(`nincs ilyen lib-forrás: ${name}`);
  return LIB_RAW[key]!;
}

beforeEach(() => {
  resetAll();
  trackingConfig.consentProvider = 'sbo';
});

afterEach(() => {
  trackingConfig.consentProvider = 'cookieyes';
});

describe('a politika deklarált és hatályos', () => {
  it('a hatályos politika: reconsent_all', () => {
    expect(LEGACY_CONSENT_MIGRATION_POLICY).toBe('reconsent_all');
  });

  it('nincs olyan üzemmód, amelyben legacy CMP-ből vezetnénk le hozzájárulást', () => {
    expect(mayDeriveConsentFromLegacyCmp()).toBe(false);
  });

  it('a döntés INDOKA a kódban van, nem csak egy külső doksiban', () => {
    // Egy indoklás nélküli konstans a következő olvasónak önkényesnek látszik,
    // és egy sorral átírható. Az itteni négy ok teszi visszakövethetővé.
    const src = libSource('consent-migration.ts');
    expect(src).toContain('Art. 7(1)');
    expect(src).toContain('KATEGÓRIA-TAXONÓMIA');
    expect(src).toMatch(/reconsent_all/);
  });
});

describe('VISELKEDÉS — egy CookieYes-accept NEM ad sbo-hozzájárulást', () => {
  it('elfogadott CookieYes-süti mellett sincs érvényes sbo döntés → a banner kérdez', () => {
    // A látogató a régi CMP-ben MINDENT elfogadott.
    setCookie('cookieyes-consent', 'consentid:abc,consent:yes,analytics:yes,advertisement:yes');
    setCkyConsent({ analytics: true, marketing: true });

    // …a saját CMP alatt viszont nincs döntése.
    expect(readSboConsent(trackingConfig.policyVersion)).toBeNull();
  });

  it('a marketing-kapu ZÁRVA marad, hiába „engedett" a CookieYes', () => {
    setCookie('cookieyes-consent', 'consentid:abc,consent:yes,analytics:yes,advertisement:yes');
    setCkyConsent({ analytics: true, marketing: true });
    // A `sbo` provider alatt a CookieYes olvasata nem forrás — és mivel nincs
    // sbo süti, nincs mire hivatkozni.
    expect(hasMarketingConsent()).toBe(false);
  });

  it('az analytics-kapu is zárva marad', () => {
    setCookie('cookieyes-consent', 'consentid:abc,consent:yes,analytics:yes,advertisement:yes');
    setCkyConsent({ analytics: true, marketing: true });
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it('a CookieYes-süti puszta jelenléte NEM hoz létre sbo_consent sütit', () => {
    setCookie('cookieyes-consent', 'consentid:abc,consent:yes,analytics:yes,advertisement:yes');
    setCkyConsent({ analytics: true, marketing: true });
    // A kapuk lekérdezése sem indíthat implicit migrációt.
    hasMarketingConsent();
    hasAnalyticsConsent();
    readSboConsent(trackingConfig.policyVersion);
    expect(document.cookie).not.toContain('sbo_consent=');
  });
});

describe('STATIKUS ŐR — nincs implicit süti-másolás a forrásban', () => {
  function libSources(): Array<[string, string]> {
    return Object.entries(LIB_RAW).map(([k, v]) => [k.split('/').pop()!, v]);
  }

  it('az `sbo_consent` sütit EGYETLEN függvény írja, és az explicit döntést vesz át', () => {
    // A cookie-írás egy helyre szorítása az, ami miatt a fenti viselkedési
    // tesztek egyáltalán teljesek lehetnek: ha több író lenne, egy új ág
    // megkerülhetné őket.
    const writers: string[] = [];
    for (const [name, src] of libSources()) {
      for (const m of src.matchAll(/document\.cookie\s*=\s*[`'"]?\s*\$?\{?\s*SBO_CONSENT_COOKIE|document\.cookie\s*=\s*[`'"]sbo_consent/g)) {
        writers.push(`${name}:${src.slice(0, m.index!).split('\n').length}`);
      }
    }
    expect(writers.length, `több sbo_consent-író: ${writers.join(', ')}`).toBeLessThanOrEqual(1);
  });

  it('a CookieYes olvasata SEHOL nem folyik bele az sbo állapotba', () => {
    // A `readCkyParallelWindow()` kimenete kizárólag a wire-payload
    // `cky_cookie_*` TELEMETRIA-mezőibe kerülhet. Ha valaki az `analytics`/
    // `marketing` state-mezőkbe kötné, az implicit migráció volna.
    const src = libSource('consent-sbo.ts');
    const forbidden = [
      /analytics:\s*cky/i,
      /marketing:\s*cky/i,
      /analytics:\s*.*cky_cookie/i,
      /marketing:\s*.*cky_cookie/i,
      /getCkyConsent\(\)[\s\S]{0,80}encodeSboConsentCookie/,
    ];
    for (const re of forbidden) {
      expect(re.test(src), `implicit migráció-gyanús minta: ${re}`).toBe(false);
    }
  });

  it('NULLA migrációs kód létezik (a politika kód-szinten is érvényesül)', () => {
    const hits: string[] = [];
    for (const [name, src] of libSources()) {
      if (name === 'consent-migration.ts') continue; // ez maga a politika-doksi
      if (/cookieyes_migrated|migrateLegacyConsent|seedFromCookieYes/i.test(src)) hits.push(name);
    }
    expect(hits, `migrációs kód került be: ${hits.join(', ')}`).toEqual([]);
  });
});
