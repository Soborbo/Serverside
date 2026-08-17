import { describe, it, expect } from 'vitest';
// @ts-expect-error — a harness sima ESM (.mjs), típusdefiníció nélkül; a tesztek
// a futásidejű viselkedést őrzik, nem a típusokat.
import { classifyRequest, isFirstParty, inspectPingForIdentifiers } from './lib/classify.mjs';
// @ts-expect-error — lásd fent.
import { contrastRatio, parseRgb, compareButtonProminence } from './lib/banner.mjs';
// @ts-expect-error — lásd fent.
import { isNonEssentialCookie, isNonEssentialStorageKey } from './lib/instrument.mjs';
// @ts-expect-error — lásd fent.
import { evaluateBeforeDecision, evaluateAfterReject, evaluateBannerUi } from './lib/checks.mjs';

/**
 * A compliance-harness TISZTA magja. Hálózat nélkül fut, ezért a normál
 * `npm test`-ben is benne van — a flotta-mérés maga NEM (élő oldalakat tölt,
 * lásd tests/compliance/README.md).
 *
 * Amit őriz: a mérőműszer kalibrációját. Egy elrontott osztályozó vagy
 * kontraszt-képlet CSENDES hamis riasztás (vagy ami rosszabb: csendes zöld) a
 * teljes flottán.
 */

describe('classifyRequest', () => {
  it('felismeri a mérési/marketing végpontokat', () => {
    expect(classifyRequest('https://www.google-analytics.com/g/collect?v=2')).toBe('ga4');
    expect(classifyRequest('https://analytics.google.com/g/collect')).toBe('ga4');
    expect(classifyRequest('https://www.googletagmanager.com/gtm.js?id=GTM-X')).toBe('gtm');
    expect(classifyRequest('https://www.googleadservices.com/pagead/conversion/1/')).toBe('google_ads');
    expect(classifyRequest('https://stats.g.doubleclick.net/j/collect')).toBe('google_ads');
    expect(classifyRequest('https://www.facebook.com/tr?id=1&ev=PageView')).toBe('meta');
    expect(classifyRequest('https://connect.facebook.net/en_US/fbevents.js')).toBe('meta');
    expect(classifyRequest('https://cdn-cookieyes.com/client_data/x/script.js')).toBe('cmp');
    expect(classifyRequest('https://lomtalan.hu/api/event/conversion')).toBe('gateway');
  });

  it('az ELSŐ FÉLEN proxyzott Google-mérést is felismeri (Tag Gateway)', () => {
    // A flotta fele saját domainen proxyzza a GA4-et; enélkül a „megy-e mérés
    // consent előtt" ellenőrzés pont ott adna hamis PASS-t.
    expect(classifyRequest('https://lomtalan.hu/meres/ga/g/c?v=2&tid=G-68EJ2V86V6&gtm=45')).toBe('ga4');
    expect(classifyRequest('https://painlessremovals.com/f807/gs/ccm/collect?tid=AW-123&en=page_view')).toBe(
      'google_ads'
    );
  });

  it('a semleges kérés `other` — nem gyártunk hamis találatot', () => {
    expect(classifyRequest('https://lomtalan.hu/styles.css')).toBe('other');
    expect(classifyRequest('https://fonts.gstatic.com/s/x.woff2')).toBe('other');
  });
});

describe('isFirstParty', () => {
  it('a site saját hostjához méri (www és apex ugyanaz, aldomain is az)', () => {
    expect(isFirstParty('https://www.lomtalan.hu/api/lead', 'https://lomtalan.hu/')).toBe(true);
    expect(isFirstParty('https://lomtalan.hu/api/lead', 'https://www.lomtalan.hu/')).toBe(true);
    expect(isFirstParty('https://shop.lomtalan.hu/api/lead', 'https://lomtalan.hu/')).toBe(true);
    expect(isFirstParty('https://www.google-analytics.com/g/collect', 'https://lomtalan.hu/')).toBe(false);
  });

  it('többcímkés public suffixnél NEM veszi első félnek az egész .co.uk-ot', () => {
    // A régi „utolsó két címke" szabály `co.uk`-ra redukált, és minden *.co.uk
    // hostot első félnek vett — a safety-net így IDEGEN harmadik felek kéréseit
    // abortálta volna, ráadásul first-party írásként jelentve őket.
    expect(isFirstParty('https://tracker.other.co.uk/collect', 'https://agykontroll.co.uk/')).toBe(false);
    expect(isFirstParty('https://www.agykontroll.co.uk/x', 'https://agykontroll.co.uk/')).toBe(true);
  });
});

describe('inspectPingForIdentifiers', () => {
  it('kiszúrja a user_id-t, a custom paramot és a click ID-t', () => {
    const r = inspectPingForIdentifiers(
      'https://www.google-analytics.com/g/collect?v=2&uid=user-1&up.plan=pro&gclid=ABC'
    );
    expect(r.params).toEqual(expect.arrayContaining(['uid', 'up.plan', 'gclid']));
    expect(r.hasClickId).toBe(true);
  });

  it('e-mail-gyanús értéket jelez (kódolva is)', () => {
    expect(inspectPingForIdentifiers('https://x/tr?ud%5Bem%5D=a%40b.com').hasEmailLike).toBe(true);
  });

  it('az URL-be ágyazott click ID-t is megtalálja a `dl` paraméterben', () => {
    const r = inspectPingForIdentifiers('https://www.google-analytics.com/g/collect?dl=https%3A%2F%2Fx.hu%2F%3Fgclid%3DZ');
    expect(r.hasClickId).toBe(true);
  });

  it('a POST-TÖRZSBEN utazó azonosítót is megtalálja', () => {
    // GA4/Meta POST-nál az azonosítók a törzsben vannak; csak az URL-t nézve a
    // „reject után nincs azonosító" ellenőrzés hamis PASS-t adna.
    const r = inspectPingForIdentifiers(
      'https://www.google-analytics.com/g/collect?v=2',
      'en=page_view&uid=user-9&ep.email=a%40b.com'
    );
    expect(r.params).toEqual(expect.arrayContaining(['body:uid', 'body:ep.email']));
    expect(r.hasEmailLike).toBe(true);
  });

  it('tiszta ping → nincs találat', () => {
    const r = inspectPingForIdentifiers('https://www.google-analytics.com/g/collect?v=2&tid=G-X&en=page_view');
    expect(r.params).toEqual([]);
    expect(r.hasEmailLike).toBe(false);
  });
});

