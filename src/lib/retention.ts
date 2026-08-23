/**
 * Ledger + dead-letter retention policy (#8/#9) — a D1 ledger és az R2 DLQ
 * korlátlan növekedése ellen. A pure mag (cutoff-számítás + policy-lista) itt él,
 * D1/R2 nélkül tesztelhető; a tényleges DELETE/list+delete a
 * scheduled/retention.ts handlerben fut (LEDGER/DEAD_LETTER binding mögött).
 *
 * Adatvédelmi / korrektségi megfontolások (FONTOS):
 *  - Az `events_raw`, `deliveries`, `idempotency` magas-volumenű, alacsony-
 *    érzékenységű OPERATÍV táblák → ezeket purge-öljük alapból (RETENTION_DAYS).
 *  - A `consent_receipts` (GDPR consent-bizonyíték) és a `lead_status` (a tényleges
 *    üzleti érték / offline-konverzió) alapból MEGMARAD. Csak külön env-vel
 *    (CONSENT_RETENTION_DAYS / LEAD_RETENTION_DAYS) purge-ölhető, jellemzően
 *    HOSSZABB ablakkal — a consent-proof megőrzési kötelezettség miatt.
 *  - Az `idempotency` purge KIZÁRJA a `do_not_replay = 1` rekordokat: ezek a
 *    consent-visszavonás / policy-tiltás permanens szuppressziós listája. Ha
 *    purge-ölnénk, egy régi tiltott event újra ki tudna menni a fan-out-on.
 */

export const DEFAULT_RETENTION_DAYS = 90;

/**
 * A `consent_debug` tábla megőrzési ablaka (Fázis D). RÖVID ÉS ALAPBÓL BE VAN
 * KAPCSOLVA — szemben a `consent_receipts`-szel, ami consent-proof, tehát
 * megmarad. Ez a tábla NYERS consent-stringeket tárol (a consentid-vel együtt),
 * kizárólag mismatch-diagnosztikához: nem napló, hanem rövid életű bizonyíték.
 * A CONSENT_DEBUG_RETENTION_DAYS env felülírhatja, de a default nem 90.
 */
export const CONSENT_DEBUG_RETENTION_DAYS = 14;

/**
 * A `consent_log` megőrzési ablaka (Soborbo CMP). ALAPBÓL BE VAN KAPCSOLVA, de
 * HOSSZÚ: 3 év. Ez consent-PROOF (GDPR Art. 7(1)) — a bizonyítási teher a
 * miénk, tehát nem törölhetjük gyorsan; viszont a jogi audit 7. pontja szerint
 * egy örökké növő, törlési szabály NÉLKÜLI append-only tábla maga is
 * minimalizálási hiányosság. A vágás a `server_received_at`-en megy.
 *
 * FONTOS: az EGY consent_id-hez tartozó RÉGEBBI revisionök is ide esnek — a
 * legfrissebb állapotot a MAX(revision) adja, és azt csak akkor veszítjük el, ha
 * maga a legutolsó döntés is 3 évnél régebbi (vagyis a lánc rég inaktív).
 */
export const CONSENT_LOG_RETENTION_DAYS = 3 * 365;

/**
 * A `consent_metrics` (banner-megjelenések) ablaka: 12 hónap. Ez UX-mérés, nem
 * bizonyíték — és ID-mentes, tehát a kockázata alacsony; a hosszú megőrzés
 * viszont semmit nem adna hozzá.
 */
export const CONSENT_METRICS_RETENTION_DAYS = 365;

export interface RetentionPolicy {
  table: string;
  /** ISO 8601 text timestamp oszlop, ami alapján vágunk. */
  column: string;
  days: number;
  /** Extra WHERE-feltétel (a cutoff mellé AND-elve). Pl. do_not_replay védelem. */
  guard?: string;
}

/**
 * Env-string → pozitív egész nap. Érvénytelen / <1 / hiányzó → fallback.
 * `fallback = 0` jelentése: a policy KIMARAD (opt-in táblák alapértelmezett OFF).
 */
export function resolveRetentionDays(
  raw: string | undefined,
  fallback: number = DEFAULT_RETENTION_DAYS
): number {
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/** A cutoff ISO-timestamp: minden rekord, aminek a timestampja < cutoff, törlendő. */
export function cutoffIso(nowMs: number, days: number): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * A futtatandó D1 retention-policy-k env alapján. Az operatív táblák mindig
 * benne vannak (RETENTION_DAYS, default 90); a consent/lead tábla CSAK ha a
 * megfelelő env explicit be van állítva (>=1 nap).
 */
export function buildRetentionPolicies(env: {
  RETENTION_DAYS?: string;
  CONSENT_RETENTION_DAYS?: string;
  CONSENT_DEBUG_RETENTION_DAYS?: string;
  CONSENT_LOG_RETENTION_DAYS?: string;
  CONSENT_METRICS_RETENTION_DAYS?: string;
  LEAD_RETENTION_DAYS?: string;
}): RetentionPolicy[] {
  const days = resolveRetentionDays(env.RETENTION_DAYS);

  const policies: RetentionPolicy[] = [
    { table: 'events_raw', column: 'received_at', days },
    { table: 'deliveries', column: 'created_at', days },
    // do_not_replay = 1 → permanens szuppressziós lista, SOHA nem purge-öljük.
    { table: 'idempotency', column: 'last_seen_at', days, guard: 'do_not_replay = 0' },
    // Fázis D: a nyers consent-stringek rövid életűek, és a purge NEM opt-in —
    // ez a tábla percenként nőhet egy elromlott CMP mellett, és tartalma
    // érzékenyebb, mint a receipteké.
    {
      table: 'consent_debug',
      column: 'created_at',
      days: resolveRetentionDays(env.CONSENT_DEBUG_RETENTION_DAYS, CONSENT_DEBUG_RETENTION_DAYS)
    },
    // Soborbo CMP: a consent-proof HOSSZÚ, de nem végtelen (3 év); a banner-
    // megjelenés-mérés rövid (12 hónap). Mindkettő alapból BE van kapcsolva — a
    // jogi audit szerint a törlési szabály hiánya maga is minimalizálási hiba.
    // A táblák üresek, amíg egyetlen site sem fut `provider='sbo'`-val, tehát a
    // policy jelenléte nem jár semmilyen hatással.
    {
      table: 'consent_log',
      column: 'server_received_at',
      days: resolveRetentionDays(env.CONSENT_LOG_RETENTION_DAYS, CONSENT_LOG_RETENTION_DAYS)
    },
    {
      table: 'consent_metrics',
      column: 'shown_at',
      days: resolveRetentionDays(env.CONSENT_METRICS_RETENTION_DAYS, CONSENT_METRICS_RETENTION_DAYS)
    }
  ];

  // Opt-in, érzékeny táblák — alapból OFF (fallback 0 = kihagyás).
  const consentDays = resolveRetentionDays(env.CONSENT_RETENTION_DAYS, 0);
  if (consentDays >= 1) {
    policies.push({ table: 'consent_receipts', column: 'received_at', days: consentDays });
  }
  const leadDays = resolveRetentionDays(env.LEAD_RETENTION_DAYS, 0);
  if (leadDays >= 1) {
    policies.push({ table: 'lead_status', column: 'created_at', days: leadDays });
  }

  return policies;
}

/** A policy → parametrizált DELETE SQL (a cutoff `?1`-ként megy be). */
export function deleteSql(policy: RetentionPolicy): string {
  const guard = policy.guard ? ` AND ${policy.guard}` : '';
  return `DELETE FROM ${policy.table} WHERE ${policy.column} < ?1${guard}`;
}
