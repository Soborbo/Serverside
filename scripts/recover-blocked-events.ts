#!/usr/bin/env node --experimental-strip-types
/**
 * EGYSZER HASZNÁLATOS recovery a lomtalan Meta-kiesés 3 elveszett leadjéhez.
 *
 * ═══ Miért van rá szükség ═══
 * 2026-07-15 és 07-20 között a lomtalan site-configból hiányzott a `meta` blokk.
 * A fan-out ezt „sikeres skip"-nek vette: nem készült DLQ-rekord, viszont a
 * `markDispatched` lefutott. Az eredmény: 3 valódi quote-lead úgy veszett el,
 * hogy (a) a payload SEHOL nem maradt meg — az events_raw csak `em_present`
 * jelenlét-flageket tárol, hash-t nem —, és (b) az idempotencia `dispatched=1`-e
 * miatt ugyanannak az eventnek az újraküldése az ingressen 204-et kapna,
 * fan-out nélkül, csendben.
 *
 * A gyökérokot a PLATFORM_NOT_CONFIGURED-ág javítja (lásd lib/skip-reason.ts),
 * de az AZ csak a JÖVŐBELI eventeket menti meg. Ez a script a MÚLTBELI hármat.
 *
 * ═══ Miért nem az ingressen megy ═══
 * Nincs és ne is legyen `force_replay` / `bypass_idempotency` kapcsoló egy
 * általánosan elérhető ingress-úton — az előbb-utóbb duplán könyvelt, valódi
 * pénzt mozgató konverziók forrása lenne. Ehelyett a rekord KÖZVETLENÜL a
 * retry/DLQ útba kerül: onnantól a már meglévő, tesztelt retry worker viszi a
 * Metának. Az idempotencia-táblához NEM nyúlunk.
 *
 * ═══ Használat ═══
 *   node scripts/recover-blocked-events.ts <crm-leads.json>              # dry-run
 *   node scripts/recover-blocked-events.ts <crm-leads.json> --execute    # ír
 *
 * A bemeneti JSON a CRM-ből jön, tömb, elemenként:
 *   {
 *     "tracking_event_id": "38467d39-…",   // MUSZÁJ az allowlistán lennie
 *     "lead_id":           "780a1d0c-…",
 *     "event_name":        "quote_calculator_submitted",
 *     "event_time":        1784144087,      // MÁSODPERC, az EREDETI időpont
 *     "event_source_url":  "https://lomtalan.hu/arajanlat",
 *     "value":             300000,
 *     "currency":          "HUF",
 *     "user_data":  { "email": "…", "phone_number": "…", "first_name": "…",
 *                     "last_name": "…", "city": "…", "postal_code": "…" },
 *     "attribution": { "fbp": "fb.1.…", "fbc": "fb.1.…" }   // opcionális
 *   }
 *
 * A hash-elés a PRODUCTION kóddal történik (`src/lib/hash.ts` közvetlen import),
 * hogy a Meta match-rate azonos legyen az élő úttal. PII-t a script SOHA nem ír ki.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashUserData, type PlainUserData, type CountryCode } from '../src/lib/hash.ts';

// ── Kemény allowlist ────────────────────────────────────────────────────────
// A D1-ből mérve (2026-07-20): ez az a HÁROM esemény, aminél ad_allowed=1
// MINDKÉT forrásban, nem szintetikus, és nincs rá későbbi accepted delivery.
// A listát szándékosan nem lehet paraméterből bővíteni — ez a script nem
// általános replay-eszköz, hanem egy konkrét incidens zárása.
const ALLOWLIST = new Set([
  '38467d39-d9a0-4fb0-9285-c36761f2cfd3', // 2026-07-15 19:34 — Meta-ablak: 07-22
  '7fe88f90-5033-4742-8a77-e27ca6938720', // 2026-07-18 16:40
  '44db0115-5f95-4960-a4ab-e379e8814546'  // 2026-07-18 20:58
]);

const SITE_ID = 'lomtalan';
const HOSTNAME = 'lomtalan.hu';
const PLATFORM = 'meta';
const COUNTRY: CountryCode = 'HU';
const D1_DB = 'event-gateway-ledger';
const R2_BUCKET = 'soborbo-tracking-dlq-eu';
/** Meta CAPI elfogadási ablak — ezen túl a feltöltés eldobódik. */
const META_WINDOW_DAYS = 7;
/** Ideiglenes fájlok helye (SQL-lekérdezés, feltöltendő DLQ-rekord). */
const TMP_DIR = process.env.TEMP || process.env.TMPDIR || '/tmp';

