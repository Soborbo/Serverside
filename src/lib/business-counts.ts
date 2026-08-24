import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode } from './error-codes';

/**
 * P1.2 — CRM business-source reconciliation (gateway-fél).
 *
 * A MEGFOGANDÓ HIBAMÓD: a P1.1 offline láb azt méri, hogy a gateway-be BEÉRKEZETT
 * lifecycle-státuszok eljutottak-e a Google-ig. Azt NEM látja, ha a CRM→gateway hívás
 * EL SEM INDUL — olyankor `received = 0`, és nulla elvárás mellett a nulla kézbesítés
 * tökéletesen egészségesnek látszik. Ez a gateway-ledger SZERKEZETI vakfoltja: a
 * hiányzó hívásról definíció szerint nincs nyoma a ledgerben.
 *
 * A megoldás egy PII-MENTES napi aggregátum, amit a CRM a MEGLÉVŐ cron-driveréről
 * pushol. Nem teljes event-sync (az második ledger lenne), nem lead-szintű join
 * (fölösleges PII-felület, és a lead_id a gateway-ben már megvan).
 */

/** A `date` KÖTELEZŐEN YYYY-MM-DD (UTC-nap). Időbélyeg nem, mert a recon napra egyeztet. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Egy CRM-nap reális felső korlátja event-típusonként. A cap NEM üzleti szabály, hanem
// cardinality-/hibavédelem: egy elgépelt vagy megszaladt aggregátor ne írjon abszurd
// számot a ledgerbe, amit aztán a recon örökös CRITICAL-ként olvas.
const MAX_COUNT = 1_000_000;
// Egy POST-ban legfeljebb ennyi event-típus. A kanonikus offline eventek száma egy
// számjegyű; a bőséges korlát a payload-robbanás ellen véd.
const MAX_ENTRIES = 64;

export interface BusinessCountEntry {
  event_name: string;
  count: number;
}

export interface BusinessCountsPayload {
  date: string;
  counts: BusinessCountEntry[];
}

/**
 * Szigorú validáció, mert ez SZERVER-SZERVER ingress: a hívónak KONKRÉT 400-at kell
 * kapnia, hogy javíthasson. (A böngésző-ág 204-es „nyeljük el" szabálya ide nem
 * vonatkozik — CLAUDE.md 12.)
 */
export function validateBusinessCounts(
  payload: unknown,
  allowedEventNames: ReadonlySet<string>
): { ok: true; value: BusinessCountsPayload } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.date !== 'string' || !DATE_RE.test(p.date)) {
    return { ok: false, error: 'date must be YYYY-MM-DD (UTC day)' };
  }
  // Jövőbeli nap → majdnem biztosan időzóna-hiba a hívónál. Csendben elfogadva egy
  // örökre üres napot hozna létre, amihez a recon soha nem talál párt.
  const today = new Date().toISOString().slice(0, 10);
  if (p.date > today) return { ok: false, error: `date is in the future (today=${today})` };

  if (!Array.isArray(p.counts)) return { ok: false, error: 'counts must be an array' };
  if (p.counts.length > MAX_ENTRIES) {
    return { ok: false, error: `counts has more than ${MAX_ENTRIES} entries` };
  }

  const seen = new Set<string>();
  const entries: BusinessCountEntry[] = [];
  for (const raw of p.counts) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'counts entries must be objects' };
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.event_name !== 'string' || !allowedEventNames.has(e.event_name)) {
      // Ismeretlen event-név elutasítva: a kanonikus events.json az egyetlen forrás,
      // és egy elgépelt név csendben egy soha nem egyeztetett sort hozna létre.
      return { ok: false, error: `unknown event_name: ${String(e.event_name)}` };
    }
    if (seen.has(e.event_name)) return { ok: false, error: `duplicate event_name: ${e.event_name}` };
    seen.add(e.event_name);
    if (
      typeof e.count !== 'number' ||
      !Number.isInteger(e.count) ||
      e.count < 0 ||
      e.count > MAX_COUNT
    ) {
      return { ok: false, error: `count for ${e.event_name} must be an integer in [0, ${MAX_COUNT}]` };
    }
    entries.push({ event_name: e.event_name, count: e.count });
  }

  return { ok: true, value: { date: p.date, counts: entries } };
}

