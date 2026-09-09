import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

/**
 * P10 — a bevétel-szemantika üzleti döntéseinek gateway-oldali fele.
 * (A döntések: `docs/REVENUE-SEMANTICS.md` §5, a user, 2026-09-09.)
 *
 * A LEGFONTOSABB, AMIT EZ A FÁJL ŐRIZ. A `lead-status.ts` az `orderId`-t a
 * `sha256(lead_id + '_' + status)`-ból képezi. Ez az EGYSZERI státuszokra
 * helyes — a retry ugyanazt küldi, a Google dedupál —, de abban a pillanatban,
 * ahogy a §5.2 döntés szerint minden RÉSZFIZETÉS külön jelet küld, végzetessé
 * válik: két fizetés ugyanazt az `orderId`-t kapná, a Google a másodikat
 * ugyanannak a konverziónak látná, és a pénz NÉMÁN elveszne. Semmilyen hibakód,
 * semmilyen ledger-sor nem jelezné — a riport csak kevesebb bevételt mutatna.
 */

const capturedPayloads: Record<string, unknown>[] = [];

vi.mock('../src/lib/datamanager', () => ({
  sendToDataManager: async (_site: unknown, _env: unknown, payload: Record<string, unknown>) => {
    capturedPayloads.push(payload);
    return { success: true, skipped: false };
  }
}));

import { handleLeadStatus, resolveConversionTimeIso, OFFLINE_WINDOW_DAYS, validateLeadStatusBody } from '../src/routes/lead-status';
import { REPEATABLE_LEAD_STATUSES, ADJUSTMENT_LEAD_STATUSES, VALID_LEAD_STATUSES } from '../src/lib/ledger';
import { TrackingErrorCode } from '../src/lib/error-codes';
import { sha256Hex } from '../src/lib/hash';

const HOST = 'painlessremovals.com';
const SITE_TOKEN = 'p10-site-token';
const LEAD = 'lead-p10-1';

let siteConfigCache: Record<string, unknown>;
let logs: Record<string, unknown>[] = [];

function makeEnv(): any {
  return {
    ADMIN_API_TOKEN: 'global-token',
    SITE_CONFIG: { get: async () => structuredClone(siteConfigCache) },
    OAUTH_TOKENS: { get: async () => null, put: async () => undefined },
    LEDGER: {
      prepare: () => ({
        bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) })
      })
    },
    DEAD_LETTER: { put: async () => undefined }
  };
}

function ctx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

