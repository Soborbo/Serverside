import type { DeadLetterRecord } from './lib/deadletter';

/**
 * Cloudflare Workers Rate Limiting binding (GA 2025-09).
 * A @cloudflare/workers-types nem feltétlenül exportálja a típust, ezért itt
 * definiáljuk a használt felületet.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;

  DEAD_LETTER: R2Bucket;

  // D1 ledger (events_raw / idempotency / deliveries / consent_receipts /
  // lead_status). OPCIONÁLIS: ha nincs bekötve, a ledger-írás + idempotencia
  // no-op (a Worker D1 nélkül is teljesen működik). Élesítés: lásd wrangler.toml
  // + `wrangler d1 migrations apply`.
  LEDGER?: D1Database;

  // Cloudflare Queues alapú újrapróbálkozás (H1). Ha NINCS bekötve, a kód
  // visszaesik a régi R2-alapú DLQ-ra (graceful fallback) — így fokozatosan
  // élesíthető. A terminális (kimerült retry) rekordok R2-be archiválódnak,
  // hogy az SLO-check / daily-digest továbbra is lássa őket.
  DLQ?: Queue<DeadLetterRecord>;

  // Natív rate limiter az ingestion végponton (H2). Ha nincs bekötve, a
  // rate-limit lépés kimarad (csak Turnstile véd).
  INGEST_LIMITER?: RateLimitBinding;

  QUOTE_STATE: DurableObjectNamespace;

  TRACKING_METRICS: AnalyticsEngineDataset;
  // Email binding — a wrangler.toml-ban kommentben (destination verify nélkül a
  // deploy elbukna). A notify.ts soft-skip-pel megy, ha hiányzik → opcionális.
  ADMIN_EMAIL?: SendEmail;

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
