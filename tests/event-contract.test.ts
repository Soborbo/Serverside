import { describe, it, expect } from 'vitest';
import events from '../src/events.json';
import {
  ALLOWED_EVENT_NAMES,
  EVENT_NAME_MAP,
  canonicalizeEventName,
  CANONICAL_EVENTS
} from '../src/types';
import { VALID_LEAD_STATUSES } from '../src/lib/ledger';

describe('event contract (events.json → derived artefacts)', () => {
  it('CANONICAL_EVENTS mirrors events.json', () => {
    expect(CANONICAL_EVENTS.map((e) => e.name)).toEqual(events.map((e) => e.name));
  });

  it('ingress allowlist = server-channel non-offline events + their legacy aliases', () => {
    const ingress = events.filter((e) => e.channels.includes('server') && e.kind !== 'offline');
    for (const e of ingress) {
      expect(ALLOWED_EVENT_NAMES.has(e.name), e.name).toBe(true);
      if (e.legacy_ga4) expect(ALLOWED_EVENT_NAMES.has(e.legacy_ga4), e.legacy_ga4).toBe(true);
    }
    // Offline events come via /lead-status (admin), NOT the conversion ingress.
    for (const e of events.filter((e) => e.kind === 'offline')) {
      expect(ALLOWED_EVENT_NAMES.has(e.name), e.name).toBe(false);
    }
    // Browser-only milestones are never accepted as a conversion-ingress POST.
    expect(ALLOWED_EVENT_NAMES.has('quote_calculator_opened')).toBe(false);
    expect(ALLOWED_EVENT_NAMES.has('scroll_depth')).toBe(false);
  });

  it('canonicalizeEventName maps every legacy alias to its canonical name', () => {
    for (const e of events.filter((e) => e.legacy_ga4)) {
      expect(canonicalizeEventName(e.legacy_ga4 as string), e.legacy_ga4 as string).toBe(e.name);
    }
    // Unknown / already-canonical names pass through unchanged.
    expect(canonicalizeEventName('quote_calculator_submitted')).toBe('quote_calculator_submitted');
    expect(canonicalizeEventName('totally_unknown')).toBe('totally_unknown');
  });

  it('EVENT_NAME_MAP covers canonical + legacy keys for every event with a Meta event', () => {
    for (const e of events.filter((e) => e.meta)) {
      expect(EVENT_NAME_MAP[e.name], e.name).toBe(e.meta);
      if (e.legacy_ga4) expect(EVENT_NAME_MAP[e.legacy_ga4 as string]).toBe(e.meta);
    }
  });

  it('every lead-status CRM event exists as an offline event in events.json', () => {
    const offline = new Set(events.filter((e) => e.kind === 'offline').map((e) => e.name));
    for (const status of VALID_LEAD_STATUSES) {
      expect(offline.has(status), status).toBe(true);
    }
  });
});