function request(body: Record<string, unknown>): Request {
  return new Request(`https://${HOST}/api/event/lead-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': SITE_TOKEN },
    body: JSON.stringify({ lead_id: LEAD, ...body })
  });
}

beforeEach(async () => {
  logs = [];
  capturedPayloads.length = 0;
  siteConfigCache = {
    site_id: 'painless',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: '1', access_token: 'T' },
    gads: {
      customer_id: '1234567890',
      login_customer_id: null,
      // A két PÉNZ-akció KÜLÖN — pontosan ez a §5.1 döntés.
      conversion_actions: { revenue_confirmed: '7665215416', payment_received: '9990001111' }
    },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
  const capture = (line: string) => {
    try { logs.push(JSON.parse(line)); } catch { /* nem strukturált sor */ }
  };
  vi.spyOn(console, 'log').mockImplementation(capture as never);
  vi.spyOn(console, 'warn').mockImplementation(capture as never);
  vi.spyOn(console, 'error').mockImplementation(capture as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── §5.2 · minden részfizetés KÜLÖN konverzió ────────────────────────────────

describe('§5.2 — a részfizetés saját jelet küld, és nem olvad össze', () => {
  it('`payment_received` occurrence_id NÉLKÜL → hangos 400, nem csendes összevonás', async () => {
    const res = await handleLeadStatus(request({ status: 'payment_received', value: 500 }), makeEnv(), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; error_code?: string };
    expect(body.error).toBe('occurrence_id_required');
    expect(body.error_code).toBe(TrackingErrorCode.LEAD_STATUS_OCCURRENCE_ID_REQUIRED);
    // És NEM ment fel semmi: a hiányzó azonosító nem termelhet konverziót.
    expect(capturedPayloads).toHaveLength(0);
  });

  it('KÉT különböző részfizetés KÉT különböző orderId-t kap', async () => {
    await handleLeadStatus(request({ status: 'payment_received', value: 500, occurrence_id: 'pay-1' }), makeEnv(), ctx());
    await handleLeadStatus(request({ status: 'payment_received', value: 700, occurrence_id: 'pay-2' }), makeEnv(), ctx());
    expect(capturedPayloads).toHaveLength(2);
    const [a, b] = capturedPayloads;
    expect(a.event_id).not.toBe(b.event_id);
    // Az érték is a SAJÁTJA — nem a teljes várt összeg (a §5.2 döntés).
    expect(a.value).toBe(500);
    expect(b.value).toBe(700);
  });

  it('UGYANAZ a részfizetés kétszer (retry) UGYANAZT az orderId-t kapja — az idempotencia megmarad', async () => {
    await handleLeadStatus(request({ status: 'payment_received', value: 500, occurrence_id: 'pay-1' }), makeEnv(), ctx());
    await handleLeadStatus(request({ status: 'payment_received', value: 500, occurrence_id: 'pay-1' }), makeEnv(), ctx());
    expect(capturedPayloads).toHaveLength(2);
    expect(capturedPayloads[0].event_id).toBe(capturedPayloads[1].event_id);
  });

  it('az EGYSZERI státuszok orderId-képlete VÁLTOZATLAN', async () => {
    // Ha ez elmozdulna, MINDEN korábban feltöltött konverzió orderId-je
    // megváltozna, és a Google újaknak látná őket — tömeges dupla könyvelés.
    await handleLeadStatus(request({ status: 'revenue_confirmed', value: 1200 }), makeEnv(), ctx());
    const expected = (await sha256Hex(`${LEAD}_revenue_confirmed`)).slice(0, 32);
    expect(capturedPayloads[0].event_id).toBe(expected);
  });

  it('az ismételhető státuszok listája nem üres, és minden eleme érvényes státusz', () => {
    expect(REPEATABLE_LEAD_STATUSES.size).toBeGreaterThan(0);
    for (const s of REPEATABLE_LEAD_STATUSES) expect(VALID_LEAD_STATUSES).toContain(s);
  });
});

// ── §5.4 · melyik időpont legyen a konverzió ideje ───────────────────────────

describe('§5.4 — ablakon belül a fizetés ideje, azon túl a won_at', () => {
  const won = '2026-01-01T00:00:00.000Z';
  const dayMs = 86_400_000;
  const plus = (days: number) => new Date(Date.parse(won) + days * dayMs).toISOString();

  it('won_at nélkül a fizetés ideje marad', () => {
    expect(resolveConversionTimeIso(plus(400))).toBe(plus(400));
  });

  it('az ablakon BELÜL a fizetés ideje marad', () => {
    expect(resolveConversionTimeIso(plus(OFFLINE_WINDOW_DAYS - 1), won)).toBe(plus(OFFLINE_WINDOW_DAYS - 1));
  });

  it('pontosan az ablak határán MÉG a fizetés ideje marad', () => {
    expect(resolveConversionTimeIso(plus(OFFLINE_WINDOW_DAYS), won)).toBe(plus(OFFLINE_WINDOW_DAYS));
  });

  it('az ablakon TÚL a won_at lesz a konverzió ideje', () => {
    expect(resolveConversionTimeIso(plus(OFFLINE_WINDOW_DAYS + 1), won)).toBe(won);
  });

  it('értelmezhetetlen dátumra a fizetés ideje marad (nem dobunk el konverziót)', () => {
    expect(resolveConversionTimeIso(plus(400), 'nem-datum')).toBe(plus(400));
  });

  it('a szabály a HANDLER-en át is érvényes: a kifutott fizetés a won_at-tal megy fel', async () => {
    await handleLeadStatus(
      request({ status: 'payment_received', value: 900, occurrence_id: 'pay-late', occurred_at: plus(200), won_at: won }),
      makeEnv(),
      ctx()
    );
    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].event_time).toBe(Math.floor(Date.parse(won) / 1000));
  });

  it('a won_at érvénytelen alakja 400 — nem némán eldobva', () => {
    expect(validateLeadStatusBody({ lead_id: LEAD, status: 'payment_received', won_at: 'tegnap' })).toBeNull();
  });
});

// ── §5.3 · a helyesbítés MA nem kézbesíthető, és ezt ki kell mondani ─────────

describe('§5.3 — a retract/restate hangosan elutasított, NEM pozitív konverzió', () => {
  for (const status of ['revenue_retracted', 'revenue_restated']) {
    it(`\`${status}\` → 501 + nevesített kód, és semmi nem megy fel`, async () => {
      const res = await handleLeadStatus(request({ status, value: 1200 }), makeEnv(), ctx());
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error?: string; error_code?: string; retryable?: boolean };
      expect(body.error).toBe('adjustment_not_supported');
      expect(body.error_code).toBe(TrackingErrorCode.LEAD_STATUS_ADJUSTMENT_UNSUPPORTED);
      expect(body.retryable).toBe(false);
      // EZ a lényeg: a normál upload-úton egy POZITÍV konverzió menne fel egy
      // visszavonásra — a hibát a kétszeresére növelve.
      expect(capturedPayloads).toHaveLength(0);
    });
  }

  it('strukturált WARN log kíséri — a CRM-nek és nekünk is nyoma marad', async () => {
    await handleLeadStatus(request({ status: 'revenue_retracted' }), makeEnv(), ctx());
    const hit = logs.find((l) => l.error_code === TrackingErrorCode.LEAD_STATUS_ADJUSTMENT_UNSUPPORTED);
    expect(hit, 'nincs strukturált log a helyesbítés elutasításáról').toBeTruthy();
    expect(hit!.level).toBe('warn');
  });

  it('a helyesbítő státuszok ÉRVÉNYES státuszok — a CRM nem „ismeretlen státusz" 400-at kap', () => {
    for (const s of ADJUSTMENT_LEAD_STATUSES) expect(VALID_LEAD_STATUSES).toContain(s);
  });
});

