#!/usr/bin/env node
/**
 * check-doc-truth.mjs — TRUTH-FREEZE KAPU (vNext P0.5).
 *
 * A doksi↔valóság drift ebben a repóban nem elméleti: két doksi 2026-08-24-ig a
 * Google Tag Gateway BEKAPCSOLÁSÁT írta elő (miközben a fleet-döntés a kikapcsolás),
 * a gtm-setup.md egy Custom HTML consent-default GTM-taget dokumentált (a valóság
 * inline `Tracking.astro`), és a generátor GA4-warningja azt sugallta, hogy a `ga4`
 * blokk kellene (a szerver egyáltalán nem küld GA4-et). Egy onboardoló ember vagy
 * agent ezekből dolgozik — a drift így KONFIGURÁCIÓS hibává válik.
 *
 * Két szabálytípus:
 *   FORBIDDEN — a konkrét, cáfolt utasítás/állítás nem lehet jelen.
 *   ANCHOR    — a kanonikus állításnak jelen KELL lennie, gépi horgonnyal
 *               (`<!-- TRUTH-ANCHOR: id -->`). Aki átírja a bekezdést és kiveszi az
 *               állítást, a horgonyt is kiveszi → a kapu bukik. Prózára illesztett
 *               pozitív grep ehelyett minden újrafogalmazásnál hamisan bukna.
 *
 * SZÁNDÉKOSAN NEM ellenőrzött: `docs/archive/**` (történeti pillanatkép, nem
 * utasítás), a terv- és cross-check-dokumentumok (IDÉZIK a hibás sorokat mint
 * evidenciát), és a compliance-riportok (mérési jegyzőkönyvek).
 *
 * Használat: node scripts/check-doc-truth.mjs   (npm run check:docs)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, stdout } from 'node:process';
import { integrationChecklist } from './lib/integration-checklist.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDED_DIRS = ['node_modules', '.git', 'docs/archive', 'tests/compliance/reports'];
const EXCLUDED_FILES = ['VNEXT-TERV.md', 'CROSSCHECK-vnext-A-H-2026-08-24.md', 'FAZIS-0-MUNKACSOMAG.md'];

/** Extra, nem-.md fájlok, amikre a tiltó szabályok szintén állnak (operátornak szóló szöveg). */
// A checklist-SABLON (scripts/lib/integration-checklist.mjs) SZÁNDÉKOSAN nincs itt.
// A prózára illesztett grep nem tudja megkülönböztetni az UTASÍTÁST az ELLENE SZÓLÓ
// figyelmeztetéstől: a modul docstringje idézi a régi hibás sort (azért létezik), a
// cookieyes-ág pedig épp TILTJA a Custom HTML consent-default taget. Mindkettő hamis
// pozitívot adna. A checklistet ezért ott ellenőrizzük, ahol számít: a GENERÁLT
// kimeneten (GENERATED_CHECKLIST_RULES) — azt kapja meg az onboardoló.
const EXTRA_FILES = ['scripts/generate-site.mjs'];

const FORBIDDEN = [
  {
    id: 'deleted-client-lib-as-install-step',
    pattern: /client-lib\/[^\n]{0,80}bemásolva/i,
    reason:
      'A flat `client-lib/` (worker-tracking.ts + uuid.ts) F2-2 óta TÖRÖLVE — a kanonikus Astro kliens a ' +
      '`soborbo-tracking` package (lib/ + components/). Telepítési lépésként hivatkozni rá olyan mappába ' +
      'küldi az onboardolót, ami nem létezik.'
  },
  {
    id: 'tag-gateway-enable-instruction',
    pattern: /(Google Tag Gateway\s*(?:→|->)\s*Enable|Enable\s+(?:the\s+)?Google Tag Gateway|Google tag gateway\s*(?:→|->)\s*Sign in)/i,
    reason:
      'A Google Tag Gateway zóna-szintű auto-injektálás DEFAULT OFF (fleet-döntés, 2026-08-24). ' +
      'Az injektálás a `gtm.start`-ot a consent-default ELÉ teszi — sbo-site-on ez pre-consent GTM-indítás. ' +
      'Doksi NEM írhatja elő a bekapcsolását.'
  },
  {
    id: 'consent-default-as-gtm-custom-html-tag',
    pattern: /Consent Default[^\n]{0,60}Custom HTML/i,
    reason:
      'A Consent Mode default INLINE van a Tracking.astro-ban, a GTM-snippet ELŐTT — nem GTM Custom HTML tag. ' +
      'Egy konténerbeli tag nem tud elég korán futni, és a gen-container.mjs sem emittál ilyet.'
  },
  {
    id: 'ga4-block-presented-as-missing-capability',
    pattern: /ga4 blokk hiányzik[^\n]{0,80}kimarad ennél a site-nál/i,
    reason:
      'A `ga4` blokk HIÁNYA a helyes állapot: a gateway Modell 2 / Run 6 óta egyáltalán nem küld GA4-et. ' +
      'A régi szöveg azt sugallta, hogy a blokk kellene — új site-nál pont a JELENLÉTÉT kell indokolni.'
  },
  {
    id: 'cookieyes-called-legacy',
    pattern: /cookieyes[^\n]{0,30}\blegacy\b|\blegacy\b[^\n]{0,30}cookieyes/i,
    reason:
      'A CookieYes MA a default, és minden élő site azt futtatja — a sbo saját CMP pilot-stádiumban van, ' +
      'nulla flippelt site-tal. „Legacy"-ként leírni a célállapotot mondaná ki jelenként (vNext P0.5).'
  }
];

