import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  redactSecrets,
  fingerprintConfig,
  diffManifest,
  type SiteManifest
} from '../src/lib/site-manifest';
// A generátor (.mjs) tükör-implementációja — a paritást ez a teszt őrzi (a
// contract-hash/contract-lock mintája szerint).
import {
  canonicalize as genCanonicalize,
  fingerprintConfig as genFingerprint
} from '../scripts/gen-site-manifest.mjs';

const SAMPLE = {
  site_id: 'sample',
  country_code: 'HU',
  currency: 'HUF',
  require_consent: true,
  meta: { pixel_id: '123456789', access_token: 'SECRET-TOKEN-abc' },
  gads: { customer_id: '1234567890', login_customer_id: null },
  expected_platforms: { smoke: ['meta'] },
  crm_token_sha256: 'a'.repeat(64)
};

describe('canonicalize — determinisztikus, kulcs-sorrend-független', () => {
  it('a kulcsok SORRENDJE nem befolyásolja a kimenetet', () => {
    const a = canonicalize({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] });
    const b = canonicalize({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('.ts és a .mjs generátor canonicalize-je BÁJTPONTOSAN egyezik', () => {
    expect(genCanonicalize(SAMPLE)).toBe(canonicalize(SAMPLE));
  });
});

describe('redactSecrets — a titkok sose kerülnek plaintextben a fingerprintbe', () => {
  it('access_token + api_secret a saját sha256-jukra cserélődik', async () => {
    const r = (await redactSecrets({
      ...SAMPLE,
      ga4: { measurement_id: 'G-XXX', api_secret: 'GA-SECRET' }
    })) as Record<string, any>;
    expect(r.meta.access_token).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.meta.access_token).not.toContain('SECRET-TOKEN');
    expect(r.ga4.api_secret).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.ga4.api_secret).not.toContain('GA-SECRET');
  });

  it('az eredeti configot nem módosítja (mély másolat)', async () => {
    const original = JSON.parse(JSON.stringify(SAMPLE));
    await redactSecrets(SAMPLE);
    expect(SAMPLE).toEqual(original);
  });
});

describe('fingerprintConfig — paritás + drift-érzékenység', () => {
  it('.ts és a .mjs generátor UGYANAZT a fingerprintet adja', async () => {
    expect(await fingerprintConfig(SAMPLE)).toBe(genFingerprint(SAMPLE));
  });

  it('sha256:<64 hex> alak', async () => {
    expect(await fingerprintConfig(SAMPLE)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a meta-blokk ELTŰNÉSE megváltoztatja a fingerprintet (lomtalan-osztály)', async () => {
    const withMeta = await fingerprintConfig(SAMPLE);
    const { meta, ...withoutMeta } = SAMPLE;
    void meta;
    expect(await fingerprintConfig(withoutMeta)).not.toBe(withMeta);
  });

  it('a token ROTÁCIÓJA driftet ad (a hash változik), plaintext nélkül', async () => {
    const a = await fingerprintConfig(SAMPLE);
    const b = await fingerprintConfig({ ...SAMPLE, meta: { ...SAMPLE.meta, access_token: 'DIFFERENT' } });
    expect(a).not.toBe(b);
  });

  it('a test_event_code beszivárgása driftet ad (CLAUDE.md §17 őre)', async () => {
    const clean = await fingerprintConfig(SAMPLE);
    const leaked = await fingerprintConfig({ ...SAMPLE, meta: { ...SAMPLE.meta, test_event_code: 'TEST123' } });
    expect(leaked).not.toBe(clean);
  });
});

describe('diffManifest — missing / changed / unmanifested / clean', () => {
  const manifest: SiteManifest = {
    sites: { 'a.com': 'sha256:aaa', 'b.com': 'sha256:bbb' }
  };

  it('minden egyezik → nincs drift', () => {
    const live = new Map([['a.com', 'sha256:aaa'], ['b.com', 'sha256:bbb']]);
    expect(diffManifest(manifest, live)).toEqual([]);
  });

  it('a KV-ből hiányzó config → missing', () => {
    const live = new Map([['a.com', 'sha256:aaa']]);
    expect(diffManifest(manifest, live)).toEqual([{ hostname: 'b.com', kind: 'missing' }]);
  });

  it('eltérő fingerprint → changed', () => {
    const live = new Map([['a.com', 'sha256:aaa'], ['b.com', 'sha256:DIFFERENT']]);
    expect(diffManifest(manifest, live)).toEqual([{ hostname: 'b.com', kind: 'changed' }]);
  });

  it('manifestből hiányzó élő config → unmanifested', () => {
    const live = new Map([
      ['a.com', 'sha256:aaa'],
      ['b.com', 'sha256:bbb'],
      ['new.com', 'sha256:ccc']
    ]);
    expect(diffManifest(manifest, live)).toEqual([{ hostname: 'new.com', kind: 'unmanifested' }]);
  });

  it('vegyes drift, hostname szerint rendezve', () => {
    const live = new Map([['a.com', 'sha256:CHANGED'], ['z.com', 'sha256:zzz']]);
    expect(diffManifest(manifest, live)).toEqual([
      { hostname: 'a.com', kind: 'changed' },
      { hostname: 'b.com', kind: 'missing' },
      { hostname: 'z.com', kind: 'unmanifested' }
    ]);
  });
});
