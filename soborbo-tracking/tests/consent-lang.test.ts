/**
 * 6.14.0 — a consent-döntés `lang` mezője az OLDAL nyelve.
 *
 * A <ConsentBanner lang> prop a SZÖVEGET választja (build-time, .astro — itt
 * nem futtatható); a wire-payload `lang`-ja a `<html lang>`-ból jön, és a
 * gateway csak `xx` / `xx-YY` alakot fogad (consent-log LANG_RE) — rossz
 * alaknál a TELJES döntés 400-at kapna. Ezt a kettőt mérjük itt: a ctx.lang
 * átvétele, a locale-visszaesés, és a wire-alak szűkítése.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applySboDecision, normalizeConsentLang, postBannerShown } from '../lib/consent-sbo';
import { trackingConfig } from '../lib/config';
import { resetAll } from './helpers';

const CTX = { bannerVersion: '2026-09-a-b2', consentTextVersion: '2026-09-a.ga4' };
const SERVER_LANG_RE = /^[A-Za-z]{2}(-[A-Za-z]{2})?$/; // = Serverside src/lib/consent-log.ts LANG_RE

function mockFetch(status = 204): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ status, ok: status < 400 }) as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const flushAsync = () => new Promise((r) => setTimeout(r, 0));
const bodyOf = (fn: ReturnType<typeof vi.fn>, i = 0) =>
  JSON.parse(String((fn.mock.calls[i] as [string, RequestInit])[1].body)) as Record<string, unknown>;

beforeEach(() => {
  resetAll();
  trackingConfig.consentProvider = 'sbo';
});

afterEach(() => {
  trackingConfig.consentProvider = 'cookieyes';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeConsentLang — a gateway alakjára szűkít', () => {
  it.each([
    ['hu', 'hu'],
    ['en-GB', 'en-GB'],
    ['pt-BR', 'pt-BR'],
    ['zh-Hant', 'zh'],
    ['sr-Latn-RS', 'sr'],
    ['de-DE-x-private', 'de'],
    ['  ro  ', 'ro'],
  ])('%s → %s', (raw, out) => {
    const got = normalizeConsentLang(raw);
    expect(got).toBe(out);
    expect(got).toMatch(SERVER_LANG_RE);
  });

  it.each(['', '   ', 'x', '123', 'eng-US', undefined, null])('%s → undefined (a hívó a locale-ra esik)', (raw) => {
    expect(normalizeConsentLang(raw as string | undefined | null)).toBeUndefined();
  });
});

describe('applySboDecision — a wire `lang`', () => {
  it('a ctx.lang (az oldal nyelve) megy ki, nem a build-locale', async () => {
    const fn = mockFetch(204);
    expect(trackingConfig.locale).toBe('hu'); // a teszt-env build-locale-ja
    applySboDecision({ analytics: true, marketing: true }, { ...CTX, lang: 'de' });
    await flushAsync();
    expect(bodyOf(fn).lang).toBe('de');
  });

  it('régiós alak változatlanul megy ki', async () => {
    const fn = mockFetch(204);
    applySboDecision({ analytics: true, marketing: true }, { ...CTX, lang: 'en-GB' });
    await flushAsync();
    expect(bodyOf(fn).lang).toBe('en-GB');
  });

  it('ctx.lang nélkül (nincs <html lang>) a build-locale a tartalék — a 6.13 viselkedése', async () => {
    const fn = mockFetch(204);
    applySboDecision({ analytics: true, marketing: true }, CTX);
    await flushAsync();
    expect(bodyOf(fn).lang).toBe(trackingConfig.locale);
  });

  it('a gateway által elutasított alak (zh-Hant) az elsődleges altagra szűkül — a döntés NEM kap 400-at', async () => {
    const fn = mockFetch(204);
    applySboDecision({ analytics: false, marketing: false }, { ...CTX, lang: 'zh-Hant' });
    await flushAsync();
    const body = bodyOf(fn);
    expect(body.lang).toBe('zh');
    expect(body.lang).toMatch(SERVER_LANG_RE);
  });

  it('értelmezhetetlen alak → locale (sosem megy ki olyan, amit a szerver eldobna)', async () => {
    const fn = mockFetch(204);
    applySboDecision({ analytics: true, marketing: false }, { ...CTX, lang: '123' });
    await flushAsync();
    expect(bodyOf(fn).lang).toBe(trackingConfig.locale);
  });
});

describe('postBannerShown — a metrika `lang`-ja ugyanazon a szabályon', () => {
  it('sendBeacon-út: a ping elmegy (a body-t a fetch-tartalék ágon mérjük, a Blob jsdom alatt nem olvasható szinkron)', () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon });
    postBannerShown({ banner_version: '2026-09-a-b2', lang: 'zh-Hant' });
    expect(beacon).toHaveBeenCalledTimes(1);
    expect((beacon.mock.calls[0][1] as Blob).type).toBe('application/json');
  });

  it('fetch-tartalék body: `zh-Hant` → `zh`, hiányzó/rossz lang → nincs lang mező', async () => {
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: undefined });
    const fn = mockFetch(204);
    postBannerShown({ banner_version: '2026-09-a-b2', lang: 'zh-Hant', device_class: 'mobile' });
    postBannerShown({ banner_version: '2026-09-a-b2', lang: '123' });
    postBannerShown({ banner_version: '2026-09-a-b2' });
    await flushAsync();
    expect(bodyOf(fn, 0)).toEqual({ banner_version: '2026-09-a-b2', lang: 'zh', device_class: 'mobile' });
    expect(bodyOf(fn, 1)).toEqual({ banner_version: '2026-09-a-b2' });
    expect(bodyOf(fn, 2)).toEqual({ banner_version: '2026-09-a-b2' });
  });
});
