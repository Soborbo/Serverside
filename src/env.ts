export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;

  DEAD_LETTER: R2Bucket;

  // Secrets (set via `wrangler secret put`)
  TURNSTILE_SECRET_KEY: string;

  // Sprint 6-7 secrets, declared in later sprints:
  //   GADS_OAUTH_CLIENT_ID: string;
  //   GADS_OAUTH_CLIENT_SECRET: string;
  //   GADS_DEVELOPER_TOKEN: string;
}
