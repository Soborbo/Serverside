import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleConsent } from '../src/routes/consent';
import { checkReplayConsent } from '../src/scheduled/retry';

/**
 * A kézbesítési hatókör (lejárat + vendorlista) csak SZŰKÜLHET — a PR #164
 * Codex-reviewjának három lelete, valódi migrációkon és SQL-en:
 *  - kulcs nélküli, kategóriát „megtartó" POST nem hosszabbíthat meg egy lejárt
 *    engedélyt, és nem nyithat új platformot (védett ÉS régi láncon sem);
 *  - lánc-forgatás után a szűkebb utód-vendorlista a régi consent_id-ra is hat.
 * A kulccsal (igazoltan) írt döntés viszont továbbra is bővíthet.
 */

const HOST = 'scope.example';
const SITE = { site_id: 'scope', country_code: 'GB', currency: 'GBP', consent: { provider: 'sbo', mode: 'basic' } };
const CID = 'consent-scope-000001';
const DAY = 86_400_000;
let seq = 0;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

/** D1-szerű shim (a consent-r7-key-cookie.test.ts mintájára). */
function makeEnv(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: db.prepare(sql).run(...(args as never[])) })
  });
  return {
    SITE_CONFIG: { get: async () => SITE },
    LEDGER: {
      prepare: (sql: string) => stmt(sql),
      batch: async (list: Array<{ sql: string; args: unknown[] }>) => {
        db.exec('BEGIN');
        try {
          const out = list.map((s) => ({ meta: db.prepare(s.sql).run(...(s.args as never[])) }));
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
    }
  } as any;
}

function decision(over: Record<string, unknown> = {}) {
  return {
    consent_id: CID,
    consent_event_id: `scope-event-${String(++seq).padStart(8, '0')}`,
    revision: 1,
    decision: 'accept_all',
    cat_analytics: true,
    cat_marketing: true,
    consent_mode: 'basic',
    policy_version: '2026-09-a',
    banner_version: 'b1',
    consent_text_version: '2026-09-a.ga4',
    ruleset: 'eea_uk',
    client_decided_at: new Date().toISOString(),
    ...over
  };
}

function post(body: Record<string, unknown>, key?: string): Request {
  const ts = Math.floor(Date.now() / 1000);
  const cookies = [`sbo_consent=v2.1.1.${body.revision}.${body.decision}.${body.consent_id}.${ts}.2026-09-a`];
  if (key) cookies.push(`sbo_consent_key=${key}`);
  return new Request(`https://${HOST}/api/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `https://${HOST}`, Cookie: cookies.join('; ') },
    body: JSON.stringify(body)
  });
}

function issuedKey(res: Response): string | undefined {
  const m = /(?:^|,\s*)sbo_consent_key=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '');
  return m ? m[1] : undefined;
}

const replay = (env: unknown, platform: string, consentId = CID) =>
  checkReplayConsent(env as never, SITE as never, { platform, site_id: 'scope', hostname: HOST, consent_id: consentId } as never);

/** A tárolt sorok beérkezési idejének visszaállítása (a lejárat szimulálása). */
function age(db: DatabaseSync, consentId: string, days: number) {
  db.prepare('UPDATE consent_log SET server_received_at = ? WHERE consent_id = ?').run(
    new Date(Date.now() - days * DAY).toISOString(),
    consentId
  );
}

describe('kulcs nélküli írás nem bővítheti a hatókört — védett lánc', () => {
  it('új platform (Meta) nem nyílik egy kulcs nélküli „megtartó" POST-tal', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    expect((await handleConsent(post(decision()), env)).status).toBe(204);
    // Ugyanazok a kategóriák, de bővebb szöveg — kulcs nélkül → igazolatlan sor.
    const res = await handleConsent(post(decision({ revision: 2, consent_text_version: '2026-09-a.ga4_meta' })), env);
    expect(res.status).toBe(204);
    expect(await replay(env, 'meta')).toMatchObject({ skipped: true, skip_reason: 'consent_vendor_not_covered' });
  });

  it('a lejárt engedélyt egy kulcs nélküli POST nem hosszabbítja meg', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision({ consent_text_version: '2026-09-a.ga4_google_ads_meta' })), env);
    age(db, CID, 200);
    await handleConsent(post(decision({ revision: 2, consent_text_version: '2026-09-a.ga4_google_ads_meta' })), env);
    expect(await replay(env, 'gads')).toMatchObject({ skipped: true, skip_reason: 'consent_expired' });
  });

  it('kulccsal (igazoltan) viszont bővíthet és megújíthat', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const key = issuedKey(await handleConsent(post(decision()), env));
    expect(key).toBeDefined();
    age(db, CID, 200);
    const res = await handleConsent(post(decision({ revision: 2, consent_text_version: '2026-09-a.ga4_meta' }), key), env);
    expect(res.status).toBe(204);
    expect(await replay(env, 'meta')).toBeNull();
  });
});

describe('kulcs nélküli írás nem bővítheti a hatókört — régi (kulcs nélküli) lánc', () => {
  it('a legmagasabb revisionű, utólag írt sor sem nyit új platformot és nem újít meg', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    db.prepare(
      `INSERT INTO consent_log (id, consent_id, consent_event_id, revision, site_id, decision,
         cat_analytics, cat_marketing, ad_user_data, ad_personalization, ad_storage, analytics_storage,
         consent_mode, policy_version, banner_version, consent_text_version, ruleset,
         client_decided_at, server_received_at)
       VALUES ('legacy-1', ?, 'legacy-event-1', 1, 'scope', 'accept_all', 1, 1,
         'GRANTED', 'GRANTED', 'GRANTED', 'GRANTED', 'basic', 'p', 'b', '2026-09-a.ga4', 'eea_uk', ?, ?)`
    ).run(CID, new Date(Date.now() - 190 * DAY).toISOString(), new Date(Date.now() - 190 * DAY).toISOString());
    const res = await handleConsent(post(decision({ revision: 2, consent_text_version: '2026-09-a.ga4_meta' })), env);
    expect(res.status).toBe(204);
    // A lejárat a lánc ELSŐ sorától számít → lejárt, akármit állít a friss sor.
    expect(await replay(env, 'meta')).toMatchObject({ skipped: true, skip_reason: 'consent_expired' });
  });
});

describe('lánc-forgatás: a szűkebb utód-vendorlista a régi consent_id-ra is hat', () => {
  it('az utód már nem nevezi meg a Metát → a régi lánchoz kötött Meta-replay sem megy', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const key = issuedKey(await handleConsent(post(decision({ consent_text_version: '2026-09-a.ga4_meta' })), env));
    expect(await replay(env, 'meta')).toBeNull();
    const NEW = 'consent-scope-000002';
    const res = await handleConsent(
      post(decision({ consent_id: NEW, revision: 1, previous_consent_id: CID, consent_text_version: '2026-09-a.ga4' }), key),
      env
    );
    expect(res.status).toBe(204);
    expect(await replay(env, 'meta', CID)).toMatchObject({ skipped: true, skip_reason: 'consent_vendor_not_covered' });
  });
});
