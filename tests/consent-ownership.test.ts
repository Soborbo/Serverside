import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleConsent, MAX_REVISION_STEP } from '../src/routes/consent';
import { sha256Hex } from '../src/lib/hash';
import { readConsentState } from '../src/lib/ledger';

/**
 * 2026-10-18 review R7 — a consent-döntés tulajdonlási bizonyítéka, ASZIMMETRIKUS
 * szabállyal (utóellenőrzés után): kulcs nélkül csak SZIGORÍTANI lehet
 * (igazolatlan sorként, ami érvényes), engedélyt bővíteni csak a lánc kulcsával.
 *
 * Korábban egy ismert consent_id + kézzel gyártott `sbo_consent` süti elég volt
 * egy hamis `withdrawn` döntéshez, akár revision=10000-rel. Most a védett láncra
 * csak a lánc titkos kulcsa (`consent_key`, a szerveren csak hash-ként) írhat, és
 * a revision ugrása a lánc ismert maximumához kötött. Valódi migrációkon fut.
 */

const HOST = 'review.example';
const SITE = { site_id: 'review', country_code: 'GB', currency: 'GBP', consent: { provider: 'sbo', mode: 'basic' } };
const CID = 'consent-12345678';
const KEY = 'k'.repeat(64);
let seq = 0;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

function makeEnv(db: DatabaseSync, opts: { failReads?: boolean } = {}) {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      if (opts.failReads) throw new Error('D1 unavailable');
      return db.prepare(sql).get(...(args as never[])) ?? null;
    },
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => db.prepare(sql).run(...(args as never[])),
    sql,
    args
  });
  const batch = async (list: Array<{ sql: string; args: unknown[] }>) => {
    db.exec('BEGIN');
    try {
      const out = list.map((x) => db.prepare(x.sql).run(...(x.args as never[])));
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return { SITE_CONFIG: { get: async () => SITE }, LEDGER: { prepare: (sql: string) => stmt(sql), batch } } as any;
}

function decision(over: Record<string, unknown> = {}) {
  return {
    consent_id: CID,
    consent_event_id: `event-${String(++seq).padStart(8, '0')}`,
    revision: 1,
    decision: 'accept_all',
    cat_analytics: true,
    cat_marketing: true,
    consent_mode: 'basic',
    policy_version: '2026-09-a',
    banner_version: 'b1',
    consent_text_version: '2026-09-a',
    ruleset: 'eea_uk',
    client_decided_at: new Date().toISOString(),
    ...over
  };
}

/**
 * A kulcs a 6.13 óta NEM a body része: a szerver adja ki HttpOnly sütiben
 * (`sbo_consent_key`), és a böngésző azzal küldi vissza. A tesztek `consent_key`
 * mezője ezért itt sütivé alakul — a forgatókönyvek változatlanok.
 */
function post(input: Record<string, unknown>, cookieAgeSec = 0): Request {
  const { consent_key, ...body } = input;
  const ts = Math.floor(Date.now() / 1000) - cookieAgeSec;
  return new Request(`https://${HOST}/api/consent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `https://${HOST}`,
      Cookie:
        `sbo_consent=v2.1.1.${body.revision}.${body.decision}.${body.consent_id}.${ts}.2026-09-a` +
        (consent_key ? `; sbo_consent_key=${consent_key}` : '')
    },
    body: JSON.stringify(body)
  });
}

const WITHDRAW = { decision: 'withdrawn', cat_analytics: false, cat_marketing: false };

function rows(db: DatabaseSync) {
  return db.prepare('SELECT revision, decision, verified FROM consent_log ORDER BY revision').all() as Array<{
    revision: number; decision: string; verified: number;
  }>;
}

function boundKeys(db: DatabaseSync) {
  return db.prepare('SELECT key_hash FROM consent_chain').all() as Array<{ key_hash: string }>;
}

