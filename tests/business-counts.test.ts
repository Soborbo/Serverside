import { describe, it, expect } from 'vitest';
import {
  validateBusinessCounts,
  computeBusinessSourceDrift,
  findSilentBusinessSources,
  storeBusinessCounts,
  fetchBusinessSourceFindings,
  BUSINESS_REPORT_HEARTBEAT,
  DEFAULT_BUSINESS_SOURCE_THRESHOLDS,
  type BusinessCountRow
} from '../src/lib/business-counts';
import { handleBusinessCounts } from '../src/routes/business-counts';
import { CANONICAL_EVENTS } from '../src/types';

const OFFLINE_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_EVENTS.filter((e) => e.kind === 'offline').map((e) => e.name)
);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const GENERATED_AT = new Date().toISOString();
const payload = (counts: Array<{ event_name: string; count: number }> = [], date = YESTERDAY) => ({
  date,
  generated_at: GENERATED_AT,
  counts
});

describe('P1.2 — payload validation', () => {
  const ok = payload([{ event_name: 'lead_qualified', count: 12 }]);

  it('accepts a valid full snapshot', () => {
    expect(validateBusinessCounts(ok, OFFLINE_NAMES).ok).toBe(true);
  });

  it('requires source generated_at ordering metadata', () => {
    const { generated_at: _drop, ...missing } = ok;
    const r = validateBusinessCounts(missing, OFFLINE_NAMES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('generated_at');
  });

  it('rejects non-canonical generated_at timestamps', () => {
    for (const generated_at of ['2026-08-24', '2026-08-24T12:00:00', 'nope']) {
      const r = validateBusinessCounts({ ...ok, generated_at }, OFFLINE_NAMES);
      expect(r.ok, generated_at).toBe(false);
    }
  });

  it('rejects unknown/non-offline event names', () => {
    for (const event_name of ['lead_qualifed', 'phone_number_clicked']) {
      const r = validateBusinessCounts(payload([{ event_name, count: 3 }]), OFFLINE_NAMES);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects future, malformed and nonexistent business dates', () => {
    for (const date of [TOMORROW, '2026-8-1', '2026/08/01', '2025-02-30', '2026-13-01']) {
      expect(validateBusinessCounts({ ...ok, date }, OFFLINE_NAMES).ok, date).toBe(false);
    }
    expect(validateBusinessCounts({ ...ok, date: '2024-02-29' }, OFFLINE_NAMES).ok).toBe(true);
  });

  it('rejects duplicate event names and invalid counts', () => {
    expect(
      validateBusinessCounts(
        payload([
          { event_name: 'lead_qualified', count: 3 },
          { event_name: 'lead_qualified', count: 9 }
        ]),
        OFFLINE_NAMES
      ).ok
    ).toBe(false);
    for (const count of [-1, 1.5, 2_000_000, Number.NaN]) {
      expect(
        validateBusinessCounts(payload([{ event_name: 'lead_qualified', count }]), OFFLINE_NAMES).ok
      ).toBe(false);
    }
  });

  it('count 0 and an empty snapshot are valid', () => {
    expect(
      validateBusinessCounts(payload([{ event_name: 'lead_qualified', count: 0 }]), OFFLINE_NAMES).ok
    ).toBe(true);
    expect(validateBusinessCounts(payload([]), OFFLINE_NAMES).ok).toBe(true);
  });
});

describe('P1.2 — CRM vs gateway drift', () => {
  const crm = (count: number): BusinessCountRow[] => [
    { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count }
  ];

  it('CRM 12 vs gateway 4 is critical', () => {
    const findings = computeBusinessSourceDrift(crm(12), [
      { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 4 }
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].gateway_count).toBe(4);
  });

  it('CRM event with no gateway receipt is critical above min sample', () => {
    const findings = computeBusinessSourceDrift(crm(8), []);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].gateway_count).toBe(0);
  });

  it('gateway >= CRM and sub-threshold noise do not alert', () => {
    expect(
      computeBusinessSourceDrift(crm(5), [
        { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 7 }
      ])
    ).toEqual([]);
    expect(
      computeBusinessSourceDrift(crm(20), [
        { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 19 }
      ])
    ).toEqual([]);
    expect(DEFAULT_BUSINESS_SOURCE_THRESHOLDS.minSample).toBe(3);
    expect(computeBusinessSourceDrift(crm(2), [])).toEqual([]);
  });

  it('event types reconcile independently', () => {
    const findings = computeBusinessSourceDrift(
      [
        { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 10 },
        { site_id: 'painless', date: YESTERDAY, event_name: 'revenue_confirmed', count: 10 }
      ],
      [{ site_id: 'painless', date: YESTERDAY, event_name: 'revenue_confirmed', count: 10 }]
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].event_name).toBe('lead_qualified');
  });

  it('heartbeat proves the CRM cron ran but never counts as a business event', () => {
    const prior: BusinessCountRow[] = [
      { site_id: 'painless', date: '2026-08-20', event_name: 'lead_qualified', count: 5 }
    ];
    const today: BusinessCountRow[] = [
      { site_id: 'painless', date: YESTERDAY, event_name: BUSINESS_REPORT_HEARTBEAT, count: 0 }
    ];
    expect(findSilentBusinessSources(prior, today, YESTERDAY)).toEqual([]);
    expect(computeBusinessSourceDrift(today, [])).toEqual([]);
  });

  it('previously reporting but silent site gets a missing warning', () => {
    const prior: BusinessCountRow[] = [
      { site_id: 'painless', date: '2026-08-20', event_name: BUSINESS_REPORT_HEARTBEAT, count: 0 }
    ];
    const findings = findSilentBusinessSources(prior, [], YESTERDAY);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('business_source_missing');
  });
});

