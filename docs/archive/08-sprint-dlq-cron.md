> ---
> **status: archived** · **do_not_use_for_implementation: true**
> superseded_by: README.md + CLAUDE.md + docs/HANDOVER-run6.md (a kanonikus élő állapot)
>
> Ez egy TERVEZÉSI/SPRINT-dokumentum a Run 1–6 építési fázisból. A benne leírt
> premisszák egy része AZÓTA MEGDŐLT (pl. Turnstile-before-everything, quote-state
> Durable Object, offline GA4 — mind törölve; lásd CLAUDE.md Rule 10/17). NE
> implementálj ez alapján; a jelenlegi valóság a fenti kanonikus fájlokban van.
> ---

# Sprint 8 — Dead Letter Queue + Cron retry

**Cél:** Failed API hívások (Meta timeout, Google Ads 5xx, GA4 connection error) **nem vesznek el** — R2 bucket-be archiválódnak, és egy óránként futó Cron Worker újra megpróbálja őket.

**Idő Claude Code-dal:** 3-4 óra.

## R2 key séma

```
{site_id}/{platform}/{YYYY-MM-DD}/{HH-MM-SS}_{event_id}_{retry_count}.json
```

Példa: `painless/meta/2026-04-29/10-30-15_abc-123-uuid_0.json`

A `retry_count` 0-tól indul, +1 minden retry-re. Max 3 retry után permanens failure: `painless/meta/dead/...` prefix.

## Új fájl: `src/lib/deadletter.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';

const MAX_RETRIES = 3;
const RETRY_WINDOW_HOURS = 24;

export type Platform = 'meta' | 'ga4' | 'gads';

export interface DeadLetterRecord {
  platform: Platform;
  site_id: string;
  hostname: string;
  event_payload: Record<string, unknown>;
  hashed_user_data?: Record<string, unknown>;
  failure_reason: string;
  retry_count: number;
  first_failed_at: string;
  last_attempted_at: string;
}