describe('R7 — csak a lánc kulcsa írhat a védett láncra', () => {
  it('új lánc kulccsal → 204, és CSAK a hash tárolódik (a nyers kulcs soha)', async () => {
    const db = freshDb();
    const res = await handleConsent(post(decision({ consent_key: KEY })), makeEnv(db));
    expect(res.status).toBe(204);
    expect(boundKeys(db)).toEqual([{ key_hash: await sha256Hex(`review:${CID}:${KEY}`) }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM consent_log').all())).not.toContain(KEY);
    expect(JSON.stringify(boundKeys(db))).not.toContain(KEY);
  });

  it('ismert consent_id + hamisított süti, kulcs NÉLKÜL: engedély-bővítés → 403, nincs új sor', async () => {
    const db = freshDb();
    await handleConsent(post(decision({ consent_key: KEY, ...WITHDRAW, decision: 'reject_all' })), makeEnv(db));
    const res = await handleConsent(post(decision({ revision: 2 })), makeEnv(db));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('consent_key_mismatch');
    expect(rows(db)).toHaveLength(1);
  });

  it('rossz kulccsal sem bővíthető → 403', async () => {
    const db = freshDb();
    await handleConsent(post(decision({ consent_key: KEY, ...WITHDRAW, decision: 'reject_all' })), makeEnv(db));
    const res = await handleConsent(post(decision({ revision: 2, consent_key: 'x'.repeat(64) })), makeEnv(db));
    expect(res.status).toBe(403);
  });

  it('a tulajdonos a saját kulcsával visszavonhat → 204', async () => {
    const db = freshDb();
    await handleConsent(post(decision({ consent_key: KEY })), makeEnv(db));
    const res = await handleConsent(post(decision({ ...WITHDRAW, revision: 2, consent_key: KEY })), makeEnv(db));
    expect(res.status).toBe(204);
    expect(rows(db).map((r) => r.decision)).toEqual(['accept_all', 'withdrawn']);
  });

  it('lejárt süti, de érvényes kulcs → a jogos frissítés átmegy', async () => {
    const db = freshDb();
    await handleConsent(post(decision({ consent_key: KEY })), makeEnv(db));
    const res = await handleConsent(post(decision({ revision: 2, consent_key: KEY }), 400 * 86400), makeEnv(db));
    expect(res.status).toBe(204);
  });

  it('ismétlés (ugyanaz a consent_event_id) → idempotens 204, egy sor', async () => {
    const db = freshDb();
    const body = decision({ consent_key: KEY });
    expect((await handleConsent(post(body), makeEnv(db))).status).toBe(204);
    expect((await handleConsent(post(body), makeEnv(db))).status).toBe(204);
    expect(rows(db)).toHaveLength(1);
  });
});

describe('R7 — a revision a lánc ismert maximumához kötött', () => {
  it('revision=10000 kulccsal sem írható → 400 revision_out_of_range', async () => {
    const db = freshDb();
    await handleConsent(post(decision({ consent_key: KEY })), makeEnv(db));
    const res = await handleConsent(post(decision({ ...WITHDRAW, revision: 10000, consent_key: KEY })), makeEnv(db));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('revision_out_of_range');
  });

  it('új láncon sem indulhat túl magas revisionnel', async () => {
    const db = freshDb();
    const res = await handleConsent(post(decision({ revision: MAX_REVISION_STEP + 1, consent_key: KEY })), makeEnv(db));
    expect(res.status).toBe(400);
  });

  it('a függőben maradt döntések tartaléka belefér (max + MAX_REVISION_STEP)', async () => {
    const db = freshDb();
    await handleConsent(post(decision({ consent_key: KEY })), makeEnv(db));
    const res = await handleConsent(post(decision({ revision: 1 + MAX_REVISION_STEP, consent_key: KEY })), makeEnv(db));
    expect(res.status).toBe(204);
  });
});

describe('R7 utóellenőrzés — kulcsvesztés: a jogos visszavonás nem vész el', () => {
  it('védett accept_all, a böngésző ÚJ kulccsal visszavon → 204, az aktuális állapot withdrawn', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision({ consent_key: KEY })), env);
    const res = await handleConsent(post(decision({ ...WITHDRAW, revision: 2, consent_key: 'n'.repeat(64) })), env);
    expect(res.status).toBe(204);
    const state = await readConsentState(env, 'review', CID);
    expect(state.kind === 'found' && state.state.decision).toBe('withdrawn');
    // Az igazolatlan sor nem köt új kulcsot a lánchoz.
    expect(rows(db).map((r) => r.verified)).toEqual([1, 0]);
    expect(boundKeys(db)).toHaveLength(1);
  });

  it('részleges visszavonás (csak a marketing ki) kulcs nélkül is átmegy', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision({ consent_key: KEY })), env);
    const res = await handleConsent(
      post(decision({ decision: 'custom', cat_analytics: true, cat_marketing: false, revision: 2 })),
      env
    );
    expect(res.status).toBe(204);
    const state = await readConsentState(env, 'review', CID);
    expect(state.kind === 'found' && state.state.ad_user_data).toBe('DENIED');
  });

  it('a tulajdonos későbbi IGAZOLT engedélye felülírja az igazolatlan visszavonást — alacsonyabb revisionnel is', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision({ consent_key: KEY })), env);
    // Harmadik fél (vagy kulcsvesztett böngésző) magas revisionnel szigorít…
    expect((await handleConsent(post(decision({ ...WITHDRAW, revision: 1 + MAX_REVISION_STEP })), env)).status).toBe(204);
    // …a tulajdonos a SAJÁT következő revisionjével, kulccsal újra engedélyez.
    await new Promise((r) => setTimeout(r, 5));
    expect((await handleConsent(post(decision({ revision: 2, consent_key: KEY })), env)).status).toBe(204);
    const state = await readConsentState(env, 'review', CID);
    expect(state.kind === 'found' && state.state.decision).toBe('accept_all');
  });
});

