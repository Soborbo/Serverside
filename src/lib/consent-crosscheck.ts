import type { Env } from '../env';
import { logStructured } from '../types';
import { TrackingErrorCode, ERROR_DESCRIPTIONS } from './error-codes';

/**
 * Fázis D · S3 — NAPI consent-keresztellenőrzés (a lib/cross-check.ts mintájára).
 *
 * Mit követ, és miért:
 *  1. GRANTED-consent MELLETTI `skipped` deliveryk, `skip_reason` bontásban.
 *     Ez a 9-es rejtély követése: ilyen sornak nem szabadna léteznie. Amíg a
 *     `skip_reason` NULL (a 0004 migráció előtti sorok), a bontás `(unnamed)`.
 *  2. TRK-910 megállapítások darabszáma `site_id × client_lib_version` bontásban.
 *     Ha a -003/-005/-006 dominál, a hiba a SAJÁT bekötéseinkben van (A kimenetel:
 *     nem épül CMP); ha a süti maga hordoz rossz állapotot konzisztens lib mellett,
 *     az a B kimenetel.
 *  3. `source_consistent = 0` aránya, az előző 7 nap átlagához mérve.
 *  4. NULL-forrás mintázat site-onként — a betöltési verseny TRENDJE. Ha az API
 *     forrás rendre NULL, miközben a süti nem, az maga a verseny.
 *  5. `consent_debug` sorok száma (a 14 napos ablakban keletkezettek napi üteme).
 *
 * Minden lekérdezés hibatűrő: egy elbukott leg logolt skip (TRK-910-007), a
 * többi attól még lefut. A pure kiértékelés (evaluateConsentCrossCheck) D1
 * nélkül tesztelhető.
 */

export interface GrantedSkipRow {
  site_id: string;
  platform: string;
  skip_reason: string;
  total: number;
}

export interface FindingCountRow {
  site_id: string;
  client_lib_version: string;
  finding_codes: string;
  total: number;
}

export interface ConsistencyRow {
  inconsistent: number;
  comparable: number;
  /**
   * Az ablak ÖSSZES receiptje — nem csak az összevethetőké.
   *
   * Ettől válik megkülönböztethetővé a két, gyökeresen eltérő nulla:
   *  - `total=0`     → nem jött forgalom (a mérés nem tud mit mondani)
   *  - `total>0, comparable=0` → jött forgalom, de MINDEN receipt egyforrású,
   *    tehát a konzisztencia-mérés szerkezetileg VAK. Ez a valós állapot addig,
   *    amíg a 6.1.0-s kliens-lib nincs kint a site-okon: a szerver-süti az
   *    egyetlen forrás, nincs mivel összevetni. A digest ezt KIMONDJA, mert egy
   *    „n/a" úgy olvasódik, mint „rendben van", és pontosan az a hibaosztály,
   *    amit ez az egész mérés kerülni akar.
   */
  total: number;
}

export interface NullSourceRow {
  site_id: string;
  cookie_null: number;
  api_null: number;
  server_null: number;
  total: number;
}

export interface ConsentCrossCheckInput {
  /** 1. — GRANTED consent mellett keletkezett skipek. */
  grantedSkips: GrantedSkipRow[];
  /** 2. — megállapítás-kódok site × lib bontásban (nyers, kód-listás sorok). */
  findings: FindingCountRow[];
  /** 3a. — a vizsgált nap konzisztencia-számai. */
  today: ConsistencyRow;
  /** 3b. — az előző 7 nap összesített konzisztencia-számai (baseline). */
  baseline: ConsistencyRow;
  /** 4. — NULL-forrás mintázat site-onként. */
  nullSources: NullSourceRow[];
  /** 5. — az aznap írt consent_debug sorok száma. */
  debugRows: number;
  /** Elbukott lekérdezés-lábak neve (ezek NEM „nincs jel", hanem vakfolt). */
  failedLegs: string[];
}

