import type { Env } from '../env';
import { lookupSiteConfig } from '../lib/config';
import { authenticateLeadStatus } from '../lib/admin-auth';
import { logStructured, CANONICAL_EVENTS } from '../types';
import { TrackingErrorCode } from '../lib/error-codes';
import { validateBusinessCounts, storeBusinessCounts } from '../lib/business-counts';

/**
 * POST /api/event/business-counts — P1.2 CRM business-source aggregátum.
 *
 * MIÉRT NEM az `/admin/*` alatt: az a felület a GLOBÁLIS `ADMIN_API_TOKEN` mögött van.
 * A CRM-nek per-site tokene van (`crm_token_sha256`), és ez szándékos: egy szivárgott
 * token blast-radiusa 1 site, nem az egész flotta. Ha ez az endpoint az admin-felületre
 * kerülne, a CRM-be be kellene tenni a globális tokent — tenant-izolációs visszalépés.
 * Ezért ugyanaz az auth, mint a `/lead-status`-on (`authenticateLeadStatus`).
 *
 * MIÉRT NEM 204: szerver-szerver útvonal. A hívónak TUDNIA kell retry-olni, tehát
 * hibánál valós státusz megy vissza (CLAUDE.md 12). Egy 204 hibára = a CRM sikernek
 * könyveli, és a napi aggregátum némán elveszik — pont az a hibaosztály, ami ellen
 * az egész P1.2 szól.
 *
 * PII: a payload SZERKEZETILEG nem tartalmazhat azonosítót — csak
 * `(event_name, count)` párok. Nincs lead_id, nincs érték, nincs identitás.
 */

// A CRM-lifecycle (offline) event-nevek — a kanonikus events.json-ból, kézi lista NÉLKÜL.
const OFFLINE_EVENT_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_EVENTS.filter((e) => e.kind === 'offline').map((e) => e.name)
);

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleBusinessCounts(request: Request, env: Env): Promise<Response> {
  const hostname = new URL(request.url).hostname;

  // CLAUDE.md 14: hostname → KV site-config. Nincs fallback config.
  //
  // `lookupSiteConfig` (nem `getSiteConfig`), mert a kettőt SZÉT KELL VÁLASZTANI
  // (2026-08-24 review, HIGH):
  //   tényleg nincs ilyen host  → 404 (permanens)
  //   a KV-olvasás HIBÁZOTT     → 503 (tranziens, retry-olható)
  // A `getSiteConfig` mindkettőre `null`-t ad, tehát egy másodperces KV-blip 404-nek
  // látszott volna. Ez az endpoint ugyan nem közvetlen money path, de PONT azt hivatott
  // bizonyítani, hogy a money-path események nem vesztek el — ha a CRM sender a 404-et
  // permanensnek veszi (és ez a szokásos olvasat), egy blip miatt a napi aggregátum
  // és a heartbeat VÉGLEG eltűnne, és a hallgatás-detektor is hamisan szólalna meg.
  const lookup = await lookupSiteConfig(hostname, env);
  if (lookup.unavailable) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.KV_READ_FAILED,
      message: 'business-counts: site config lookup unavailable (transient)',
      hostname
    });
    return json({ error: 'config_unavailable', detail: 'site config lookup failed; retry' }, 503);
  }
  const siteConfig = lookup.config;
  if (!siteConfig) return json({ error: 'unknown_site' }, 404);

  if (!(await authenticateLeadStatus(request, env, siteConfig))) {
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.ADMIN_UNAUTHORIZED,
      message: 'business-counts request failed authentication',
      hostname,
      site_id: siteConfig.site_id
    });
    return json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const validated = validateBusinessCounts(body, OFFLINE_EVENT_NAMES);
  if (!validated.ok) {
    // KONKRÉT hibaüzenet: a hívó szerver ebből tud javítani. Nem PII — a validáció
    // csak event-nevet és számot lát.
    return json({ error: 'invalid_payload', detail: validated.error }, 400);
  }

  if (!env.LEDGER) {
    // Nincs hova írni → 503, NEM 200. A „nyugtázom, de eldobom" pont a néma
    // adatvesztés, amit a P1.2 mérni hivatott.
    return json({ error: 'ledger_unavailable' }, 503);
  }

  const stored = await storeBusinessCounts(env, siteConfig.site_id, validated.value);
  if (!stored) return json({ error: 'store_failed' }, 500);

  logStructured({
    level: 'info',
    message: 'business counts stored',
    site_id: siteConfig.site_id,
    date: validated.value.date,
    entries: validated.value.counts.length,
    // Darabszámok összege — NEM PII, és a napi logból látszik a nagyságrend.
    total: validated.value.counts.reduce((n, c) => n + c.count, 0)
  });

  return json({ ok: true, site_id: siteConfig.site_id, date: validated.value.date }, 200);
}
