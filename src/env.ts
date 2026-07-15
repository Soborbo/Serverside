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

  // Natív rate limiter az admin API-ra (/api/event/admin/*). A token-gate +
  // timing-safe compare már védi a végpontot; ez defense-in-depth a token
  // brute-force ellen (IP-kulcsos throttle az auth ELŐTT). Ha nincs bekötve,
  // visszaesik az INGEST_LIMITER-re; ha az sincs, a throttle kimarad.
  ADMIN_LIMITER?: RateLimitBinding;

  TRACKING_METRICS: AnalyticsEngineDataset;
  // Email binding — a wrangler.toml-ban kommentben (destination verify nélkül a
  // deploy elbukna). A notify.ts soft-skip-pel megy, ha hiányzik → opcionális.
  ADMIN_EMAIL?: SendEmail;

  // Secrets (set via `wrangler secret put`)
  GADS_OAUTH_CLIENT_ID: string;
  GADS_OAUTH_CLIENT_SECRET: string;
  GADS_DEVELOPER_TOKEN: string;

  // Admin secret for /api/event/oauth-debug + /api/event/debug-ga4 access.
  // If unset (test deploy), debug routes return 404.
  ADMIN_API_TOKEN?: string;

  // Allowed Origin hostnames for CORS (comma-separated). If unset, falls back
  // to the request hostname (workers.dev in test mode).
  ALLOWED_ORIGINS?: string;

  // A napi synthetic-lead füstteszt elvárt site-jai (vesszővel elválasztva).
  // A daily digest riaszt, ha bármelyiknek nincs friss smoke-sora a ledgerben.
  SMOKE_SITES?: string;




  // Optional: Data Manager API dry-run. Set to "1" to send events:ingest with
  // validateOnly=true (request is validated by Google but NOT executed — no
  // conversions recorded). Use during the parallel-run window before GCP setup
  // is fully live. Default (unset) = live ingestion.
  DATAMANAGER_VALIDATE_ONLY?: string;

  // Retention (#8/#9). Operatív D1 táblák (events_raw/deliveries/idempotency) +
  // R2 'dead' archívum megőrzési ablaka napokban. Unset → 90 nap. A
  // consent_receipts és lead_status alapból MEGMARAD (compliance/üzleti érték);
  // csak az alábbi külön env-ekkel purge-ölhető, jellemzően hosszabb ablakkal.
  RETENTION_DAYS?: string;
  // Opt-in: consent-receipt purge napokban (default OFF — a consent-proof marad).
  CONSENT_RETENTION_DAYS?: string;
  // Opt-in: lead_status purge napokban (default OFF — az offline-konverzió marad).
  LEAD_RETENTION_DAYS?: string;
  // R2 'dead' DLQ-archívum purge napokban. Unset → RETENTION_DAYS default (90).
  // A PENDING (retry-olható) rekordokat SOHA nem purge-öljük.
  DEAD_RECORD_RETENTION_DAYS?: string;

  // Optional (Twilio for SMS alerts)
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  // A kritikus SMS-riasztás célszáma E.164-ben (`wrangler secret put ADMIN_PHONE`).
  // Ha nincs beállítva, az SMS-láb soft-skip (a korábbi hardcoded placeholder
  // minden SMS-t csendben elbuktatott).
  ADMIN_PHONE?: string;
}
