import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleConsent } from '../src/routes/consent';
import { readConsentState } from '../src/lib/ledger';
import { checkReplayConsent } from '../src/scheduled/retry';

/**
 * 2026-10-18 review R7 — második utóellenőrzés: a lánc tulajdonlása és a
 * kulcsvesztés EGYÜTT. Valódi migrációkon, tényleges SQL-lel (node:sqlite).
 *
 * Az elvárt üzleti működés:
 *  - a consent_id (+ hamisított `sbo_consent` süti) ismerete SEMMILYEN engedélyt
 *    nem adhat — se régi (kulcs nélküli), se védett láncon;
 *  - a lánc kulcsát a SZERVER adja ki HttpOnly sütiben → nem függ a böngésző
 *    localStorage-ától (letiltott tárhely ≠ védelem nélküli lánc);
 *  - igazolatlan írás csak SZIGORÍTHAT (a jogos visszavonás így kulcsvesztés után
 *    is eljut a szerverhez, és a régi eseményekre is hat);
 *  - az első kulcs hozzárendelése párhuzamos kérések mellett is egyértelmű.
 */

const HOST = 'review.example';
const SITE = { site_id: 'review', country_code: 'GB', currency: 'GBP', consent: { provider: 'sbo', mode: 'basic' } };
const CID = 'consent-r7-0000001';
let seq = 0;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

type Fail = { reads?: boolean; writes?: boolean };

/** D1-szerű shim: prepare/bind/first/all/run + batch (egy tranzakció, mint a D1-ben). */
function makeEnv(db: DatabaseSync, fail: Fail = {}) {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      await Promise.resolve();
      if (fail.reads) throw new Error('D1 unavailable');
      return db.prepare(sql).get(...(args as never[])) ?? null;
    },
    all: async () => {
      await Promise.resolve();
      if (fail.reads) throw new Error('D1 unavailable');
      return { results: db.prepare(sql).all(...(args as never[])) };
    },
    run: async () => {
      await Promise.resolve();
      if (fail.writes) throw new Error('D1 unavailable');
      return { meta: db.prepare(sql).run(...(args as never[])) };
    }
  });
  return {
    SITE_CONFIG: { get: async () => SITE },
    LEDGER: {
      prepare: (sql: string) => stmt(sql),
      batch: async (list: Array<{ sql: string; args: unknown[] }>) => {
        await Promise.resolve();
        if (fail.writes) throw new Error('D1 unavailable');
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

const ACCEPT = { decision: 'accept_all', cat_analytics: true, cat_marketing: true };
const REJECT = { decision: 'reject_all', cat_analytics: false, cat_marketing: false };
const WITHDRAW = { decision: 'withdrawn', cat_analytics: false, cat_marketing: false };

function decision(over: Record<string, unknown> = {}) {
  return {
    consent_id: CID,
    consent_event_id: `r7-event-${String(++seq).padStart(8, '0')}`,
    revision: 1,
    ...ACCEPT,
    consent_mode: 'basic',
    policy_version: '2026-09-a',
    banner_version: 'b1',
    consent_text_version: '2026-09-a',
    ruleset: 'eea_uk',
    client_decided_at: new Date().toISOString(),
    ...over
  };
}

/** A böngésző kérése: a saját `sbo_consent` sütije + (ha van) a szerver kiadta kulcs-süti. */
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

/** A válasz Set-Cookie-jából a kiadott kulcs (vagy undefined). */
function issuedKey(res: Response): string | undefined {
  const sc = res.headers.get('Set-Cookie') ?? '';
  const m = /(?:^|,\s*)sbo_consent_key=([^;]+)/.exec(sc);
  return m ? m[1] : undefined;
}

async function stateOf(env: unknown) {
  const read = await readConsentState(env as never, 'review', CID);
  return read.kind === 'found' ? read.state : null;
}

/** Régi (0011 előtti) lánc: kulcs nélküli sor közvetlenül a táblában. */
function seedLegacyChain(db: DatabaseSync, over: { decision?: string; a?: number; m?: number } = {}) {
  const granted = (over.m ?? 1) === 1 ? 'GRANTED' : 'DENIED';
  db.prepare(
    `INSERT INTO consent_log (id, consent_id, consent_event_id, revision, site_id, decision,
       cat_analytics, cat_marketing, ad_user_data, ad_personalization, ad_storage, analytics_storage,
       consent_mode, policy_version, banner_version, consent_text_version, ruleset,
       client_decided_at, server_received_at)
     VALUES (?, ?, ?, 1, 'review', ?, ?, ?, ?, ?, ?, ?, 'basic', 'p', 'b', 't', 'eea_uk', ?, ?)`
  ).run(
    'legacy-row-1', CID, 'legacy-event-0001', over.decision ?? 'accept_all', over.a ?? 1, over.m ?? 1,
    granted, granted, granted, (over.a ?? 1) === 1 ? 'GRANTED' : 'DENIED',
    new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString()
  );
}

const ATTACKER_KEY = 'a'.repeat(43);

describe('R7 — a kulcsot a szerver adja ki (HttpOnly süti), nem a localStorage', () => {
  it('az első döntés 204 + HttpOnly, Secure, SameSite=Strict kulcs-süti a consent-útvonalra', async () => {
    const db = freshDb();
    const res = await handleConsent(post(decision()), makeEnv(db));
    expect(res.status).toBe(204);
    const sc = res.headers.get('Set-Cookie') ?? '';
    expect(issuedKey(res)).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\/api\/consent/i);
    // A nyers kulcs SOHA nem kerül az adatbázisba.
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM consent_log').all(),
      db.prepare('SELECT * FROM consent_chain').all()
    ]);
    expect(dump).not.toContain(issuedKey(res)!);
  });

  it('tárhely nem elérhető (a kliens body-kulcsot nem küld): a lánc így is védett lesz', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const first = await handleConsent(post(decision(REJECT)), env);
    expect(first.status).toBe(204);
    expect(issuedKey(first)).toBeDefined();
    // Azonosítót ismerő harmadik fél engedélyt próbál adni → elutasítva.
    const attack = await handleConsent(post(decision({ revision: 2 }), ATTACKER_KEY), env);
    expect(attack.status).toBe(403);
    expect((await stateOf(env))?.decision).toBe('reject_all');
  });

  it('a tulajdonos a kiadott kulccsal engedélyt bővíthet (igazolt sor)', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const key = issuedKey(await handleConsent(post(decision(REJECT)), env));
    const res = await handleConsent(post(decision({ revision: 2 }), key), env);
    expect(res.status).toBe(204);
    expect((await stateOf(env))?.decision).toBe('accept_all');
  });
});

