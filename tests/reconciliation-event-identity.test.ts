import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeSiteDrift, fetchReconInputs } from '../src/lib/reconciliation';
import { recordRetryDelivery } from '../src/scheduled/retry';
import type { DeadLetterRecord } from '../src/lib/deadletter';
import type { SiteConfig } from '../src/lib/config';
import type { Env } from '../src/env';

/**
 * 2026-10-18 review R4 + R5 — a reconciliation EGYEDI eseményeket és VÉGSŐ
 * kézbesítési állapotot számol, a VALÓDI migrációkon és a VALÓDI SQL-en.
 *
 * R4: a nem jogosult eventek consent-skipjeit a coverage-alapból KÉTSZER vontuk
 *     le, így a teljes kiesés néma maradt.
 * R5: a sikeres offline retry (`origin='retry'`) láthatatlan volt az offline
 *     Google-láb ellenőrzésének.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

/** Minimális D1-adapter a node:sqlite fölött. */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => db.prepare(sql).run(...(args as never[]))
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (items: Array<{ run: () => Promise<unknown> }>) => {
      for (const i of items) await i.run();
    }
  };
}

const SITE = { site_id: 'review', country_code: 'GB', currency: 'GBP' } as SiteConfig;
let seq = 0;
const now = () => new Date().toISOString();
const since = () => new Date(Date.now() - 86_400_000).toISOString();

function insertEvent(db: DatabaseSync, eventId: string, adAllowed: 0 | 1) {
  db.prepare(
    `INSERT INTO events_raw (id, event_id, site_id, hostname, event_name, event_time, ad_allowed, received_at)
     VALUES (?, ?, 'review', 'review.example', 'contact_form_submitted', 0, ?, ?)`
  ).run(`e${++seq}`, eventId, adAllowed, now());
}

