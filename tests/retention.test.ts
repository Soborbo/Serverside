import { describe, it, expect } from 'vitest';
import {
  resolveRetentionDays,
  cutoffIso,
  buildRetentionPolicies,
  deleteSql,
  DEFAULT_RETENTION_DAYS
} from '../src/lib/retention';

describe('resolveRetentionDays', () => {
  it('defaults to 90 when unset', () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('parses a valid positive integer', () => {
    expect(resolveRetentionDays('30')).toBe(30);
  });

  it('falls back on invalid / non-positive input', () => {
    expect(resolveRetentionDays('0')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('-5')).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('abc')).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('honours a custom fallback of 0 (opt-in OFF)', () => {
    expect(resolveRetentionDays(undefined, 0)).toBe(0);
    expect(resolveRetentionDays('not-a-number', 0)).toBe(0);
  });
});

describe('cutoffIso', () => {
  it('subtracts N days from now and returns ISO', () => {
    const now = Date.parse('2026-06-27T00:00:00.000Z');
    expect(cutoffIso(now, 90)).toBe('2026-03-29T00:00:00.000Z');
  });
});

describe('buildRetentionPolicies', () => {
  it('purges only operational tables (+ consent_debug/log/metrics) by default', () => {
    const tables = buildRetentionPolicies({}).map((p) => p.table);
    expect(tables).toEqual([
      'events_raw',
      'deliveries',
      'idempotency',
      'consent_debug',
      // Soborbo CMP: saját, HOSSZABB ablakkal — nem az operatív 90 nappal.
      'consent_log',
      'consent_metrics'
    ]);
    // A consent-PROOF (receipts) és az üzleti érték marad; a nyers debug-string nem.
    expect(tables).not.toContain('consent_receipts');
    expect(tables).not.toContain('lead_status');
  });

  it('uses RETENTION_DAYS for the operational tables', () => {
    const policies = buildRetentionPolicies({ RETENTION_DAYS: '30' });
    // A consent-táblák SAJÁT ablakot kapnak (debug 14 nap, log 3 év, metrics 12
    // hónap) — ha a RETENTION_DAYS-t követnék, a consent-proof 30 nap múlva
    // eltűnne, a nyers debug-string pedig hónapokig állna.
    const operational = policies.filter((p) => !p.table.startsWith('consent_'));
    expect(operational.map((p) => p.table)).toEqual(['events_raw', 'deliveries', 'idempotency']);
    expect(operational.every((p) => p.days === 30)).toBe(true);
  });

  it('consent_log: 3 év, a server_received_at-en — proof, de nem végtelen', () => {
    const log = buildRetentionPolicies({ RETENTION_DAYS: '30' }).find((p) => p.table === 'consent_log');
    expect(log?.days).toBe(3 * 365);
    expect(deleteSql(log!)).toBe('DELETE FROM consent_log WHERE server_received_at < ?1');
  });

  it('consent_metrics: 12 hónap (ID-mentes UX-mérés, nem bizonyíték)', () => {
    const metrics = buildRetentionPolicies({}).find((p) => p.table === 'consent_metrics');
    expect(metrics?.days).toBe(365);
    expect(deleteSql(metrics!)).toBe('DELETE FROM consent_metrics WHERE shown_at < ?1');
  });

  it('a consent_log/metrics ablak env-vel felülírható', () => {
    const policies = buildRetentionPolicies({
      CONSENT_LOG_RETENTION_DAYS: '400',
      CONSENT_METRICS_RETENTION_DAYS: '90'
    });
    expect(policies.find((p) => p.table === 'consent_log')?.days).toBe(400);
    expect(policies.find((p) => p.table === 'consent_metrics')?.days).toBe(90);
  });

  it('purges consent_debug after 14 days — NOT opt-in, NOT the 90-day window', () => {
    // A tábla nyers consent-stringeket tárol (consentid-vel). Rövid életű
    // bizonyíték, nem napló: ha a RETENTION_DAYS-t követné, hónapokig állna.
    const debug = buildRetentionPolicies({ RETENTION_DAYS: '90' }).find(
      (p) => p.table === 'consent_debug'
    );
    expect(debug?.days).toBe(14);
    expect(deleteSql(debug!)).toBe('DELETE FROM consent_debug WHERE created_at < ?1');
  });

  it('a consent_debug ablak env-vel felülírható', () => {
    const debug = buildRetentionPolicies({ CONSENT_DEBUG_RETENTION_DAYS: '7' }).find(
      (p) => p.table === 'consent_debug'
    );
    expect(debug?.days).toBe(7);
  });

  it('protects the do_not_replay suppression list on idempotency', () => {
    const idem = buildRetentionPolicies({}).find((p) => p.table === 'idempotency');
    expect(idem?.guard).toBe('do_not_replay = 0');
    expect(deleteSql(idem!)).toBe(
      'DELETE FROM idempotency WHERE last_seen_at < ?1 AND do_not_replay = 0'
    );
  });

  it('opts in consent_receipts / lead_status only when env is set', () => {
    const policies = buildRetentionPolicies({
      CONSENT_RETENTION_DAYS: '365',
      LEAD_RETENTION_DAYS: '730'
    });
    const consent = policies.find((p) => p.table === 'consent_receipts');
    const lead = policies.find((p) => p.table === 'lead_status');
    expect(consent?.days).toBe(365);
    expect(lead?.days).toBe(730);
  });

  it('ignores consent/lead opt-in when value is invalid', () => {
    const tables = buildRetentionPolicies({ CONSENT_RETENTION_DAYS: '0' }).map((p) => p.table);
    expect(tables).not.toContain('consent_receipts');
  });
});

describe('deleteSql', () => {
  it('builds a parameterized delete without guard', () => {
    expect(deleteSql({ table: 'events_raw', column: 'received_at', days: 90 })).toBe(
      'DELETE FROM events_raw WHERE received_at < ?1'
    );
  });
});
