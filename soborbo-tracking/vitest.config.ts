import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts'],
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
