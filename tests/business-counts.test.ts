import { describe, it, expect } from 'vitest';
import {
  validateBusinessCounts,
  computeBusinessSourceDrift,
  findSilentBusinessSources,
  DEFAULT_BUSINESS_SOURCE_THRESHOLDS,
  type BusinessCountRow
} from '../src/lib/business-counts';
import { handleBusinessCounts } from '../src/routes/business-counts';
import { CANONICAL_EVENTS } from '../src/types';

/**
 * vNext P1.2 — CRM business-source reconciliation (gateway-fél).
 *
 * A MEGFOGANDÓ HIBAMÓD, amit a P1.1 SZERKEZETILEG nem lát: ha a CRM→gateway hívás
 * EL SEM INDUL, a ledgerben `received = 0`, és nulla elvárás mellett a nulla
 * kézbesítés tökéletesen egészségesnek látszik. A hiányzó hívásról definíció szerint
 * nincs nyoma a ledgerben — ezért kell egy KÜLSŐ, CRM-oldali darabszám.
 */

const OFFLINE_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_EVENTS.filter((e) => e.kind === 'offline').map((e) => e.name)
);

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('P1.2 — payload-validáció (szerver-szerver: KONKRÉT 400, nem néma elnyelés)', () => {
  const ok = { date: YESTERDAY, counts: [{ event_name: 'lead_qualified', count: 12 }] };

  it('érvényes payload átmegy', () => {
    const r = validateBusinessCounts(ok, OFFLINE_NAMES);
    expect(r.ok).toBe(true);
  });

  it('ismeretlen event_name → 400 a névvel (elgépelés nem hozhat létre néma sort)', () => {
    const r = validateBusinessCounts(
      { date: YESTERDAY, counts: [{ event_name: 'lead_qualifed', count: 3 }] },
      OFFLINE_NAMES
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('lead_qualifed');
  });

  it('NEM-offline (böngésző) event-név sem fogadható el', () => {
    // A P1.2 a CRM-lifecycle darabszámairól szól; egy böngésző-event ide keveredve
    // olyan sort hozna létre, amihez a recon soha nem talál párt a lead_status-ban.
    const r = validateBusinessCounts(
      { date: YESTERDAY, counts: [{ event_name: 'phone_number_clicked', count: 3 }] },
      OFFLINE_NAMES
    );
    expect(r.ok).toBe(false);
  });

  it('jövőbeli dátum → 400 (időzóna-hiba a hívónál, nem néma üres nap)', () => {
    const r = validateBusinessCounts({ ...ok, date: TOMORROW }, OFFLINE_NAMES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('future');
  });

  it('rossz dátumformátum → 400', () => {
    for (const date of ['2026-8-1', '2026/08/01', '2026-08-01T00:00:00Z', '']) {
      expect(validateBusinessCounts({ ...ok, date }, OFFLINE_NAMES).ok).toBe(false);
    }
  });

  it('duplikált event_name → 400 (különben az utolsó csendben felülírná az elsőt)', () => {
    const r = validateBusinessCounts(
      {
        date: YESTERDAY,
        counts: [
          { event_name: 'lead_qualified', count: 3 },
          { event_name: 'lead_qualified', count: 9 }
        ]
      },
      OFFLINE_NAMES
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicate');
  });

  it('negatív / tört / abszurd count → 400', () => {
    for (const count of [-1, 1.5, 2_000_000, Number.NaN]) {
      const r = validateBusinessCounts(
        { date: YESTERDAY, counts: [{ event_name: 'lead_qualified', count }] },
        OFFLINE_NAMES
      );
      expect(r.ok, `count=${count}`).toBe(false);
    }
  });

  it('count: 0 ÉRVÉNYES — a „ma nulla lead" valós, mérendő információ', () => {
    const r = validateBusinessCounts(
      { date: YESTERDAY, counts: [{ event_name: 'lead_qualified', count: 0 }] },
      OFFLINE_NAMES
    );
    expect(r.ok).toBe(true);
  });
});

describe('P1.2 — a gateway-ledger vakfoltja: a CRM > gateway eltérés', () => {
  const crm = (count: number): BusinessCountRow[] => [
    { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count }
  ];

  it('a CRM 12-t jelentett, a gateway 4-et kapott → CRITICAL', () => {
    const findings = computeBusinessSourceDrift(crm(12), [
      { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 4 }
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('business_source_drift');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].crm_count).toBe(12);
    expect(findings[0].gateway_count).toBe(4);
  });

  it('a CRM jelentett, a gateway SEMMIT nem kapott → CRITICAL (a P1.1 itt vak)', () => {
    // Ez az a helyzet, amit a P1.1 szerkezetileg nem lát: nulla beérkezés = nulla
    // elvárás = nulla kézbesítés = „egészséges".
    const findings = computeBusinessSourceDrift(crm(8), []);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].gateway_count).toBe(0);
  });

  it('gateway >= CRM → NINCS finding (a fordított irány nem hiba)', () => {
    // A gateway kaphat lifecycle-státuszt más forrásból is (manuális replay, másik
    // backend), és a UTC-nap határa legális ±1 eltérést ad.
    const findings = computeBusinessSourceDrift(crm(5), [
      { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 7 }
    ]);
    expect(findings).toEqual([]);
  });

  it('küszöb alatti eltérés → csend (nap-határ zaj)', () => {
    const findings = computeBusinessSourceDrift(crm(20), [
      { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 19 }
    ]);
    expect(findings).toEqual([]);
  });

  it('apró minta → csend (1 hiány 1-ből = 100%, de értelmetlen)', () => {
    expect(DEFAULT_BUSINESS_SOURCE_THRESHOLDS.minSample).toBe(3);
    expect(computeBusinessSourceDrift(crm(2), [])).toEqual([]);
  });

  it('event-típusonként külön (a lead_qualified vesztesége nem tűnik el a revenue mögött)', () => {
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
});

describe('P1.2 — elhallgatott CRM-cron (business_source_missing)', () => {
  const prior: BusinessCountRow[] = [
    { site_id: 'painless', date: '2026-08-20', event_name: 'lead_qualified', count: 5 },
    { site_id: 'beautyflow', date: '2026-08-20', event_name: 'lead_qualified', count: 2 }
  ];

  it('korábban jelentett, ma NEM → WARNING', () => {
    const findings = findSilentBusinessSources(
      prior,
      [{ site_id: 'beautyflow', date: YESTERDAY, event_name: 'lead_qualified', count: 3 }],
      YESTERDAY
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].site_id).toBe('painless');
    expect(findings[0].kind).toBe('business_source_missing');
  });

  it('sosem jelentett site NEM riaszt (nincs bekötve, nem elhallgatott)', () => {
    // A megfigyelt előzményhez mérünk, nem konfigurált listához — különben minden
    // nem-CRM-es site minden nap riasztana.
    const findings = findSilentBusinessSources([], [], YESTERDAY);
    expect(findings).toEqual([]);
  });

  it('mindenki jelentett → csend', () => {
    const findings = findSilentBusinessSources(
      prior,
      [
        { site_id: 'painless', date: YESTERDAY, event_name: 'lead_qualified', count: 5 },
        { site_id: 'beautyflow', date: YESTERDAY, event_name: 'lead_qualified', count: 2 }
      ],
      YESTERDAY
    );
    expect(findings).toEqual([]);
  });
});

// ── Route-szint ──────────────────────────────────────────────────────────────

const SITE = {
  site_id: 'painless',
  country_code: 'GB',
  currency: 'GBP',
  // sha256('per-site-token-abc') — a per-site auth ehhez hasonlít
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
  const goodBody = { date: YESTERDAY, counts: [{ event_name: 'lead_qualified', count: 4 }] };

  it('PER-SITE tokennel 200 (nem a globális admin tokent kéri)', async () => {
    const token = 'per-site-token-abcdefghijklmno';
    const site = { ...SITE, crm_token_sha256: await sha256Hex(token) };
    const res = await handleBusinessCounts(
      req('bc1.example.com', token, goodBody),
      makeEnv({ SITE_CONFIG: { get: async () => site } })
    );
    expect(res.status).toBe(200);
  });

  it('token nélkül 401', async () => {
    const site = { ...SITE, crm_token_sha256: await sha256Hex('x'.repeat(20)) };
    const res = await handleBusinessCounts(
      req('bc2.example.com', undefined, goodBody),
      makeEnv({ SITE_CONFIG: { get: async () => site } })
    );
    expect(res.status).toBe(401);
  });

  it('MÁSIK site tokenjével 401 (tenant-izoláció)', async () => {
    const site = { ...SITE, crm_token_sha256: await sha256Hex('site-a-token-1234567890') };
    const res = await handleBusinessCounts(
      req('bc3.example.com', 'site-b-token-1234567890', goodBody),
      makeEnv({ SITE_CONFIG: { get: async () => site } })
    );
    expect(res.status).toBe(401);
  });

  it('ismeretlen hostname → 404, NINCS fallback config (CLAUDE.md 14)', async () => {
    const res = await handleBusinessCounts(
      req('bc4.example.com', 'global-admin-token', goodBody),
      makeEnv({ SITE_CONFIG: { get: async () => null } })
    );
    expect(res.status).toBe(404);
  });

  it('rossz payload → 400 KONKRÉT indoklással (a hívó tudjon javítani)', async () => {
    const res = await handleBusinessCounts(
      req('bc5.example.com', 'global-admin-token', { date: YESTERDAY, counts: [{ event_name: 'nope', count: 1 }] }),
      makeEnv()
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(await res.text());
    expect(body.detail).toContain('nope');
  });

  it('nincs LEDGER → 503, NEM 200 (a „nyugtázom, de eldobom" a néma adatvesztés)', async () => {
    const res = await handleBusinessCounts(
      req('bc6.example.com', 'global-admin-token', goodBody),
      makeEnv({ LEDGER: undefined })
    );
    expect(res.status).toBe(503);
  });

  it('D1-írás hibája → 500, hogy a CRM retry-olhasson (CLAUDE.md 12)', async () => {
    const res = await handleBusinessCounts(
      req('bc7.example.com', 'global-admin-token', goodBody),
      makeEnv({
        LEDGER: {
          prepare: () => ({ bind: () => ({}) }),
          batch: async () => {
            throw new Error('D1 down');
          }
        }
      })
    );
    expect(res.status).toBe(500);
  });

  it('a válasz SOHA nem 204 — a szerver-szerver hívónak státusz kell', async () => {
    for (const env of [makeEnv(), makeEnv({ LEDGER: undefined })]) {
      const res = await handleBusinessCounts(req('bc8.example.com', 'global-admin-token', goodBody), env);
      expect(res.status).not.toBe(204);
    }
  });
});
