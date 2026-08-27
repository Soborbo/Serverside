import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A KITERJESZTETT UTM-EK A MAGBAN VANNAK, NEM SITE-PATCHKÉNT.
 *
 * ── Miért került ide ─────────────────────────────────────────────────────────
 * Az `olcsokontenerhaz` vendorolt `persistence.ts`-ébe valaki kézzel beleírta a
 * Google Ads kampány-sablon négy extra UTM-jét, és MELLÉ EGY FIGYELMEZTETÉST:
 *
 *   „Site-specifikus (olcso ads-setup): a Google Ads kampány-sablon extra UTM-jei.
 *    A kanonikus lib frissítésekor EZEKET MEG KELL ŐRIZNI (vendor-diff jegyzet)."
 *
 * Ez a megjegyzés maga a hiba diagnózisa: egy vendorolt fájlba írt site-lokális
 * bővítés a KÖVETKEZŐ re-vendorolásnál némán eltűnik, és csak akkor derül ki,
 * amikor a kampány-riportban már nincs `utm_id`.
 *
 * A négy mező nem olcso-specifikus kitalálás — ezek a Google Ads/GA4 HIVATALOS
 * kiterjesztett UTM-paraméterei, amiket az auto-taggelt kampány-sablon küld.
 * Tehát nem megőrizni kell őket a következő frissítéskor, hanem a MAGBA tenni,
 * ahol minden site megkapja és semmilyen frissítés nem viszi el.
 */

const PERSISTENCE = fileURLToPath(new URL('../soborbo-tracking/lib/persistence.ts', import.meta.url));

const EXTENDED = ['utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic'];

describe('kiterjesztett UTM-ek — a kanonikus attribúcióban', () => {
  const src = readFileSync(PERSISTENCE, 'utf8');

  it.each(EXTENDED)('a `%s` szerepel az attribúció TÍPUSÁBAN', (field) => {
    expect(src).toMatch(new RegExp(`\\n\\s*${field}\\?: string;`));
  });

  it.each(EXTENDED)('a `%s`-t a perzisztencia-kulcslista is átviszi', (field) => {
    // A 277. sor körüli `for (const k of [...])` a tárolt blobba mentendő
    // kulcsokat sorolja. Ha egy mező a típusban van, de innen kimarad, akkor az
    // URL-ből még felolvassuk, de az OLDALVÁLTÁST nem éli túl — vagyis pont a
    // kampány-attribúció veszik el, csendben.
    expect(src).toMatch(new RegExp(`'${field}'`));
  });

  it.each(EXTENDED)('a `%s`-t az URL-olvasás is felveszi (stored fallbackkel)', (field) => {
    expect(src).toMatch(new RegExp(`${field}: u\\.get\\('${field}'\\) \\|\\| s\\?\\.${field}`));
  });
});
