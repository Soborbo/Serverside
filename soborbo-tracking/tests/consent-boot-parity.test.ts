import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeSboConsentCookie,
  parseSboConsentCookie,
  SBO_CONSENT_MAX_AGE_S,
  type SboConsentState
} from '../lib/consent-sbo-state';

/**
 * A TÉNYLEGES GTM-KAPU tesztje — eddig NULLA fedés volt rajta.
 *
 * A `Tracking.astro` inline consent-bootja dönti el, betöltődik-e egyáltalán a
 * GTM. A parsere KÉZZEL DUPLIKÁLT párja a `lib/consent-sbo-state.ts`-nek
 * (bundler nélkül kell futnia, minden más előtt) — és eddig egyetlen teszt sem
 * érintette. Egy formátumváltás után a GTM-kapu és a lib MÁST gondolt volna
 * ugyanarról a sütiről, NÉMÁN: a kapu vagy beengedne egy érvénytelen döntést,
 * vagy kizárna egy érvényeset.
 *
 * Ez a fájl kiemeli az inline szkriptet a komponensből, jsdom-ban lefuttatja, és
 * UGYANAZOKRA a fixture-ökre veti össze a TS-parserrel.
 */

// A komponens NYERS forrása — ugyanaz a Vite-minta, mint a component-imports
// tesztben (a csomagban szándékosan nincs @types/node: a lib böngésző-oldali).
const RAW = (import.meta as unknown as {
  glob: (p: string, o: unknown) => Record<string, string>;
}).glob('../components/Tracking.astro', { query: '?raw', eager: true, import: 'default' });

/** Az `{isSbo && (<script …>…</script>)}` blokk törzsének kiemelése. */
function extractBootScript(): string {
  const src = Object.values(RAW)[0]!;
  const marker = '{isSbo && (';
  const start = src.indexOf(marker);
  expect(start, 'az sbo consent-boot blokk nem található a komponensben').toBeGreaterThan(-1);
  const openTag = src.indexOf('>', src.indexOf('<script', start)) + 1;
  const closeTag = src.indexOf('</script>', openTag);
  expect(closeTag).toBeGreaterThan(openTag);
  return src.slice(openTag, closeTag);
}

const BOOT = extractBootScript();

interface BootResult {
  gtmLoaded: boolean;
  /** Az utolsó `consent update` parancs, ha volt. */
  update: Record<string, string> | null;
}

/**
 * A boot lefuttatása egy friss dataLayer-rel. A `define:vars` behelyettesítést
 * kézzel pótoljuk — az Astro fordításkor teszi ugyanezt.
 */
function runBoot(cookie: string | null, policyVersion: string): BootResult {
  document.cookie
    .split(';')
    .map((c) => c.split('=')[0]!.trim())
    .filter(Boolean)
    .forEach((n) => { document.cookie = `${n}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`; });
  if (cookie !== null) document.cookie = `sbo_consent=${encodeURIComponent(cookie)}; path=/`;

  const w = window as unknown as { dataLayer?: unknown[]; __sboLoadGtm?: () => void };
  w.dataLayer = [];
  delete w.__sboLoadGtm;

  // A boot a `getElementsByTagName('script')[0]` mellé injektál. ÉLES oldalon
  // ez mindig létezik (maga az inline szkript az), jsdom-ban viszont üres
  // dokumentumból indulunk — ezért egy horgony-szkriptet teszünk be.
  document.head.innerHTML = '';
  document.head.appendChild(document.createElement('script'));

  // A GTM-injektálást elfogjuk: jsdom-ban nem akarunk hálózatot, és úgyis csak
  // az érdekel, MEGTÖRTÉNT-e a betöltés.
  let gtmLoaded = false;
  const realCreate = document.createElement.bind(document);
  (document as unknown as { createElement: typeof document.createElement }).createElement = ((
    tag: string
  ) => {
    const el = realCreate(tag);
    if (tag === 'script') {
      Object.defineProperty(el, 'src', {
        set() { gtmLoaded = true; },
        get() { return ''; },
        configurable: true
      });
    }
    return el;
  }) as typeof document.createElement;

  try {
    // eslint-disable-next-line no-new-func
    new Function('gtmId', 'policyVersion', BOOT)('GTM-TEST', policyVersion);
  } finally {
    (document as unknown as { createElement: typeof document.createElement }).createElement =
      realCreate;
  }

  let update: Record<string, string> | null = null;
  for (const entry of w.dataLayer ?? []) {
    // A `gtag()` az arguments-objektumot pusholja: [0]='consent', [1]='update'.
    const args = entry as unknown as { 0?: string; 1?: string; 2?: Record<string, string> };
    if (args && args[0] === 'consent' && args[1] === 'update' && args[2]) update = args[2];
  }
  return { gtmLoaded, update };
}