describe('R7 — ismert azonosító + hamis süti + támadói kulcs', () => {
  it('védett lánc: a támadói kulcs nem bővíthet, és nem is kötődik a lánchoz', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision(REJECT)), env);
    const res = await handleConsent(post(decision({ revision: 2 }), ATTACKER_KEY), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('consent_key_mismatch');
    expect(issuedKey(res)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_chain').get()).toEqual({ n: 1 });
  });

  it('régi (kulcs nélküli) lánc: a támadó NEM foglalhatja le saját kulccsal, és engedélyt sem adhat', async () => {
    const db = freshDb();
    seedLegacyChain(db, { decision: 'reject_all', a: 0, m: 0 });
    const env = makeEnv(db);
    const res = await handleConsent(post(decision({ revision: 2 }), ATTACKER_KEY), env);
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_chain').get()).toEqual({ n: 0 });
    expect((await stateOf(env))?.decision).toBe('reject_all');
  });
});

describe('R7 — régi lánc első kulcsos frissítése', () => {
  it('szigorítás: 204, igazolatlan, a lánc NEM kap kulcsot (a tulajdonos nem igazolható)', async () => {
    const db = freshDb();
    seedLegacyChain(db);
    const env = makeEnv(db);
    const res = await handleConsent(post(decision({ ...WITHDRAW, revision: 2 }), ATTACKER_KEY), env);
    expect(res.status).toBe(204);
    expect(issuedKey(res)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_chain').get()).toEqual({ n: 0 });
    expect((await stateOf(env))?.decision).toBe('withdrawn');
  });

  it('bővítés: 403 consent_key_mismatch (a kliens új, kulcsos láncot indít)', async () => {
    const db = freshDb();
    seedLegacyChain(db, { decision: 'reject_all', a: 0, m: 0 });
    const env = makeEnv(db);
    const res = await handleConsent(post(decision({ revision: 2 })), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('consent_key_mismatch');
  });
});

describe('R7 — helyi tárhely törölve, a süti megmarad, majd visszavonás', () => {
  it('a visszavonás kulcs nélkül is eljut, és a korábban sorba állított esemény újraküldése elmarad', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    expect((await handleConsent(post(decision()), env)).status).toBe(204);
    // A kulcs-süti elveszett (csak a hozzájárulási süti maradt) → kulcs nélküli visszavonás.
    const res = await handleConsent(post(decision({ ...WITHDRAW, revision: 2 })), env);
    expect(res.status).toBe(204);
    expect((await stateOf(env))?.decision).toBe('withdrawn');
    const replay = await checkReplayConsent(env, SITE as never, {
      platform: 'meta', site_id: 'review', hostname: HOST, consent_id: CID
    } as never);
    expect(replay).toMatchObject({ success: true, skipped: true, skip_reason: 'consent_withdrawn' });
  });
});

describe('R7 — két lap egyidejű döntése', () => {
  it('egyszerre induló első döntések: pontosan EGY kulcs kötődik; a vesztes a kapott kulccsal újrapróbál', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const [a, b] = await Promise.all([
      handleConsent(post(decision({ ...REJECT })), env),
      handleConsent(post(decision({ revision: 2 })), env)
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_chain').get()).toEqual({ n: 1 });
    const keys = [issuedKey(a), issuedKey(b)].filter(Boolean);
    expect(keys).toHaveLength(1);
    const statuses = [a.status, b.status].sort();
    // A győztes 204; a vesztes bővítő döntése 403 (vagy, ha az elsőnek érkezett, a szigorító 204).
    expect(statuses[0]).toBe(204);
    // A böngésző mostantól a győztes kulcsát küldi → a vesztes döntés újraküldése igazolt.
    const loserBody = b.status === 403 ? decision({ revision: 2 }) : decision({ ...REJECT, revision: 3 });
    const retry = await handleConsent(post(loserBody, keys[0]), env);
    expect(retry.status).toBe(204);
  });

  it('azonos revision két lapról: determinisztikus — a későbbi döntés, egyezésnél a szigorúbb', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const key = issuedKey(await handleConsent(post(decision(REJECT)), env));
    const t = new Date().toISOString();
    await handleConsent(post(decision({ revision: 2, client_decided_at: t }), key), env);
    await handleConsent(post(decision({ ...REJECT, revision: 2, client_decided_at: t }), key), env);
    expect((await stateOf(env))?.decision).toBe('reject_all');
    const later = new Date(Date.now() + 2000).toISOString();
    await handleConsent(post(decision({ revision: 2, client_decided_at: later }), key), env);
    expect((await stateOf(env))?.decision).toBe('accept_all');
  });
});

describe('R7 — fordított sorrend és ismételt kérés', () => {
  it('rev3 visszavonás előbb, rev2 engedély később: az állapot withdrawn; ismétlés idempotens 204', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    const key = issuedKey(await handleConsent(post(decision()), env));
    const rev3 = decision({ ...WITHDRAW, revision: 3 });
    const rev2 = decision({ revision: 2 });
    expect((await handleConsent(post(rev3, key), env)).status).toBe(204);
    expect((await handleConsent(post(rev2, key), env)).status).toBe(204);
    expect((await stateOf(env))?.decision).toBe('withdrawn');
    // Ismétlés kulcs NÉLKÜL is (elveszett válasz utáni retry): a már tárolt esemény 204.
    expect((await handleConsent(post(rev2), env)).status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_log').get()).toEqual({ n: 3 });
  });
});

describe('R7 — adatbázishiba és helyreállás', () => {
  it('olvasási hiba → 503, nincs írás, nincs kulcs; helyreállás után ugyanaz a kérés 204', async () => {
    const db = freshDb();
    const body = decision();
    const down = await handleConsent(post(body), makeEnv(db, { reads: true }));
    expect(down.status).toBe(503);
    expect(issuedKey(down)).toBeUndefined();
    const up = await handleConsent(post(body), makeEnv(db));
    expect(up.status).toBe(204);
    expect(issuedKey(up)).toBeDefined();
  });

  it('írási hiba az első kötésnél → 503, se sor, se kötés (atomi), és nincs kiadott kulcs', async () => {
    const db = freshDb();
    const res = await handleConsent(post(decision()), makeEnv(db, { writes: true }));
    expect(res.status).toBe(503);
    expect(issuedKey(res)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_chain').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM consent_log').get()).toEqual({ n: 0 });
  });

  it('replay olvasási hibánál: nem küld, és nem dobja el (CONSENT_STATE_UNAVAILABLE)', async () => {
    const db = freshDb();
    await handleConsent(post(decision()), makeEnv(db));
    const replay = await checkReplayConsent(makeEnv(db, { reads: true }), SITE as never, {
      platform: 'meta', site_id: 'review', hostname: HOST, consent_id: CID
    } as never);
    expect(replay?.success).toBe(false);
    expect(replay?.skipped).toBeUndefined();
  });
});

