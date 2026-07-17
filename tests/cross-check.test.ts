import { describe, it, expect } from 'vitest';
import {
  compareCrossCounts,
  invertOnsiteActions,
  buildGadsCrossCheckQuery,
  parseGadsCrossCheckResponse,
  buildGa4RunReportBody,
  parseGa4RunReportResponse,
  assembleLedgerCounts,
  GA4_CHECK_EVENTS,
  DEFAULT_CROSS_CHECK_THRESHOLDS
} from '../src/lib/cross-check';

const EVENTS = ['callback_request_submitted', 'quote_calculator_submitted'];

describe('compareCrossCounts', () => {
  it('returns nothing when the counts agree', () => {
    expect(
      compareCrossCounts(
        'painless',
        'gads',
        EVENTS,
        { callback_request_submitted: 4, quote_calculator_submitted: 3 },
        { callback_request_submitted: 4, quote_calculator_submitted: 3 }
      )
    ).toEqual([]);
  });

  // A 2026-07-15-i valós eset: ledger 4 callback / 3 kalkulátor, GA4 2 / 1 —
  // pontosan ezt az osztályt kell elkapnia.
  it('flags the real 2026-07-15 divergence as critical', () => {
    const findings = compareCrossCounts(
      'lomtalan',
      'ga4',
      EVENTS,
      { callback_request_submitted: 4, quote_calculator_submitted: 3 },
      { callback_request_submitted: 2, quote_calculator_submitted: 1 }
    );
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === 'critical')).toBe(true);
    expect(findings[0].ledger_count).toBe(4);
    expect(findings[0].platform_count).toBe(2);
  });

  it('flags the reverse direction too (platform > ledger = gateway leg broken)', () => {
    const findings = compareCrossCounts(
      'painless',
      'gads',
      ['callback_request_submitted'],
      { callback_request_submitted: 0 },
      { callback_request_submitted: 5 }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].value).toBe(1);
  });

  it('stays silent under minSample (1 vs 2 is noise, not drift)', () => {
    expect(
      compareCrossCounts(
        'painless',
        'ga4',
        ['callback_request_submitted'],
        { callback_request_submitted: 1 },
        { callback_request_submitted: 2 }
      )
    ).toEqual([]);
  });

  it('warns between the warn and crit thresholds', () => {
    // 10 vs 7 → 30% diff: warn (>=25%), nem crit (<50%)
    const findings = compareCrossCounts(
      'painless',
      'gads',
      ['quote_calculator_submitted'],
      { quote_calculator_submitted: 10 },
      { quote_calculator_submitted: 7 }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('ignores events outside the check set', () => {
    expect(
      compareCrossCounts(
        'painless',
        'gads',
        ['quote_calculator_submitted'],
        { phone_number_clicked: 50 },
        { quote_calculator_submitted: 0, phone_number_clicked: 3 }
      )
    ).toEqual([]);
  });

  it('treats a missing key as zero on either side', () => {
    const findings = compareCrossCounts(
      'painless',
      'ga4',
      ['quote_calculator_submitted'],
      { quote_calculator_submitted: 6 },
      {}
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].platform_count).toBe(0);
    expect(findings[0].severity).toBe('critical');
  });
});

describe('GA4_CHECK_EVENTS (events.json-ból származtatva)', () => {
  it('uses the legacy GA4 alias where one exists', () => {
    const quote = GA4_CHECK_EVENTS.find((e) => e.event_name === 'quote_calculator_submitted');
    expect(quote?.ga4_name).toBe('quote_calculator_conversion');
    const callback = GA4_CHECK_EVENTS.find((e) => e.event_name === 'callback_request_submitted');
    expect(callback?.ga4_name).toBe('callback_conversion');
  });

  it('only contains conversion-kind key events (offline CRM statuses excluded)', () => {
    expect(GA4_CHECK_EVENTS.some((e) => e.event_name === 'revenue_confirmed')).toBe(false);
    expect(GA4_CHECK_EVENTS.some((e) => e.event_name === 'scroll_depth')).toBe(false);
  });
});

