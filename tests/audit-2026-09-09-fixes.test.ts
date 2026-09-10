import { describe, it, expect, vi, afterEach } from 'vitest';
// A lead-status.ts a sendAlert-en át behúzná a notify.ts `cloudflare:email`
// import-ját (lásd fanout-isolation.test.ts) — ezért itt is mockoljuk.
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendAdminEmail: async () => {},
  sendCriticalSMS: async () => {},
  throttleOncePer: async () => true,
  escapeHtml: (s: string) => s
}));

import { normalizePhone } from '../src/lib/hash';
import { normalizePhone as normalizePhoneBrowser } from '../soborbo-tracking/lib/persistence';
import { sendToDataManager } from '../src/lib/datamanager';
import { skipReasonFromErrorCode } from '../src/lib/ledger';
import { handleLeadStatus } from '../src/routes/lead-status';
import { TrackingErrorCode } from '../src/lib/error-codes';
import { stripCommentsForRules } from '../../scripts/check-backend-contract.mjs';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';
import type { GAdsPayload } from '../src/lib/gads';
import { sendToMetaCAPI } from '../src/lib/meta';
import { listSitePrefixes } from '../src/lib/deadletter';
import { handleScheduledRetry } from '../src/scheduled/retry';
import { readFile } from 'node:fs/promises';

/**
 * A 2026-09-09-i teljes kód-audit javításainak REGRESSZIÓS őre.
 *
 * Minden eset a JAVÍTÁS ELŐTTI kódon BUKIK — ez a feltétele annak, hogy egy
 * későbbi refaktor ne tudja némán visszahozni ugyanazt a hibát. A leírások a
 * KÖVETKEZMÉNYT nevezik meg, nem a mechanizmust: az invariáns az, ami számít.
 */

afterEach(() => vi.unstubAllGlobals());

// ── 1. Telefon: a nemzetközi `00` prefix ────────────────────────────────────
describe('normalizePhone — a `00` nemzetközi prefix nem lehet trunk-nulla', () => {
  it('szerver: `0044…` → `+44…`, NEM `+44044…`', () => {
    expect(normalizePhone('0044 7123 456789', 'GB')).toBe('+447123456789');
  });

  it('szerver: `0036…` → `+36…`', () => {
    expect(normalizePhone('0036 30 123 4567', 'HU')).toBe('+36301234567');
  });

  it('szerver: a `00`-s alak UGYANAZT adja, mint a `+`-os', () => {
    expect(normalizePhone('0044 7123 456789', 'GB')).toBe(normalizePhone('+44 7123 456789', 'GB'));
  });

  it('a NEMZETI trunk-nulla érintetlen marad (`07…` → `+447…`)', () => {
    expect(normalizePhone('07123 456789', 'GB')).toBe('+447123456789');
    expect(normalizePhone('06 30 123 4567', 'HU')).toBe('+36301234567');
  });

  it('a puszta `00` nem hívókód — nem lesz belőle `+`', () => {
    expect(normalizePhone('00', 'GB')).toBeUndefined();
  });

  it('BÖNGÉSZŐ-LÁB PARITÁS: a kliens ugyanazt a stringet állítja elő', () => {
    // Ha a két láb eltér, a Pixel és a CAPI/EC MÁS hash-t kap ugyanarra az
    // emberre — a match némán romlik, és semmi nem jelzi.
    expect(normalizePhoneBrowser('0044 7123 456789', 'GB')).toBe(
      normalizePhone('0044 7123 456789', 'GB')
    );
    expect(normalizePhoneBrowser('0036 30 123 4567', 'HU')).toBe(
      normalizePhone('0036 30 123 4567', 'HU')
    );
  });
});

// ── 2. Data Manager: cím-azonosító és customer_id ───────────────────────────
const dmSite: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { lead_qualified: '99887766' }
  }
} as SiteConfig;

function dmEnv(): Env {
  return {
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    }
  } as unknown as Env;
}

const dmPayload: GAdsPayload = {
  event_name: 'lead_qualified',
  event_id: 'order-abc-123',
  event_time: 1781122021
};

function captureDmBody(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return { body: () => captured };
}

function identifiersOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const events = (body.events ?? []) as Record<string, unknown>[];
  const ud = (events[0]?.userData ?? {}) as Record<string, unknown>;
  return (ud.userIdentifiers ?? []) as Record<string, unknown>[];
}