export interface ConsentCrossCheckSummary {
  granted_but_skipped_total: number;
  granted_skip_breakdown: GrantedSkipRow[];
  /** TRK-kód → (site × lib) → darabszám, a kód-listák szétbontása után. */
  finding_counts: Array<{
    error_code: string;
    site_id: string;
    client_lib_version: string;
    total: number;
  }>;
  inconsistent_rate: number | null;
  baseline_inconsistent_rate: number | null;
  inconsistent_rate_delta: number | null;
  /**
   * A konzisztencia-láb VAK-e: jött receipt, de egy sem volt összevethető
   * (mind egyforrású). Nem riasztás — ez a várt állapot, amíg a 6.1.0-s lib
   * nincs kint —, de a digestnek ki KELL mondania, hogy az `n/a` ne olvasódjon
   * „rendben van"-ként. Lásd ConsistencyRow.total.
   */
  consistency_blind: boolean;
  /** Az aznapi receiptek száma és az összevethetők száma (a vakság mértéke). */
  consistency_total: number;
  consistency_comparable: number;
  null_sources: NullSourceRow[];
  debug_rows: number;
  failed_legs: string[];
  /** Megy-e riasztás, és miért. */
  alert: boolean;
  alert_reasons: string[];
}

export interface ConsentCrossCheckThresholds {
  /**
   * Mekkora ABSZOLÚT elmozdulás számít jelnek a `source_consistent=0` arányban
   * a 7 napos átlaghoz képest (0.10 = 10 százalékpont).
   */
  inconsistentRateDelta: number;
  /** Ennyi összehasonlítható receipt alatt nincs arány-alapú riasztás (zajvédelem). */
  minSample: number;
}

export const DEFAULT_CONSENT_CROSS_CHECK_THRESHOLDS: ConsentCrossCheckThresholds = {
  inconsistentRateDelta: 0.1,
  minSample: 20
};

function rate(row: ConsistencyRow): number | null {
  if (row.comparable <= 0) return null;
  return Math.round((row.inconsistent / row.comparable) * 10000) / 10000;
}

/**
 * A kód-listás sorok szétbontása kódonkénti darabszámmá (pure). A receipt egy
 * eventre több kódot is hordozhat (pl. "TRK-910-003,TRK-910-005") — mindegyik
 * kód a saját vödrébe számít, mert a döntési kapu szempontjából az számít, MELYIK
 * hibaosztály dominál, nem az, hány event volt „valamilyen szempontból rossz".
 */
export function expandFindingCounts(
  rows: readonly FindingCountRow[]
): ConsentCrossCheckSummary['finding_counts'] {
  const acc = new Map<string, { error_code: string; site_id: string; client_lib_version: string; total: number }>();
  for (const row of rows) {
    for (const code of String(row.finding_codes ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)) {
      const key = `${code}|${row.site_id}|${row.client_lib_version}`;
      const cur = acc.get(key);
      if (cur) cur.total += row.total;
      else
        acc.set(key, {
          error_code: code,
          site_id: row.site_id,
          client_lib_version: row.client_lib_version,
          total: row.total
        });
    }
  }
  return [...acc.values()].sort((a, b) => b.total - a.total);
}

/**
 * A napi értékelés (pure). Riaszt, ha
 *  - (1) GRANTED-consent melletti skip keletkezett (bármennyi), VAGY
 *  - (3) a `source_consistent=0` arány a 7 napos átlaghoz képest a küszöbnél
 *        többet mozdult (bármelyik irányba — a hirtelen JAVULÁS is jelzés, mert
 *        rendszerint azt jelenti, hogy egy forrás elnémult), VAGY
 *  - bármelyik lekérdezés-láb elbukott (vakfolt ≠ „nincs jel").
 */
