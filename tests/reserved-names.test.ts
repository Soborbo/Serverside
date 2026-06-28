import { describe, it, expect } from 'vitest';
import events from '../src/events.json';

// GA4 automatikus/fenntartott események — egy kanonikus név SEM ütközhet velük
// (ezért `scroll_depth` ≠ `scroll`, `video_play` ≠ `video_start`).
const GA4_RESERVED = new Set([
  'scroll', 'form_start', 'form_submit', 'video_start', 'video_progress', 'video_complete',
  'click', 'page_view', 'session_start', 'first_visit', 'user_engagement', 'first_open'
]);

describe('canonical events', () => {
  it('no event name collides with a GA4 reserved name', () => {
    const collisions = events.map((e) => e.name).filter((n) => GA4_RESERVED.has(n));
    expect(collisions).toEqual([]);
  });

  it('every conversion has a Meta event and a non-empty channel set', () => {
    for (const e of events.filter((e) => e.kind === 'conversion')) {
      expect(e.meta, e.name).toBeTruthy();
      expect(e.channels.length, e.name).toBeGreaterThan(0);
    }
  });

  it('names are snake_case and unique', () => {
    const names = events.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('offline events are server-only with no Meta event', () => {
    for (const e of events.filter((e) => e.kind === 'offline')) {
      expect(e.channels, e.name).toEqual(['server']);
      expect(e.meta, e.name).toBeNull();
    }
  });
});