const ANCHORS = [
  {
    id: 'tag-gateway-default-off',
    file: 'soborbo-tracking/docs/cloudflare-setup.md',
    reason: 'a Tag Gateway default-OFF állapotának kimondása'
  },
  {
    id: 'consent-default-is-inline-not-a-gtm-tag',
    file: 'soborbo-tracking/docs/gtm-setup.md',
    reason: 'a consent-default tényleges helye (inline Tracking.astro)'
  },
  {
    id: 'server-sends-no-ga4',
    file: 'soborbo-tracking/INSTALL.md',
    reason: 'a szerver NEM küld GA4-et (Modell 2 / Run 6)'
  },
  {
    id: 'google-offline-path-is-data-manager',
    file: 'soborbo-tracking/INSTALL.md',
    reason: 'a Google offline út a Data Manager API; a legacy uploadClickConversions dormant'
  },
  {
    id: 'cmp-default-cookieyes-sbo-is-pilot',
    file: 'soborbo-tracking/INSTALL.md',
    reason: 'CMP: default cookieyes, sbo = pilot, per-site emberi döntés; célállapot sbo fleet-wide'
  }
];

/**
 * GENERÁLT kimenetre vonatkozó szabályok (2026-08-24 review #4).
 *
 * Egy generált dokumentum ugyanúgy sodródhat, mint egy kézzel írt — csak rosszabbul,
 * mert minden új site bekötésekor újratermelődik, és az onboardoló EBBŐL dolgozik. A
 * kapu ezért nem a sablon SZÖVEGÉRE illeszkedik, hanem arra, amit a site tényleg kap:
 * legeneráljuk mindkét provider-változatot, és azon futtatjuk az állításokat.
 *
 * `mustNotMatch` — konkrét WIRING-utasítás, ami az adott providernél hamis.
 * `mustContain`  — az adott providernél elhagyhatatlan lépés.
 */
const GENERATED_CHECKLIST_RULES = [
  {
    id: 'sbo-checklist-must-not-wire-cookieyes',
    provider: 'sbo',
    mustNotMatch: [
      { re: /client-lib\/[^\n]{0,80}bemásolva/i, why: 'a flat client-lib/ F2-2 óta TÖRÖLVE — a kanonikus kliens a soborbo-tracking package' },
      { re: /cookieYesId/, why: 'sbo site-on nincs CookieYes-szkript — a Tracking.astro a szinkron consent-bootot rendereli' },
      { re: /cookieyes-consent/, why: 'sbo site-on a gateway a saját sbo_consent sütiből olvas, nem a cookieyes-consentből' },
      { re: /CookieYes aktív/i, why: 'egyenesen hamis utasítás egy sbo site-on' },
      { re: /<TrackingNoscript gtmId/, why: 'sbo site-on a TrackingNoscript-et KI kell venni: noscript alatt nincs consent-döntés, a GTM-iframe consent előtt futna' }
    ],
    mustContain: [
      { s: 'PUBLIC_TRACKING_CONSENT_PROVIDER=sbo', why: 'a provider env nélkül a kliens a cookieyes-ágra esik vissza' },
      { s: 'PUBLIC_TRACKING_POLICY_VERSION', why: 'kötelező mező minden consent-log soron' },
      { s: 'ConsentBanner', why: 'sbo-n a banner a döntés egyetlen felülete' },
      { s: 'consentId', why: 'a backend-dispatch consentId nélkül az offline/replay láb nem tudja feloldani a consent_log revisionjét' }
    ]
  },
  {
    id: 'cookieyes-checklist-must-still-wire-cookieyes',
    provider: 'cookieyes',
    mustNotMatch: [
      { re: /client-lib\/[^\n]{0,80}bemásolva/i, why: 'a flat client-lib/ F2-2 óta TÖRÖLVE — a kanonikus kliens a soborbo-tracking package' },
      { re: /PUBLIC_TRACKING_CONSENT_PROVIDER=sbo/, why: 'a default (cookieyes) checklist nem kapcsolhat sbo-ra' }
    ],
    mustContain: [
      { s: 'CookieYes aktív', why: 'a mai default provider tényleges bekötési lépése' },
      { s: 'TrackingNoscript', why: 'cookieyes-ágon a noscript GTM-iframe kell' }
    ]
  }
];

