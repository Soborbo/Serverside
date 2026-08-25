import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendToDataManager, classifyError, isValidClickId } from '../src/lib/datamanager';
import { getAccessTokenDetailed } from '../src/lib/gads-oauth';
import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY } from '../src/lib/error-codes';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';
import type { GAdsPayload } from '../src/lib/gads';

/**
 * F2 — a Google offline láb hibaosztályozása és a NÉMA SIKER zárása.
 *
 * KÉT HIBAOSZTÁLY, amit ez a fájl őriz:
 *
 * 1. NÉMA SIKER (§17). A Data Manager válaszát `.catch(() => ({}))` nyelte el,
 *    így egy értelmezhetetlen törzsű 200-as válasz végigcsúszott a siker-ágon:
 *    `accepted`, `conversions_processed: 1` — miközben fogalmunk sem volt,
 *    rögzített-e a Google bármit. A money-path közepén.
 *
 * 2. GYŰJTŐKÓDOK. Minden 4xx ÉS 5xx egyetlen `warning` súlyú kódba
 *    (TRK-840-003) esett, minden OAuth-bukás pedig a TRK-800-001-be. A ledger
 *    így nem tudta megkülönböztetni a RETRYABLE vendor-kiesést a TERMINAL rossz
 *    payloadtól, sem a beírandó secretet a visszavont hozzájárulástól.
 */

const baseSiteConfig: SiteConfig = {
  site_id: 'test',
  country_code: 'GB',
  currency: 'GBP',
  meta: { pixel_id: '1', access_token: 'T' },
  ga4: { measurement_id: 'G-X', api_secret: 'S' },
  gads: {
    customer_id: '1234567890',
    login_customer_id: null,
    conversion_actions: { lead_qualified: '99887766' }
  }
} as unknown as SiteConfig;

const basePayload: GAdsPayload = {
  event_name: 'lead_qualified',
  event_id: 'order-abc-123',
  event_time: 1781122021
};

function envWithCachedToken(extra: Partial<Env> = {}): Env {
  return {
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':access_token') ? 'cached-token' : null),
      put: async () => undefined
    },
    ...extra
  } as unknown as Env;
}

/** KV, amiben CSAK refresh token van — tehát a refresh hálózati ág lefut. */
function envNeedingRefresh(extra: Partial<Env> = {}): Env {
  return {
    GADS_OAUTH_CLIENT_ID: 'client',
    GADS_OAUTH_CLIENT_SECRET: 'secret',
    OAUTH_TOKENS: {
      get: async (k: string) => (k.endsWith(':refresh_token') ? 'refresh-abc' : null),
      put: async () => undefined
    },
    ...extra
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

// ── 1. A NÉMA SIKER ─────────────────────────────────────────────────

describe('§17 — értelmezhetetlen 2xx NEM lehet siker', () => {
  const unparseable = [
    ['nem-JSON törzs (proxy hibaoldal)', async () => { throw new SyntaxError('Unexpected token <'); }],
    ['csonka törzs', async () => { throw new SyntaxError('Unexpected end of JSON input'); }],
  ] as const;

  for (const [label, json] of unparseable) {
    it(`200 + ${label} → rejected, TRK-840-012, NEM conversions_processed`, async () => {
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json } as unknown as Response));

      const r = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, { em: 'EMHASH' });

      expect(r.success).toBe(false);
      expect(r.error_code).toBe(TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE);
      expect(r.conversions_processed).toBeUndefined();
      // A vendor-státuszt ÁTADJUK: a ledger lássa, hogy a Google válaszolt,
      // csak épp értelmezhetetlenül.
      expect(r.status).toBe(200);
    });
  }

  it('200 + nem-objektum törzs (`"OK"`) → szintén TRK-840-012', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => 'OK' } as unknown as Response));
    const r = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, { em: 'EMHASH' });
    expect(r.error_code).toBe(TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE);
    expect(r.success).toBe(false);
  });

  it('200 + null törzs → szintén TRK-840-012', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => null } as unknown as Response));
    const r = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, { em: 'EMHASH' });
    expect(r.error_code).toBe(TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE);
  });

  it('az ismeretlen állapot CRITICAL súlyú — nem nyelhető el warningként', () => {
    expect(ERROR_SEVERITY[TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE]).toBe('critical');
  });

  it('a VALÓDI siker (200 + requestId) változatlanul accepted marad', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200, json: async () => ({ requestId: 'req-1' })
    } as unknown as Response));
    const r = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, { em: 'EMHASH' });
    expect(r).toMatchObject({ success: true, conversions_processed: 1, status: 200 });
  });

  it('200 requestId NÉLKÜL: elfogadjuk (a 2xx a vendor igazolása), de jelezzük', async () => {
    // A hiányzó vendor-nyom nem fokozza le a kézbesítést — de nem is néma.
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response));
    const r = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, { em: 'EMHASH' });
    expect(r.success).toBe(true);
    expect(ERROR_DESCRIPTIONS[TrackingErrorCode.DATAMANAGER_RESPONSE_NO_REQUEST_ID]).toBeTruthy();
  });
});

