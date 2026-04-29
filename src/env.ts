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

  // Admin secret for /api/event/oauth-debug + /api/event/debug-ga4 access.
  // If unset (test deploy), debug routes return 404.
  ADMIN_API_TOKEN?: string;

  // Allowed Origin hostnames for CORS (comma-separated). If unset, falls back
  // to the request hostname (workers.dev in test mode).
  ALLOWED_ORIGINS?: string;

  // Optional: opt-in to fail-open Turnstile validation during a Cloudflare
  // Turnstile incident. Set to "1" to enable. Default = fail-closed.
  TURNSTILE_FAILOPEN?: string;

  // Optional: short-circuit DO alarm duration for testing (seconds).
  // Default = 3600 (60 min) per spec.
  QUOTE_ALARM_SECONDS?: string;

  // Optional (Twilio for SMS alerts)
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
}