const [inputPath, ...flags] = process.argv.slice(2);
const EXECUTE = flags.includes('--execute');

if (!inputPath) {
  console.error('usage: recover-blocked-events.ts <crm-leads.json> [--execute]');
  process.exit(1);
}

/**
 * Shell NÉLKÜL indítunk: shellen keresztül a Windows cmd megeszi az SQL
 * idézőjeleit (a lekérdezés SQLITE_ERROR-ral hasal el), ráadásul a nem-escape-elt
 * argumentumok injektálhatók.
 *
 * A wrangler JS-belépőjét közvetlenül a futó Node-dal hívjuk, nem `npx`-en át:
 * Node 24 biztonsági okból EINVAL-lal elutasítja a `.cmd` shell nélküli
 * indítását, shellel viszont visszajönne az idézőjel-probléma.
 */
const WRANGLER_BIN = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);
const wrangler = (args: string[]): string =>
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });

/**
 * D1 SELECT → sorok. A `--json` kimenet burkolt: [{ results: [...] }].
 *
 * `--command`, NEM `--file`: a fájlos út SELECT-nél csak futásstatisztikát ad
 * vissza (Total queries executed / Rows read), sorokat nem — a szűrőink így
 * némán üres eredményt látnának, és MINDEN eventet elutasítanának.
 */