// ── 2. VENDOR-HIBA OSZTÁLYOZÁS ──────────────────────────────────────

describe('classifyError — retryability szerint elkülönítve', () => {
  it('401 = lejárt token (magától megoldódik), 403 = jogosultság (operátori)', () => {
    expect(classifyError(401, 'x')).toBe(TrackingErrorCode.DATAMANAGER_AUTH_REJECTED);
    expect(classifyError(403, 'x')).toBe(TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED);
    // A kettő összemosása azt jelentené, hogy egy visszavont scope
    // megkülönböztethetetlen egy percek alatt magától elmúló lejárt tokentől.
    expect(classifyError(401, 'x')).not.toBe(classifyError(403, 'x'));
  });

  it('429 → rate limit', () => {
    expect(classifyError(429, 'quota')).toBe(TrackingErrorCode.DATAMANAGER_RATE_LIMITED);
  });

  it('5xx → SERVER_ERROR (RETRYABLE), nem a 4xx-gyűjtő', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(classifyError(s, 'Internal error')).toBe(TrackingErrorCode.DATAMANAGER_SERVER_ERROR);
    }
    expect(classifyError(500, 'Internal error')).not.toBe(TrackingErrorCode.DATAMANAGER_API_REJECTED);
  });

  it('400 + fieldViolations → VALIDATION_FAILED (TERMINAL)', () => {
    const details = [{
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'events[0].userData', description: 'invalid hash' }]
    }];
    expect(classifyError(400, 'There was a problem with the request.', details))
      .toBe(TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED);
  });

  it('400 + INVALID_ARGUMENT a details-ben → VALIDATION_FAILED', () => {
    // A VALÓS éles sor a ledgerből (2026-08-11, trapezlemezes): a felső szintű
    // message generikus, a `reason` a details[]-ben van.
    const details = [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'INVALID_ARGUMENT',
      domain: 'datamanager.googleapis.com'
    }];
    expect(classifyError(400, 'There was a problem with the request.', details))
      .toBe(TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED);
  });

  it('a NOT_ALLOWLISTED felismerés a DETAILS-ből is működik, nem csak a message-ből', () => {
    // Eddig CSAK a felső szintű message-t nézte, ami generikus — így a
    // felismerés a gyakorlatban szinte mindig mellé futott.
    const details = [{ reason: 'NOT_ALLOWLISTED', domain: 'datamanager.googleapis.com' }];
    expect(classifyError(400, 'There was a problem with the request.', details))
      .toBe(TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED);
    // …és a message-ből továbbra is (regresszió-őr).
    expect(classifyError(400, 'destination is not allowlisted'))
      .toBe(TrackingErrorCode.DATAMANAGER_NOT_ALLOWLISTED);
  });

  it('a maradék 4xx marad a residual gyűjtőben — a kód jelentése nem változott', () => {
    expect(classifyError(404, 'Not found')).toBe(TrackingErrorCode.DATAMANAGER_API_REJECTED);
    expect(classifyError(409, 'Conflict')).toBe(TrackingErrorCode.DATAMANAGER_API_REJECTED);
  });

  it('a szétválasztott kódok végig érnek a transportig (nem csak a classifier tudja)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 503,
      json: async () => ({ error: { code: 503, message: 'backend unavailable' } })
    } as unknown as Response));
    const r = await sendToDataManager(baseSiteConfig, envWithCachedToken(), basePayload, { em: 'EMHASH' });
    expect(r.error_code).toBe(TrackingErrorCode.DATAMANAGER_SERVER_ERROR);
    expect(r.status).toBe(503);
  });
});

// ── 3. KLIKK-ID ALAKI ELLENŐRZÉS ────────────────────────────────────