describe('P1.2 — monotonic full snapshot storage', () => {
  function recordingEnv() {
    const prepared: string[] = [];
    let batched: Array<{ sql: string; args: unknown[] }> = [];
    const env: any = {
      LEDGER: {
        prepare: (sql: string) => {
          prepared.push(sql);
          return { bind: (...args: unknown[]) => ({ sql, args }) };
        },
        batch: async (rows: Array<{ sql: string; args: unknown[] }>) => {
          batched = rows;
          return [];
        }
      }
    };
    return { env, prepared, executed: () => batched };
  }

  it('writes source-order metadata before replacing the daily snapshot', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(env, 'painless', payload([{ event_name: 'lead_qualified', count: 4 }], '2026-08-23'));
    expect(executed()[0].sql).toContain('business_count_snapshots');
    expect(executed()[0].sql).toContain('excluded.generated_at >= business_count_snapshots.generated_at');
    expect(executed()[0].args).toContain(GENERATED_AT);
  });

  it('DELETE and INSERTs are gated by the currently accepted generated_at', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(env, 'painless', payload([{ event_name: 'lead_qualified', count: 4 }], '2026-08-23'));
    const clear = executed().find((r) => r.sql.trim().startsWith('DELETE'))!;
    expect(clear.sql).toContain('business_count_snapshots');
    expect(clear.sql).toContain('generated_at = ?4');
    expect(clear.args[3]).toBe(GENERATED_AT);
    const inserts = executed().filter((r) => r.sql.includes('INSERT INTO business_counts'));
    expect(inserts.length).toBe(2); // heartbeat + lead_qualified
    expect(inserts.every((r) => r.sql.includes('generated_at = ?6'))).toBe(true);
  });

  it('empty corrected snapshot still clears prior business rows and writes heartbeat', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(env, 'painless', payload([], '2026-08-23'));
    expect(executed().some((r) => r.sql.trim().startsWith('DELETE'))).toBe(true);
    const countRows = executed().filter((r) => r.sql.includes('INSERT INTO business_counts'));
    expect(countRows).toHaveLength(1);
    expect(countRows[0].args[2]).toBe(BUSINESS_REPORT_HEARTBEAT);
  });

  it('snapshot metadata + clear + rows execute in one D1 batch', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(
      env,
      'painless',
      payload([
        { event_name: 'lead_qualified', count: 4 },
        { event_name: 'revenue_confirmed', count: 1 }
      ], '2026-08-23')
    );
    expect(executed()).toHaveLength(5); // snapshot metadata + delete + heartbeat + 2 rows
  });
});

