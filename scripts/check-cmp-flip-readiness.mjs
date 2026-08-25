#!/usr/bin/env node
/**
 * P3.3 — a CMP pilot-flip ELŐFELTÉTEL-ŐRE.
 *
 * A flip két kézi kapcsoló (site env + KV `consent.provider`), és pontosan
 * ezért veszélyes: semmi nem akadályozza meg, hogy hiányzó előfeltételekkel
 * kapcsolják át. A hibák viszont NÉMÁK — egy `policy-unset` verzióval rögzített
 * hozzájárulás például tökéletesen működőnek látszik, csak épp a
 * bizonyíték-értéke nulla, és ez majd egy hatósági megkeresésnél derül ki.
 *
 * Ez a szkript a flip ELŐTT futtatandó, és mindent kimond, ami hiányzik.
 * SZÁNDÉKOSAN nem deploy-eszköz: nem kapcsol át semmit, csak megmondja,
 * szabad-e.
 *
 * Használat:
 *   node scripts/check-cmp-flip-readiness.mjs <hostname> [--config <fájl>]
 *
 * A site-configot vagy fájlból olvassa (`--config`), vagy — ha nincs megadva —
 * jelzi, hogy az élő KV-t kézzel kell ellenőrizni. Hálózatot NEM használ:
 * a flip-readiness ellenőrzés nem függhet attól, hogy épp van-e API-token.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const hostname = args.find((a) => !a.startsWith('--'));
const configIdx = args.indexOf('--config');
const configPath = configIdx !== -1 ? args[configIdx + 1] : null;

if (!hostname) {
  console.error('Használat: node scripts/check-cmp-flip-readiness.mjs <hostname> [--config <fájl>]');
  process.exit(2);
}

const problems = [];
const warnings = [];
const okItems = [];

function fail(id, msg, fix) {
  problems.push({ id, msg, fix });
}
function warn(id, msg) {
  warnings.push({ id, msg });
}
function ok(msg) {
  okItems.push(msg);
}

// ── 1. Migrációs politika: ELDÖNTVE és kódba zárva ────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'soborbo-tracking', 'lib', 'consent-migration.ts'), 'utf8');
  const m = src.match(/LEGACY_CONSENT_MIGRATION_POLICY:\s*LegacyConsentMigrationPolicy\s*=\s*'([a-z_]+)'/);
  if (!m) {
    fail('CMP-FLIP-001', 'A migrációs politika nem olvasható ki a kódból.', 'Ellenőrizd a lib/consent-migration.ts-t.');
  } else if (m[1] === 'migrate_if_equivalent') {
    fail(
      'CMP-FLIP-001',
      'A politika `migrate_if_equivalent`, de az ekvivalencia BIZONYÍTÁSA nem része ennek az ellenőrzésnek.',
      'Vagy állítsd vissza `reconsent_all`-ra, vagy csatold a kategória- és szövegverzió-egyezés bizonyítékát.'
    );
  } else {
    ok(`migrációs politika: ${m[1]} (a régi CookieYes-döntéseket NEM vesszük át)`);
  }
}

// ── 2. Süti-formátum: a lib és az inline boot EGYEZIK ─────────────────
{
  const state = fs.readFileSync(path.join(ROOT, 'soborbo-tracking', 'lib', 'consent-sbo-state.ts'), 'utf8');
  const boot = fs.readFileSync(path.join(ROOT, 'soborbo-tracking', 'components', 'Tracking.astro'), 'utf8');
  const libVersion = state.match(/return `(v\d+)\./)?.[1];
  const bootVersion = boot.match(/p\[0\]\s*===\s*'(v\d+)'/)?.[1];
  if (!libVersion || !bootVersion) {
    warn('CMP-FLIP-002', 'A süti-formátum verziója nem olvasható ki mindkét oldalról — nézd meg kézzel.');
  } else if (libVersion !== bootVersion) {
    fail(
      'CMP-FLIP-002',
      `A süti-formátum SZÉTCSÚSZOTT: lib=${libVersion}, inline boot=${bootVersion}.`,
      'A GTM-kapu és a lib mást gondolna ugyanarról a sütiről. Lásd tests/consent-boot-parity.test.ts.'
    );
  } else {
    ok(`süti-formátum egyezik a lib és az inline boot között (${libVersion})`);
  }
}

// ── 3. A 0006-os migráció létezik (consent_log) ───────────────────────
{
  const mig = path.join(ROOT, 'migrations', '0006_consent_log.sql');
  if (!fs.existsSync(mig)) {
    fail('CMP-FLIP-003', 'Hiányzik a 0006_consent_log migráció.', 'A consent-napló nélkül nincs Art. 7(1) bizonyíték.');
  } else {
    ok('0006_consent_log migráció megvan (éles D1-en KÉZZEL ellenőrizendő, hogy le is futott)');
    warn('CMP-FLIP-003', 'A migráció ÉLES lefutását ez a szkript nem tudja ellenőrizni (nincs hálózat) — nézd meg: wrangler d1 migrations list.');
  }
}

// ── 4. Consent-szövegek: verziózott könyvtár, mindkét nyelven ─────────
{
  const dir = path.join(ROOT, 'consent-texts');
  const versions = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  if (versions.length === 0) {
    fail('CMP-FLIP-004', 'Nincs verziózott consent-szöveg könyvtár.', 'A consent_text_version bizonyíték-láb enélkül üres.');
  } else {
    for (const v of versions) {
      for (const lang of ['hu.json', 'en.json']) {
        if (!fs.existsSync(path.join(dir, v, lang))) {
          fail('CMP-FLIP-004', `Hiányzik a(z) ${v}/${lang} szövegfájl.`, 'Mindkét nyelv kell, különben a bizonyíték nyelvfüggően hiányos.');
        }
      }
    }
    ok(`consent-szövegek: ${versions.join(', ')}`);
  }
}

// ── 5. A site KV-configja (ha megadták) ───────────────────────────────
if (configPath) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail('CMP-FLIP-005', `A megadott config nem olvasható/parse-olható: ${e.message}`, 'Ellenőrizd az utat és a JSON-t.');
  }
  if (cfg) {
    if (cfg.consent?.provider !== 'sbo') {
      warn('CMP-FLIP-005', `A configban a provider még '${cfg.consent?.provider ?? 'nincs megadva'}' — a flip ezt írja át 'sbo'-ra.`);
    } else {
      ok("a config már provider: 'sbo'");
    }
    if (cfg.require_consent !== true) {
      fail(
        'CMP-FLIP-006',
        `require_consent !== true (jelenleg: ${JSON.stringify(cfg.require_consent)}).`,
        'Saját CMP-vel fail-open configon élesíteni önellentmondás: a bannert megmutatjuk, de a döntést nem kényszerítjük ki.'
      );
    } else {
      ok('require_consent: true');
    }
    if (cfg.meta?.test_event_code) {
      fail('CMP-FLIP-007', 'A configban test_event_code van!', 'CLAUDE.md 17. — éles KV-be SOSEM. Távolítsd el a flip előtt.');
    }
  }
} else {
  warn('CMP-FLIP-005', 'Nem adtál meg site-configot (--config) — a provider/require_consent/test_event_code ellenőrzés KIMARADT.');
}

// ── 6. Emlékeztetők, amiket gép nem tud ellenőrizni ───────────────────
const manual = [
  'PUBLIC_TRACKING_POLICY_VERSION beállítva a site buildjében (NEM maradhat `policy-unset` — a bizonyíték-érték nulla lenne)',
  'PUBLIC_TRACKING_CONSENT_PROVIDER=sbo a site env-jében',
  'A süti-leíró oldal (mely süti, mennyi ideig, kinek) ÉL és a banner rá mutat',
  'Baseline-snapshot: 7 napos konverzió- és consent-arány a flip ELŐTT — a reconsent_all miatt VÁRHATÓ visszaesés, ezt mérni kell',
  'GTM Preview: a párhuzamos ablakban a kikapcsolt CookieYes NEM push-ol saját consent-parancsot',
  'A rollout-ablakban CSAK a CMP változik (R0.2) — se conversion-action, se OAuth, se package-migráció',
  'Rollback kipróbálva: consent.provider vissza `cookieyes`-ra, és az üzleti funkciók futnak tovább'
];

// ── Kimenet ───────────────────────────────────────────────────────────
console.log(`\nCMP flip-readiness — ${hostname}\n${'='.repeat(40)}\n`);

for (const o of okItems) console.log(`  ✅ ${o}`);
if (warnings.length) {
  console.log('\n  ── Figyelmeztetések ──');
  for (const w of warnings) console.log(`  ⚠️  ${w.id}  ${w.msg}`);
}
console.log('\n  ── KÉZI ellenőrzés (gép nem tudja) ──');
for (const m of manual) console.log(`  ☐ ${m}`);

if (problems.length) {
  console.error('\n  ── BLOKKOLÓ ──');
  for (const p of problems) {
    console.error(`  ❌ ${p.id}  ${p.msg}`);
    console.error(`       → ${p.fix}`);
  }
  console.error(`\nCMP_FLIP_NOT_READY — ${problems.length} blokkoló.\n`);
  process.exit(1);
}

console.log('\n✅ CMP_FLIP_GATE_OK — a gépi előfeltételek rendben. A kézi listát is nézd végig.\n');
