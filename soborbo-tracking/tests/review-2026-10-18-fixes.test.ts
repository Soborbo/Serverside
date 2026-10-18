import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import { encodeSboConsentCookie, readSboConsent, type SboConsentState } from '../lib/consent-sbo-state';
import { readConsentFromCookie } from '../server/backend/gateway-dispatch';

/**
 * 2026-10-18 review — R3, R9, R10 javításainak őrei.
 *
 * R3: a szerveroldali olvasó egy elavult / hiányzó sbo-döntés mellett a régi
 *     CookieYes-„igen"-re esett vissza.
 * R9: függő fetch alatt egy második submit preventDefault nélkül csúszott át.
 * R10: régi policy-verziójú süti elrejtette a bannert, miközben a mérés már nem
 *      fogadta el — a látogató új kérdés nélkül esett ki a mérésből.
 */

const NOW = Math.floor(Date.now() / 1000);

function sbo(over: Partial<SboConsentState> = {}): string {
  return encodeSboConsentCookie({
    analytics: true,
    marketing: true,
    revision: 1,
    decision: 'accept_all',
    consentId: 'consent-12345678',
    decidedAtSec: NOW,
    policyVersion: 'new-policy',
    ...over
  });
}

const CY_YES = 'cookieyes-consent=analytics:yes,advertisement:yes';
const CY_NO = 'cookieyes-consent=analytics:no,advertisement:no';

describe('R3 — readConsentFromCookie: szolgáltató × süti × kategória mátrix', () => {
  const opts = { expectedPolicyVersion: 'new-policy' };
  const current = (m: boolean) => `sbo_consent=${encodeURIComponent(sbo({ marketing: m, analytics: m, decision: m ? 'accept_all' : 'reject_all' }))}`;
  const stale = `sbo_consent=${encodeURIComponent(sbo({ policyVersion: 'old-policy' }))}`;
  const expired = `sbo_consent=${encodeURIComponent(sbo({ decidedAtSec: NOW - 400 * 86400 }))}`;

  const ad = (header: string, o: Parameters<typeof readConsentFromCookie>[1]) =>
    readConsentFromCookie(header, o)?.ad_user_data;

  for (const provider of ['sbo', undefined] as const) {
    const label = provider ?? 'nincs megadva';
    describe(`provider=${label}`, () => {
      it('aktuális sbo-döntés dönt (engedélyezett / tiltott), a CookieYes-süti mellett is', () => {
        expect(ad(`${current(true)}; ${CY_NO}`, { ...opts, provider })).toBe('GRANTED');
        expect(ad(`${current(false)}; ${CY_YES}`, { ...opts, provider })).toBe('DENIED');
      });
      it('RÉGI policy-verziójú sbo-süti + CookieYes yes → nincs döntés (NEM GRANTED)', () => {
        expect(ad(`${stale}; ${CY_YES}`, { ...opts, provider })).toBeUndefined();
      });
      it('lejárt sbo-süti + CookieYes yes → nincs döntés', () => {
        expect(ad(`${expired}; ${CY_YES}`, { ...opts, provider })).toBeUndefined();
      });
      it('sérült sbo-süti + CookieYes yes → nincs döntés', () => {
        expect(ad(`sbo_consent=garbage; ${CY_YES}`, { ...opts, provider })).toBeUndefined();
      });
    });
  }

  it('provider=sbo: sbo-süti NÉLKÜL a CookieYes yes sem dönt', () => {
    expect(ad(CY_YES, { ...opts, provider: 'sbo' })).toBeUndefined();
  });

  it('provider nincs megadva, sbo-süti nélkül: a CookieYes-flotta viselkedése változatlan', () => {
    expect(ad(CY_YES, opts)).toBe('GRANTED');
    expect(ad(CY_NO, opts)).toBe('DENIED');
    expect(ad(CY_YES, {})).toBe('GRANTED');
  });

  it('provider=cookieyes: kizárólag a CookieYes-süti dönt (egy ottfelejtett sbo-süti sem)', () => {
    expect(ad(`${current(false)}; ${CY_YES}`, { provider: 'cookieyes' })).toBe('GRANTED');
    expect(ad(`${current(true)}; ${CY_NO}`, { provider: 'cookieyes' })).toBe('DENIED');
    expect(ad(current(true), { provider: 'cookieyes' })).toBeUndefined();
  });
});

// A komponensek NYERS forrása — ugyanaz a Vite-minta, mint a consent-boot-parity
// tesztben (a csomagban szándékosan nincs @types/node).
const RAW = (import.meta as unknown as {
  glob: (p: string[], o: unknown) => Record<string, string>;
}).glob(['../components/TrackedForm.astro', '../components/ConsentBanner.astro'], {
  query: '?raw',
  eager: true,
  import: 'default'
});

