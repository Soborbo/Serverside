export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;

  DEAD_LETTER: R2Bucket;

  QUOTE_STATE: DurableObjectNamespace;

  TRACKING_METRICS: AnalyticsEngineDataset;
  ADMIN_EMAIL: SendEmail;

  // Secrets (set via `wrangler secret put`)
  TURNSTILE_SECRET_KEY: string;
  GADS_OAUTH_CLIENT_ID: string;
  GADS_OAUTH_CLIENT_SECRET: string;
  GADS_DEVELOPER_TOKEN: string;

  // Optional (Twilio for SMS alerts)
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
}
