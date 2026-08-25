import { describe, it, expect } from 'vitest';
import {
  validateBusinessCounts,
  computeBusinessSourceDrift,
  findSilentBusinessSources,
  storeBusinessCounts,
  BUSINESS_REPORT_HEARTBEAT,
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

/**
 * 2026-08-24 Codex-review — négy valós találat javítása.
 * Mindegyik ugyanabba a hibaosztályba tartozik: a monitor tisztának LÁTSZIK, miközben
 * vagy hamisan riaszt, vagy el sem indult.
 */
describe('Codex #4 — nem létező naptári nap elutasítása', () => {
  it('a regexet átúszó, de NEM LÉTEZŐ dátum → 400', () => {
    // Ezek mind illeszkednek a YYYY-MM-DD alakra és a múltban vannak, tehát a korábbi
    // ellenőrzéseken átmentek volna — és egy olyan nap alá íródtak volna, amit a napi
    // recon soha nem kérdez le (a monitor arra a payloadra csendben megszűnik).
    for (const date of ['2025-02-30', '2026-00-15', '2026-13-01', '2025-04-31']) {
      const r = validateBusinessCounts(
        { date, counts: [{ event_name: 'lead_qualified', count: 3 }] },
        OFFLINE_NAMES
      );
      expect(r.ok, `date=${date}`).toBe(false);
      if (!r.ok) expect(r.error).toContain('calendar');
    }
  });

  it('valódi szökőnap ÁTMEGY (nem túl szigorú)', () => {
    const r = validateBusinessCounts(
      { date: '2024-02-29', counts: [{ event_name: 'lead_qualified', count: 3 }] },
      OFFLINE_NAMES
    );
    expect(r.ok).toBe(true);
  });
});

describe('Codex #3 — az eseménytelen nap NEM „elhallgatott CRM"', () => {
  // A #71 hotfix óta a DELETE is bindol (teljes snapshot-csere), ezért az INSERT-eket
  // a statement TÍPUSA szerint kell kiválogatni — a puszta bind-számolás félrevezetne.
  function insertRecordingEnv() {
    const inserts: unknown[][] = [];
    const env: any = {
      LEDGER: {
        prepare: (q: string) => ({
          bind: (...args: unknown[]) => {
            if (!q.trim().startsWith('DELETE')) inserts.push(args);
            return {};
          }
        }),
        batch: async () => []
      }
    };
    return { env, inserts };
  }

  it('minden sikeres beküldés ír JELZŐSORT, üres counts esetén is', async () => {
    const { env, inserts } = insertRecordingEnv();
    // A CRM dokumentált GROUP BY lekérdezése egy nulla-lifecycle-es napon ÜRES tömböt ad.
    const ok = await storeBusinessCounts(env, 'painless', { date: '2026-08-23', counts: [] });
    expect(ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][2]).toBe(BUSINESS_REPORT_HEARTBEAT);
    expect(inserts[0][3]).toBe(0);
  });

  it('a jelzősor NEM-üres beküldésnél is megy (egységes „jelentkezett-e ma" kérdés)', async () => {
    const { env, inserts } = insertRecordingEnv();
    await storeBusinessCounts(env, 'painless', {
      date: '2026-08-23',
      counts: [{ event_name: 'lead_qualified', count: 4 }]
    });
    expect(inserts.map((w) => w[2])).toEqual([BUSINESS_REPORT_HEARTBEAT, 'lead_qualified']);
  });

  it('a jelzősor miatt az eseménytelen nap NEM ad business_source_missing-et', () => {
    const prior: BusinessCountRow[] = [
      { site_id: 'painless', date: '2026-08-20', event_name: 'lead_qualified', count: 5 }
    ];
    // Ma csak a jelzősor van (nulla lifecycle-esemény) — a cron LEFUTOTT.
    const today: BusinessCountRow[] = [
      { site_id: 'painless', date: YESTERDAY, event_name: BUSINESS_REPORT_HEARTBEAT, count: 0 }
    ];
    expect(findSilentBusinessSources(prior, today, YESTERDAY)).toEqual([]);
  });

  it('a jelzősor SOHA nem termel driftet (életjel, nem darabszám)', () => {
    const findings = computeBusinessSourceDrift(
      [{ site_id: 'painless', date: YESTERDAY, event_name: BUSINESS_REPORT_HEARTBEAT, count: 0 }],
      []
    );
    expect(findings).toEqual([]);
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

  it('üres counts is 200, ÉS ír (a jelzősor miatt) — az eseménytelen nap valós információ', async () => {
    const res = await handleBusinessCounts(
      req('bc9.example.com', 'global-admin-token', { date: YESTERDAY, counts: [] }),
      makeEnv()
    );
    expect(res.status).toBe(200);
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

describe('Codex #1 — a napot az occurred_at dönti el, nem a created_at', () => {
  it('a lead_status lekérdezés az occurred_at-re csoportosít és szűr', async () => {
    // MIÉRT EZ A TESZT: a nap-hozzárendelés oszlopa MAGA a kontraktus. A CRM
    // aggregátuma az esemény idejére csoportosít; ha a gateway a felvétel idejére
    // (created_at) tenné, akkor egy UTC-éjfélen átnyúló outbox-retry az eredeti napot
    // hiányosnak, a következőt figyelmen kívül hagyott többletnek mutatná — és a 3-as
    // minimum mellett már EGY késve érkezett kérés hamis CRITICAL-t adna.
    const sql: string[] = [];
    const env: any = {
      LEDGER: {
        prepare: (q: string) => {
          sql.push(q);
          return { bind: () => ({ all: async () => ({ results: [] }) }), all: async () => ({ results: [] }) };
        }
      }
    };
    const r = await (await import('../src/lib/business-counts')).fetchBusinessSourceFindings(
      env,
      '2026-08-23',
      '2026-08-16'
    );
    expect(r).toEqual([]);

    const leadStatusQuery = sql.find((q) => q.includes('FROM lead_status'))!;
    expect(leadStatusQuery).toBeDefined();
    expect(leadStatusQuery).toContain('substr(occurred_at, 1, 10)');
    // A created_at NEM szerepelhet a nap-hozzárendelésben ezen a lábon.
    expect(leadStatusQuery).not.toContain('created_at');
  });
});

describe('Codex #2 — a lekérdezés bukása NEM „nincs eltérés"', () => {
  it('fetchBusinessSourceFindings null-t ad D1-hibára (nem üres tömböt)', async () => {
    const env: any = {
      LEDGER: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error('no such table: business_counts');
            }
          }),
          all: async () => {
            throw new Error('no such table: business_counts');
          }
        })
      }
    };
    const r = await (await import('../src/lib/business-counts')).fetchBusinessSourceFindings(
      env,
      '2026-08-23',
      '2026-08-16'
    );
    // Ez a KÜLÖNBSÉG a lényeg: `null` ≠ `[]`. A hívónak tudnia kell, hogy a láb el sem
    // indult — különben a napi riport `business_source_findings: 0`-t írna, kiesne az
    // email-feltételből, és a monitor tisztának látszana. (A 0007 migráció hiánya
    // élesben PONTOSAN ezt a hibát produkálja.)
    expect(r).toBeNull();
  });

  it('nincs LEDGER → szintén null, nem üres tömb', async () => {
    const r = await (await import('../src/lib/business-counts')).fetchBusinessSourceFindings(
      {} as any,
      '2026-08-23',
      '2026-08-16'
    );
    expect(r).toBeNull();
  });
});