export async function writeDeadLetter(
  env: Env,
  record: DeadLetterRecord
): Promise<void> {
  const date = new Date(record.last_attempted_at);
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '-');

  const eventId = (record.event_payload.event_id as string) || 'unknown';
  const safeEventId = eventId.slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '_');

  const prefix = record.retry_count >= MAX_RETRIES
    ? `${record.site_id}/${record.platform}/dead`
    : `${record.site_id}/${record.platform}/${dateStr}`;

  const key = `${prefix}/${timeStr}_${safeEventId}_${record.retry_count}.json`;

  try {
    await env.DEAD_LETTER.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }
    });

    logStructured({
      level: 'warn',
      message: 'Wrote event to dead letter queue',
      site_id: record.site_id,
      platform: record.platform,
      retry_count: record.retry_count,
      r2_key: key
    });
  } catch (err) {
    logStructured({
      level: 'error',
      message: 'Failed to write dead letter — event lost',
      site_id: record.site_id,
      platform: record.platform,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function listPendingRetries(
  env: Env,
  sitePrefix?: string
): Promise<{ key: string; record: DeadLetterRecord }[]> {
  const now = Date.now();
  const cutoffMs = RETRY_WINDOW_HOURS * 60 * 60 * 1000;

  const results: { key: string; record: DeadLetterRecord }[] = [];
  let cursor: string | undefined = undefined;
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    const listResult = await env.DEAD_LETTER.list({
      prefix: sitePrefix,
      cursor,
      limit: 1000
    });

    for (const obj of listResult.objects) {
      if (obj.key.includes('/dead/')) continue;

      try {
        const body = await env.DEAD_LETTER.get(obj.key);
        if (!body) continue;
        const record = await body.json() as DeadLetterRecord;

        const firstFailedMs = new Date(record.first_failed_at).getTime();
        if (now - firstFailedMs > cutoffMs) continue;
        if (record.retry_count >= MAX_RETRIES) continue;

        results.push({ key: obj.key, record });
      } catch (err) {
        logStructured({
          level: 'warn',
          message: 'Skipped corrupt DLQ record',
          r2_key: obj.key,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    if (!listResult.truncated) break;
    cursor = listResult.cursor;
    iterations++;
  }

  return results;
}

export async function deleteDeadLetter(env: Env, key: string): Promise<void> {
  try {
    await env.DEAD_LETTER.delete(key);
  } catch (err) {
    logStructured({
      level: 'warn',
      message: 'Failed to delete DLQ record after retry',
      r2_key: key,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
```

## Módosítandó fájl: `src/routes/conversion.ts`

A fan-out kódot bővítsd: ha bármelyik platform fail-el, írjuk DLQ-ba.

```typescript
import { writeDeadLetter, type Platform } from '../lib/deadletter';

// ... existing code ...

ctx.waitUntil(
  Promise.allSettled([metaPromise, ga4Promise, gadsPromise]).then(async (results) => {
    const [metaResult, ga4Result, gadsResult] = results;

    const failedPlatforms: Array<[Platform, string]> = [];

    if (metaResult.status === 'rejected' || (metaResult.status === 'fulfilled' && !metaResult.value.success)) {
      failedPlatforms.push([
        'meta',
        metaResult.status === 'rejected' ? String(metaResult.reason) : (metaResult.value.error || 'unknown')
      ]);
    }
    if (ga4Result.status === 'rejected' || (ga4Result.status === 'fulfilled' && !ga4Result.value.success)) {
      failedPlatforms.push([
        'ga4',
        ga4Result.status === 'rejected' ? String(ga4Result.reason) : (ga4Result.value.error || 'unknown')
      ]);
    }
    if (gadsResult.status === 'rejected' || (gadsResult.status === 'fulfilled' && !gadsResult.value.success)) {
      failedPlatforms.push([
        'gads',
        gadsResult.status === 'rejected' ? String(gadsResult.reason) : (gadsResult.value.error || 'unknown')
      ]);
    }

    const nowIso = new Date().toISOString();
    for (const [platform, reason] of failedPlatforms) {
      await writeDeadLetter(env, {
        platform,
        site_id: siteConfig.site_id,
        hostname,
        event_payload: payload as Record<string, unknown>,
        hashed_user_data: hashedUserData as unknown as Record<string, unknown>,
        failure_reason: reason,
        retry_count: 0,
        first_failed_at: nowIso,
        last_attempted_at: nowIso
      });
    }

    logStructured({
      level: 'info',
      message: 'Fan-out completed',
      site_id: siteConfig.site_id,
      event_name: payload.event_name,
      meta_success: metaResult.status === 'fulfilled' && metaResult.value.success,
      ga4_success: ga4Result.status === 'fulfilled' && ga4Result.value.success,
      gads_success: gadsResult.status === 'fulfilled' && gadsResult.value.success,
      platforms_failed: failedPlatforms.length
    });
  })
);
```

## Cron Trigger

### `wrangler.toml` bővítés

```toml
[triggers]
crons = ["0 * * * *"]
```

### `src/worker.ts` scheduled handler

```typescript
import { handleScheduledRetry } from './scheduled/retry';

export default {
  async fetch(request, env, ctx) {
    // ... existing fetch handler unchanged
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduledRetry(event, env));
  }
};
```

### Új fájl: `src/scheduled/retry.ts`

```typescript
import type { Env } from '../env';
import { listPendingRetries, deleteDeadLetter, writeDeadLetter, type DeadLetterRecord } from '../lib/deadletter';
import { sendToMetaCAPI } from '../lib/meta';
import { sendToGA4MP } from '../lib/ga4';
import { sendToGoogleAdsCAPI } from '../lib/gads';
import { getSiteConfig } from '../lib/config';
import { logStructured } from '../types';

const MAX_RETRIES_PER_RUN = 100;

export async function handleScheduledRetry(
  event: ScheduledEvent,
  env: Env
): Promise<void> {
  logStructured({
    level: 'info',
    message: 'Cron retry started',
    cron: event.cron,
    scheduled_time: new Date(event.scheduledTime).toISOString()
  });

  const pending = await listPendingRetries(env);
  const toRetry = pending.slice(0, MAX_RETRIES_PER_RUN);

  let succeeded = 0;
  let failed = 0;

  for (const { key, record } of toRetry) {
    const success = await retrySingle(env, record);
    if (success) {
      await deleteDeadLetter(env, key);
      succeeded++;
    } else {
      await deleteDeadLetter(env, key);
      await writeDeadLetter(env, {
        ...record,
        retry_count: record.retry_count + 1,
        last_attempted_at: new Date().toISOString()
      });
      failed++;
    }
  }

  logStructured({
    level: 'info',
    message: 'Cron retry completed',
    total_pending: pending.length,
    retried: toRetry.length,
    succeeded,
    failed
  });
}

async function retrySingle(env: Env, record: DeadLetterRecord): Promise<boolean> {
  const siteConfig = await getSiteConfig(record.hostname, env);
  if (!siteConfig) return false;

  const payload = record.event_payload as Record<string, unknown>;
  const hashedUserData = record.hashed_user_data as Record<string, string>;

  if (record.platform === 'meta') {
    const result = await sendToMetaCAPI(siteConfig, payload as any, hashedUserData as any);
    return result.success;
  }
  if (record.platform === 'ga4') {
    const result = await sendToGA4MP(siteConfig, payload as any);
    return result.success;
  }
  if (record.platform === 'gads') {
    const result = await sendToGoogleAdsCAPI(siteConfig, env, payload as any, hashedUserData as any);
    return result.success;
  }
  return false;
}
```

## Manuális tesztelés

### A. Force Meta failure
1. KV-ben `meta.access_token` = `INVALID_TOKEN`
2. Curl conversion event
3. R2: `wrangler r2 object list soborbo-tracking-dlq` → látnod kell `painless/meta/...` key-t
4. Logs: `"Wrote event to dead letter queue"`

### B. Cron retry
1. Visszaállítod a valós token-t
2. Várj 1 órát (vagy manuálisan triggereld dev-ben)
3. Logs: `"Cron retry completed" succeeded: 1`
4. R2: a key eltűnt
5. Meta Events Manager: az event most megérkezik

### C. Max retry limit
1. KV-ben `meta.access_token` MARAD `INVALID_TOKEN` 4 órán át
2. 4 cron run után `retry_count: 3`
3. R2: a `painless/meta/dead/` prefix alatt jelenik meg

### D. Manual DLQ inspection

```bash
wrangler r2 object list soborbo-tracking-dlq --prefix=painless/meta/dead/
wrangler r2 object get soborbo-tracking-dlq painless/meta/dead/2026-04-29_10-30-15_abc-123_3.json
```

## Sprint 8 utáni státusz

- ✅ Failed events nem vesznek el
- ✅ Cron óránként újra próbál
- ✅ Max 3 retry, után "dead" prefix
- ✅ R2 logok inspectálhatók manuálisan
- ❌ Astro production integration: Sprint 9
- ❌ Multi-tenant rollout: Sprint 10

## Mit KÉRDEZZ a usertől

1. Force failure test sikeres? R2-ben látható a DLQ record?
2. Cron retry sikeres test után? Failed event újra próbálva?