export function evaluateConsentCrossCheck(
  input: ConsentCrossCheckInput,
  t: ConsentCrossCheckThresholds = DEFAULT_CONSENT_CROSS_CHECK_THRESHOLDS
): ConsentCrossCheckSummary {
  const grantedTotal = input.grantedSkips.reduce((s, r) => s + r.total, 0);
  const todayRate = rate(input.today);
  const baseRate = rate(input.baseline);
  const delta =
    todayRate !== null && baseRate !== null
      ? Math.round((todayRate - baseRate) * 10000) / 10000
      : null;

  const reasons: string[] = [];
  if (grantedTotal > 0) {
    const breakdown = input.grantedSkips
      .map((r) => `${r.site_id}/${r.platform}:${r.skip_reason}=${r.total}`)
      .join(', ');
    reasons.push(`GRANTED consent mellett ${grantedTotal} skipped delivery (${breakdown})`);
  }
  if (
    delta !== null &&
    Math.abs(delta) >= t.inconsistentRateDelta &&
    input.today.comparable >= t.minSample
  ) {
    reasons.push(
      `source_consistent=0 arány ${(todayRate! * 100).toFixed(1)}% vs 7 napos átlag ${(baseRate! * 100).toFixed(1)}%`
    );
  }
  if (input.failedLegs.length > 0) {
    reasons.push(`lekérdezés-láb elbukott: ${input.failedLegs.join(', ')} — ez vakfolt, nem nulla`);
  }

  return {
    granted_but_skipped_total: grantedTotal,
    granted_skip_breakdown: input.grantedSkips,
    finding_counts: expandFindingCounts(input.findings),
    inconsistent_rate: todayRate,
    baseline_inconsistent_rate: baseRate,
    inconsistent_rate_delta: delta,
    // Vak = jött forgalom, de egyetlen receipt sem volt összevethető. A
    // `total === 0` NEM vakság, hanem csend (nincs mit mérni).
    consistency_blind: input.today.total > 0 && input.today.comparable === 0,
    consistency_total: input.today.total,
    consistency_comparable: input.today.comparable,
    null_sources: input.nullSources,
    debug_rows: input.debugRows,
    failed_legs: input.failedLegs,
    alert: reasons.length > 0,
    alert_reasons: reasons
  };
}

// ── D1 lekérdezések ─────────────────────────────────────────────────────────

/**
 * 1. GRANTED-consent melletti skipek. A join az event_id + site_id páron megy
 * (a receipt eventenként egy sor). CSAK az EXPLICIT `ad_user_data='GRANTED'`
 * receipt számít bizonyítéknak — a jel nélküli receipt `ad_allowed=1`-e a
 * require_consent=false defaultból is jöhet, az NEM consent.
 */
export const SQL_GRANTED_SKIPS = `
  SELECT d.site_id AS site_id,
         d.platform AS platform,
         COALESCE(d.skip_reason, '(unnamed)') AS skip_reason,
         COUNT(*) AS total
  FROM deliveries d
  JOIN consent_receipts c
    ON c.event_id = d.event_id AND c.site_id = d.site_id
  WHERE d.created_at >= ?1 AND d.created_at < ?2
    AND d.status = 'skipped'
    AND c.ad_user_data = 'GRANTED'
  GROUP BY d.site_id, d.platform, skip_reason`;

/** 2. TRK-910 megállapítások site × client_lib_version bontásban. */
export const SQL_FINDINGS = `
  SELECT site_id,
         COALESCE(client_lib_version, '(none)') AS client_lib_version,
         finding_codes,
         COUNT(*) AS total
  FROM consent_receipts
  WHERE received_at >= ?1 AND received_at < ?2 AND finding_codes IS NOT NULL
  GROUP BY site_id, client_lib_version, finding_codes`;

/**
 * 3. source_consistent arány. A NULL (nincs összehasonlítható forrás) kimarad a
 * nevezőből — de a `total` külön jön, hogy a „nincs forgalom" és a „van
 * forgalom, de egyik receipt sem mérhető" eset ne mosódjon össze.
 */
export const SQL_CONSISTENCY = `
  SELECT SUM(CASE WHEN source_consistent = 0 THEN 1 ELSE 0 END) AS inconsistent,
         SUM(CASE WHEN source_consistent IS NOT NULL THEN 1 ELSE 0 END) AS comparable,
         COUNT(*) AS total
  FROM consent_receipts
  WHERE received_at >= ?1 AND received_at < ?2`;

/**
 * 4. NULL-forrás mintázat. Egy forrás akkor „nem volt elérhető", ha MINDKÉT
 * kategóriája NULL — a részlegesen kitöltött forrás létezett, csak nem mondott
 * mindent.
 */
