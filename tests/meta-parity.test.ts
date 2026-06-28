import { describe, it, expect } from 'vitest';
import events from '../src/events.json';
import { EVENT_NAME_MAP } from '../src/types'; // events.json-ból generálva

describe('Meta event-name parity', () => {
  it('server EVENT_NAME_MAP matches the canonical meta field for every server event', () => {
    for (const e of events.filter((e) => e.meta && e.channels.includes('server'))) {
      expect(EVENT_NAME_MAP[e.name], e.name).toBe(e.meta);
    }
    // A böngésző/szerver eltérés (Lead vs Contact) okozta a régi dedup-bugot — ez őrzi.
  });

  it('legacy GA4 alias maps to the same Meta event as its canonical name', () => {
    for (const e of events.filter((e) => e.meta && e.legacy_ga4)) {
      expect(EVENT_NAME_MAP[e.legacy_ga4 as string], e.legacy_ga4 as string).toBe(e.meta);
    }
  });
});
