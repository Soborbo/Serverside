import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cloudflare:email runtime-import elkerülése (lásd fanout-isolation.test.ts).
vi.mock('../src/lib/notify', () => ({
  sendAlert: vi.fn(async () => {}),
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  escapeHtml: (s: string) => s
}));

import { handleConversion } from '../src/routes/conversion';
import { sendAlert } from '../src/lib/notify';
import { sha256Hex } from '../src/lib/hash';
import { TrackingErrorCode } from '../src/lib/error-codes';

/**
 * Skip-osztályozás — a lomtalan 2026-07-15 … 07-20-i csendes adatvesztés regressziós őre.
 *
 * A hiba anatómiája: a hiányzó Meta-config `{success:true, skipped:true}`-t adott,
 * amit a fan-out ugyanúgy kezelt, mint egy consent-tiltást — nem készült retry-
 * rekord, a `markDispatched` mégis lefutott. Így 3 valódi lead veszett el úgy,
 * hogy a monitor zöld maradt, a payload pedig SEHOL nem maradt meg (a DLQ-t
 * kihagytuk, az events_raw csak jelenlét-flageket tárol) — ezért ezt a hármat
 * utólag már csak a CRM-ből lehet visszanyerni.
 *
 * A helyes viselkedés három ágra válik (lásd lib/skip-reason.ts):
 *   consent_denied → terminális, nincs DLQ, ledger-sor MARAD (GDPR-audit), dispatched OK
 *   not_expected   → terminális, nincs DLQ, ledger-sor SINCS (F4-2 zajcsökkentés), dispatched OK
 *   not_configured ELVÁRT platformon → ledger-hibakód + DLQ-rekord + CRITICAL,
 *                    és dispatched CSAK sikeres DLQ-perzisztálás után
 *
 * F4-2: a `not_expected` (be nem kötött, nem elvárt scaffold-platform) mostantól NEM
 * ír delivery-sort — enélkül minden esemény 3–4 értelmetlen 'skipped' sort hagyott.
 */

const HOST = 'lomtalan-skip.example.com';
const SITE_TOKEN = 'lomtalan-skip-token';

async function config(opts: {
  withMeta?: boolean;
  expectedSmoke?: string[];
}): Promise<Record<string, unknown>> {
  return {
    site_id: 'lomtalan-skip',
    country_code: 'HU',
    currency: 'HUF',
    require_consent: true,
    ...(opts.withMeta ? { meta: { pixel_id: '123', access_token: 'TOKEN' } } : {}),
    ...(opts.expectedSmoke ? { expected_platforms: { smoke: opts.expectedSmoke } } : {}),
    gads: { customer_id: null, login_customer_id: null },
    crm_token_sha256: await sha256Hex(SITE_TOKEN)
  };
}

interface DeliveryRow {
  platform: string;
  status: string;
  http_status: number | null;
  error_code: string | null;
}

function makeLedger() {
  const deliveries: DeliveryRow[] = [];
  const dispatchedUpdates: string[] = [];
  const ledger = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async first() {
              if (sql.includes('INSERT INTO idempotency')) {
                return {
                  seen_count: 1,
                  dispatched: 0,
                  do_not_replay: 0,
                  first_seen_at: new Date().toISOString()
                };
              }
              return null;
            },
            async run() {
              if (sql.includes('UPDATE idempotency SET dispatched')) {
                dispatchedUpdates.push(sql);
              }
              return {};
            }
          };
        }
      };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      for (const s of stmts) {
        if (s.sql.includes('INSERT INTO deliveries')) {
          deliveries.push({
            platform: String(s.args[5]),
            status: String(s.args[6]),
            http_status: s.args[7] as number | null,
            error_code: (s.args[8] as string | null) ?? null
          });
        }
      }
      return [];
    }
  };
  return { ledger, deliveries, dispatchedUpdates };
}

