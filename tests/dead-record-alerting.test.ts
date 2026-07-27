import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A „Dead records: N" riasztás CSELEKVÉSRE VÁLTHATÓSÁGA.
 *
 * A regresszió: a levél annyit mondott, hogy „Records exceeded max retries: 1 —
 * permanently lost unless manually reprocessed", darabszámmal. A kézi út (single
 * replay) viszont PONTOS R2-kulcsot vár, amit sem a levél, sem bármelyik végpont
 * nem adott meg — vagyis a riasztás egy nem létező eljárásra utasított, miközben
 * a retention órája ketyegett (90 nap, aztán tényleg elveszett).
 *
 * A notify mockja itt az IGAZI escapeHtml-t használja: a levélbe vendor-szöveg
 * (failure_reason) kerül, aminek escape-eltnek kell lennie.
 */
const sentEmails: { subject: string; body: string; severity?: string }[] = [];
vi.mock('../src/lib/notify', () => ({
  sendAlert: async () => {},
  sendCriticalSMS: async () => {},
  throttleOncePer: async () => true,
  sendAdminEmail: async (_env: unknown, subject: string, body: string, severity?: string) => {
    sentEmails.push({ subject, body, severity });
    return true;
  },
  escapeHtml: (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
}));

vi.mock('../src/lib/config', () => ({
  countSiteConfigs: async () => 3
}));

import { handleSloCheck, renderDeadRecordTable } from '../src/scheduled/slo-check';
import { renderDeadRecordList } from '../src/scheduled/daily-digest';
import { summarizeDeadRecord, type DeadLetterRecord } from '../src/lib/deadletter';
import type { Env } from '../src/env';

const DEAD_KEY = 'lomtalan/meta/dead/2026-07-20/10-30-00_evt-dead-1_3_abcd1234.json';

const record: DeadLetterRecord = {
  platform: 'meta',
  site_id: 'lomtalan',
  hostname: 'lomtalan.hu',
  event_payload: { event_id: 'evt-dead-1', event_name: 'quote_calculator_submitted' },
  hashed_user_data: { em: 'a'.repeat(64) },
  failure_reason: 'HTTP 500 <script>alert(1)</script>',
  retry_count: 3,
  first_failed_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  last_attempted_at: new Date().toISOString()
};

function bucketWith(keys: string[]) {
  return {
    list: async () => ({
      objects: keys.map((key) => ({ key, uploaded: new Date() })),
      truncated: false,
      cursor: undefined
    }),
    get: async (key: string) => (keys.includes(key) ? { json: async () => record } : null)
  };
}

beforeEach(() => {
  sentEmails.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('SLO dead-record riasztás — azonosítja a rekordot', () => {
  it('a levél tartalmazza az R2-kulcsot, a site-ot és a futtatható replay-parancsot', async () => {
    await handleSloCheck({ DEAD_LETTER: bucketWith([DEAD_KEY]) } as unknown as Env);

    const email = sentEmails.find((e) => e.subject.startsWith('Dead records'));
    expect(email).toBeDefined();
    expect(email!.subject).toBe('Dead records: 1');
    // Az eddig HIÁNYZÓ információ: MELYIK rekord és HOGYAN kell replay-elni.
    expect(email!.body).toContain(DEAD_KEY);
    expect(email!.body).toContain('lomtalan');
    expect(email!.body).toContain('quote_calculator_submitted');
    expect(email!.body).toContain('/api/event/admin/dlq/dead');
    expect(email!.body).toContain('/api/event/admin/dlq/replay');
  });

  it('PII SOHA nem megy ki a levélben (CLAUDE.md 13.)', async () => {
    await handleSloCheck({ DEAD_LETTER: bucketWith([DEAD_KEY]) } as unknown as Env);
    const email = sentEmails.find((e) => e.subject.startsWith('Dead records'))!;
    expect(email.body).not.toContain('a'.repeat(64));
    expect(email.body).not.toContain('hashed_user_data');
  });

  it('nincs dead rekord → nincs riasztás', async () => {
    const pendingOnly = 'lomtalan/meta/2026-07-26/10-30-00_evt_1_zzzz.json';
    await handleSloCheck({ DEAD_LETTER: bucketWith([pendingOnly]) } as unknown as Env);
    expect(sentEmails.find((e) => e.subject.startsWith('Dead records'))).toBeUndefined();
  });

  it('a részlet-scan hibája NEM nyeli el a riasztást (csak a részleteket veszti)', async () => {
    let call = 0;
    const flakyBucket = {
      // 1. hívás: a darabszámoló scan; utána a részlet-scan dob.
      list: async () => {
        call++;
        if (call > 1) throw new Error('R2 down');
        return {
          objects: [{ key: DEAD_KEY, uploaded: new Date() }],
          truncated: false,
          cursor: undefined
        };
      },
      get: async () => ({ json: async () => record })
    };
    await handleSloCheck({ DEAD_LETTER: flakyBucket } as unknown as Env);
    const email = sentEmails.find((e) => e.subject.startsWith('Dead records'));
    expect(email).toBeDefined();
    expect(email!.body).toContain('/api/event/admin/dlq/dead');
  });
});

describe('render-helperek — vendor-szöveg escape-elve', () => {
  it('renderDeadRecordTable escape-eli a failure_reason-t', () => {
    const html = renderDeadRecordTable([summarizeDeadRecord(DEAD_KEY, record)], 1);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renderDeadRecordList escape-eli a failure_reason-t és jelzi a maradékot', () => {
    const html = renderDeadRecordList([summarizeDeadRecord(DEAD_KEY, record)], 5);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('and 4 more');
  });

  it('részletek nélkül is a felfedező végpontra mutat', () => {
    expect(renderDeadRecordTable([], 2)).toContain('/api/event/admin/dlq/dead');
    expect(renderDeadRecordList([], 2)).toContain('/api/event/admin/dlq/dead');
  });
});