describe('Data Manager — a cím-azonosító CSAK hiánytalanul mehet ki', () => {
  it('HIÁNYOS cím (nincs postalCode) → a bundle kimarad, az e-mail azonosító MEGY', async () => {
    // A Google mind a 4 AddressInfo-mezőt kötelezőnek jelöli: egy csonka bundle
    // a TELJES kérést 400-azza, tehát a mellette utazó érvényes e-mail is odavész.
    const cap = captureDmBody();
    const res = await sendToDataManager(dmSite, dmEnv(), dmPayload, {
      em: 'a'.repeat(64),
      fn: 'b'.repeat(64),
      ln: 'c'.repeat(64)
    });
    expect(res.success).toBe(true);
    const ids = identifiersOf(cap.body());
    expect(ids.some((i) => 'address' in i)).toBe(false);
    expect(ids.some((i) => 'emailAddress' in i)).toBe(true);
  });

  it('HIÁNYOS cím (csak keresztnév) → a bundle kimarad', async () => {
    const cap = captureDmBody();
    await sendToDataManager(
      dmSite,
      dmEnv(),
      { ...dmPayload, postal_code: 'SW1A 1AA', country: 'GB' },
      { em: 'a'.repeat(64), fn: 'b'.repeat(64) }
    );
    expect(identifiersOf(cap.body()).some((i) => 'address' in i)).toBe(false);
  });

  it('TELJES cím → a bundle kimegy, plain regionCode + postalCode-dal', async () => {
    const cap = captureDmBody();
    await sendToDataManager(
      dmSite,
      dmEnv(),
      { ...dmPayload, postal_code: 'SW1A 1AA', country: 'GB' },
      { fn: 'b'.repeat(64), ln: 'c'.repeat(64) }
    );
    const address = identifiersOf(cap.body()).find((i) => 'address' in i)?.address as Record<
      string,
      unknown
    >;
    expect(address).toEqual({
      givenName: 'b'.repeat(64),
      familyName: 'c'.repeat(64),
      regionCode: 'GB',
      postalCode: 'SW1A1AA'
    });
  });

  it('cím-mező nélküli event: nincs address-bundle, és nincs figyelmeztetés sem', async () => {
    const cap = captureDmBody();
    await sendToDataManager(dmSite, dmEnv(), dmPayload, { em: 'a'.repeat(64) });
    expect(identifiersOf(cap.body()).some((i) => 'address' in i)).toBe(false);
  });
});

describe('Data Manager — a customer_id alakja futásidőben ellenőrzött (CLAUDE.md 4.)', () => {
  it('kötőjeles customer_id → skip, vendor-hívás NEM történik', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    const res = await sendToDataManager(
      { ...dmSite, gads: { ...dmSite.gads!, customer_id: '123-456-7890' } } as SiteConfig,
      dmEnv(),
      dmPayload,
      { em: 'a'.repeat(64) }
    );
    expect(called).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.error_code).toBe(TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID);
  });

  it('formahibás login_customer_id → szintén skip (a manager-fiók is azonosító)', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    const res = await sendToDataManager(
      { ...dmSite, gads: { ...dmSite.gads!, login_customer_id: '306-385-1682' } } as SiteConfig,
      dmEnv(),
      dmPayload,
      { em: 'a'.repeat(64) }
    );
    expect(called).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it('a ledger a hibakódból `invalid_identifier` címkét képez — nem csupasz `skipped`', () => {
    // Enélkül a sor megkülönböztethetetlen egy jogos consent-kihagyástól: ez a
    // vakfolt rejtette el a lomtalan Meta-kiesését öt napon át.
    expect(skipReasonFromErrorCode(TrackingErrorCode.PLATFORM_IDENTIFIER_INVALID)).toBe(
      'invalid_identifier'
    );
  });
});

// ── 3. lead-status: a szándékos kihagyás nem lehet néma ─────────────────────
interface CapturedDelivery {
  sql: string;
  values: unknown[];
}

function leadStatusEnv(opts: {
  siteConfig: Record<string, unknown>;
  receiptRow?: Record<string, unknown> | null;
  captured: CapturedDelivery[];
}): Env {
  const stmt = (sql: string) => ({
    bind: (...values: unknown[]) => {
      opts.captured.push({ sql, values });
      return {
        first: async () =>
          /FROM consent_receipts/.test(sql) ? (opts.receiptRow ?? null) : null,
        run: async () => undefined,
        all: async () => ({ results: [] })
      };
    }
  });
  return {
    ADMIN_API_TOKEN: 'admin-token',
    GADS_OAUTH_CLIENT_ID: 'c',
    GADS_OAUTH_CLIENT_SECRET: 's',
    SITE_CONFIG: { get: async () => opts.siteConfig },
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    },
    LEDGER: { prepare: stmt, batch: async () => undefined }
  } as unknown as Env;
}