describe('klikk-ID validálás — egy rossz karakter ne vigye el az egész eventet', () => {
  it('valósághű azonosítókat elfogad', () => {
    expect(isValidClickId('CjwKCAjw_5jVBRB0EiwAXWmVIkQ2mZ4pYQ8fN3xTvB1a')).toBe(true);
    expect(isValidClickId('BwEIABAAGgJqcw0Sq3NfR8mTvY2xUa1bQ')).toBe(true);
  });

  it('a tipikus CRM-szemetet elutasítja', () => {
    for (const junk of [
      '',                                   // üres mentés
      'null',
      'undefined',                          // 9 karakter — pont ezért 10 az alsó határ
      'N/A',
      '?gclid=abc',                         // csonka URL-részlet
      'https://example.com/?gclid=abc123',  // az egész URL bement
      '"abc123def456"',                     // idézőjelekkel mentve
      'abc 123 def',                        // szóköz
      'x'.repeat(513),                      // képtelenül hosszú
    ]) {
      expect(isValidClickId(junk), `elfogadta: ${junk}`).toBe(false);
    }
  });

  it('hibás gclid → ELDOBJUK, de az event a hashelt identityvel FELMEGY', async () => {
    // Ez a lényeg: a szemét klikk-ID nem csak a saját mezőjét rontaná el, hanem
    // az EGÉSZ eventet 400-ba vinné — és vele a hash-match is elveszne.
    let captured: { events: { adIdentifiers?: unknown; userData?: unknown }[] } | null = null;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as unknown as Response;
    });

    const r = await sendToDataManager(
      baseSiteConfig, envWithCachedToken(),
      { ...basePayload, gclid: 'undefined' },
      { em: 'EMHASH' }
    );

    expect(r.success).toBe(true);
    expect(captured!.events[0]!.adIdentifiers).toBeUndefined();
    expect(captured!.events[0]!.userData).toBeDefined();
  });

  it('hibás gclid mellett a VALID gbraid lép a helyére', async () => {
    let captured: { events: { adIdentifiers?: unknown }[] } | null = null;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ requestId: 'r' }) } as unknown as Response;
    });

    await sendToDataManager(
      baseSiteConfig, envWithCachedToken(),
      { ...basePayload, gclid: 'null', gbraid: 'BwEIABAAGgJqcw0Sq3NfR8mTvY2xUa1bQ' },
      { em: 'EMHASH' }
    );
    expect(captured!.events[0]!.adIdentifiers).toEqual({ gbraid: 'BwEIABAAGgJqcw0Sq3NfR8mTvY2xUa1bQ' });
  });

  it('CSAK szemét klikk-ID és NINCS identity → skip, nem vak 400', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('a hálózatot el sem szabad érnie');
    });
    const r = await sendToDataManager(
      baseSiteConfig, envWithCachedToken(),
      { ...basePayload, gclid: 'undefined' },
      {}
    );
    expect(r).toMatchObject({ success: true, skipped: true, error_code: TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS });
  });
});

// ── 4. OAUTH-OKOK ───────────────────────────────────────────────────

