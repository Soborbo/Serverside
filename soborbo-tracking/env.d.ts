/**
 * Ambient types for the Astro/Vite `import.meta.env` used by lib/*.ts.
 * The real values are injected by Astro at build time (PUBLIC_* vars) and by
 * vitest.config.ts `define` in tests. This declaration lets `tsc --noEmit`
 * type-check the library without pulling in the full Astro/Vite type packages.
 */
interface ImportMetaEnv {
  readonly PUBLIC_TRACKING_COUNTRY?: string;
  readonly PUBLIC_TRACKING_CURRENCY?: string;
  readonly PUBLIC_TRACKING_LOCALE?: string;
  /**
   * A saját CMP consent-végpontjának alapja (default `/api/consent`). A záró
   * perjel tiszteletben tartva — `trailingSlash: 'always'` site-okon
   * `/api/consent/`. Lásd lib/config.ts `consentEndpoint`.
   */
  readonly PUBLIC_TRACKING_CONSENT_ENDPOINT?: string;
  /**
   * Az advanced mód jogi jóváhagyása `<YYYY-MM-DD>:<hivatkozás>` alakban — nélküle
   * az eea_uk rulesetben az advanced build bukik. Lásd lib/config.ts advancedModeBlocker.
   */
  readonly PUBLIC_TRACKING_ADVANCED_APPROVAL?: string;
  /** Vite dev flag — used by consent.ts isDevMode(). */
  readonly DEV?: boolean;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