function leadStatusCtx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    settle: () => Promise.allSettled(pending)
  };
  return ctx as unknown as ExecutionContext & { settle: () => Promise<unknown> };
}

function leadStatusRequest(body: Record<string, unknown>): Request {
  return new Request('https://painlessremovals.com/api/event/lead-status', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function deliveryInserts(captured: CapturedDelivery[]): CapturedDelivery[] {
  return captured.filter((c) => /INSERT INTO deliveries/.test(c.sql));
}

describe('lead-status — a consent-kihagyás ledger-sort ír MINDEN ágon', () => {
  const site = {
    site_id: 'beautyflow',
    country_code: 'HU',
    currency: 'HUF',
    require_consent: true,
    expected_platforms: { smoke: ['meta'], offline: ['gads'] },
    gads: {
      customer_id: '9796138635',
      login_customer_id: null,
      conversion_actions: { revenue_confirmed: '7664842040' }
    }
  };

  it('DENIED receipt → `skipped|consent_denied` sor (eddig NYOMTALAN volt)', async () => {
    // Élő mérés (2026-09-09): a beautyflow 37 revenue_confirmed státuszából 28
    // pontosan így tűnt el — a CRM mind a 37-et `accepted`-nek könyvelte.
    const captured: CapturedDelivery[] = [];
    const ctx = leadStatusCtx();
    const res = await handleLeadStatus(
      leadStatusRequest({ lead_id: 'lead-0001-abcd', status: 'revenue_confirmed', value: 1200 }),
      leadStatusEnv({
        siteConfig: site,
        receiptRow: { ad_allowed: 0, ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
        captured
      }),
      ctx
    );
    await (ctx as unknown as { settle: () => Promise<unknown> }).settle();
    expect(res.status).toBe(200);
    const rows = deliveryInserts(captured);
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toContain('skipped');
    expect(rows[0].values).toContain('consent_denied');
  });

  it('CRM ad_allowed=false (receipt nélkül) → szintén sor íródik', async () => {
    const captured: CapturedDelivery[] = [];
    const ctx = leadStatusCtx();
    await handleLeadStatus(
      leadStatusRequest({
        lead_id: 'lead-0002-abcd',
        status: 'revenue_confirmed',
        value: 900,
        ad_allowed: false
      }),
      leadStatusEnv({ siteConfig: site, receiptRow: null, captured }),
      ctx
    );
    await (ctx as unknown as { settle: () => Promise<unknown> }).settle();
    const rows = deliveryInserts(captured);
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toContain('consent_denied');
  });

  it('fail-closed (semmilyen jel, require_consent) → szintén sor íródik', async () => {
    const captured: CapturedDelivery[] = [];
    const ctx = leadStatusCtx();
    await handleLeadStatus(
      leadStatusRequest({ lead_id: 'lead-0003-abcd', status: 'revenue_confirmed', value: 500 }),
      leadStatusEnv({ siteConfig: site, receiptRow: null, captured }),
      ctx
    );
    await (ctx as unknown as { settle: () => Promise<unknown> }).settle();
    expect(deliveryInserts(captured)).toHaveLength(1);
  });
});

describe('lead-status — a nem elvárt offline láb nem termel DLQ-t', () => {
  // Élő KV (2026-09-09): olcsokontenerhaz / skinlab / szelloztetes pontosan így
  // néz ki — customer_id a recon/health miatt, conversion_actions nélkül.
  const siteWithoutOfflineExpectation = {
    site_id: 'olcsokontenerhaz',
    country_code: 'HU',
    currency: 'HUF',
    require_consent: true,
    expected_platforms: { smoke: ['meta'] },
    gads: { customer_id: '6797699997', login_customer_id: null }
  };

  it('hiányzó conversion action + nem elvárt offline → 200, se DLQ, se 202', async () => {
    const captured: CapturedDelivery[] = [];
    let dlqSends = 0;
    const env = leadStatusEnv({ siteConfig: siteWithoutOfflineExpectation, captured });
    (env as unknown as { DLQ: unknown }).DLQ = {
      send: async () => {
        dlqSends++;
      }
    };
    const ctx = leadStatusCtx();
    const res = await handleLeadStatus(
      leadStatusRequest({
        lead_id: 'lead-0004-abcd',
        status: 'revenue_confirmed',
        value: 700,
        ad_allowed: true
      }),
      env,
      ctx
    );
    await (ctx as unknown as { settle: () => Promise<unknown> }).settle();
    expect(res.status).toBe(200);
    expect(dlqSends).toBe(0);
    const body = (await res.json()) as { uploaded_to_gads?: boolean; queued_for_retry?: boolean };
    expect(body.uploaded_to_gads).toBe(false);
    expect(body.queued_for_retry).toBeUndefined();
  });

  it('ELVÁRT offline láb hiányzó conversion actionnel viszont TOVÁBBRA is blokk (202/503)', async () => {
    // A szűkítés nem nyithat rést: ahol az offline láb elvárt, a config-hiány
    // változatlanul retryable konfigurációs blokk.
    const captured: CapturedDelivery[] = [];
    const env = leadStatusEnv({
      siteConfig: {
        ...siteWithoutOfflineExpectation,
        expected_platforms: { smoke: ['meta'], offline: ['gads'] }
      },
      captured
    });
    (env as unknown as { DLQ: unknown }).DLQ = { send: async () => undefined };
    const ctx = leadStatusCtx();
    const res = await handleLeadStatus(
      leadStatusRequest({
        lead_id: 'lead-0005-abcd',
        status: 'revenue_confirmed',
        value: 700,
        ad_allowed: true
      }),
      env,
      ctx
    );
    await (ctx as unknown as { settle: () => Promise<unknown> }).settle();
    expect([202, 503]).toContain(res.status);
  });
});

// ── 4. A szerződés-őr nem elégíthető ki KOMMENTTEL ──────────────────────────
describe('check-backend-contract — a szabály a KÓD-ra kérdez, nem a kommentre', () => {
  it('kikommentezett kód NEM elégíti ki a mintát', () => {
    const src = `// DISABLED: if (now - decidedAtSec > SBO_CONSENT_MAX_AGE_S) return null;\nconst x = 1;`;
    expect(stripCommentsForRules(src)).not.toContain('SBO_CONSENT_MAX_AGE_S');
  });

  it('blokk-kommentbe rejtett kulcs NEM számít (`map.marketing /* was map.advertisement */`)', () => {
    const src = `const a = map.marketing; /* was map.advertisement */`;
    const out = stripCommentsForRules(src);
    expect(out).not.toContain('advertisement');
    expect(out).toContain('map.marketing');
  });

  it('a STRING-literálok érintetlenek (egy `//` szöveg nem üti ki a strippert)', () => {
    const src = `const url = 'https://example.com/x'; const y = 2; // vege`;
    const out = stripCommentsForRules(src);
    expect(out).toContain(`'https://example.com/x'`);
    expect(out).toContain('const y = 2;');
    expect(out).not.toContain('vege');
  });

  it('a valódi kód VÁLTOZATLANUL átmegy', () => {
    const src = `export const BACKEND_LIB_VERSION = '6.7.1';`;
    expect(stripCommentsForRules(src)).toContain(`BACKEND_LIB_VERSION = '6.7.1'`);
  });
});

// ── 5. Meta: a kvóta-hiba nem TERMINÁLIS ────────────────────────────────────
describe('Meta hibaosztályozás — a throttle nem végleges elutasítás', () => {
  const metaSite = {
    site_id: 'test',
    country_code: 'GB',
    currency: 'GBP',
    meta: { pixel_id: '1234567890123456', access_token: 'T' }
  } as unknown as Parameters<typeof sendToMetaCAPI>[0];

  const metaPayload = {
    event_name: 'contact_form_submitted',
    event_id: 'evt-1',
    event_time: 1781122021
  } as unknown as Parameters<typeof sendToMetaCAPI>[1];

  // A Meta a CAPI kvóta-hibáit HTTP 400-zal is adja; a jelzés a `code`-ban van.
  // Rate-limitként osztályozva a rekord retryable; `META_API_REJECTED`-ként
  // TERMINÁLIS, tehát három azonos újrapróbálkozás után a konverzió halott —
  // pont egy forgalmi csúcson, amikor a legtöbb pénz múlik rajta.
  for (const code of [4, 17, 32, 613, 80004]) {
    it(`a Meta code=${code} RATE_LIMITED, nem végleges elutasítás`, async () => {
      vi.stubGlobal('fetch', async () =>
        new Response(JSON.stringify({ error: { code, message: 'rate limited' } }), { status: 400 })
      );
      const res = await sendToMetaCAPI(metaSite, metaPayload, { em: 'a'.repeat(64) });
      expect(res.success).toBe(false);
      expect(res.error_code).toBe(TrackingErrorCode.META_RATE_LIMITED);
    });
  }

  it('a nem-kvóta 400 VÁLTOZATLANUL META_API_REJECTED marad', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { code: 100, message: 'something else' } }), { status: 400 })
    );
    const res = await sendToMetaCAPI(metaSite, metaPayload, { em: 'a'.repeat(64) });
    expect(res.error_code).toBe(TrackingErrorCode.META_API_REJECTED);
  });
});