/**
 * 2026-08-24 merge-gate review (#71 hotfix) — HIGH: tranziens KV-hiba ≠ „nincs ilyen site".
 *
 * A route korábban `getSiteConfig()`-ot használt, ami MINDKÉT okra `null`-t ad. Egy
 * másodperces KV-blip így 404-nek látszott. A CRM sender a 404-et a szokásos olvasat
 * szerint PERMANENSNEK veszi → a napi aggregátum és a heartbeat VÉGLEG eltűnik, és
 * ráadásul a hallgatás-detektor is hamisan szólal meg rá.
 */
describe('#71 HIGH — KV-blip 503, nem 404', () => {
  const body = { date: YESTERDAY, counts: [{ event_name: 'lead_qualified', count: 4 }] };

  it('SITE_CONFIG.get dob → 503 (retry-olható), NEM 404', async () => {
    const res = await handleBusinessCounts(
      req('bcx1.example.com', 'global-admin-token', body),
      makeEnv({
        SITE_CONFIG: {
          get: async () => {
            throw new Error('KV transient failure');
          }
        }
      })
    );
    expect(res.status).toBe(503);
    const parsed = JSON.parse(await res.text());
    expect(parsed.error).toBe('config_unavailable');
  });

  it('tényleg nincs ilyen host → továbbra is 404 (permanens)', async () => {
    const res = await handleBusinessCounts(
      req('bcx2.example.com', 'global-admin-token', body),
      makeEnv({ SITE_CONFIG: { get: async () => null } })
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text()).error).toBe('unknown_site');
  });
});