describe('kontraszt (WCAG)', () => {
  it('parseRgb rgb és rgba alakot is olvas', () => {
    expect(parseRgb('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
    expect(parseRgb('rgba(0, 0, 0, 0.5)')).toEqual([0, 0, 0]);
    expect(parseRgb('transparent')).toBeNull();
  });

  it('fekete-fehér = 21, azonos szín = 1', () => {
    expect(contrastRatio('rgb(0,0,0)', 'rgb(255,255,255)')).toBe(21);
    expect(contrastRatio('rgb(18,18,18)', 'rgb(18,18,18)')).toBe(1);
  });

  it('parse-olhatatlan szín → null (a „nem tudjuk" NEM „rossz")', () => {
    expect(contrastRatio('transparent', 'rgb(0,0,0)')).toBeNull();
  });
});

describe('compareButtonProminence', () => {
  const big = { area: 10000, font_size_px: 18, color: 'rgb(255,255,255)', background_color: 'rgb(10,125,43)' };

  it('hiányzó reject gomb → nem egyenrangú, megnevezett okkal', () => {
    const r = compareButtonProminence(big, null);
    expect(r.equal_prominence).toBe(false);
    expect(r.reason).toBe('no_reject_button');
  });

  it('a látványosan kisebb reject bukik, és megmondja, min', () => {
    const small = { area: 2000, font_size_px: 11, color: 'rgb(185,185,185)', background_color: 'rgb(242,242,242)' };
    const r = compareButtonProminence(big, small);
    expect(r.equal_prominence).toBe(false);
    expect(r.area_ratio).toBeLessThan(0.7);
    expect(r.failures.join(' ')).toMatch(/terület|betűméret|kontraszt/);
  });

  it('az egyforma gombpár átmegy', () => {
    const r = compareButtonProminence(big, { ...big });
    expect(r.equal_prominence).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe('nem-esszenciális besorolás', () => {
  it('a mérési kulcsok nem-esszenciálisak', () => {
    for (const k of ['sb_tracking', 'sb_first_touch', 'sb_session', '__sb_attribution', '_ga', '_fbp']) {
      expect(isNonEssentialStorageKey(k)).toBe(true);
    }
    expect(isNonEssentialStorageKey('theme')).toBe(false);
  });

  it('a CMP saját és az infrastruktúra-sütije esszenciális', () => {
    for (const c of ['cookieyes-consent', 'cky-active-check', '__cf_bm', 'PHPSESSID']) {
      expect(isNonEssentialCookie(c)).toBe(false);
    }
    expect(isNonEssentialCookie('_ga')).toBe(true);
    expect(isNonEssentialCookie('_fbp')).toBe(true);
  });
});

describe('checks — a bizonyíték-szabály', () => {
  const cleanCapture = {
    requests: [],
    cookies: [],
    page: { storage: [], dataLayer: [], cookieReads: 0 },
    noscript_gtm_iframe: null
  };

  it('tiszta oldal: nincs FAIL a döntés előtti blokkban', () => {
    const checks = evaluateBeforeDecision(cleanCapture);
    expect(checks.filter((c: { status: string }) => c.status === 'FAIL')).toEqual([]);
  });

  it('MINDEN FAIL mellett van nyers bizonyíték', () => {
    const dirty = {
      requests: [
        { t: 2, category: 'ga4', method: 'GET', url: 'https://www.google-analytics.com/g/collect?uid=1' },
        { t: 1, category: 'gtm', method: 'GET', url: 'https://www.googletagmanager.com/gtm.js' }
      ],
      cookies: [{ name: '_fbp', domain: '.x.hu', expires: 'session' }],
      page: {
        storage: [
          { t: 1, op: 'setItem', area: 'local', key: 'sb_tracking' },
          { t: 1, op: 'getItem', area: 'local', key: '__sb_attribution' }
        ],
        dataLayer: [],
        cookieReads: 3
      },
      noscript_gtm_iframe: '<noscript><iframe src="…/ns.html?id=GTM-X">'
    };
    const checks = [...evaluateBeforeDecision(dirty), ...evaluateAfterReject(dirty)];
    const fails = checks.filter((c: { status: string }) => c.status === 'FAIL');
    expect(fails.length).toBeGreaterThan(4);
    for (const f of fails) expect(f.evidence, `${f.id} bizonyíték nélkül`).toBeTruthy();
  });

  it('nincs banner → NO_BANNER_OBSERVED, NEM „nincs CMP"', () => {
    const [c] = evaluateBannerUi(null, null);
    expect(c.status).toBe('N-A');
    expect(c.detail).toMatch(/NO_BANNER_OBSERVED/);
  });
});
