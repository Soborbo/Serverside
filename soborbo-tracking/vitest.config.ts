import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    // .mjs too: harnesses for the node-side .mjs tooling (server/*.mjs) live
    // outside the browser tsconfig on purpose — see the note in
    // tests/check-event-contract-script.test.mjs.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    // Node 25+ saját (kísérleti) `localStorage`/`sessionStorage` globált ad, ami
    // --localstorage-file nélkül üres/undefined — és ELTAKARJA a jsdom tárolóját:
    // Node 26-on 63 teszt bukott `Cannot read properties of undefined (getItem)`
    // hibával. A kapcsoló Node 22–24-en is érvényes (ott no-op).
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
    },
  },
  // The canonical event source lives one level up (Serverside/src/events.json),
  // shared in-repo with the gateway worker — allow Vite to serve it into tests.
  server: { fs: { allow: ['..'] } },
  define: {
    // Market config — HU market default in the tests (proves the non-GBP behavior)
    'import.meta.env.PUBLIC_TRACKING_COUNTRY': JSON.stringify('HU'),
    'import.meta.env.PUBLIC_TRACKING_CURRENCY': JSON.stringify('HUF'),
    'import.meta.env.PUBLIC_TRACKING_LOCALE': JSON.stringify('hu'),
  },
});