/**
 * 2026-08-24 merge-gate review (#71 hotfix) — MEDIUM: a payload TELJES napi snapshot.
 *
 * A korábbi „csak upsert" modell csak azokra az event-nevekre volt javító hatású,
 * amiket a MÁSODIK payload is tartalmazott. Egy javított, üres snapshot után a régi
 * darabszám bent maradt, és a recon egy olyan üzleti számhoz mérte a gateway-t, amit
 * a CRM már visszavont.
 */
describe('#71 MEDIUM — teljes snapshot-csere, nem részleges upsert', () => {
  /**
   * A statementeket a VÉGREHAJTÁSNÁL nézzük, nem az előkészítésnél: ami `bind()`-olva
   * lett, de nem került a `batch()`-be, az nem fut le. (Az első nekifutásomban a
   * tesztek a bind-okra álltak, és emiatt a DELETE kivétele mellett is zöldek
   * maradtak — a teszt az előkészítést mérte, nem a hatást.)
   */
  function recordingEnv() {
    let batched: Array<{ kind: 'delete' | 'insert'; args: unknown[] }> = [];
    const env: any = {
      LEDGER: {
        prepare: (q: string) => {
          const kind = q.trim().startsWith('DELETE') ? ('delete' as const) : ('insert' as const);
          return { bind: (...args: unknown[]) => ({ kind, args }) };
        },
        batch: async (rows: Array<{ kind: 'delete' | 'insert'; args: unknown[] }>) => {
          batched = rows;
          return [];
        }
      }
    };
    return { env, executed: () => batched };
  }

  it('a nap korábbi ÜZLETI sorait törli, a heartbeatet KIVÉVE', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(env, 'painless', {
      date: '2026-08-23',
      counts: [{ event_name: 'lead_qualified', count: 4 }]
    });
    const del = executed().find((o) => o.kind === 'delete');
    expect(del, 'nincs VÉGREHAJTOTT DELETE — a kimaradó event-név bent maradna').toBeDefined();
    expect(del!.args).toEqual(['painless', '2026-08-23', BUSINESS_REPORT_HEARTBEAT]);
  });

  it('ÜRES javított snapshot is törli a korábbi darabszámokat', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(env, 'painless', { date: '2026-08-23', counts: [] });
    expect(executed().filter((o) => o.kind === 'delete')).toHaveLength(1);
    // …és a jelzősor ilyenkor is kimegy: a nap „jelentkezett, de nulla esemény".
    const inserts = executed().filter((o) => o.kind === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[2]).toBe(BUSINESS_REPORT_HEARTBEAT);
  });

  it('a törlés és a beszúrás EGY batch-ben megy (D1-en tranzakció)', async () => {
    const { env, executed } = recordingEnv();
    await storeBusinessCounts(env, 'painless', {
      date: '2026-08-23',
      counts: [{ event_name: 'lead_qualified', count: 4 }, { event_name: 'revenue_confirmed', count: 1 }]
    });
    // DELETE + heartbeat + 2 üzleti sor — nincs olyan pillanat, amikor a nap üres.
    expect(executed()).toHaveLength(4);
    expect(executed()[0].kind).toBe('delete');
  });
});