// ── 6. A lifecycle-sorok dedup-kulcsa ───────────────────────────────────────
describe('lead_status — a determinisztikus orderId a soron van (0010)', () => {
  it('a beszúrás hordozza az orderId-t, és két retry UGYANAZT írja', async () => {
    // A sorok per-KÍSÉRLET keletkeznek (a beszúrás a 503/202 elágazások ELŐTT
    // ütemeződik). orderId nélkül a COUNT-oló olvasók a retry-kat külön
    // eseménynek látják: egy tranziens vendor-kiesés received=6/accepted=3
    // képet ad → HAMIS CRITICAL riasztás.
    const orderIds: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const captured: CapturedDelivery[] = [];
      const ctx = leadStatusCtx();
      await handleLeadStatus(
        leadStatusRequest({
          lead_id: 'lead-9001-abcd',
          status: 'revenue_confirmed',
          value: 1000,
          ad_allowed: true
        }),
        leadStatusEnv({
          siteConfig: {
            site_id: 'beautyflow',
            country_code: 'HU',
            currency: 'HUF',
            require_consent: true,
            expected_platforms: { smoke: ['meta'], offline: ['gads'] },
            gads: {
              customer_id: '9796138635',
              login_customer_id: null,
              conversion_actions: { revenue_confirmed: '7664842040' }
            }
          },
          captured
        }),
        ctx
      );
      await (ctx as unknown as { settle: () => Promise<unknown> }).settle();
      const insert = captured.find((c) => /INSERT INTO lead_status/.test(c.sql));
      expect(insert, 'lead_status insert missing').toBeDefined();
      expect(insert!.sql).toContain('order_id');
      orderIds.push(insert!.values[insert!.values.length - 1]);
    }
    expect(orderIds[0]).toBeTruthy();
    expect(orderIds[0]).toBe(orderIds[1]);
  });

  it('a COUNT-oló olvasók DISTINCT-tel számolnak, nem nyers darabszámmal', async () => {
    const [recon, counts] = await Promise.all([
      readFile(new URL('../src/lib/reconciliation.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/lib/business-counts.ts', import.meta.url), 'utf8')
    ]);
    for (const [name, src] of [
      ['reconciliation', recon],
      ['business-counts', counts]
    ] as const) {
      const leadStatusQueries = src
        .split('\n')
        .filter((l) => /COUNT\(\*\)/.test(l) && /lead_status/.test(src));
      expect(src, `${name}: a lead_status olvasói DISTINCT-et használnak`).toContain(
        'COUNT(DISTINCT COALESCE(order_id, id))'
      );
      expect(leadStatusQueries.join('\n')).not.toContain('COUNT(*) AS received');
    }
  });
});

