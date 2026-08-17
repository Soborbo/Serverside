/**
 * Riport-építés: gépi `report.json` + emberi `report.md`.
 *
 * A markdown FŐ eleme egyetlen táblázat (sorok = site-ok, oszlopok = kritikus
 * ellenőrzések), hogy egy pillantással látszódjon, HÁNY oldal bukik MELYIK
 * ponton. Alatta site-onkénti részletek a NYERS bizonyítékkal.
 */

import { FAIL, INFO, NA, PASS, TABLE_COLUMNS } from './checks.mjs';

const MARK = { [PASS]: '✅', [FAIL]: '❌', [NA]: '–', [INFO]: 'ℹ️', ERROR: '⚠️' };

/**
 * Azok az országkódok, ahonnan egy `eea_uk` szabályrendszerű site mérése
 * érvényes. Nem teljes EEA-lista: a flotta piacai + a fő EEA-kilépőpontok.
 */
const EEA_UK_COUNTRIES = new Set(['HU', 'GB', 'IE', 'DE', 'AT', 'FR', 'NL', 'BE', 'SK', 'RO', 'PL', 'CZ', 'ES', 'IT']);

export function statusMark(status) {
  // A hiányzó státusz „nem mérhető" — sosem `?`. Egy értelmezhetetlen jel a
  // táblázatban rosszabb, mint a bevallott hiány.
  return MARK[status] || '–';
}

/** site-eredmény → { checkId: status } lapos térkép. */
export function indexChecks(siteResult) {
  const map = {};
  for (const c of siteResult.checks || []) map[c.id] = c.status;
  return map;
}

/** Oszloponkénti bukás-összesítés — ez a riport lényege. */
export function summarizeColumns(results) {
  return TABLE_COLUMNS.map((col) => {
    let pass = 0;
    let fail = 0;
    let na = 0;
    for (const r of results) {
      if (r.status === 'ERROR') continue;
      const s = indexChecks(r)[col.id];
      if (s === PASS) pass++;
      else if (s === FAIL) fail++;
      else na++;
    }
    return { ...col, pass, fail, na };
  });
}

function evidenceBlock(check) {
  if (check.evidence === null || check.evidence === undefined) return '';
  const json = JSON.stringify(check.evidence, null, 2);
  const trimmed = json.length > 4000 ? `${json.slice(0, 4000)}\n… (levágva, a teljes lista a report.json-ban)` : json;
  return `\n\n<details><summary>bizonyíték</summary>\n\n\`\`\`json\n${trimmed}\n\`\`\`\n\n</details>`;
}

