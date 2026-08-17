import { describe, it, expect, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConsent } from '../src/routes/consent';

/**
 * Soborbo CMP · Fázis 1 — a `/api/consent` végpont.
 *
 * A két dolog, amit ezek a tesztek őriznek:
 *
 *  1. INERTSÉG. `provider='cookieyes'` (minden mai site) mellett a végpont 403-at
 *     ad, és SEMMIT nem ír D1-be. A merge önmagában nulla viselkedésváltozás.
 *
 *  2. ŐSZINTE STÁTUSZKÓDOK. Itt a 204 NEM az alapértelmezés, mint a böngésző-
 *     beaconnél (CLAUDE.md 12.): a kliens az EGYETLEN hely, ahol a döntés még
 *     megvan, amíg nem nyugtáztuk. Egy csendes 204 D1-hiba fölött elveszett
 *     consent-proof, amiről soha senki nem szerez tudomást.
 */

const HOST = 'consent-test.example.com';

const SBO_SITE = {
  site_id: 'consent-test',
  country_code: 'HU',
  currency: 'HUF',
  consent: { provider: 'sbo', mode: 'basic' }
};

const COOKIEYES_SITE = {
  site_id: 'consent-test-cky',
  country_code: 'HU',
  currency: 'HUF'
};

const DECISION = {
  consent_id: 'c1d2e3f4-aaaa-bbbb-cccc-000000000001',
  consent_event_id: 'e1d2e3f4-aaaa-bbbb-cccc-000000000002',
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

interface LedgerCall {
  sql: string;
  binds: unknown[];
}

/**
 * @param opts.d1Error a `.run()` ELDOBJON-e (D1-kiesés szimulációja)
 * @param opts.unique  UNIQUE-ütközést dobjon-e (idempotens duplikátum)
 */
function makeEnv(
  site: unknown,
  opts: { d1Error?: boolean; unique?: boolean; firstRow?: unknown; kvFail?: boolean } = {}
): { env: any; calls: LedgerCall[] } {
  const calls: LedgerCall[] = [];
  const env = {
    SITE_CONFIG: {
      get: async () => {
        if (opts.kvFail) throw new Error('KV unavailable');
        return site;
      }
    },
    LEDGER: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            calls.push({ sql, binds });
            if (opts.unique) throw new Error('D1_ERROR: UNIQUE constraint failed: consent_log.consent_event_id');
            if (opts.d1Error) throw new Error('D1_ERROR: database is locked');
            return { success: true };
          },
          first: async () => {
            calls.push({ sql, binds });
            if (opts.d1Error) throw new Error('D1_ERROR: database is locked');
            return opts.firstRow ?? null;
          }
        })
      })
    }
  };
  return { env, calls };
}

function post(path: string, body: unknown, host = HOST): Request {
  return new Request(`https://${host}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `https://${host}` },
    body: JSON.stringify(body)
  });
}

