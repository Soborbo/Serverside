import { describe, it, expect } from 'vitest';
import {
  SKIP_REASONS,
  isSkipReason,
  isTerminalSkip,
  type SkipReason
} from '../src/lib/skip-reason';
import {
  normalizeDelivery,
  recordDeliveries,
  skipReasonFromErrorCode,
  type DeliveryRecord
} from '../src/lib/ledger';
import { TrackingErrorCode } from '../src/lib/error-codes';

/**
 * Fázis D · S2.1 — a skip-ok MEGNEVEZÉSE és perzisztálása.
 *
 * A mérés tétje: 30 nap ledger-adatból 9 olyan `skipped` delivery van, aminek a
 * consent receiptje GRANTED — és mivel egyetlen skipped sornak sincs error_code-ja,
 * a skip oka SEHOL nincs rögzítve. Ezek a tesztek azt őrzik, hogy
 *  (a) minden új ok TERMINÁLIS, és a `not_configured` marad az EGYETLEN retryable,
 *  (b) az ok tényleg a `deliveries.skip_reason` oszlopba kerül.
 */

describe('SkipReason taxonómia', () => {
  it('a not_configured az EGYETLEN nem-terminális ok', () => {
    const retryable = SKIP_REASONS.filter((r) => !isTerminalSkip(r));
    expect(retryable).toEqual(['not_configured']);
  });

  it('minden Fázis D-ben felvett ok terminális', () => {
    const phaseD: SkipReason[] = [
      'consent_missing_failclosed',
      'consent_missing_legacy',
      'consent_uncertain_failclosed',
      'no_identifiers',
      'dedup',
      'eea_rule',
      'template_guard'
    ];
    for (const r of phaseD) expect(isTerminalSkip(r)).toBe(true);
  });

  it('a hiányzó ok (undefined) terminális marad — fail-safe, nincs örök DLQ-keringés', () => {
    expect(isTerminalSkip(undefined)).toBe(true);
  });

  it('a not_expected és a not_configured KÜLÖN ok marad (2026-07-15 tanulsága)', () => {
    expect(isTerminalSkip('not_expected')).toBe(true);
    expect(isTerminalSkip('not_configured')).toBe(false);
  });

  it('isSkipReason csak a taxonómia tagjait fogadja el', () => {
    expect(isSkipReason('consent_uncertain_failclosed')).toBe(true);
    expect(isSkipReason('consent_uncertain')).toBe(false);
    expect(isSkipReason(undefined)).toBe(false);
  });
});

describe('skipReasonFromErrorCode', () => {
  it('a csak-error_code-dal jelző offline skipeket is megnevezi', () => {
    expect(skipReasonFromErrorCode(TrackingErrorCode.PLATFORM_NOT_CONFIGURED)).toBe(
      'not_configured'
    );
    expect(skipReasonFromErrorCode(TrackingErrorCode.MISSING_CONVERSION_ACTION)).toBe(
      'not_configured'
    );
    expect(skipReasonFromErrorCode(TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS)).toBe(
      'no_identifiers'
    );
  });

  it('nem erőltet okot oda, ahova nem illik (validate-only)', () => {
    expect(skipReasonFromErrorCode(TrackingErrorCode.DATAMANAGER_VALIDATE_ONLY)).toBeUndefined();
    expect(skipReasonFromErrorCode(undefined)).toBeUndefined();
  });
});

describe('normalizeDelivery → skip_reason', () => {
  it('átviszi a vendor által adott okot', () => {
    const r = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true, skipped: true, skip_reason: 'consent_uncertain_failclosed' }
    });
    expect(r).toEqual({
      platform: 'meta',
      status: 'skipped',
      skip_reason: 'consent_uncertain_failclosed'
    });
  });

  it('error_code mellé is odateszi a levezetett okot', () => {
    const r = normalizeDelivery('gads', {
      status: 'fulfilled',
      value: {
        success: true,
        skipped: true,
        error_code: TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS
      }
    });
    expect(r).toMatchObject({
      status: 'skipped',
      error_code: TrackingErrorCode.DATAMANAGER_NO_IDENTIFIERS,
      skip_reason: 'no_identifiers'
    });
  });

  it('accepted/rejected soron nincs skip_reason', () => {
    const ok = normalizeDelivery('meta', {
      status: 'fulfilled',
      value: { success: true, status: 200 }
    });
    expect(ok.skip_reason).toBeUndefined();
  });
});

/** Minimál D1-stub: az utolsó batch bind-argumentumait őrzi meg. */
function makeLedger() {
  const rows: unknown[][] = [];
  return {
    rows,
    LEDGER: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { sql, args };
          }
        };
      },
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) if (s.sql.includes('INSERT INTO deliveries')) rows.push(s.args);
        return [];
      }
    }
  };
}

describe('recordDeliveries → deliveries.skip_reason', () => {
  const write = async (records: DeliveryRecord[]) => {
    const { rows, LEDGER } = makeLedger();
    await recordDeliveries({ LEDGER } as never, {
      event_id: 'evt-1',
      site_id: 'site',
      event_name: 'callback_request_submitted',
      records
    });
    // A skip_reason az oszloplista VÉGÉN van (0004 ALTER TABLE) → utolsó bind-arg.
    return rows.map((args) => args[args.length - 1]);
  };

  it('kiírja a skipped sor okát', async () => {
    expect(
      await write([{ platform: 'meta', status: 'skipped', skip_reason: 'consent_denied' }])
    ).toEqual(['consent_denied']);
  });

  it('NULL-t ír, ha a skipnek nincs neve (nem-migrált ág)', async () => {
    expect(await write([{ platform: 'msads', status: 'skipped' }])).toEqual([null]);
  });

  it('accepted soron NULL (a skip_reason csak skipre értelmes)', async () => {
    expect(
      await write([{ platform: 'meta', status: 'accepted', http_status: 200 }])
    ).toEqual([null]);
  });
});