// ── 7. A DLQ-retry méltányos a site-ok között ───────────────────────────────
describe('cron retry — egy site backlogja nem éheztetheti ki a többit', () => {
  it('a prefixeket delimiterrel gyűjti, és site-onként osztja a keretet', async () => {
    // R2 KULCS-SORRENDBEN egy alfabetikusan korai site tartós
    // `blocked_configuration` backlogja elfogyasztotta a 100-as futás-keretet,
    // és minden utána következő site 24 órás ablakú, VALÓDI vendor-hibái
    // egyetlen újrapróbálkozás nélkül jártak le.
    const listCalls: { prefix?: string; delimiter?: string; limit?: number }[] = [];
    const env = {
      DEAD_LETTER: {
        list: async (opts: { prefix?: string; delimiter?: string; limit?: number }) => {
          listCalls.push(opts);
          if (opts.delimiter === '/') {
            return {
              objects: [],
              delimitedPrefixes: ['aaa-site/', 'zzz-site/'],
              truncated: false
            };
          }
          return { objects: [], delimitedPrefixes: [], truncated: false };
        }
      }
    } as unknown as Env;

    const prefixes = await listSitePrefixes(env);
    expect(prefixes).toEqual(['aaa-site/', 'zzz-site/']);
    expect(listCalls[0].delimiter).toBe('/');

    // A késői site is sorra kerül: a scan MINDKÉT prefixre lefut.
    listCalls.length = 0;
    await handleScheduledRetry({ cron: '0 * * * *', scheduledTime: Date.now() } as ScheduledEvent, env);
    const scanned = listCalls.filter((c) => c.delimiter !== '/').map((c) => c.prefix);
    expect(scanned).toContain('aaa-site/');
    expect(scanned).toContain('zzz-site/');
  });
});