const POLICY = '2026-08-a';
const freshSec = () => Math.floor(Date.now() / 1000) - 60;

function cookieFor(over: Partial<SboConsentState> = {}): string {
  return encodeSboConsentCookie({
    analytics: true,
    marketing: true,
    revision: 1,
    decision: 'accept_all',
    consentId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    decidedAtSec: freshSec(),
    policyVersion: POLICY,
    ...over
  });
}

beforeEach(() => {
  (window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
});

describe('a script tényleg kiemelhető (a teszt maga nem hazudhat zöldet)', () => {
  it('a kiemelt szkript tartalmazza a consent-bootot', () => {
    // Ha a komponens szerkezete változik és a kiemelés üresre fut, MINDEN alábbi
    // teszt triviálisan átmenne — ezért ez az első állítás.
    expect(BOOT).toContain("gtag('consent', 'default'");
    expect(BOOT).toContain('sbo_consent');
    expect(BOOT).toContain('__sboLoadGtm');
    expect(BOOT.length).toBeGreaterThan(500);
  });
});

describe('BIT-PARITÁS — az inline boot és a TS-parser ugyanazt fogadja el', () => {
  const CASES: Array<[string, string | null]> = [
    ['nincs süti', null],
    ['üres süti', ''],
    ['accept_all', cookieFor()],
    ['reject_all', cookieFor({ analytics: false, marketing: false, decision: 'reject_all' })],
    ['custom — csak analytics', cookieFor({ analytics: true, marketing: false, decision: 'custom' })],
    ['custom — csak marketing', cookieFor({ analytics: false, marketing: true, decision: 'custom' })],
    ['withdrawn', cookieFor({ analytics: false, marketing: false, decision: 'withdrawn', revision: 3 })],
    ['régi v1-es formátum', 'v1.1.1.1.accept_all.a1b2c3d4-e5f6-7890.1756000000'],
    ['ismeretlen v3', `v3.1.1.1.accept_all.a1b2c3d4-e5f6-7890.${freshSec()}.${POLICY}`],
    ['hiányzó mező', `v2.1.1.1.accept_all.a1b2c3d4-e5f6-7890.${freshSec()}`],
    ['ismeretlen decision', `v2.1.1.1.maybe.a1b2c3d4-e5f6-7890.${freshSec()}.${POLICY}`],
    ['decision↔kategória ellentmondás', `v2.1.0.1.accept_all.a1b2c3d4-e5f6-7890.${freshSec()}.${POLICY}`],
    ['revision=0', `v2.1.1.0.accept_all.a1b2c3d4-e5f6-7890.${freshSec()}.${POLICY}`],
    ['rövid consent_id', `v2.1.1.1.accept_all.abc.${freshSec()}.${POLICY}`],
    ['üres policy-verzió', `v2.1.1.1.accept_all.a1b2c3d4-e5f6-7890.${freshSec()}.`],
    ['MÁS policy-verzió', cookieFor({ policyVersion: '2026-09-b' })],
    ['LEJÁRT döntés', cookieFor({ decidedAtSec: Math.floor(Date.now() / 1000) - SBO_CONSENT_MAX_AGE_S - 10 })],
    ['szemét', 'nem-is-suti'],
  ];

  for (const [label, cookie] of CASES) {
    it(`${label}: a boot és a parser egyetért`, () => {
      const parsed = parseSboConsentCookie(cookie, POLICY);
      const boot = runBoot(cookie, POLICY);

      // A boot akkor és csak akkor enged (consent update + GTM), ha a parser
      // ÉRVÉNYES döntést lát, ÉS abban van legalább egy engedett kategória.
      const shouldGrant = !!parsed && (parsed.analytics || parsed.marketing);
      expect(boot.gtmLoaded, `GTM-betöltés eltérés: ${label}`).toBe(shouldGrant);
      expect(!!boot.update, `consent update eltérés: ${label}`).toBe(shouldGrant);

      if (parsed && shouldGrant) {
        expect(boot.update!.analytics_storage).toBe(parsed.analytics ? 'granted' : 'denied');
        expect(boot.update!.ad_storage).toBe(parsed.marketing ? 'granted' : 'denied');
        expect(boot.update!.ad_user_data).toBe(parsed.marketing ? 'granted' : 'denied');
        expect(boot.update!.ad_personalization).toBe(parsed.marketing ? 'granted' : 'denied');
      }
    });
  }
});

describe('a boot alap-viselkedése', () => {
  it('döntés NÉLKÜL minden jel denied, és a GTM EL SEM INDUL', () => {
    const r = runBoot(null, POLICY);
    expect(r.gtmLoaded).toBe(false);
    const dl = (window as unknown as { dataLayer: Record<number, unknown>[] }).dataLayer;
    const def = dl.find((e) => (e as { 0?: string; 1?: string })[1] === 'default') as
      | { 2?: Record<string, string> }
      | undefined;
    expect(def?.[2]?.ad_storage).toBe('denied');
    expect(def?.[2]?.analytics_storage).toBe('denied');
    // A `security_storage` szándékosan granted: jogos érdek, nem hozzájárulás-köteles.
    expect(def?.[2]?.security_storage).toBe('granted');
  });

  it('reject_all után a GTM NEM töltődik be (a döntés tiszteletben tartva)', () => {
    const r = runBoot(cookieFor({ analytics: false, marketing: false, decision: 'reject_all' }), POLICY);
    expect(r.gtmLoaded).toBe(false);
  });

  it('analytics-only döntésnél a GTM betöltődik, de a marketing-jelek denied-ek', () => {
    const r = runBoot(cookieFor({ analytics: true, marketing: false, decision: 'custom' }), POLICY);
    expect(r.gtmLoaded).toBe(true);
    expect(r.update!.analytics_storage).toBe('granted');
    expect(r.update!.ad_storage).toBe('denied');
  });

  it('a policy-verzió változása ÚJRAKÉRDEZÉST vált ki (a GTM nem indul)', () => {
    // Ez a P3.2 lényege: a hozzájárulás ahhoz a szöveghez szólt, amit akkor
    // olvastak. Új szöveg = új kérdés.
    const r = runBoot(cookieFor(), '2026-09-b');
    expect(r.gtmLoaded).toBe(false);
  });

  it('a `__sboLoadGtm` idempotens — kétszeri hívás egy betöltés', () => {
    runBoot(null, POLICY);
    const w = window as unknown as { __sboLoadGtm?: () => void; dataLayer: unknown[] };
    expect(typeof w.__sboLoadGtm).toBe('function');
    const before = w.dataLayer.length;
    w.__sboLoadGtm!();
    w.__sboLoadGtm!();
    const starts = (w.dataLayer as Record<string, unknown>[])
      .slice(before)
      .filter((e) => e && e['gtm.start'] !== undefined);
    expect(starts).toHaveLength(1);
  });
});
