import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A <ConsentBanner /> .astro frontmatterjét a vitest nem futtatja — a 6.8.0
 * fejlesztésekor egy CRLF-en csendben elhasalt import-csere pont itt maradt
 * észrevétlen (a banner a régi 2026-08-a szöveget töltötte volna, a
 * `parseVendors` pedig definiálatlan lett a site buildjében). Ez a teszt a
 * FORRÁST olvassa: a banner a legfrissebb töredék-verziót és az összeállítót
 * használja-e.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('../soborbo-tracking/components/ConsentBanner.astro', import.meta.url)),
  'utf8'
);

describe('<ConsentBanner /> forrás', () => {
  it('a vendor-összeállítót importálja és használja', () => {
    expect(SRC).toMatch(/import \{[^}]*\bcomposeBannerTexts\b[^}]*\bparseVendors\b[^}]*\} from '\.\.\/lib\/consent-vendors'/);
    expect(SRC).toMatch(/parseVendors\(import\.meta\.env\.PUBLIC_TRACKING_VENDORS, \{ strict: true \}\)/);
  });

  it('a 2026-09-a töredékeket tölti, nem a régi 2026-08-a kész szöveget', () => {
    expect(SRC).toContain("from '../consent-texts/2026-09-a/hu.json'");
    expect(SRC).toContain("from '../consent-texts/2026-09-a/en.json'");
    expect(SRC).not.toContain('2026-08-a');
  });

  it('A/B: a változat-választás a verziók kiolvasása ELŐTT fut', () => {
    const pick = SRC.indexOf('pickBannerVariant(root, Math.random())');
    const read = SRC.indexOf('root.dataset.bannerVersion');
    expect(pick, 'pickBannerVariant hívás hiányzik').toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(pick);
  });
});