const SITE = {
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  crm_token_sha256: '',
  meta: { pixel_id: '1', access_token: 'T' },
  gads: { customer_id: null, login_customer_id: null }
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeEnv(over: Record<string, unknown> = {}): any {
  return {
    ADMIN_API_TOKEN: 'global-admin-token',
    SITE_CONFIG: { get: async () => SITE },
    LEDGER: {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => []
    },
    ...over
  };
}

function req(host: string, token: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-Admin-Token'] = token;
  return new Request(`https://${host}/api/event/business-counts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

describe('P1.2 — /api/event/business-counts route', () => {
  const goodBody = payload([{ event_name: 'lead_qualified', count: 4 }]);

  it('accepts the per-site token', async () => {
    const token = 'per-site-token-abcdefghijklmno';
    const site = { ...SITE, crm_token_sha256: await sha256Hex(token) };
    const res = await handleBusinessCounts(
      req('bc1.example.com', token, goodBody),
      makeEnv({ SITE_CONFIG: { get: async () => site } })
    );
    expect(res.status).toBe(200);
  });

  it('rejects missing/wrong tenant tokens', async () => {
    const site = { ...SITE, crm_token_sha256: await sha256Hex('site-a-token-1234567890') };
    expect(
      (await handleBusinessCounts(req('bc2.example.com', undefined, goodBody), makeEnv({ SITE_CONFIG: { get: async () => site } }))).status
    ).toBe(401);
    expect(
      (await handleBusinessCounts(req('bc3.example.com', 'site-b-token-1234567890', goodBody), makeEnv({ SITE_CONFIG: { get: async () => site } }))).status
    ).toBe(401);
  });

  it('unknown hostname is 404 but transient KV failure is 503', async () => {
    expect(
      (await handleBusinessCounts(req('bc4.example.com', 'global-admin-token', goodBody), makeEnv({ SITE_CONFIG: { get: async () => null } }))).status
    ).toBe(404);
    const transient = await handleBusinessCounts(
      req('bcx.example.com', 'global-admin-token', goodBody),
      makeEnv({ SITE_CONFIG: { get: async () => { throw new Error('KV transient'); } } })
    );
    expect(transient.status).toBe(503);
  });

  it('bad payload is 400; missing ledger is 503; D1 failure is 500; never 204', async () => {
    const bad = await handleBusinessCounts(
      req('bc5.example.com', 'global-admin-token', { date: YESTERDAY, generated_at: GENERATED_AT, counts: [{ event_name: 'nope', count: 1 }] }),
      makeEnv()
    );
    expect(bad.status).toBe(400);

    const noLedger = await handleBusinessCounts(
      req('bc6.example.com', 'global-admin-token', goodBody),
      makeEnv({ LEDGER: undefined })
    );
    expect(noLedger.status).toBe(503);

    const d1Fail = await handleBusinessCounts(
      req('bc7.example.com', 'global-admin-token', goodBody),
      makeEnv({ LEDGER: { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error('D1 down'); } } })
    );
    expect(d1Fail.status).toBe(500);
    expect([bad.status, noLedger.status, d1Fail.status]).not.toContain(204);
  });
});

describe('P1.2 — day semantics and monitoring scope', () => {
  function reconEnv(configs: Array<{ key: string; value: unknown }>, rows: {
    today?: BusinessCountRow[];
    lifecycle?: Array<{ site_id: string; date: string; event_name: string; count: number }>;
    prior?: BusinessCountRow[];
  }): any {
    let queryIndex = 0;
    return {
      SITE_CONFIG: {
        list: async () => ({ keys: configs.map((c) => ({ name: c.key })), list_complete: true }),
        get: async (name: string) => configs.find((c) => c.key === name)?.value ?? null
      },
      LEDGER: {
        prepare: (sql: string) => ({
          bind: () => ({
            all: async () => {
              queryIndex++;
              if (sql.includes('FROM lead_status')) return { results: rows.lifecycle ?? [] };
              if (sql.includes('date >= ?1')) return { results: rows.prior ?? [] };
              return { results: rows.today ?? [] };
            }
          })
        })
      },
      _queries: () => queryIndex
    };
  }

  it('groups gateway lifecycle rows by occurred_at, not created_at', async () => {
    const sql: string[] = [];
    const env: any = {
      SITE_CONFIG: { list: async () => ({ keys: [], list_complete: false }) },
      LEDGER: {
        prepare: (q: string) => {
          sql.push(q);
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
      }
    };
    expect(await fetchBusinessSourceFindings(env, '2026-08-23', '2026-08-16')).toEqual([]);
    const leadStatusQuery = sql.find((q) => q.includes('FROM lead_status'))!;
    expect(leadStatusQuery).toContain('substr(occurred_at, 1, 10)');
    expect(leadStatusQuery).not.toContain('created_at');
  });

  it('a fully enumerated monitoring:false site is excluded from business-source findings', async () => {
    const site = { site_id: 'disabled', monitoring: false };
    const env = reconEnv(
      [{ key: 'disabled.example.com', value: site }],
      {
        today: [{ site_id: 'disabled', date: YESTERDAY, event_name: 'lead_qualified', count: 10 }],
        lifecycle: [],
        prior: [{ site_id: 'disabled', date: '2026-08-20', event_name: BUSINESS_REPORT_HEARTBEAT, count: 0 }]
      }
    );
    expect(await fetchBusinessSourceFindings(env, YESTERDAY, '2026-08-16')).toEqual([]);
  });

  it('query failure returns null, not a false clean result', async () => {
    const env: any = {
      SITE_CONFIG: { list: async () => ({ keys: [], list_complete: false }) },
      LEDGER: {
        prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1 down'); } }) })
      }
    };
    expect(await fetchBusinessSourceFindings(env, '2026-08-23', '2026-08-16')).toBeNull();
  });
});