// ── §5.1 · két külön konverzió-akció, dupla számolás nélkül ──────────────────

describe('§5.1 — a megnyert ajánlat és a befolyt pénz KÉT külön akció', () => {
  it('ha a config UGYANARRA az akcióra képezi a kettőt → 500 + kritikus kód', async () => {
    (siteConfigCache.gads as any).conversion_actions = {
      revenue_confirmed: '7665215416',
      payment_received: '7665215416'
    };
    const res = await handleLeadStatus(
      request({ status: 'payment_received', value: 500, occurrence_id: 'pay-1' }),
      makeEnv(),
      ctx()
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; error_code?: string };
    expect(body.error).toBe('double_count_config');
    expect(body.error_code).toBe(TrackingErrorCode.LEAD_STATUS_DOUBLE_COUNT_CONFIG);
    expect(capturedPayloads).toHaveLength(0);
  });

  it('az őr a MÁSIK státuszra is véd (nem csak arra, amelyik épp jött)', async () => {
    (siteConfigCache.gads as any).conversion_actions = {
      revenue_confirmed: '7665215416',
      payment_received: '7665215416'
    };
    const res = await handleLeadStatus(request({ status: 'revenue_confirmed', value: 1200 }), makeEnv(), ctx());
    expect(res.status).toBe(500);
  });

  it('KÜLÖN akciókkal a dispatch normálisan lefut', async () => {
    const res = await handleLeadStatus(
      request({ status: 'payment_received', value: 500, occurrence_id: 'pay-1' }),
      makeEnv(),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].event_name).toBe('payment_received');
  });
});
