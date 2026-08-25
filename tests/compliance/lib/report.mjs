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

/**
 * Azok az ellenőrzések, amiknek az eredménye a BÖNGÉSZŐ tárolási politikájától
 * függ, nem csak a site viselkedésétől. Safari/WebKit ITP alatt a site ugyanúgy
 * megpróbálja letenni a sütit, de a böngésző eldobja vagy particionálja — a
 * megfigyelő ekkor PASS-t lát ott, ahol Chromiumon FAIL van.
 */
/**
 * CSAK a süti-ellenőrzések. A storage-műveleteket a beinjektált szkript a
 * `Storage.prototype`-on figyeli, tehát a `setItem`/`getItem` hívás akkor is
 * látszik, ha az ITP később eldobja az adatot — ott nincs elfedés. A sütiket
 * viszont a böngésző süti-tárából olvassuk vissza: amit az ITP eldobott vagy
 * particionált, az egyszerűen NINCS ott, és a harness PASS-t ír.
 */
export const ITP_MASKED_CHECK_IDS = ['A_no_nonessential_cookies', 'C_no_nonessential_cookies'];

/** A táblázat-fejlécben az érintett oszlopokra tett jelölés. */
const ITP_MASKED_SUFFIX = '⁽ᴵᵀᴾ⁾';

const ITP_MASKED_LABELS = ITP_MASKED_CHECK_IDS.map(
  (id) => TABLE_COLUMNS.find((c) => c.id === id)?.label || id
);

/** Hány site kapott ✅-t egy ITP-vel elfedhető ellenőrzésen. */
function itpMaskedPassCount(results) {
  let n = 0;
  for (const r of results) {
    if (r.status === 'ERROR') continue;
    const idx = indexChecks(r);
    n += ITP_MASKED_CHECK_IDS.filter((id) => idx[id] === PASS).length;
  }
  return n;
}

/**
 * ÁLLANDÓ figyelmeztetés — nem futásfüggő, és szándékosan a lap tetején van.
 *
 * A harness eddigi két üzemi köre alatt KÉT külön mechanizmus adott hamis
 * PASS-t, és MINDKETTŐT a bizonyíték-lista emberi átolvasása fogta meg, nem a
 * teszt: (1) a site saját domainjén proxyzott GA4/Ads hit (Google Tag Gateway)
 * `other`-nek látszott, (2) a Safari ITP eldobta a sütit, amit a site letenni
 * próbált. A műszer hibája nem véletlenszerű: OPTIMISTA irányba téved. Egy ❌
 * ezért erős állítás, egy ✅ viszont csak annyit jelent, hogy EBBEN a
 * futásban, EZZEL a böngészővel nem láttunk semmit.
 */
const OPTIMISTIC_BIAS_NOTE =
  '> **A műszer optimista irányba téved — a ✅ gyengébb állítás, mint a ❌.** ' +
  'A harness eddig kétszer adott hamis PASS-t (első félen proxyzott Google-mérés; Safari ITP által ' +
  'eldobott süti), és mindkettőt a nyers bizonyíték emberi átolvasása fogta meg, nem az ellenőrzés. ' +
  'Mielőtt egy ✅-ra döntést építesz, nyisd ki alatta a bizonyíték-blokkot.';

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

/**
 * F7 — vendor-leltár egy site-ról, fázisonként.
 *
 * A táblázat legfontosabb sorai az ISMERETLEN vendorok (előre rendezve): azok,
 * amikről a regiszter nem mond semmit. Az `'other'` gyűjtőkategória korábban pont
 * ezt tüntette el — egy sose látott mérőszkript ugyanúgy nézett ki, mint egy
 * webfont.
 *
 * Hiányzó leltár → KIMONDJUK, hogy nincs. Üres szakasz azt sugallná, hogy nincs
 * mit jelenteni.
 */
