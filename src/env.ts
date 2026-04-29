export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;

  DEAD_LETTER: R2Bucket;

  // Secrets (set via `wrangler secret put`)
  // Filled in across Sprint 2-7:
  //   TURNSTILE_SECRET_KEY: string;        // Sprint 2
  //   GADS_OAUTH_CLIENT_ID: string;        // Sprint 6
  //   GADS_OAUTH_CLIENT_SECRET: string;    // Sprint 6
  //   GADS_DEVELOPER_TOKEN: string;        // Sprint 7
}
