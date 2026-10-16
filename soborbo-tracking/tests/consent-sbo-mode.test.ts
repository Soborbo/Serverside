/**
 * A consent_log.consent_mode a TÉNYLEGESEN futó módot rögzíti (a boot ugyanabból
 * a trackingConfig.consentMode-ból dönt) — korábban fixen 'basic' volt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('consent_mode a döntés-payloadban', () => {
  beforeEach(() => {
    vi.resetModules();
    document.cookie.split(';').forEach((c) => {
      const n = c.split('=')[0]!.trim();
      if (n) document.cookie = `${n}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    });
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['advanced', 'advanced'],
    ['basic', 'basic'],
    [undefined, 'basic'],
    ['ADVANCED', 'basic'],
  ])('PUBLIC_TRACKING_CONSENT_MODE=%s → %s', async (env, expected) => {
    if (env !== undefined) vi.stubEnv('PUBLIC_TRACKING_CONSENT_MODE', env);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { applySboDecision } = await import('../lib/consent-sbo');
    applySboDecision({ analytics: true, marketing: true }, { bannerVersion: 'b', consentTextVersion: 't' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.consent_mode).toBe(expected);
    vi.unstubAllGlobals();
  });
});