function makeEnv(opts: {
  siteConfig: unknown;
  ledger: unknown;
  r2PutThrows?: boolean;
  withQueue?: boolean;
  queueSendThrows?: boolean;
}): { env: any; deadRecords: any[]; queueSends: any[] } {
  const deadRecords: any[] = [];
  const queueSends: any[] = [];
  const env: any = {
    SITE_CONFIG: { get: async () => opts.siteConfig },
    LEDGER: opts.ledger,
    DEAD_LETTER: {
      put: async (_key: string, body: string) => {
        if (opts.r2PutThrows) throw new Error('R2 down');
        deadRecords.push(JSON.parse(body));
      }
    }
  };
  if (opts.withQueue) {
    env.DLQ = {
      send: async (rec: unknown) => {
        if (opts.queueSendThrows) throw new Error('Queue down');
        queueSends.push(rec);
      }
    };
  }
  return { env, deadRecords, queueSends };
}

/** `adAllowed` a consent-jelekből dől el (require_consent=true a configban). */
function leadRequest(adAllowed: boolean): Request {
  return new Request(`https://${HOST}/api/event/conversion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': SITE_TOKEN,
      'CF-Connecting-IP': '10.0.0.1'
    },
    body: JSON.stringify({
      event_name: 'quote_calculator_submitted',
      event_id: 'evt-skip-classification',
      event_time: Math.floor(Date.now() / 1000),
      value: 300000,
      currency: 'HUF',
      service: 'lomtalanitas',
      lead_id: 'lead-skip-12345678',
      event_source_url: `https://${HOST}/arajanlat`,
      consent: adAllowed
        ? { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED', ad_storage: 'GRANTED' }
        : { ad_user_data: 'DENIED', ad_personalization: 'DENIED', ad_storage: 'DENIED' },
      user_data: { email: 'x@example.com', phone_number: '+36301234567' }
    })
  });
}

function collectingCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

function installFetch(metaStatus = 200): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.includes('facebook.com')) {
        return new Response(JSON.stringify({ events_received: 1 }), { status: metaStatus });
      }
      return new Response('{}', { status: 200 });
    })
  );
  return calls;
}

const metaRow = (rows: DeliveryRow[]) => rows.find((r) => r.platform === 'meta');
const notConfiguredAlerts = () =>
  vi.mocked(sendAlert).mock.calls.filter(
    (c) => c[1] === TrackingErrorCode.PLATFORM_NOT_CONFIGURED
  );

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(sendAlert).mockClear();
});