describe('R7 — „később érkezett" a beszúrási sorrend, nem az időbélyeg', () => {
  it('azonos milliszekundumban érkező igazolatlan visszavonás is érvényesül', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision()), env);
    await handleConsent(post(decision({ ...WITHDRAW, revision: 2 })), env);
    // A két sor időbélyegét egyenlővé tesszük — a régi `>` összehasonlítás itt elveszítette a szigorítást.
    db.exec(`UPDATE consent_log SET server_received_at = '2026-10-18T10:00:00.000Z'`);
    expect((await stateOf(env))?.decision).toBe('withdrawn');
  });
});

describe('R7 — revision-felpumpálás nem fedheti el a visszavonást (független utóellenőrzés)', () => {
  it('régi lánc: a támadó a változatlan engedélyt magas revisionre tolja, a tulajdonos visszavonása mégis érvényes', async () => {
    const db = freshDb();
    seedLegacyChain(db);
    const env = makeEnv(db);
    for (const rev of [21, 41, 61]) {
      expect((await handleConsent(post(decision({ revision: rev }), ATTACKER_KEY), env)).status).toBe(204);
    }
    expect((await handleConsent(post(decision({ ...WITHDRAW, revision: 2 })), env)).status).toBe(204);
    expect((await stateOf(env))?.decision).toBe('withdrawn');
  });

  it('védett lánc: ugyanez a kulcs elvesztése után', async () => {
    const db = freshDb();
    const env = makeEnv(db);
    await handleConsent(post(decision()), env);
    for (const rev of [21, 41]) await handleConsent(post(decision({ revision: rev }), ATTACKER_KEY), env);
    expect((await handleConsent(post(decision({ ...WITHDRAW, revision: 2 })), env)).status).toBe(204);
    expect((await stateOf(env))?.decision).toBe('withdrawn');
  });
});
