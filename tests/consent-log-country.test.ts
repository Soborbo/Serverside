import { describe, it, expect, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConsent } from '../src/routes/consent';
import { parseConsentPayload, serverObservedCountry } from '../src/lib/consent-log';

/**
 * 2026-10 CMP pilot-review, A5/B4 — a `consent_log.country` a SkinLab 753
 * sorából 753-ban NULL volt: a worker csak a kliens által küldött országot
 * fogadta, a kliens-lib pedig sosem küldött. Mostantól a Cloudflare
 * IP-geolokációja (`request.cf.country`) adja.
 */

const HOST = 'consent-country.example.com';
const CONSENT_ID = 'c1d2e3f4-aaaa-bbbb-cccc-000000000099';

const DECISION = {
  consent_id: CONSENT_ID,
  consent_event_id: 'e1d2e3f4-aaaa-bbbb-cccc-000000000098',
  revision: 1,
  decision: 'accept_all',
  cat_analytics: true,
  cat_marketing: true,
  consent_mode: 'basic',
  policy_version: '2026-08-a',
  banner_version: 'b1',
  consent_text_version: '2026-08-a',
  ruleset: 'eea_uk',
  lang: 'hu',
  client_decided_at: '2026-08-17T10:00:00.000Z'
};

describe('serverObservedCountry', () => {
  it('ISO-2 → nagybetűs', () => {
    expect(serverObservedCountry('HU')).toBe('HU');
    expect(serverObservedCountry('gb')).toBe('GB');
  });

  it.each([
    ['XX (ismeretlen)', 'XX'],
    ['T1 (Tor)', 'T1'],
    ['hiányzik', undefined],
    ['nem string', 36],
    ['üres', ''],
    ['háromjegyű', 'HUN']
  ])('%s → undefined', (_name, v) => {
    expect(serverObservedCountry(v)).toBeUndefined();
  });
});

describe('parseConsentPayload — country elsőbbség', () => {
  it('a szerver által megfigyelt ország nyer a kliens által küldött fölött', () => {
    const r = parseConsentPayload({ ...DECISION, country: 'de' }, 'site', 'HU');
    expect(r.ok && r.entry.country).toBe('HU');
  });

  it('szerver-ország nélkül a kliensé marad (visszafelé kompatibilis)', () => {
    const r = parseConsentPayload({ ...DECISION, country: 'de' }, 'site');
    expect(r.ok && r.entry.country).toBe('DE');
  });

  it('egyik sincs → undefined (NULL), nem találunk ki', () => {
    const r = parseConsentPayload(DECISION, 'site');
    expect(r.ok && r.entry.country).toBeUndefined();
  });
});

// ── Route-szint: a valódi INSERT-be kerül-e ──────────────────────────────────

function makeEnv() {
  const inserts: unknown[][] = [];
  const env = {
    SITE_CONFIG: {
      get: async () => ({
        site_id: 'consent-country',
        country_code: 'HU',
        currency: 'HUF',
        consent: { provider: 'sbo', mode: 'basic' }
      })
    },
    LEDGER: {
      batch: async (list: Array<{ run: () => Promise<unknown> }>) => {
        for (const s of list) await s.run();
        return [];
      },
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO consent_log')) inserts.push(binds);
            return { success: true };
          },
          first: async () => null,
          all: async () => ({ results: [] })
        })
      })
    }
  };
  return { env: env as never, inserts };
}

function post(cfCountry: unknown, body: Record<string, unknown> = DECISION): Request {
  const req = new Request(`https://${HOST}/api/consent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `https://${HOST}`,
      Cookie: `sbo_consent=v2.1.1.1.accept_all.${CONSENT_ID}.1787000000.2026-08-a`
    },
    body: JSON.stringify(body)
  });
  // A Workers-runtime a `cf` objektumot a Request-re akasztja; Node-ban kézzel.
  if (cfCountry !== undefined) Object.defineProperty(req, 'cf', { value: { country: cfCountry } });
  return req;
}

// consent_log INSERT bind-sorrend (ledger.ts recordConsentDecision): 18 = country
const COUNTRY_IDX = 18;

describe('/api/consent — a country a request.cf-ből íródik', () => {
  it('cf.country=HU → a consent_log sor country-ja HU', async () => {
    const { env, inserts } = makeEnv();
    const res = await handleConsent(post('HU'), env);
    expect(res.status).toBe(204);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][COUNTRY_IDX]).toBe('HU');
  });

  it('cf nélkül (pl. helyi dev) → NULL, és a döntés ugyanúgy tárolódik', async () => {
    const { env, inserts } = makeEnv();
    const res = await handleConsent(post(undefined), env);
    expect(res.status).toBe(204);
    expect(inserts[0][COUNTRY_IDX]).toBeNull();
  });

  it('cf.country=XX → NULL, nem „XX"', async () => {
    const { env, inserts } = makeEnv();
    await handleConsent(post('XX'), env);
    expect(inserts[0][COUNTRY_IDX]).toBeNull();
  });
});
