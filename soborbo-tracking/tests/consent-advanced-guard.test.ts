import { describe, it, expect } from 'vitest';
import { advancedModeBlocker } from '../lib/config';

/**
 * Döntés (2026-11-03): EEA/UK alatt a basic a kötelező alap. Az advanced mód
 * süti nélküli pingjei döntés előtt is mennek, ezért csak dokumentált jogi
 * jóváhagyással buildelhető — a <Tracking /> build-időben dobja ezt a hibát.
 */
describe('advancedModeBlocker — az advanced mód kapuja', () => {
  it('basic mód mindig megengedett', () => {
    expect(advancedModeBlocker('basic', 'eea_uk', undefined)).toBeNull();
  });

  it('advanced + eea_uk jóváhagyás nélkül → hiba', () => {
    expect(advancedModeBlocker('advanced', 'eea_uk', undefined)).toMatch(/jogi jóváhagyás/);
    expect(advancedModeBlocker('advanced', 'eea_uk', '')).not.toBeNull();
  });

  it('formailag hibás jóváhagyás nem elég (dátum ÉS hivatkozás kell)', () => {
    expect(advancedModeBlocker('advanced', 'eea_uk', 'igen')).not.toBeNull();
    expect(advancedModeBlocker('advanced', 'eea_uk', '2026-12-01')).not.toBeNull();
    expect(advancedModeBlocker('advanced', 'eea_uk', '2026-12-01:x')).not.toBeNull();
  });

  it('advanced + eea_uk dátumozott, hivatkozott jóváhagyással → megengedett', () => {
    expect(advancedModeBlocker('advanced', 'eea_uk', '2026-12-01:dpo-memo-2026-12')).toBeNull();
    expect(advancedModeBlocker('advanced', 'eea_uk', ' 2026-12-01:legal/advanced-v1 ')).toBeNull();
  });

  it('nem EEA/UK ruleset alatt az őr nem szól bele', () => {
    expect(advancedModeBlocker('advanced', 'us', undefined)).toBeNull();
  });
});

// A komponens NYERS forrása — ugyanaz a Vite-minta, mint a consent-boot-parity
// tesztben (a csomagban szándékosan nincs @types/node).
const RAW = (import.meta as unknown as {
  glob: (p: string, o: unknown) => Record<string, string>;
}).glob('../components/Tracking.astro', { query: '?raw', eager: true, import: 'default' });

describe('<Tracking /> — az őr build-időben fut', () => {
  it('sbo ágon meghívja az advancedModeBlocker-t, és hibát dob', () => {
    const src = Object.values(RAW)[0]!;
    const front = src.split('---')[1] ?? '';
    expect(front).toMatch(/if \(isSbo\) \{[\s\S]*advancedModeBlocker\([\s\S]*PUBLIC_TRACKING_ADVANCED_APPROVAL[\s\S]*throw new Error\(blocker\)/);
  });
});
