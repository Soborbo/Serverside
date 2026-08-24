import { defineConfig, devices } from '@playwright/test';

/**
 * PECR storage-access E2E (2. brief · S5).
 *
 * BÖNGÉSZŐ-VARIANCIA: Chromium ÉS WebKit, mert a Safari ITP a first-party
 * storage-ot eltérően kezeli (7 napos JS-cookie élettartam, eltérő
 * localStorage-ürítés) — egy csak-Chromium zöld itt nem bizonyít semmit a
 * flotta Safari-forgalmára.
 *
 * A `webServer` a fixture-t PRODUCTION módban buildeli (lásd vite.e2e.config.ts):
 * a lib consent-kapuja dev-ben enged, prodban deny-all, és a mérendő eset az
 * utóbbi.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${process.env.E2E_PORT || 4173}`,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run e2e:build && node tests/e2e/serve.mjs',
    url: `http://localhost:${process.env.E2E_PORT || 4173}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Sandbox/CI-kapcsoló: ha a futtató környezet HOZ egy böngészőt, azt
        // használjuk letöltés helyett. Üresen hagyva a Playwright sajátját viszi
        // (`npx playwright install chromium webkit`).
        ...(process.env.PW_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } }
          : {})
      }
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        ...(process.env.PW_WEBKIT_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PW_WEBKIT_EXECUTABLE } }
          : {})
      }
    }
  ]
});
