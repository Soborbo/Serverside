import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import {
  enqueueFailure,
  listPendingRetries,
  maxRetriesFor,
  retryWindowHoursFor,
  MAX_RETRIES,
  MAX_RETRIES_BLOCKED_CONFIG,
  type DeadLetterRecord
} from '../src/lib/deadletter';
import { handleScheduledRetry } from '../src/scheduled/retry';

/**
 * A konfigurációs blokk retry-kerete.
 *
 * A hiányzó config NEM hálózati hiba: magától soha nem javul meg, csak akkor, ha
 * valaki visszaírja a KV-t. A vendor-hibákra szabott keret ([60s, 5p, 30p] × 3,
 * 24 órás ablak) ezért itt kifejezetten káros — a rekord ~35 perc alatt kimerülne
 * és a dead-archívumba esne, jóval azelőtt, hogy bárki reagálna a riasztásra.
 * Vagyis pont abban a forgatókönyvben mondana csődöt, amiért készült (lomtalan
 * Meta, 2026-07-15: a config 5 napig hiányzott).
 */

const base = (over: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({
  platform: 'meta',
  site_id: 'lomtalan',
  hostname: 'lomtalan.hu',
  event_payload: { event_id: 'evt-blocked-1', event_name: 'quote_calculator_submitted' },
  failure_reason: "expected platform 'meta' has no config block for this site",
  retry_count: 0,
  first_failed_at: new Date().toISOString(),
  last_attempted_at: new Date().toISOString(),
  ...over
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('A konfigurációs blokk külön retry-keretet kap', () => {
  it('a keret tágabb, mint a vendor-hibáké', () => {
    expect(maxRetriesFor(base())).toBe(MAX_RETRIES);
    expect(maxRetriesFor(base({ blocked_configuration: true }))).toBe(MAX_RETRIES_BLOCKED_CONFIG);
    expect(MAX_RETRIES_BLOCKED_CONFIG).toBeGreaterThan(MAX_RETRIES);

    expect(retryWindowHoursFor(base())).toBe(24);
    // 7 nap — a Meta CAPI elfogadási ablaka; ezen túl a retry értelmetlen.
    expect(retryWindowHoursFor(base({ blocked_configuration: true }))).toBe(168);
  });

  it('a blokkolt rekord KIKERÜLI a Queue-t és egyenesen R2-be megy', async () => {
    const queueSends: unknown[] = [];
    const r2Puts: string[] = [];
    const env: any = {
      DLQ: { send: async (r: unknown) => queueSends.push(r) },
      DEAD_LETTER: { put: async (_k: string, body: string) => r2Puts.push(body) }
    };

    // Vendor-hiba → Queue (a gyors backoff ott a helyes).
    await enqueueFailure(env, base());
    expect(queueSends).toHaveLength(1);
    expect(r2Puts).toHaveLength(0);

    // Konfigurációs blokk → R2. A Queue saját max_retries-e és 24 órás
    // delaySeconds-plafonja néhány kézbesítés után eldobná az üzenetet, a
    // config-hiány viszont napokig állhat; az R2-rekordot az óránkénti cron
    // nézi, a lejáratot a mi 7 napos ablakunk szabja.
    await enqueueFailure(env, base({ blocked_configuration: true }));
    expect(queueSends).toHaveLength(1);
    expect(r2Puts).toHaveLength(1);
    expect(JSON.parse(r2Puts[0]).blocked_configuration).toBe(true);
  });

  it('a 24 órát meghaladó blokkolt rekord MÉG NEM jár le (a vendor-hibás igen)', async () => {
    const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const records = [
      base({ first_failed_at: thirtyHoursAgo }),
      base({ first_failed_at: thirtyHoursAgo, blocked_configuration: true })
    ];
    const env: any = {
      DEAD_LETTER: {
        list: async () => ({
          objects: records.map((_, i) => ({ key: `lomtalan/meta/2026-07-15/r${i}.json` })),
          truncated: false
        }),
        get: async (key: string) => {
          const idx = Number(key.match(/r(\d+)\.json$/)![1]);
          return { json: async () => records[idx] };
        }
      }
    };

    const scan = await listPendingRetries(env);
    // A vendor-hibás rekord lejárt, a konfigurációs blokk még próbálkozik.
    expect(scan.expired).toHaveLength(1);
    expect(scan.expired[0].record.blocked_configuration).toBeUndefined();
    expect(scan.pending).toHaveLength(1);
    expect(scan.pending[0].record.blocked_configuration).toBe(true);
  });

  it('a még mindig hiányzó config skipje NEM fogyasztja a retry_countot', async () => {
    // A site-config továbbra sem tartalmaz meta blokkot → retrySingle skippel.
    const stored: DeadLetterRecord[] = [];
    const record = base({
      blocked_configuration: true,
      retry_count: 2,
      // Konkrét régi időbélyeg — így a frissítés ténye nem attól függ, hogy a
      // teszt átlép-e egy ezredmásodperc-határt.
      last_attempted_at: '2026-07-19T00:00:00.000Z'
    });
    const env: any = {
      SITE_CONFIG: { get: async () => ({ site_id: 'lomtalan', country_code: 'HU' }) },
      DEAD_LETTER: {
        list: async () => ({
          objects: [{ key: 'lomtalan/meta/2026-07-15/r0.json' }],
          truncated: false
        }),
        get: async () => ({ json: async () => record }),
        put: async (_k: string, body: string) => stored.push(JSON.parse(body)),
        delete: async () => {}
      }
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await handleScheduledRetry({ scheduledTime: Date.now(), cron: '0 * * * *' } as unknown as ScheduledEvent, env);

    // Hívás nem történt → nem volt kísérlet → a számláló áll. Enélkül az
    // óránkénti cron ~egy nap alatt kiégetné a 28-as keretet.
    expect(stored).toHaveLength(1);
    expect(stored[0].retry_count).toBe(2);
    expect(stored[0].blocked_configuration).toBe(true);
    // A last_attempted_at viszont frissül — a rekord kora követhető marad.
    expect(stored[0].last_attempted_at).not.toBe(record.last_attempted_at);
  });

  it('valódi vendor-hiba UTÁN a retry_count normálisan nő', async () => {
    const stored: DeadLetterRecord[] = [];
    const record = base({ blocked_configuration: true, retry_count: 2 });
    const env: any = {
      // Most VAN meta config → valódi hívás indul, és az 500-assal elbukik.
      SITE_CONFIG: {
        get: async () => ({
          site_id: 'lomtalan',
          country_code: 'HU',
          meta: { pixel_id: '1', access_token: 'T' }
        })
      },
      DEAD_LETTER: {
        list: async () => ({
          objects: [{ key: 'lomtalan/meta/2026-07-15/r0.json' }],
          truncated: false
        }),
        get: async () => ({ json: async () => record }),
        put: async (_k: string, body: string) => stored.push(JSON.parse(body)),
        delete: async () => {}
      }
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }))
    );

    await handleScheduledRetry({ scheduledTime: Date.now(), cron: '0 * * * *' } as unknown as ScheduledEvent, env);

    expect(stored).toHaveLength(1);
    expect(stored[0].retry_count).toBe(3);
  });
});
