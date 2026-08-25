import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// F4-1(b) — a drift-őr CÍMZETTJÉNEK strukturális kapuja.
//
// 2026-08-25: az őr napi futása hetek óta nem driftet jelzett, hanem HTTP 404-gyel
// bukott: a bázis-URL a `*.workers.dev` subdomain volt, amit a Cloudflare nem
// irányít erre a Workerre — a kérés el sem jutott hozzá. A drift-figyelés maga
// volt néma, miközben pirosnak látszott. Ez a teszt a CÍMZETTET rögzíti, hogy a
// visszaesés fordításkor bukjon, ne egy hónap múlva egy CI-log alján.
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW = readFileSync(
  new URL('../.github/workflows/version-drift.yml', import.meta.url),
  'utf8'
);

/** A workflow-ban idézőjelek közt szereplő https URL-ek. */
function urls(src: string): string[] {
  return [...src.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]);
}

describe('version-drift workflow — a drift-őr címzettje', () => {
  it('egyáltalán van benne bázis-URL (input default + env)', () => {
    expect(urls(WORKFLOW).length).toBeGreaterThanOrEqual(2);
  });

  it('SOHA nem a *.workers.dev subdomain (oda a kérés el sem jut → néma őr)', () => {
    for (const u of urls(WORKFLOW)) {
      expect(new URL(u).hostname.endsWith('.workers.dev'), `tiltott hoszt: ${u}`).toBe(false);
    }
  });

  it('minden előfordulás UGYANARRA a hosztra mutat (a dispatch-default ne csússzon el az envtől)', () => {
    const hosts = new Set(urls(WORKFLOW).map((u) => new URL(u).hostname));
    expect([...hosts]).toHaveLength(1);
  });

  it('tenant-semleges hoszt: nem egy per-ügyfél domain (egy site elvesztése ne vakítsa meg az őrt)', () => {
    const host = new URL(urls(WORKFLOW)[0]).hostname;
    expect(host.endsWith('.soborbo.co.uk')).toBe(true);
  });

  it('a /api/event/version útvonalat hívja a check-scripten át', () => {
    expect(WORKFLOW).toContain('scripts/check-version-drift.mjs');
  });
});