function d1(sql: string): Record<string, unknown>[] {
  const out = wrangler(['d1', 'execute', D1_DB, '--remote', '--json', '--command', sql]);
  // A wrangler bannert is írhat a JSON elé — az első '[' vagy '{'-től parse-olunk.
  const start = out.search(/[[{]/);
  if (start < 0) throw new Error(`unexpected wrangler output: ${out.slice(0, 200)}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

interface CrmLead {
  tracking_event_id: string;
  lead_id: string;
  event_name: string;
  event_time: number;
  event_source_url?: string;
  value?: number;
  currency?: string;
  user_data: PlainUserData;
  attribution?: { fbp?: string; fbc?: string };
}

const leads: CrmLead[] = JSON.parse(readFileSync(inputPath, 'utf8'));

console.log(`\n${EXECUTE ? '⚠️  ÉLES FUTÁS' : '🔍 DRY-RUN'} — ${leads.length} bemeneti rekord\n`);

// ── Ledger-oldali igazságok egyetlen körben ────────────────────────────────
const ids = [...ALLOWLIST].map((id) => `'${id}'`).join(',');
const consentRows = d1(
  `SELECT r.event_id, r.ad_allowed AS raw_ad, c.ad_allowed AS receipt_ad
     FROM events_raw r LEFT JOIN consent_receipts c ON c.event_id = r.event_id
    WHERE r.site_id='${SITE_ID}' AND r.event_id IN (${ids})`
);
const acceptedRows = d1(
  `SELECT event_id, COUNT(*) AS n FROM deliveries
    WHERE site_id='${SITE_ID}' AND platform='${PLATFORM}' AND status='accepted'
      AND event_id IN (${ids}) GROUP BY event_id`
);
const consentByEvent = new Map(consentRows.map((r) => [String(r.event_id), r]));
const acceptedByEvent = new Map(acceptedRows.map((r) => [String(r.event_id), Number(r.n)]));

const nowSec = Math.floor(Date.now() / 1000);
let planned = 0;
let refused = 0;

for (const lead of leads) {
  const id = lead.tracking_event_id;
  const label = `${id.slice(0, 8)}…`; // event_id nem PII, de rövidítve is elég
  const refuse = (why: string) => {
    console.log(`  ❌ ${label} — KIHAGYVA: ${why}`);
    refused++;
  };

  // 1. Allowlist — az egyetlen módja, hogy egy event ide bekerüljön.
  if (!ALLOWLIST.has(id)) {
    refuse('nincs az allowlistán');
    continue;
  }
  // 2. Szintetikus kizárása (öv és nadrágtartó: az allowlist már kizárja).
  if (id.startsWith('smoke-') || lead.lead_id?.startsWith('smoke-')) {
    refuse('szintetikus esemény');
    continue;
  }
  // 3. Consent — MINDKÉT forrásnak egyeznie kell. Egy GDPR-tiltott eventet
  //    utólag feltölteni súlyosabb hiba, mint elveszíteni.
  const consent = consentByEvent.get(id);
  if (!consent) {
    refuse('nincs ledger-rekord (events_raw)');
    continue;
  }
  if (Number(consent.raw_ad) !== 1 || Number(consent.receipt_ad) !== 1) {
    refuse(`consent nem engedi (events_raw=${consent.raw_ad}, receipt=${consent.receipt_ad})`);
    continue;
  }
  // 4. Nincs későbbi sikeres kézbesítés — különben duplán könyvelnénk.
  if ((acceptedByEvent.get(id) ?? 0) > 0) {
    refuse('már van accepted delivery erre az event_id-ra');
    continue;
  }
  // 5. Meta 7 napos ablak — ezen túl a feltöltés úgyis eldobódik.
  const ageDays = (nowSec - lead.event_time) / 86400;
  if (ageDays > META_WINDOW_DAYS) {
    refuse(`az esemény ${ageDays.toFixed(1)} napos — a Meta ${META_WINDOW_DAYS} napos ablakán kívül`);
    continue;
  }
  if (!Number.isFinite(lead.event_time) || lead.event_time <= 0) {
    refuse('hiányzó vagy érvénytelen event_time');
    continue;
  }

  // ── DLQ-rekord az EREDETI azonosítókkal ──────────────────────────────────
  const hashed = await hashUserData(lead.user_data, COUNTRY);
  if (!hashed.em && !hashed.ph) {
    refuse('a CRM-ben nincs se email, se telefon — match nélkül nincs értelme');
    continue;
  }

  const eventPayload: Record<string, unknown> = {
    event_name: lead.event_name,
    event_id: id, // EREDETI — a Meta ezzel dedup-ol a böngésző-Pixellel
    event_time: lead.event_time, // EREDETI — nem a mostani idő
    event_source_url: lead.event_source_url,
    value: lead.value,
    currency: lead.currency,
    fbp: lead.attribution?.fbp,
    fbc: lead.attribution?.fbc
  };

  const nowIso = new Date().toISOString();
  const record = {
    platform: PLATFORM,
    site_id: SITE_ID,
    hostname: HOSTNAME,
    lead_id: lead.lead_id,
    event_payload: eventPayload,
    hashed_user_data: hashed,
    failure_reason:
      'manual recovery: meta config was missing during the 2026-07-15..07-20 outage',
    // A hosszú retry-ablakot ez kapcsolja be (lib/deadletter.ts).
    blocked_configuration: true,
    retry_count: 0,
    first_failed_at: nowIso,
    last_attempted_at: nowIso
  };

  // R2-kulcs a writeDeadLetter formátumával — így a cron pending-ként látja.
  const dateStr = nowIso.slice(0, 10);
  const timeStr = nowIso.slice(11, 19).replace(/:/g, '-');
  const safeEventId = id.slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '_');
  const key = `${SITE_ID}/${PLATFORM}/${dateStr}/${timeStr}_${safeEventId}_0_${randomUUID().slice(0, 8)}.json`;

  // A napló SOHA nem tartalmaz PII-t — csak azt, hogy MELY mezők álltak rendelkezésre.
  const present = ['em', 'ph', 'fn', 'ln', 'ct', 'zp', 'country']
    .filter((k) => (hashed as Record<string, unknown>)[k])
    .join(',');
  console.log(
    `  ✅ ${label} — event_time=${lead.event_time} (${ageDays.toFixed(1)} nap), ` +
      `hash-mezők: [${present}], kulcs: ${key}`
  );
  planned++;

  if (EXECUTE) {
    const tmp = `${TMP_DIR}/dlq-${safeEventId}.json`;
    writeFileSync(tmp, JSON.stringify(record));
    wrangler(['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', tmp, '--remote']);
    unlinkSync(tmp);
  }
}

console.log(
  `\n${EXECUTE ? 'Kiírva' : 'Kiírásra várna'}: ${planned} · Kihagyva: ${refused}\n`
);
if (!EXECUTE && planned > 0) {
  console.log('Éles futáshoz: add hozzá a --execute kapcsolót.');
  console.log('Utána az óránkénti cron viszi a Metának; ellenőrzés:');
  console.log(`  SELECT event_id, status, origin, http_status, created_at FROM deliveries
   WHERE site_id='${SITE_ID}' AND platform='${PLATFORM}'
     AND event_id IN (${[...ALLOWLIST].map((i) => `'${i}'`).join(', ')})
   ORDER BY event_id, created_at;\n`);
}