describe('OAuth — az OK utazik tovább, nem egy „nincs token" gyűjtő', () => {
  it('hiányzó CLIENT_ID → TRK-800-011', async () => {
    const env = envNeedingRefresh({ GADS_OAUTH_CLIENT_ID: '' } as Partial<Env>);
    const r = await getAccessTokenDetailed('123', env);
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_OAUTH_CLIENT_ID_MISSING });
  });

  it('hiányzó CLIENT_SECRET → TRK-800-012', async () => {
    const env = envNeedingRefresh({ GADS_OAUTH_CLIENT_SECRET: '' } as Partial<Env>);
    const r = await getAccessTokenDetailed('123', env);
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_OAUTH_CLIENT_SECRET_MISSING });
  });

  it('hiányzó secret esetén EL SEM INDUL a hálózati kérés', async () => {
    // Enélkül a Google `invalid_client`-et adna, ami megkülönböztethetetlen egy
    // valóban rossz kulcstól — holott itt egyszerűen nincs beírva a secret.
    let called = false;
    vi.stubGlobal('fetch', async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } as unknown as Response; });
    await getAccessTokenDetailed('123', envNeedingRefresh({ GADS_OAUTH_CLIENT_ID: '' } as Partial<Env>));
    expect(called).toBe(false);
  });

  it('invalid_grant (lejárt/VISSZAVONT refresh token) → TRK-800-013, critical', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    } as unknown as Response));
    const r = await getAccessTokenDetailed('123', envNeedingRefresh());
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED });
    // Emberi újra-engedélyezést kíván — ezért nem warning.
    expect(ERROR_SEVERITY[TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED]).toBe('critical');
  });

  it('egyéb OAuth HTTP-hiba → TRK-800-014, NEM keverve az invalid_granttal', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 500, json: async () => ({ error: 'internal_failure' })
    } as unknown as Response));
    const r = await getAccessTokenDetailed('123', envNeedingRefresh());
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_OAUTH_HTTP_ERROR });
  });

  it('értelmezhetetlen OAuth-válasz → TRK-800-015 (eddig ŐRIZETLEN .json() dobott)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }
    } as unknown as Response));
    const r = await getAccessTokenDetailed('123', envNeedingRefresh());
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE });
  });

  it('2xx access_token nélkül → TRK-800-015', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200, json: async () => ({ expires_in: 3600 })
    } as unknown as Response));
    const r = await getAccessTokenDetailed('123', envNeedingRefresh());
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE });
  });

  it('OAuth időtúllépés → TRK-800-016', async () => {
    vi.stubGlobal('fetch', async () => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    });
    const r = await getAccessTokenDetailed('123', envNeedingRefresh());
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_OAUTH_TIMEOUT });
  });

  it('nincs refresh token a KV-ben → TRK-800-009 (változatlan jelentés)', async () => {
    const env = { GADS_OAUTH_CLIENT_ID: 'c', GADS_OAUTH_CLIENT_SECRET: 's',
      OAUTH_TOKENS: { get: async () => null, put: async () => undefined } } as unknown as Env;
    const r = await getAccessTokenDetailed('123', env);
    expect(r).toMatchObject({ error_code: TrackingErrorCode.GADS_NO_REFRESH_TOKEN });
  });

  it('gyorsítótárazott token → nincs hálózati hívás', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => { called = true; return {} as Response; });
    const r = await getAccessTokenDetailed('123', envWithCachedToken());
    expect(r).toEqual({ accessToken: 'cached-token' });
    expect(called).toBe(false);
  });

  it('az OAuth-ok VÉGIG ér a Data Manager eredményéig (a ledger ezt írja le)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'revoked' })
    } as unknown as Response));
    const r = await sendToDataManager(baseSiteConfig, envNeedingRefresh(), basePayload, { em: 'EMHASH' });
    // Eddig itt GADS_NO_ACCESS_TOKEN (TRK-800-001) állt volna: „nincs token".
    expect(r.error_code).toBe(TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED);
    expect(r.success).toBe(false);
  });
});

// ── 5. KATALÓGUS-TELJESSÉG ──────────────────────────────────────────

describe('katalógus — minden új kódnak van leírása és súlya', () => {
  const NEW_CODES = [
    TrackingErrorCode.GADS_OAUTH_CLIENT_ID_MISSING,
    TrackingErrorCode.GADS_OAUTH_CLIENT_SECRET_MISSING,
    TrackingErrorCode.GADS_REFRESH_TOKEN_REVOKED,
    TrackingErrorCode.GADS_OAUTH_HTTP_ERROR,
    TrackingErrorCode.GADS_OAUTH_MALFORMED_RESPONSE,
    TrackingErrorCode.GADS_OAUTH_TIMEOUT,
    TrackingErrorCode.DATAMANAGER_PERMISSION_DENIED,
    TrackingErrorCode.DATAMANAGER_VALIDATION_FAILED,
    TrackingErrorCode.DATAMANAGER_SERVER_ERROR,
    TrackingErrorCode.DATAMANAGER_MALFORMED_RESPONSE,
    TrackingErrorCode.DATAMANAGER_INVALID_CLICK_ID,
    TrackingErrorCode.DATAMANAGER_RESPONSE_NO_REQUEST_ID,
    TrackingErrorCode.UNSUPPORTED_LEAD_STATUS_MAPPING,
  ];

  it('mindegyik egyedi', () => {
    expect(new Set(NEW_CODES).size).toBe(NEW_CODES.length);
  });

  it('mindegyiknek van leírása és súlya', () => {
    for (const c of NEW_CODES) {
      expect(ERROR_DESCRIPTIONS[c], c).toBeTruthy();
      expect(ERROR_SEVERITY[c], c).toBeTruthy();
    }
  });

  it('egyik új kód sem ír felül meglévő számot', () => {
    const previouslyUsed = new Set([
      'TRK-800-001','TRK-800-002','TRK-800-003','TRK-800-004','TRK-800-005',
      'TRK-800-006','TRK-800-007','TRK-800-008','TRK-800-009','TRK-800-010',
      'TRK-840-001','TRK-840-002','TRK-840-003','TRK-840-004','TRK-840-005',
      'TRK-840-006','TRK-840-007','TRK-840-008','TRK-400-021',
    ]);
    for (const c of NEW_CODES) expect(previouslyUsed.has(c), c).toBe(false);
  });
});