describe('Google Ads query + parser', () => {
  it('builds a conversion-date query for the given day', () => {
    const q = buildGadsCrossCheckQuery('2026-07-15');
    expect(q).toContain('metrics.all_conversions_by_conversion_date');
    expect(q).toContain("segments.date = '2026-07-15'");
    expect(q).toContain('FROM customer');
  });

  it('rejects a malformed date (GAQL injection guard)', () => {
    expect(() => buildGadsCrossCheckQuery("2026-07-15' OR 1=1")).toThrow();
  });

  it('maps action names back to event names and sums duplicates', () => {
    const nameToEvent = invertOnsiteActions({
      callback_request_submitted: 'Callback requested',
      quote_calculator_submitted: 'Quote calculator finished'
    });
    const counts = parseGadsCrossCheckResponse(
      {
        results: [
          {
            segments: { conversionActionName: 'Callback requested' },
            metrics: { allConversionsByConversionDate: 2 }
          },
          {
            segments: { conversionActionName: 'Quote calculator finished' },
            metrics: { allConversionsByConversionDate: 3 }
          },
          // nem mappelt action (pl. hívás-követés) → figyelmen kívül
          {
            segments: { conversionActionName: 'Calls from ads' },
            metrics: { allConversionsByConversionDate: 7 }
          }
        ]
      },
      nameToEvent
    );
    expect(counts).toEqual({
      callback_request_submitted: 2,
      quote_calculator_submitted: 3
    });
  });

  it('tolerates an empty / malformed response', () => {
    expect(parseGadsCrossCheckResponse({}, {})).toEqual({});
    expect(parseGadsCrossCheckResponse({ results: [{}] }, {})).toEqual({});
  });
});

describe('GA4 body + parser', () => {
  it('builds a single-day runReport filtered to the mapped names', () => {
    const body = buildGa4RunReportBody('2026-07-15', ['callback_conversion']) as {
      dateRanges: Array<{ startDate: string; endDate: string }>;
      dimensionFilter: { filter: { inListFilter: { values: string[] } } };
    };
    expect(body.dateRanges).toEqual([{ startDate: '2026-07-15', endDate: '2026-07-15' }]);
    expect(body.dimensionFilter.filter.inListFilter.values).toEqual(['callback_conversion']);
  });

  it('rejects a malformed date', () => {
    expect(() => buildGa4RunReportBody('yesterday', [])).toThrow();
  });

  it('maps legacy GA4 names back to canonical event names', () => {
    const counts = parseGa4RunReportResponse(
      {
        rows: [
          {
            dimensionValues: [{ value: 'callback_conversion' }],
            metricValues: [{ value: '2' }]
          },
          {
            dimensionValues: [{ value: 'quote_calculator_conversion' }],
            metricValues: [{ value: '1' }]
          },
          // nem várt event a válaszban → figyelmen kívül
          { dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '900' }] }
        ]
      },
      {
        callback_conversion: 'callback_request_submitted',
        quote_calculator_conversion: 'quote_calculator_submitted'
      }
    );
    expect(counts).toEqual({
      callback_request_submitted: 2,
      quote_calculator_submitted: 1
    });
  });

  it('tolerates an empty response (no rows on zero-traffic days)', () => {
    expect(parseGa4RunReportResponse({}, {})).toEqual({});
  });
});

describe('assembleLedgerCounts', () => {
  it('groups rows per site and event', () => {
    const map = assembleLedgerCounts([
      { site_id: 'painless', event_name: 'callback_request_submitted', total: 4 },
      { site_id: 'painless', event_name: 'quote_calculator_submitted', total: 3 },
      { site_id: 'lomtalan', event_name: 'quote_calculator_submitted', total: 2 }
    ]);
    expect(map.get('painless')).toEqual({
      callback_request_submitted: 4,
      quote_calculator_submitted: 3
    });
    expect(map.get('lomtalan')).toEqual({ quote_calculator_submitted: 2 });
    expect(map.get('nosite')).toBeUndefined();
  });
});

describe('DEFAULT_CROSS_CHECK_THRESHOLDS', () => {
  it('is tuned so daily lead volumes (3-5/day) are actionable but 1-2 diffs are not', () => {
    expect(DEFAULT_CROSS_CHECK_THRESHOLDS.minSample).toBe(3);
    expect(DEFAULT_CROSS_CHECK_THRESHOLDS.relDiffWarn).toBeLessThan(
      DEFAULT_CROSS_CHECK_THRESHOLDS.relDiffCrit
    );
  });
});