describe('inertség — provider=cookieyes', () => {
  it('403, és EGYETLEN D1-írás sem történik', async () => {
    // Ez a Fázis 1 legfontosabb tesztje. Ha ez elromlik, a merge már nem inert.
    const { env, calls } = makeEnv(COOKIEYES_SITE);
    const res = await handleConsent(post('/api/consent', DECISION), env);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('a hiányzó consent blokk ugyanúgy 403 (a default nem sbo)', async () => {
    const { env, calls } = makeEnv({ ...COOKIEYES_SITE, consent: undefined });
    const res = await handleConsent(post('/api/consent', DECISION), env);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/consent — őszinte státuszkódok', () => {
  it('204 + X-Consent-Received a sikeres tárolásra', async () => {
    const { env, calls } = makeEnv(SBO_SITE);
    const res = await handleConsent(post('/api/consent', DECISION), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Consent-Received')).toBe('1');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO consent_log');
  });

  it('204 a duplikátumra is — a kliens retry-ja NEM hiba', async () => {
    // Az idempotencia a UNIQUE indexen áll, nem előzetes SELECT-en: két
    // párhuzamos beacon között az utóbbi versenyt nyerne és duplikálna.
    const { env } = makeEnv(SBO_SITE, { unique: true });
    const res = await handleConsent(post('/api/consent', DECISION), env);
    expect(res.status).toBe(204);
  });

  it('503 D1-hibára — NEM 204', async () => {
    // A kliens `receipt_synced=false`-t tart és újraküldi. Egy csendes 204 itt
    // azt jelentené, hogy a consent-proof elveszett, és senki nem tud róla.
    const { env } = makeEnv(SBO_SITE, { d1Error: true });
    const res = await handleConsent(post('/api/consent', DECISION), env);
    expect(res.status).toBe(503);
  });

  it('400 + MEGNEVEZETT ok a hibás payloadra', async () => {
    const { env, calls } = makeEnv(SBO_SITE);
    const res = await handleConsent(
      post('/api/consent', { ...DECISION, cat_marketing: false }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('decision_categories_mismatch');
    expect(calls).toHaveLength(0);
  });

  it('403 idegen originről', async () => {
    const { env, calls } = makeEnv(SBO_SITE);
    const req = new Request(`https://${HOST}/api/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify(DECISION)
    });
    const res = await handleConsent(req, env);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('KV-kiesés → 503, NEM 404', async () => {
    // 404-re a kliens ELDOBNÁ a pending receiptet („ez a site nem létezik"), és a
    // döntés bizonyítéka véglegesen elveszne egy pár másodperces KV-blip miatt.
    const { env } = makeEnv(SBO_SITE, { kvFail: true });
    const res = await handleConsent(post('/api/consent', DECISION), env);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
  });
});

describe('POST /api/consent/shown — ID-mentes UX-mérés', () => {
  it('204 és consent_metrics sor', async () => {
    const { env, calls } = makeEnv(SBO_SITE);
    const res = await handleConsent(
      post('/api/consent/shown', { banner_version: 'b1', lang: 'hu', device_class: 'mobile' }),
      env
    );
    expect(res.status).toBe(204);
    expect(calls[0].sql).toContain('INSERT INTO consent_metrics');
  });

  it('400, ha a ping azonosítót hordoz — és semmi nem íródik', async () => {
    const { env, calls } = makeEnv(SBO_SITE);
    const res = await handleConsent(
      post('/api/consent/shown', { banner_version: 'b1', consent_id: 'c1d2e3f4-aaaa-bbbb' }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('identifier_not_allowed');
    expect(calls).toHaveLength(0);
  });
});

describe('GET /api/consent/:id — a legfrissebb revision', () => {
  const get = (id: string) =>
    new Request(`https://${HOST}/api/consent/${id}`, {
      method: 'GET',
      headers: { Origin: `https://${HOST}` }
    });

  it('200 + állapot, ORDER BY revision DESC-kel', async () => {
    const { env, calls } = makeEnv(SBO_SITE, {
      firstRow: {
        consent_id: 'c1',
        revision: 3,
        decision: 'withdrawn',
        cat_analytics: 0,
        cat_marketing: 0,
        ad_user_data: 'DENIED',
        ad_personalization: 'DENIED',
        ad_storage: 'DENIED',
        analytics_storage: 'DENIED',
        client_decided_at: '2026-08-17T10:00:00.000Z',
        server_received_at: '2026-08-17T10:00:01.000Z'
      }
    });
    const res = await handleConsent(get('c1d2e3f4-aaaa-bbbb-cccc-000000000001'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.revision).toBe(3);
    expect(body.decision).toBe('withdrawn');
    // A legfrissebb revision feloldása — enélkül egy régi GRANTED nyerne.
    expect(calls[0].sql).toContain('ORDER BY revision DESC');
    // Tenant-izoláció: a site_id a lekérdezés RÉSZE.
    expect(calls[0].sql).toContain('site_id = ?');
    expect(calls[0].binds[0]).toBe('consent-test');
  });

  it('404, ha nincs ilyen döntés — a hívó a mai szabályra esik vissza', async () => {
    const { env } = makeEnv(SBO_SITE, { firstRow: null });
    const res = await handleConsent(get('c1d2e3f4-aaaa-bbbb-cccc-000000000001'), env);
    expect(res.status).toBe(404);
  });

  it('a válasz nem cache-elhető', async () => {
    const { env } = makeEnv(SBO_SITE, {
      firstRow: {
        consent_id: 'c1',
        revision: 1,
        decision: 'accept_all',
        cat_analytics: 1,
        cat_marketing: 1,
        ad_user_data: 'GRANTED',
        ad_personalization: 'GRANTED',
        ad_storage: 'GRANTED',
        analytics_storage: 'GRANTED',
        client_decided_at: '2026-08-17T10:00:00.000Z',
        server_received_at: '2026-08-17T10:00:01.000Z'
      }
    });
    const res = await handleConsent(get('c1d2e3f4-aaaa-bbbb-cccc-000000000001'), env);
    // Egy cache-elt consent-állapot a visszavonást késleltetné — pont azt, aminek
    // azonnal hatnia kell.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