describe('Skip-osztályozás — terminális ágak (nincs DLQ, dispatched mehet)', () => {
  it('1. consent-tiltás + hiányzó Meta config → consent-skip, NINCS DLQ, dispatched', async () => {
    installFetch();
    const { ledger, deliveries, dispatchedUpdates } = makeLedger();
    const { env, deadRecords } = makeEnv({
      siteConfig: await config({ withMeta: false, expectedSmoke: ['meta'] }),
      ledger
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(false), env, ctx);
    await Promise.allSettled(tasks);

    // A consent-tiltás ELŐBBRE való: hiába elvárt a Meta és hiányzik a configja,
    // egy GDPR-tiltott eventet SOHA nem teszünk el újrapróbálásra.
    expect(metaRow(deliveries)?.status).toBe('skipped');
    expect(metaRow(deliveries)?.error_code).toBeNull();
    expect(deadRecords).toHaveLength(0);
    expect(notConfiguredAlerts()).toHaveLength(0);
    expect(dispatchedUpdates.length).toBeGreaterThan(0);
  });

  it('2. consent OK + Meta NEM elvárt + nincs config → not-expected skip, NINCS DLQ, NINCS ledger-sor, dispatched', async () => {
    installFetch();
    const { ledger, deliveries, dispatchedUpdates } = makeLedger();
    const { env, deadRecords } = makeEnv({
      // expected_platforms.smoke = ['tiktok'] → a Meta nem elvárt ezen a site-on.
      siteConfig: await config({ withMeta: false, expectedSmoke: ['tiktok'] }),
      ledger
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(true), env, ctx);
    await Promise.allSettled(tasks);

    // F4-2: a Meta not_expected → NEM ír ledger-sort (zajcsökkentés).
    expect(metaRow(deliveries)).toBeUndefined();
    // A Meta nem elvárt → nincs róla retry-rekord. (A TikTok VISZONT elvárt ebben
    // a configban és szintén nincs bekötve, ezért ő jogosan kap egyet — pont ez
    // mutatja, hogy a döntés platformonként, az expected listából születik.)
    expect(deadRecords.filter((r) => r.platform === 'meta')).toHaveLength(0);
    expect(notConfiguredAlerts().filter((c) => (c[2] as any)?.platform === 'meta')).toHaveLength(0);
    // A TikTok elvárt + hiányzó config → not_configured: ledger-sor MARAD + DLQ + alert.
    expect(deliveries.find((d) => d.platform === 'tiktok')?.status).toBe('skipped');
    expect(deliveries.find((d) => d.platform === 'tiktok')?.error_code).toBe(
      TrackingErrorCode.PLATFORM_NOT_CONFIGURED
    );
    expect(deadRecords.filter((r) => r.platform === 'tiktok')).toHaveLength(1);
    // A LinkedIn/MsAds nem elvártak → nincs soruk.
    expect(deliveries.filter((d) => d.platform === 'linkedin' || d.platform === 'msads')).toHaveLength(0);
    expect(dispatchedUpdates.length).toBeGreaterThan(0);
  });

  it('2b. hiányzó expected_platforms blokk → fail-safe: nincs DLQ-áradat, nincs zaj-sor', async () => {
    installFetch();
    const { ledger, deliveries } = makeLedger();
    const { env, deadRecords } = makeEnv({
      siteConfig: await config({ withMeta: false }), // nincs expected_platforms
      ledger
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(true), env, ctx);
    await Promise.allSettled(tasks);

    // Semmi nem elvárt + semmi nincs bekötve → minden láb not_expected → 0 ledger-sor,
    // 0 DLQ (fail-safe: egy sosem-bekötött platform nem hiba, nem gyárt zajt).
    expect(deliveries).toHaveLength(0);
    expect(deadRecords).toHaveLength(0);
  });

  it('F4-2. csak-Meta site (Meta elvárt+konfigurált): a scaffold-lábak NEM írnak zaj-sort', async () => {
    installFetch(200);
    const { ledger, deliveries } = makeLedger();
    const { env } = makeEnv({
      siteConfig: await config({ withMeta: true, expectedSmoke: ['meta'] }),
      ledger
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(true), env, ctx);
    await Promise.allSettled(tasks);

    // KIZÁRÓLAG a Meta ír sort (elvárt + konfigurált + accepted); a tiktok/linkedin/
    // msads not_expected → egyetlen 'skipped' zaj-sor sem. Ez az F4-2 lényege.
    expect(deliveries.map((d) => d.platform)).toEqual(['meta']);
    expect(metaRow(deliveries)?.status).toBe('accepted');
  });
});

describe('Skip-osztályozás — ELVÁRT platform hiányzó configgal (retryable blokk)', () => {
  it('3. consent OK + Meta elvárt + nincs config → skipped+hibakód, EGY DLQ-rekord, dispatched', async () => {
    const calls = installFetch();
    const { ledger, deliveries, dispatchedUpdates } = makeLedger();
    const { env, deadRecords } = makeEnv({
      siteConfig: await config({ withMeta: false, expectedSmoke: ['meta'] }),
      ledger
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(true), env, ctx);
    await Promise.allSettled(tasks);

    // Vendorhívás NEM történt → a ledger-státusz 'skipped' marad (accepted SOHA
    // nem íródhat HTTP-státusz nélkül), de a hibakód elárulja, hogy ez blokk.
    expect(calls.filter((c) => c.includes('facebook.com'))).toHaveLength(0);
    expect(metaRow(deliveries)?.status).toBe('skipped');
    expect(metaRow(deliveries)?.http_status).toBeNull();
    expect(metaRow(deliveries)?.error_code).toBe(TrackingErrorCode.PLATFORM_NOT_CONFIGURED);

    // A payload megőrizve — pontosan ez hiányzott a 3 elveszett lomtalan-leadnél.
    expect(deadRecords).toHaveLength(1);
    expect(deadRecords[0].platform).toBe('meta');
    expect(deadRecords[0].blocked_configuration).toBe(true);
    expect(deadRecords[0].event_payload.event_id).toBe('evt-skip-classification');
    expect(deadRecords[0].hashed_user_data).toBeTruthy();

    expect(notConfiguredAlerts()).toHaveLength(1);
    // A DLQ-írás sikerült → az idempotencia lezárhatja az eventet. A retryt
    // innentől a DLQ birtokolja, nem az ingress.
    expect(dispatchedUpdates.length).toBeGreaterThan(0);
  });

  it('4. ugyanaz, de a DLQ-tárolás meghiúsul → dispatched MARAD 0 + CRITICAL', async () => {
    installFetch();
    const { ledger, dispatchedUpdates } = makeLedger();
    const { env } = makeEnv({
      siteConfig: await config({ withMeta: false, expectedSmoke: ['meta'] }),
      ledger,
      r2PutThrows: true
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(true), env, ctx);
    await Promise.allSettled(tasks);

    // Sem vendor, sem DLQ → az event minden tárból kiesett. Ha itt dispatched=1-et
    // írnánk, még a kézi újraküldést is elnyelné az idempotencia.
    expect(dispatchedUpdates).toHaveLength(0);
    const critical = vi
      .mocked(sendAlert)
      .mock.calls.filter((c) => c[1] === TrackingErrorCode.RETRY_PERSIST_FAILED);
    expect(critical).toHaveLength(1);
  });

  it('6. az ingress megismétlése DLQ-tárolás után → nincs MÁSODIK DLQ-bejegyzés', async () => {
    installFetch();
    const { ledger, deliveries } = makeLedger();
    const { env, deadRecords } = makeEnv({
      siteConfig: await config({ withMeta: false, expectedSmoke: ['meta'] }),
      ledger
    });

    const first = collectingCtx();
    await handleConversion(leadRequest(true), env, first.ctx);
    await Promise.allSettled(first.tasks);
    expect(deadRecords).toHaveLength(1);

    // Második, azonos event_id-s beérkezés — a fake ledger most már dispatched=1-et ad.
    const dispatchedLedger = {
      ...ledger,
      prepare(sql: string) {
        const inner = (ledger as any).prepare(sql);
        return {
          bind(...args: unknown[]) {
            const st = inner.bind(...args);
            return {
              ...st,
              async first() {
                if (sql.includes('INSERT INTO idempotency')) {
                  return {
                    seen_count: 2,
                    dispatched: 1,
                    do_not_replay: 0,
                    first_seen_at: new Date().toISOString()
                  };
                }
                return st.first();
              }
            };
          }
        };
      }
    };
    const second = collectingCtx();
    const res = await handleConversion(
      leadRequest(true),
      { ...env, LEDGER: dispatchedLedger },
      second.ctx
    );
    await Promise.allSettled(second.tasks);

    expect(res.status).toBe(200);
    // A duplikátum nem fan-outol → nem gyárt újabb retry-rekordot. A retryt
    // egyedül a már eltárolt DLQ-példány birtokolja.
    expect(deadRecords).toHaveLength(1);
    expect(deliveries.filter((d) => d.platform === 'meta')).toHaveLength(1);
  });

  it('7. consent-tiltott event SOHA nem kerül retryba, akkor sem ha a Meta elvárt', async () => {
    installFetch();
    const { ledger } = makeLedger();
    const { env, deadRecords, queueSends } = makeEnv({
      siteConfig: await config({ withMeta: false, expectedSmoke: ['meta'] }),
      ledger,
      withQueue: true
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(false), env, ctx);
    await Promise.allSettled(tasks);

    expect(deadRecords).toHaveLength(0);
    expect(queueSends).toHaveLength(0);
  });
});

describe('Skip-osztályozás — a config helyreállítása után', () => {
  it('5. visszaírt Meta configgal az event accepted, eredeti event_id-vel és HTTP-státusszal', async () => {
    const calls = installFetch(200);
    const { ledger, deliveries } = makeLedger();
    const { env, deadRecords } = makeEnv({
      siteConfig: await config({ withMeta: true, expectedSmoke: ['meta'] }),
      ledger
    });
    const { ctx, tasks } = collectingCtx();

    await handleConversion(leadRequest(true), env, ctx);
    await Promise.allSettled(tasks);

    expect(calls.filter((c) => c.includes('facebook.com'))).toHaveLength(1);
    expect(metaRow(deliveries)?.status).toBe('accepted');
    expect(metaRow(deliveries)?.http_status).toBe(200);
    expect(metaRow(deliveries)?.error_code).toBeNull();
    // Élő config mellett nincs blokk → nincs retry-rekord és nincs riasztás.
    expect(deadRecords).toHaveLength(0);
    expect(notConfiguredAlerts()).toHaveLength(0);
  });
});