export function inventoryTable(inventory) {
  const lines = ['**Vendor-leltár (F7)**', ''];
  if (!inventory || !inventory.rows || inventory.rows.length === 0) {
    lines.push('_Nem készült vendor-leltár ehhez a site-hoz (a fázisok nem futottak le)._', '');
    return lines;
  }
  const phases = inventory.phases || [];
  lines.push(`| Vendor | Osztály | Ismert | ${phases.join(' | ')} | Első előfordulás |`);
  lines.push(`| --- | --- | --- | ${phases.map(() => '---').join(' | ')} | --- |`);
  for (const row of inventory.rows) {
    const counts = phases.map((ph) => row.counts[ph] ?? 0);
    lines.push(
      `| ${row.known ? row.name : `⚠️ ${row.host ?? row.key}`} | ${row.consent_class ?? '—'} | ` +
        `${row.known ? 'igen' : '**NEM**'} | ${counts.join(' | ')} | ${row.first_seen_phase} |`
    );
  }
  lines.push('');
  return lines;
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
  if (missingBrowsers.includes('chromium') && browsers.includes('webkit')) {
    // Ez a KOCKÁZATOS irány, ezért kap saját, konkrét szöveget: WebKit alatt a
    // süti- és storage-ellenőrzések PASS-ra fordulhatnak ATTÓL, hogy az ITP
    // eldobta a sütit — nem attól, hogy a site nem próbálta letenni. Egy
    // WebKit-only riportot különben úgy olvas a jövőbeli olvasó, hogy azok az
    // oldalak rendben vannak.
    limitations.push(
      `**Csak WebKit futott — a süti-ellenőrzések ✅-jai NEM megbízhatóak.** A Safari ITP a sütit eldobja ` +
        'vagy particionálja, tehát a harness PASS-t ír ott is, ahol a site MEGPRÓBÁLTA letenni. Az érintett ' +
        `oszlopok a táblázatban ${ITP_MASKED_SUFFIX}-jelölést kapnak: ` +
        `${ITP_MASKED_LABELS.map((c) => `\`${c}\``).join(', ')} — ebben a futásban **${itpMaskedPassCount(results)}** ` +
        'ilyen ✅ van, és egyikből sem következik, hogy az az oldal tiszta. ' +
        '(A storage-ellenőrzéseket ez NEM érinti: azokat a `Storage.prototype`-on figyeljük, a hívás az ITP ' +
        'alatt is látszik.) Ugyanezt Chromiumon is le kell mérni ' +
        '(`npm run compliance -- --browser=chromium`), és a SZIGORÚBB eredmény az igaz.'
    );
  }
  if (missingBrowsers.includes('webkit') && browsers.includes('chromium')) {
    limitations.push(
      '**Hiányzó böngésző: webkit.** A Safari ITP a first-party storage-ot eltérően kezeli, ezért a ' +
        'storage-hoz kötődő ellenőrzések csak Chromiumra érvényesek ' +
        '(`npx playwright install webkit && npm run compliance -- --browser=webkit`).'
    );
  }
  if (limitations.length) {
    lines.push('');
    lines.push('> ## ⚠️ A BASELINE ÉRVÉNYESSÉGE KORLÁTOZOTT');
    for (const l of limitations) lines.push(`> - ${l}`);
  }
  lines.push('');
  lines.push(OPTIMISTIC_BIAS_NOTE);
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
  // WebKit-only futásnál a süti-oszlopok fejléce megjelöli magát. A korlátozás
  // a lap tetején is ott van, de a félreolvasás ITT történik — a táblázatban.
  const itpMasked = browsers.includes('webkit') && !browsers.includes('chromium');
  const columnLabel = (c) =>
    itpMasked && ITP_MASKED_CHECK_IDS.includes(c.id) ? `${c.label} ${ITP_MASKED_SUFFIX}` : c.label;
  lines.push(`| Site | ${TABLE_COLUMNS.map(columnLabel).join(' | ')} |`);
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
  if (itpMasked) {
    lines.push('');
    lines.push(
      `${ITP_MASKED_SUFFIX} **Ebben az oszlopban a ✅ nem bizonyíték.** Csak WebKit futott; a Safari ITP ` +
        'eldobja a sütit, amit a site letenni próbált, tehát a harness nem lát semmit ott sem, ahol Chromiumon ' +
        '❌ lenne. Chromium-méréssel kell összevetni.'
    );
  }
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
    lines.push(...inventoryTable(r.inventory));
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