describe('R7 utóellenőrzés — a régi (kulcs nélküli) láncot senki nem „védheti le"', () => {
  // 2026-10-18 második utóellenőrzés: a korábbi elvárás („a valódi látogató saját
  // kulccsal BŐVÍTHET egy régi láncot") pontosan a hiba volt — ugyanezt a kérést
  // egy azonosítót ismerő harmadik fél is elküldheti. A régi lánc tulajdonosa nem
  // igazolható, ezért ott igazolatlan írás csak szigoríthat; engedélyt az új,
  // kulcsos lánc ad (a kliens 403-ra lánc-forgatással válaszol).
  it('támadó saját kulccsal visszavon (204, igazolatlan); bővítés kulccsal is 403 — kulcs egyik írással sem kötődik', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    // Régi, kulcs nélküli engedély (a 0013 előtti lánc: nincs consent_chain sora).
    expect((await handleConsent(post(decision()), env)).status).toBe(204);
    db.exec('DELETE FROM consent_chain');
    expect((await handleConsent(post(decision({ ...WITHDRAW, revision: 2, consent_key: 'a'.repeat(64) })), env)).status).toBe(204);
    expect((await handleConsent(post(decision({ revision: 3, consent_key: 'v'.repeat(64) })), env)).status).toBe(403);
    expect(boundKeys(db)).toHaveLength(0);
    const state = await readConsentState(env, 'review', CID);
    expect(state.kind === 'found' && state.state.decision).toBe('withdrawn');
  });

  it('a lánc-állapot olvasási hibája → 503 (a kliens megőrzi és újraküldi), nincs írás', async () => {
    const db = freshDb();
    const res = await handleConsent(post(decision({ consent_key: KEY })), makeEnv(db, { failReads: true }));
    expect(res.status).toBe(503);
    expect(rows(db)).toHaveLength(0);
  });
});