function insertDelivery(
  db: DatabaseSync,
  d: { event_id: string; platform: string; status: string; origin: string; skip_reason?: string; event_name?: string; http?: number }
) {
  db.prepare(
    `INSERT INTO deliveries (id, event_id, site_id, event_name, platform, status, http_status, origin, created_at, skip_reason)
     VALUES (?, ?, 'review', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `d${++seq}`, d.event_id, d.event_name ?? 'contact_form_submitted', d.platform, d.status,
    d.http ?? (d.status === 'skipped' ? null : 200), d.origin, now(), d.skip_reason ?? null
  );
}

async function metaFindings(db: DatabaseSync) {
  const env = { LEDGER: d1(db) } as unknown as Env;
  const inputs = await fetchReconInputs(env, since(), [SITE], true);
  return { input: inputs![0], findings: computeSiteDrift(inputs![0]).filter((f) => f.kind === 'coverage_drift') };
}

describe('R4 — Meta-lefedettség egyedi event_id szerint', () => {
  it('100 event: 80 tiltott (consent-skip) + 20 jogosult, 0 kézbesítés → CRITICAL coverage_drift', async () => {
    const db = freshDb();
    for (let i = 0; i < 80; i++) {
      insertEvent(db, `denied-${i}`, 0);
      insertDelivery(db, { event_id: `denied-${i}`, platform: 'meta', status: 'skipped', origin: 'fanout', skip_reason: 'consent_denied' });
    }
    for (let i = 0; i < 20; i++) insertEvent(db, `ok-${i}`, 1);
    const { findings } = await metaFindings(db);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', value: 0 });
  });

  it('a pure függvény régi (coverage nélküli) alakján is riaszt — a skipped sorok nem csökkentik az alapot', () => {
    const findings = computeSiteDrift({
      site_id: 'review', events_total: 100, ad_eligible: 20, lead_status_total: 0,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 0, skipped: 80 }]
    });
    expect(findings.map((f) => f.kind)).toContain('coverage_drift');
  });

  it('ismételt kézbesítés (fanout + retry ugyanarra az eventre) nem tolja 100% fölé', async () => {
    const db = freshDb();
    for (let i = 0; i < 20; i++) {
      insertEvent(db, `ok-${i}`, 1);
      insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'accepted', origin: 'fanout' });
      insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'accepted', origin: 'retry' });
    }
    const { input, findings } = await metaFindings(db);
    expect(findings).toEqual([]);
    expect(input.platforms.find((p) => p.platform === 'meta')!.coverage).toEqual({ eligible: 20, delivered: 20, excused: 0 });
  });

  it('a fele kézbesítve, a másik fele egy KÉSŐBBI retry-n → teljes lefedettség', async () => {
    const db = freshDb();
    for (let i = 0; i < 20; i++) {
      insertEvent(db, `ok-${i}`, 1);
      if (i < 10) insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'accepted', origin: 'fanout' });
      else {
        insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'rejected', origin: 'fanout', http: 500 });
        insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'accepted', origin: 'retry' });
      }
    }
    expect((await metaFindings(db)).findings).toEqual([]);
  });

  it('szándékosan nem elvárt Meta (not_expected) → nincs drift', async () => {
    const db = freshDb();
    for (let i = 0; i < 30; i++) {
      insertEvent(db, `ok-${i}`, 1);
      insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'skipped', origin: 'fanout', skip_reason: 'not_expected' });
    }
    expect((await metaFindings(db)).findings).toEqual([]);
  });

  it('ELVÁRT, de hiányzó config (not_configured) NEM tűnik el az alapból → CRITICAL', async () => {
    const db = freshDb();
    for (let i = 0; i < 30; i++) {
      insertEvent(db, `ok-${i}`, 1);
      insertDelivery(db, { event_id: `ok-${i}`, platform: 'meta', status: 'skipped', origin: 'fanout', skip_reason: 'not_configured' });
    }
    const { findings } = await metaFindings(db);
    expect(findings[0]?.severity).toBe('critical');
  });
});

describe('R5 — az offline Google-láb látja a sikeres retry-t, eseményenként egyszer', () => {
  function gadsRecord(eventId: string): DeadLetterRecord {
    return {
      platform: 'gads',
      site_id: 'review',
      hostname: 'review.example',
      lead_id: 'lead-12345678',
      event_payload: { event_name: 'lead_qualified', event_id: eventId },
      failure_reason: 'test',
      retry_count: 0,
      first_failed_at: now(),
      last_attempted_at: now()
    };
  }
  function insertLeadStatus(db: DatabaseSync, orderId: string) {
    db.prepare(
      `INSERT INTO lead_status (id, lead_id, site_id, status, order_id, occurred_at, created_at)
       VALUES (?, 'lead-12345678', 'review', 'lead_qualified', ?, ?, ?)`
    ).run(`ls${++seq}`, orderId, now(), now());
  }
  async function offlineLeg(db: DatabaseSync) {
    const env = { LEDGER: d1(db) } as unknown as Env;
    const inputs = await fetchReconInputs(env, since(), [SITE], true);
    return inputs!.find((i) => i.site_id === 'review')!.offline_legs![0];
  }

  it('első offline küldés elutasítva, a retry sikeres → 1 accepted, 0 rejected, helyes utolsó sikeridő', async () => {
    const db = freshDb();
    insertLeadStatus(db, 'order-0001');
    insertDelivery(db, { event_id: 'order-0001', event_name: 'lead_qualified', platform: 'gads', status: 'rejected', origin: 'offline', http: 503 });
    const env = { LEDGER: d1(db) } as unknown as Env;
    await recordRetryDelivery(env, gadsRecord('order-0001'), { success: true, status: 200 });

    const leg = await offlineLeg(db);
    expect(leg).toMatchObject({ received: 1, accepted: 1, rejected: 0 });
    expect(leg.last_accepted_at).not.toBeNull();
  });

  it('többszöri sikeres retry ugyanarra az orderId-re sem többszörös konverzió', async () => {
    const db = freshDb();
    insertLeadStatus(db, 'order-0002');
    const env = { LEDGER: d1(db) } as unknown as Env;
    await recordRetryDelivery(env, gadsRecord('order-0002'), { success: true, status: 200 });
    await recordRetryDelivery(env, gadsRecord('order-0002'), { success: true, status: 200 });
    insertDelivery(db, { event_id: 'order-0002', event_name: 'lead_qualified', platform: 'gads', status: 'accepted', origin: 'offline' });
    expect((await offlineLeg(db)).accepted).toBe(1);
  });

  it('végleg elutasított esemény rejected-ként, a policy-skip a skip-oka alatt számít', async () => {
    const db = freshDb();
    insertLeadStatus(db, 'order-r');
    insertLeadStatus(db, 'order-s');
    insertDelivery(db, { event_id: 'order-r', event_name: 'lead_qualified', platform: 'gads', status: 'rejected', origin: 'offline', http: 400 });
    insertDelivery(db, { event_id: 'order-r', event_name: 'lead_qualified', platform: 'gads', status: 'rejected', origin: 'retry', http: 400 });
    insertDelivery(db, { event_id: 'order-s', event_name: 'lead_qualified', platform: 'gads', status: 'skipped', origin: 'offline', skip_reason: 'consent_withdrawn' });
    const leg = await offlineLeg(db);
    expect(leg).toMatchObject({ accepted: 0, rejected: 1, skips: { consent_withdrawn: 1 } });
  });
});