function checkGeneratedChecklists() {
  const violations = [];
  const base = {
    site_id: 'gate-fixture',
    hostnames: ['gate-fixture.example.com'],
    country_code: 'HU',
    currency: 'HUF',
    require_consent: true,
    meta: { pixel_id: '123456', access_token: 'T' },
    gads: { customer_id: null }
  };

  for (const rule of GENERATED_CHECKLIST_RULES) {
    const cfg = rule.provider === 'sbo' ? { ...base, consent: { provider: 'sbo' } } : base;
    let text;
    try {
      text = integrationChecklist(cfg);
    } catch (e) {
      violations.push({
        kind: 'GENERATED',
        rule: rule.id,
        where: `integrationChecklist(provider=${rule.provider})`,
        line: '(a generálás dobott)',
        reason: e instanceof Error ? e.message : String(e)
      });
      continue;
    }
    for (const m of rule.mustNotMatch) {
      if (m.re.test(text))
        violations.push({
          kind: 'GENERATED',
          rule: rule.id,
          where: `integrationChecklist(provider=${rule.provider})`,
          line: `TILTOTT minta jelen van: ${m.re}`,
          reason: m.why
        });
    }
    for (const c of rule.mustContain) {
      if (!text.includes(c.s))
        violations.push({
          kind: 'GENERATED',
          rule: rule.id,
          where: `integrationChecklist(provider=${rule.provider})`,
          line: `HIÁNYZÓ kötelező lépés: ${c.s}`,
          reason: c.why
        });
    }
  }
  return violations;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) continue;
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (entry.endsWith('.md') && !EXCLUDED_FILES.includes(rel)) acc.push(rel);
  }
  return acc;
}

export function checkDocTruth() {
  const files = [...walk(ROOT), ...EXTRA_FILES];
  const violations = [];

  for (const rel of files) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A tiltó szabályokat a SAJÁT definíciójukon ne futtassuk (ez a fájl).
      if (rel === 'scripts/check-doc-truth.mjs') return;
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line))
          violations.push({ kind: 'FORBIDDEN', rule: rule.id, where: `${rel}:${i + 1}`, line: line.trim(), reason: rule.reason });
      }
    });
  }

  for (const a of ANCHORS) {
    let text = '';
    try {
      text = readFileSync(join(ROOT, a.file), 'utf8');
    } catch {
      violations.push({ kind: 'ANCHOR', rule: a.id, where: a.file, line: '(fájl nem olvasható)', reason: a.reason });
      continue;
    }
    if (!text.includes(`TRUTH-ANCHOR: ${a.id}`))
      violations.push({ kind: 'ANCHOR', rule: a.id, where: a.file, line: '(hiányzó horgony)', reason: a.reason });
  }

  violations.push(...checkGeneratedChecklists());

  return violations;
}

function main() {
  const violations = checkDocTruth();
  if (violations.length === 0) {
    stdout.write(
      '✅ DOC_TRUTH_OK — nincs cáfolt utasítás, minden kanonikus állítás a helyén, ' +
        'és a GENERÁLT checklist mindkét provider-változata helyes.\n'
    );
    return;
  }
  stdout.write('DOC_TRUTH_FAIL\n\n');
  for (const v of violations) {
    stdout.write(`[${v.kind}: ${v.rule}] ${v.where}\n  > ${v.line}\n  ${v.reason}\n\n`);
  }
  exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
