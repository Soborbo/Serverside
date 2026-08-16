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
  it('purges only operational tables (+ consent_debug) by default', () => {
    const tables = buildRetentionPolicies({}).map((p) => p.table);
    expect(tables).toEqual(['events_raw', 'deliveries', 'idempotency', 'consent_debug']);
    // A consent-PROOF és az üzleti érték marad; a nyers debug-string nem.
    expect(tables).not.toContain('consent_receipts');
    expect(tables).not.toContain('lead_status');
  });

  it('uses RETENTION_DAYS for the operational tables', () => {
    const policies = buildRetentionPolicies({ RETENTION_DAYS: '30' });
    const operational = policies.filter((p) => p.table !== 'consent_debug');
    expect(operational.every((p) => p.days === 30)).toBe(true);
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