/**
 * Idempotens felírás: a PK (site_id, date, event_name) ütközésén FELÜLÍR. Egy késve
 * érkező, javított aggregátum tehát javítja a korábbit — az újraküldés biztonságos,
 * ugyanaz a minta, mint a CRM outbox determinisztikus kulcsainál.
 *
 * `false` visszatérés = a sorok NEM biztos, hogy tárolódtak → a hívó 500-at kapjon,
 * hogy retry-olhasson (a néma elnyelés pont az a hibaosztály, ami ellen a P1.2 szól).
 */
export async function storeBusinessCounts(
  env: Env,
  siteId: string,
  payload: BusinessCountsPayload
): Promise<boolean> {
  if (!env.LEDGER) return false;
  if (payload.counts.length === 0) return true;
  const receivedAt = new Date().toISOString();
  try {
    const stmt = env.LEDGER.prepare(
      `INSERT INTO business_counts (site_id, date, event_name, count, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(site_id, date, event_name)
       DO UPDATE SET count = excluded.count, received_at = excluded.received_at`
    );
    await env.LEDGER.batch(
      payload.counts.map((c) => stmt.bind(siteId, payload.date, c.event_name, c.count, receivedAt))
    );
    return true;
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.LEDGER_WRITE_FAILED,
      message: 'business_counts write failed',
      site_id: siteId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

// ── Recon-oldal ──────────────────────────────────────────────────────────────

export interface BusinessCountRow {
  site_id: string;
  date: string;
  event_name: string;
  count: number;
}

/** A gateway-be TÉNYLEGESEN beérkezett lifecycle-státuszok ugyanarra a napra. */
export interface LedgerLifecycleRow {
  site_id: string;
  date: string;
  event_name: string;
  count: number;
}

export type BusinessSourceKind = 'business_source_drift' | 'business_source_missing';

export interface BusinessSourceFinding {
  site_id: string;
  event_name: string;
  date: string;
  kind: BusinessSourceKind;
  severity: 'warning' | 'critical';
  /** A CRM szerinti darabszám. */
  crm_count: number;
  /** A gateway-ledgerbe beérkezett darabszám. */
  gateway_count: number;
  detail: string;
}

export interface BusinessSourceThresholds {
  /** Ennél kevesebb CRM-esemény alatt nem riasztunk (1 hiány 1-ből = 100%, de zaj). */
  minSample: number;
  /** Az elveszett hányad küszöbe. */
  lossWarn: number;
  lossCrit: number;
}

export const DEFAULT_BUSINESS_SOURCE_THRESHOLDS: BusinessSourceThresholds = {
  minSample: 3,
  lossWarn: 0.1,
  lossCrit: 0.3
};

const rowKey = (siteId: string, date: string, eventName: string) => `${siteId} ${date} ${eventName}`;

/**
 * CRM-aggregátum ↔ gateway lead_status összevetés.
 *
 * SZÁNDÉKOSAN EGYIRÁNYÚ: csak a CRM > gateway eltérés a finding. A fordított irány
 * (gateway > CRM) nem hiba — a gateway kaphat lifecycle-státuszt más forrásból is
 * (manuális replay, másik backend), és a CRM aggregátuma a saját napjára vonatkozik,
 * ami a UTC-nap határán legális ±1 eltérést ad.
 */
export function computeBusinessSourceDrift(
  crmRows: BusinessCountRow[],
  ledgerRows: LedgerLifecycleRow[],
  t: BusinessSourceThresholds = DEFAULT_BUSINESS_SOURCE_THRESHOLDS
): BusinessSourceFinding[] {
  const ledger = new Map<string, number>();
  for (const r of ledgerRows) ledger.set(rowKey(r.site_id, r.date, r.event_name), r.count);

  const findings: BusinessSourceFinding[] = [];
  for (const c of crmRows) {
    if (c.count < t.minSample) continue;
    const got = ledger.get(rowKey(c.site_id, c.date, c.event_name)) ?? 0;
    if (got >= c.count) continue;
    const loss = (c.count - got) / c.count;
    if (loss < t.lossWarn) continue;
    findings.push({
      site_id: c.site_id,
      event_name: c.event_name,
      date: c.date,
      kind: 'business_source_drift',
      severity: loss >= t.lossCrit ? 'critical' : 'warning',
      crm_count: c.count,
      gateway_count: got,
      detail:
        `${c.date} ${c.event_name}: a CRM ${c.count} uzleti esemenyt jelentett, a gateway ` +
        `${got}-t kapott meg (${(loss * 100).toFixed(1)}% el sem indult)`
    });
  }
  return findings;
}

/**
 * Elhallgatott site-ok: korábban jelentett, ma nem.
 *
 * A megfigyelt előzményhez mérünk, nem konfigurált listához — egy sosem-jelentkező
 * site nem riaszt (nincs bekötve), egy elhallgató igen. Ugyanaz az elv, mint a napi
 * digest `expected_platforms`-fallbackjénél.
 */
export function findSilentBusinessSources(
  priorRows: BusinessCountRow[],
  todayRows: BusinessCountRow[],
  date: string
): BusinessSourceFinding[] {
  const reportedToday = new Set(todayRows.map((r) => r.site_id));
  const reportedBefore = [...new Set(priorRows.map((r) => r.site_id))];
  return reportedBefore
    .filter((siteId) => !reportedToday.has(siteId))
    .map((siteId) => ({
      site_id: siteId,
      event_name: '*',
      date,
      kind: 'business_source_missing' as const,
      severity: 'warning' as const,
      crm_count: 0,
      gateway_count: 0,
      detail:
        `${siteId}: korabban napi business-count aggregatumot kuldott, ${date}-re NEM — ` +
        'maga a CRM-cron allhatott le (a lifecycle-konverziok igy nema veszteseget szenvednek)'
    }));
}

/**
 * A recon két lekérdezése + az összevetés. `null` = a lekérdezés elbukott VAGY nincs
 * LEDGER binding — a hívó ezt NEM keverheti össze a „nincs eltéréssel".
 */
export async function fetchBusinessSourceFindings(
  env: Env,
  date: string,
  priorSinceDate: string
): Promise<BusinessSourceFinding[] | null> {
  if (!env.LEDGER) return null;
  try {
    const [crm, ledgerRows, prior] = await Promise.all([
      env.LEDGER.prepare(
        `SELECT site_id, date, event_name, count FROM business_counts WHERE date = ?1`
      )
        .bind(date)
        .all<BusinessCountRow>(),
      env.LEDGER.prepare(
        `SELECT site_id, substr(created_at, 1, 10) AS date, status AS event_name, COUNT(*) AS count
         FROM lead_status
         WHERE substr(created_at, 1, 10) = ?1
           AND lead_id NOT LIKE 'smoke-%' AND lead_id NOT LIKE 'dm-validate%'
         GROUP BY site_id, status`
      )
        .bind(date)
        .all<LedgerLifecycleRow>(),
      env.LEDGER.prepare(
        `SELECT site_id, date, event_name, count FROM business_counts
         WHERE date >= ?1 AND date < ?2`
      )
        .bind(priorSinceDate, date)
        .all<BusinessCountRow>()
    ]);

    const crmRows = crm.results ?? [];
    return [
      ...computeBusinessSourceDrift(crmRows, ledgerRows.results ?? []),
      ...findSilentBusinessSources(prior.results ?? [], crmRows, date)
    ];
  } catch (err) {
    logStructured({
      level: 'error',
      error_code: TrackingErrorCode.RECON_QUERY_FAILED,
      message: 'business-source reconciliation query failed',
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