/** A komponens <script>-jét kiemeli, az importokat paraméterként adjuk át. */
function compileComponentScript(path: string): string {
  const text = RAW[`../${path}`];
  const source = text
    .split('<script>')[1]
    .split('</script>')[0]
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  return ts
    .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
    .outputText.replace(/export\s*\{\s*\};?/g, '');
}

function clearCookies(): void {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

afterEach(() => {
  clearCookies();
  document.body.innerHTML = '';
});

describe('R9 — TrackedForm: függő küldés alatt minden új submit elnyelve', () => {
  function mount() {
    document.body.innerHTML =
      '<form data-tracked-form data-submit-mode="fetch"><input name="email" value="test@example.com"><button>Submit</button></form>';
    const compiled = compileComponentScript('components/TrackedForm.astro');
    let finish!: (v: unknown) => void;
    const pending = new Promise((resolve) => (finish = resolve));
    const calls = { async: 0 };
    const result = { eventId: 'event-12345678' };
    new Function(
      'trackLeadSubmit', 'trackContactSubmit', 'populateHiddenFields', 'waitForTracking',
      'initFormAbandonTracking', 'stageLeadSubmit', 'stageContactSubmit', 'submitTrackedFormAsync',
      compiled
    )(
      () => result, () => result, () => {}, async () => {}, () => () => {},
      () => result, () => result,
      () => { calls.async++; return pending; }
    );
    document.dispatchEvent(new Event('astro:page-load'));
    return { form: document.querySelector('form')!, finish, pending, calls, result };
  }

  it('második submit (dupla klikk / Enter) a fetch alatt: defaultPrevented, egyetlen üzleti kérés', async () => {
    const { form, finish, pending, calls, result } = mount();
    const first = new Event('submit', { cancelable: true });
    form.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);

    const second = new Event('submit', { cancelable: true });
    form.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(calls.async).toBe(1);

    finish({ ok: true, eventId: result.eventId });
    await pending;
    await Promise.resolve();
  });

  it('sikertelen küldés után a látogató újra küldhet (a guard felold)', async () => {
    const { form, finish, pending, calls, result } = mount();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    finish({ ok: false, eventId: result.eventId });
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    const again = new Event('submit', { cancelable: true });
    form.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(true);
    expect(calls.async).toBe(2);
  });
});

describe('R10 — ConsentBanner: a láthatóság az aktív policy-verzióhoz kötött', () => {
  function mountBanner(policyVersion: string) {
    document.body.innerHTML =
      '<div id="sb-consent" hidden><div data-sb-layer="banner" hidden></div><div data-sb-layer="overlay" hidden></div>' +
      '<div data-sb-layer="panel" hidden></div><input type="checkbox" data-sb-category="analytics"><input type="checkbox" data-sb-category="marketing"></div>';
    const compiled = compileComponentScript('components/ConsentBanner.astro');
    new Function(
      'isSboConsentProvider', 'trackingConfig', 'readSboConsent', 'applySboDecision', 'flushPendingSboConsent',
      'postBannerShown', 'getDevice', 'createPanelKeydownHandler', 'panelFocusables', 'restoreFocus',
      'pickBannerVariant', compiled
    )(
      () => true, { policyVersion }, readSboConsent, () => ({}), async () => {}, () => {}, () => 'desktop',
      () => () => {}, () => [], () => {}, () => 'a'
    );
    document.dispatchEvent(new Event('astro:page-load'));
    return document.querySelector<HTMLElement>('#sb-consent')!;
  }

  it('régi policy-verziójú döntés → a banner MEGJELENIK (új kérés)', () => {
    document.cookie = `sbo_consent=${encodeURIComponent(sbo({ policyVersion: 'old-policy' }))}; path=/`;
    expect(readSboConsent('new-policy')).toBeNull();
    expect(mountBanner('new-policy').hidden).toBe(false);
  });

  it('aktuális verziójú döntés → a banner rejtve marad', () => {
    document.cookie = `sbo_consent=${encodeURIComponent(sbo())}; path=/`;
    expect(mountBanner('new-policy').hidden).toBe(true);
  });

  it('a panel régi döntésnél nem mutat előre bepipált kategóriát', () => {
    document.cookie = `sbo_consent=${encodeURIComponent(sbo({ policyVersion: 'old-policy' }))}; path=/`;
    const root = mountBanner('new-policy');
    (window as unknown as { sboConsent: { open: () => void } }).sboConsent.open();
    expect(root.querySelector<HTMLInputElement>('[data-sb-category="analytics"]')!.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[data-sb-category="marketing"]')!.checked).toBe(false);
  });
});