export const SQL_NULL_SOURCES = `
  SELECT site_id,
         SUM(CASE WHEN src_cookie_analytics IS NULL AND src_cookie_marketing IS NULL THEN 1 ELSE 0 END) AS cookie_null,
         SUM(CASE WHEN src_api_analytics IS NULL AND src_api_marketing IS NULL THEN 1 ELSE 0 END) AS api_null,
         SUM(CASE WHEN src_server_analytics IS NULL AND src_server_marketing IS NULL THEN 1 ELSE 0 END) AS server_null,
         COUNT(*) AS total
  FROM consent_receipts
  WHERE received_at >= ?1 AND received_at < ?2
  GROUP BY site_id`;

/** 5. consent_debug sorok száma. */
export const SQL_DEBUG_ROWS = `
  SELECT COUNT(*) AS total FROM consent_debug WHERE created_at >= ?1 AND created_at < ?2`;

async function queryLeg<T>(
  env: Env,
  leg: string,
  sql: string,
  from: string,
  to: string,
  failedLegs: string[]
): Promise<T[] | null> {
  try {
    const res = await env.LEDGER!.prepare(sql).bind(from, to).all<T>();
    return res.results ?? [];
  } catch (err) {
    failedLegs.push(leg);
    logStructured({
      level: 'warn',
      error_code: TrackingErrorCode.CONSENT_CROSS_CHECK_FAILED,
      message: ERROR_DESCRIPTIONS[TrackingErrorCode.CONSENT_CROSS_CHECK_FAILED],
      leg,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * A teljes napi consent-keresztellenőrzés egy UTC-napra (YYYY-MM-DD).
 * LEDGER binding nélkül null (a hívó ilyenkor no-op).
 */
export async function runConsentCrossCheck(
  env: Env,
  date: string,
  thresholds: ConsentCrossCheckThresholds = DEFAULT_CONSENT_CROSS_CHECK_THRESHOLDS
): Promise<ConsentCrossCheckSummary | null> {
  if (!env.LEDGER) return null;

  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  // Baseline: a vizsgált napot MEGELŐZŐ 7 teljes nap (a mai nap nincs benne,
  // különben önmagához hasonlítanánk és minden elmozdulás felhígulna).
  const baselineStart = new Date(Date.parse(dayStart) - 7 * 24 * 60 * 60 * 1000).toISOString();

  const failedLegs: string[] = [];
  const grantedSkips = await queryLeg<GrantedSkipRow>(
    env,
    'granted_skips',
    SQL_GRANTED_SKIPS,
    dayStart,
    dayEnd,
    failedLegs
  );
  const findings = await queryLeg<FindingCountRow>(
    env,
    'findings',
    SQL_FINDINGS,
    dayStart,
    dayEnd,
    failedLegs
  );
  const today = await queryLeg<ConsistencyRow>(
    env,
    'consistency_today',
    SQL_CONSISTENCY,
    dayStart,
    dayEnd,
    failedLegs
  );
  const baseline = await queryLeg<ConsistencyRow>(
    env,
    'consistency_baseline',
    SQL_CONSISTENCY,
    baselineStart,
    dayStart,
    failedLegs
  );
  const nullSources = await queryLeg<NullSourceRow>(
    env,
    'null_sources',
    SQL_NULL_SOURCES,
    dayStart,
    dayEnd,
    failedLegs
  );
  const debugRows = await queryLeg<{ total: number }>(
    env,
    'debug_rows',
    SQL_DEBUG_ROWS,
    dayStart,
    dayEnd,
    failedLegs
  );

  const zero: ConsistencyRow = { inconsistent: 0, comparable: 0, total: 0 };
  const norm = (r: ConsistencyRow | undefined): ConsistencyRow =>
    r
      ? { inconsistent: r.inconsistent ?? 0, comparable: r.comparable ?? 0, total: r.total ?? 0 }
      : zero;

  return evaluateConsentCrossCheck(
    {
      grantedSkips: grantedSkips ?? [],
      findings: findings ?? [],
      today: norm(today?.[0]),
      baseline: norm(baseline?.[0]),
      nullSources: nullSources ?? [],
      debugRows: debugRows?.[0]?.total ?? 0,
      failedLegs
    },
    thresholds
  );
}
