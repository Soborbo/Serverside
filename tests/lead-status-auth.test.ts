import { describe, it, expect } from 'vitest';
import { authenticateLeadStatus, siteTokenMatches } from '../src/lib/admin-auth';
import { sha256Hex } from '../src/lib/hash';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';

function req(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set('X-Admin-Token', token);
  return new Request('https://track.example.com/api/event/lead-status', {
    method: 'POST',
    headers
  });
}

const baseSite: SiteConfig = {
  site_id: 'example',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: 'x', access_token: 'y' },
  gads: { customer_id: null, login_customer_id: null }
};

const GLOBAL = 'global-operator-token';
const env = { ADMIN_API_TOKEN: GLOBAL } as unknown as Env;

describe('siteTokenMatches (pure, constant-time hex compare)', () => {
  it('true on equal hashes, false on any difference', async () => {
    const h = await sha256Hex('per-site-token');
    expect(siteTokenMatches(h, h)).toBe(true);
    expect(siteTokenMatches(h, await sha256Hex('other'))).toBe(false);
    expect(siteTokenMatches('', h)).toBe(false);
  });
});

describe('authenticateLeadStatus — per-site token isolation', () => {
  it('accepts the correct per-site token', async () => {
    const site = { ...baseSite, crm_token_sha256: await sha256Hex('site-A-token') };
    expect(await authenticateLeadStatus(req('site-A-token'), env, site)).toBe(true);
  });

  it('rejects the GLOBAL token for a site that has its own (tenant boundary)', async () => {
    const site = { ...baseSite, crm_token_sha256: await sha256Hex('site-A-token') };
    expect(await authenticateLeadStatus(req(GLOBAL), env, site)).toBe(false);
  });

  it("rejects another site's token (cross-tenant attempt)", async () => {
    const siteA = { ...baseSite, crm_token_sha256: await sha256Hex('site-A-token') };
    expect(await authenticateLeadStatus(req('site-B-token'), env, siteA)).toBe(false);
  });

  it('rejects a missing header when a per-site token is set', async () => {
    const site = { ...baseSite, crm_token_sha256: await sha256Hex('site-A-token') };
    expect(await authenticateLeadStatus(req(), env, site)).toBe(false);
  });

  it('falls back to the global token when the site has no per-site token', async () => {
    expect(await authenticateLeadStatus(req(GLOBAL), env, baseSite)).toBe(true);
    expect(await authenticateLeadStatus(req('wrong'), env, baseSite)).toBe(false);
  });

  it('fallback denies when the global token is unset (test deploy)', async () => {
    const noGlobal = {} as unknown as Env;
    expect(await authenticateLeadStatus(req('anything'), noGlobal, baseSite)).toBe(false);
  });
});