export function buildMarkdown(run) {
  const { started_at, finished_at, browsers, test_country, results, run_command, relay_mode } = run;
  const lines = [];

  lines.push('# Consent compliance baseline');
  lines.push('');
  lines.push(`**Futás:** \`${run_command}\`  `);
  lines.push(`**Kezdet:** ${started_at} · **Vége:** ${finished_at}  `);
  lines.push(`**Böngészők:** ${browsers.join(', ')}  `);
  lines.push(`**Teszt-IP országa:** ${test_country || 'ismeretlen'} — a banner megjelenése geo-függő lehet.`);
  if (relay_mode) {
    lines.push('');
    lines.push(
      '> **Relay-mód volt bekapcsolva.** A böngésző kéréseit a futtató Node HTTP-stackje szolgálta ki ' +
        '(a mérés környezetében a böngésző közvetlenül nem jut ki a hálózatra). Minden kérés ugyanúgy ' +
        'megjelenik a felvételben — csak a válasz jön máshonnan. Ami emiatt NEM mérhető pontosan: a ' +
        'HTTP/2–3 és TLS-szintű viselkedés, valamint a böngésző saját protokoll-optimalizációi.'
    );
  }
  // A baseline ÉRVÉNYESSÉGI korlátai a lap tetejére kerülnek, nem a lábjegyzetbe:
  // egy hiányos mérésből levont következtetés rosszabb, mint a hiányzó mérés.
  const limitations = [];
  const expectedRegions = [...new Set(results.map((r) => r.site?.expected_ruleset).filter(Boolean))];
  if (test_country && expectedRegions.includes('eea_uk') && !EEA_UK_COUNTRIES.has(test_country)) {
    limitations.push(
      `**A mérés \`${test_country}\` IP-ről futott, miközben minden site \`eea_uk\` szabályrendszerű.** ` +
        'A CMP-megjelenítés és a tag-viselkedés geo-függő lehet, ezért ez a futás NEM alkalmas az EEA/UK ' +
        'viselkedés megállapítására: a hiányzó banner vagy kontroll itt N-A-ként jelenik meg, nem hibaként. ' +
        'A baseline-t HU/UK kilépőpontról meg kell ismételni.'
    );
  }
  const missingBrowsers = ['chromium', 'webkit'].filter((b) => !browsers.includes(b));
  if (missingBrowsers.length) {
    limitations.push(
      `**Hiányzó böngésző: ${missingBrowsers.join(', ')}.** A Safari ITP a first-party storage-ot eltérően ` +
        'kezeli, ezért a storage-hoz kötődő ellenőrzések csak a mért böngészőre érvényesek ' +
        '(`npx playwright install webkit && npm run compliance -- --browser=webkit`).'
    );
  }
  if (limitations.length) {
    lines.push('');
    lines.push('> ## ⚠️ A BASELINE ÉRVÉNYESSÉGE KORLÁTOZOTT');
    for (const l of limitations) lines.push(`> - ${l}`);
  }
  lines.push('');
  lines.push(
    '> Ez MÉRÉS, nem javítás. A harness kizárólag olvas és megfigyel: egyetlen űrlapot sem küld be, ' +
      'egyetlen konverziót sem vált ki (a first-party nem-GET kéréseket hálózati szinten abortálja, ' +
      'a submit-eseményeket a DOM-ban blokkolja, és csak a consent-banner gombjaira kattint).'
  );
  lines.push('');

  // ── Fő táblázat ─────────────────────────────────────────────────────────
  lines.push('## Áttekintés');
  lines.push('');
  lines.push(`| Site | ${TABLE_COLUMNS.map((c) => c.label).join(' | ')} |`);
  lines.push(`|---|${TABLE_COLUMNS.map(() => '---').join('|')}|`);
  for (const r of results) {
    if (r.status === 'ERROR') {
      lines.push(`| \`${r.site_id}\` (${r.browser}) | ${TABLE_COLUMNS.map(() => '⚠️').join(' | ')} |`);
      continue;
    }
    const idx = indexChecks(r);
    lines.push(
      `| \`${r.site_id}\` (${r.browser}) | ${TABLE_COLUMNS.map((c) => statusMark(idx[c.id])).join(' | ')} |`
    );
  }
  lines.push('');
  lines.push('✅ megfelel · ❌ bukik · – nem értelmezhető / nem mérhető · ⚠️ a site mérése hibára futott');
  lines.push('');

  // ── Oszlop-összesítés ───────────────────────────────────────────────────
  lines.push('## Hány oldal bukik melyik ponton');
  lines.push('');
  lines.push('| Ellenőrzés | ❌ bukik | ✅ megfelel | – n/a |');
  lines.push('|---|---:|---:|---:|');
  for (const c of summarizeColumns(results)) {
    lines.push(`| ${c.label} | **${c.fail}** | ${c.pass} | ${c.na} |`);
  }
  lines.push('');

  // ── Hibák / kimaradt site-ok ────────────────────────────────────────────
  const errors = results.filter((r) => r.status === 'ERROR');
  if (errors.length) {
    lines.push('## Nem mért site-ok');
    lines.push('');
    for (const e of errors) {
      lines.push(`- \`${e.site_id}\` (${e.browser}) — ${e.error}`);
    }
    lines.push('');
  }

  const notInManifest = results.filter((r) => r.site && r.site.manifest === false);
  if (notInManifest.length) {
    const ids = [...new Set(notInManifest.map((r) => r.site_id))];
    lines.push('## A site-manifestben NEM szereplő, mégis mért oldalak');
    lines.push('');
    lines.push(
      `${ids.map((i) => `\`${i}\``).join(', ')} — a manifestet SZÁNDÉKOSAN nem módosítottuk (ez a harness csak mér).`
    );
    lines.push('');
  }

  // ── Site-részletek ──────────────────────────────────────────────────────
  lines.push('## Site-részletek');
  lines.push('');
  for (const r of results) {
    lines.push(`### \`${r.site_id}\` · ${r.browser} · ${r.url}`);
    lines.push('');
    if (r.status === 'ERROR') {
      lines.push(`⚠️ **ERROR:** ${r.error}`);
      lines.push('');
      continue;
    }
    if (r.banner && !r.banner.banner_visible) {
      lines.push(
        `**NO_BANNER_OBSERVED** — nem láttunk bannert (teszt-ország: ${test_country || 'ismeretlen'}). ` +
          'Ez nem bizonyítja, hogy nincs CMP.'
      );
      lines.push('');
    }
    if (r.screenshot) lines.push(`![${r.site_id} első réteg](${r.screenshot})`);
    lines.push('');
    for (const c of r.checks) {
      lines.push(`- ${statusMark(c.status)} **${c.id}** — ${c.detail}${evidenceBlock(c)}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'A gépi alak (`report.json`) minden ellenőrzéshez tartalmazza a teljes bizonyíték-listát ' +
      '(request-ek, sütik, storage-műveletek), a markdown csak a levágott kivonatot.'
  );
  lines.push('');
  return lines.join('\n');
}
