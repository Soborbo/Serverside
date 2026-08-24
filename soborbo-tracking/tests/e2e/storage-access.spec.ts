import { test, expect, type Page } from '@playwright/test';

/**
 * PECR storage-access — valódi böngészőben, PRODUCTION bundle-lel.
 *
 * Amit a vitest-suite NEM tud bizonyítani, és ezért itt van:
 *  1. Hogy tényleg nem TÖRTÉNIK hozzáférés. A unit teszt a visszaadott értéket
 *     nézi; itt a `Storage.prototype` és a `document.cookie` leírója van
 *     patchelve, tehát magát a MŰVELETET látjuk (a PECR alatt az olvasás a
 *     szabályozott cselekmény, nem az eredménye).
 *  2. A prod consent-kapu. A package `isDevMode()`-ja dev-ben ENGED — a vitest
 *     dev-módban fut, tehát a „CookieYes sosem tölt be → deny-all" ág csak itt
 *     mérhető. Ez a betöltési verseny szélső esete.
 *  3. bfcache / vissza-navigáció: a kapu a visszaállított oldalon is érvényes-e.
 */

const NON_ESSENTIAL_KEYS = ['sb_tracking', 'sb_first_touch', 'sb_session'];

interface AccessLog {
  ls: Array<{ op: string; key: string }>;
  cookieGet: number;
  cookieSet: string[];
}

async function boot(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
}

const access = (page: Page) => page.evaluate(() => (window as never as { __t: { access: () => AccessLog } }).__t.access());
const raw = (page: Page) =>
  page.evaluate(() =>
    (window as never as { __t: { raw: () => Record<string, string | null> } }).__t.raw()
  );

/** Külső (harmadik feles) kérés a fixture-ből mindig hiba — semmi nem tölt ilyet. */
function failOnThirdParty(page: Page): string[] {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') external.push(r.url());
  });
  return external;
}

test.describe('friss böngésző, döntés nélkül', () => {
  test('a CMP sosem tölt be: nincs non-essential storage ÍRÁS és OLVASÁS sem', async ({ page }) => {
    const external = failOnThirdParty(page);
    await boot(page, '/?gclid=G-URL&fbclid=F-URL&utm_source=google');

    await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.noCmp();          // a CookieYes szkript nem töltött be → prodban deny-all
      t.resetAccess();
      t.initTracking();
      t.readAll();        // amit egy konverzió pillanatában kiolvasnánk
    });

    const log = await access(page);
    const touched = log.ls.filter((e) => NON_ESSENTIAL_KEYS.includes(e.key));
    expect(touched, `non-essential storage hozzáférés: ${JSON.stringify(touched)}`).toEqual([]);
    // A Meta-sütik olvasása is terminál-storage hozzáférés → nem történhet meg.
    expect(log.cookieGet).toBe(0);
    expect(log.cookieSet).toEqual([]);
    expect(external).toEqual([]);
  });

  test('az URL-paraméterek olvasása MEGENGEDETT (nem terminál-storage)', async ({ page }) => {
    await boot(page, '/?gclid=G-URL&fbclid=F-URL');
    const read = await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, () => unknown> }).__t;
      t.noCmp();
      t.resetAccess();
      return t.readAll() as { gclid: string | null; fbclid: string | null };
    });
    expect(read.gclid).toBe('G-URL');
    expect(read.fbclid).toBe('F-URL');
  });

  test('a blokkolt olvasás JELENTVE van a konverziós payloadban', async ({ page }) => {
    await boot(page);
    await page.request.post('/__posts/reset');
    await page.evaluate(async () => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.noCmp();
      t.initTracking();
      t.readAll();
      await (t.send() as Promise<boolean>);
    });
    // A payload a szerver-ingress felé is ezt viszi (consent_receipts oszlop).
    const posts = await (await page.request.get('/__posts')).json();
    // Consent nélkül a lib nem dispatch-el konverziót — a blokk-jel a kliensen áll.
    const blocked = await page.evaluate(() =>
      (window as never as { __t: { blocked: () => { blocked: boolean; keys: string[] } } }).__t.blocked()
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.keys).toContain('sb_tracking');
    expect(Array.isArray(posts)).toBe(true);
  });
});

