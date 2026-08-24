import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * A Playwright-fixture PRODUCTION build-je (tests/e2e/fixture → tests/e2e/dist).
 *
 * Production, szándékosan: a package consent-kapuja `getCkyConsent()` hiányában
 * `isDevMode()`-ot ad, ami dev-ben ENGED, prodban DENY-ALL. A read-gate valódi
 * kockázata (lassan töltő CookieYes → egy beleegyező látogató olvasása is
 * blokkolódik) csak prod-bundle-ben mérhető.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./tests/e2e/fixture', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./tests/e2e/dist', import.meta.url)),
    emptyOutDir: true,
    // Olvasható marad, ha egy assert elhasal és a bundle-be kell nézni.
    minify: false,
    target: 'es2020'
  },
  define: {
    'import.meta.env.PUBLIC_TRACKING_COUNTRY': JSON.stringify('GB'),
    'import.meta.env.PUBLIC_TRACKING_CURRENCY': JSON.stringify('GBP'),
    'import.meta.env.PUBLIC_TRACKING_LOCALE': JSON.stringify('en')
  }
});