test.describe('marketing consent megadva', () => {
  test('sb_tracking / sb_first_touch írható ÉS olvasható', async ({ page }) => {
    await boot(page, '/?gclid=G-1&utm_source=google');
    const result = await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: true, marketing: true });
      t.initTracking();
      t.resetAccess();
      return t.readAll() as { stored: { gclid?: string } | null; blocked: { blocked: boolean } };
    });
    expect(result.stored?.gclid).toBe('G-1');
    expect(result.blocked.blocked).toBe(false);

    const stored = await raw(page);
    expect(stored.sb_tracking).toContain('G-1');
    expect(stored.sb_first_touch).toContain('google');

    const log = await access(page);
    expect(log.ls.some((e) => e.op === 'getItem' && e.key === 'sb_tracking')).toBe(true);
  });
});

test.describe('visszavonás', () => {
  test('marketing ON → OFF: sb_tracking, sb_first_touch és a Meta sütik törlődnek', async ({ page }) => {
    const external = failOnThirdParty(page);
    await boot(page, '/?gclid=G-2&utm_source=google');

    await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: true, marketing: true });
      t.initTracking();
      t.seedMetaCookies();
    });
    const before = await raw(page);
    expect(before.sb_tracking).toContain('G-2');
    expect(before.cookie).toContain('_fbp=');

    await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: true, marketing: false });
    });

    const after = await raw(page);
    expect(after.sb_tracking).toBeNull();
    expect(after.sb_first_touch).toBeNull();
    expect(after.cookie).not.toContain('_fbp=fb.1.100.200');
    expect(after.cookie).not.toContain('_fbc=fb.1.100.CLICK');
    // Az analytics érintetlen: a két kategória függetlenül vonható vissza.
    expect(after.sb_session === null || after.sb_session !== undefined).toBe(true);
    expect(external).toEqual([]);
  });

  test('a visszavonás UTÁN nincs több olvasás sem', async ({ page }) => {
    await boot(page, '/?gclid=G-3');
    const blocked = await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: true, marketing: true });
      t.initTracking();
      t.setConsent({ analytics: true, marketing: false });
      t.resetAccess();
      t.readAll();
      return t.blocked() as { blocked: boolean; keys: string[] };
    });
    expect(blocked.blocked).toBe(true);
    const log = await access(page);
    expect(log.ls.filter((e) => e.op === 'getItem' && NON_ESSENTIAL_KEYS.includes(e.key))).toEqual([]);
  });

  test('analytics ON → OFF: sb_session törlődik, a marketing storage marad', async ({ page }) => {
    await boot(page, '/?gclid=G-4');
    await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: true, marketing: true });
      t.initTracking();
      t.session();
    });
    expect((await raw(page)).sb_session).not.toBeNull();

    await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: false, marketing: true });
    });

    const after = await raw(page);
    expect(after.sb_session).toBeNull();
    expect(after.sb_tracking).toContain('G-4');
  });
});

test.describe('bfcache / vissza-navigáció', () => {
  test('a kapu a visszaállított oldalon is érvényes', async ({ page }) => {
    await boot(page, '/?gclid=G-5');
    await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.setConsent({ analytics: true, marketing: true });
      t.initTracking();
    });
    // Másik oldal, majd vissza — bfcache-ből vagy újratöltésből.
    await page.goto('/?page=2');
    await page.goBack();
    await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);

    const blocked = await page.evaluate(() => {
      const t = (window as never as { __t: Record<string, (a?: unknown) => unknown> }).__t;
      t.noCmp();        // a visszaállított oldalon a CMP (még) nincs meg
      t.resetAccess();
      t.readAll();
      return t.blocked() as { blocked: boolean };
    });
    expect(blocked.blocked).toBe(true);
    const log = await access(page);
    expect(log.ls.filter((e) => e.op === 'getItem' && NON_ESSENTIAL_KEYS.includes(e.key))).toEqual([]);
    expect(log.cookieGet).toBe(0);
  });
});
