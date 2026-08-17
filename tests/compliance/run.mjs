#!/usr/bin/env node
/**
 * Consent compliance harness — a JELENLEGI (CookieYes-es) állapot mérése a
 * teljes flottán, gépi és ismételhető módon.
 *
 *   npm run compliance
 *   npm run compliance -- --site=lomtalan
 *   npm run compliance -- --browser=chromium --scenarios=A,C
 *
 * EZ MÉR, NEM JAVÍT, ÉS NEM CSELEKSZIK. Négy védvonal biztosítja, hogy élő
 * oldalon SOHA ne keletkezzen hamis lead vagy konverzió:
 *   1. Hálózati abort: MINDEN nem-GET/HEAD kérés a site SAJÁT origin-jére
 *      megszakad (űrlap-POST, sendBeacon a gateway felé, fetch-lead) — a
 *      megszakított kéréseket a riport bizonyítékként felsorolja.
 *   2. DOM-blokk: a `submit` esemény capture fázisban megáll, és a
 *      `HTMLFormElement.prototype.submit()` no-op (lásd lib/instrument.mjs).
 *   3. Kattintás-allowlist: kizárólag a consent-banner felderített gombjaira
 *      kattintunk (accept / reject / settings / revisit). Máshova SOHA.
 *   4. Nulla beírás: a kód SEHOL nem hív `fill()`/`type()`/`press()`-t — ezt
 *      egy grep is bizonyítja.
 *
 * NEM CI-BA VALÓ: élő oldalakat tölt be, tehát kézzel vagy ütemezetten futtatandó.
 */

import { chromium, webkit } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { instrumentationScript } from './lib/instrument.mjs';
import { classifyRequest, isFirstParty } from './lib/classify.mjs';
import { SELECTORS, TEXT_PATTERNS, bannerProbeScript } from './lib/banner.mjs';
import {
  evaluateAfterReject,
  evaluateBannerUi,
  evaluateBeforeDecision,
  evaluateCookiePolicy,
  evaluateWithdrawal
} from './lib/checks.mjs';
import { buildMarkdown } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NAV_TIMEOUT_MS = 45_000;
/** Mennyit várunk a késleltetett tagek beindulására a döntés után. */
const SETTLE_MS = 3_000;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    site: null,
    browser: 'chromium',
    scenarios: 'A,B,C,D,GPC',
    timeout: DEFAULT_NAV_TIMEOUT_MS,
    // A flotta-lista és a kimenet felülírható — az önteszt (selftest/) ezzel fut
    // a saját, HELYI fixture-jén, hogy a harness működése élő oldal nélkül is
    // bizonyítható legyen.
    sitesFile: null,
    out: null,
    // Relay-mód: a böngésző kéréseit a Node HTTP-stackjén szolgáljuk ki. Olyan
    // környezetekhez kell, ahol a böngésző nem jut ki (a sandbox egress-proxyja
    // a Chromium alagutazott TLS-ét bontja, miközben a Node-é átmegy). A MÉRÉS
    // nem sérül: minden kérés ugyanúgy megjelenik a `request` eseményben — csak a
    // válasz jön máshonnan. Alapból KI: valódi hálózaton ne legyen köztes réteg.
    relay: false
  };
  for (const raw of argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, '').split('=');
    if (k === 'site') args.site = v;
    else if (k === 'browser') args.browser = v;
    else if (k === 'scenarios') args.scenarios = v;
    else if (k === 'timeout') args.timeout = Number(v);
    else if (k === 'sites-file') args.sitesFile = v;
    else if (k === 'out') args.out = v;
    else if (k === 'relay') args.relay = v !== 'false';
  }
  args.scenarioSet = new Set(args.scenarios.split(',').map((s) => s.trim().toUpperCase()));
  return args;
}

const BROWSERS = { chromium, webkit };

function browserTypes(name) {
  if (name === 'both' || name === 'all') return ['chromium', 'webkit'];
  return [name];
}

// ── Felvétel egy kontextusban ───────────────────────────────────────────────

/**
 * A négy védvonal közül az ELSŐ. Minden nem-GET/HEAD kérést megszakít, ami a
 * site saját originjére menne — ez az űrlap-beküldés és a gateway-beacon útja.
 * A harmadik feles (Google/Meta) kéréseket SZÁNDÉKOSAN átengedi: azok a mérés
 * tárgyai, blokkolva pont azt nem látnánk, amiért a harness készült.
 */
async function installSafetyNet(context, siteUrl, blocked, relay = false) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && isFirstParty(req.url(), siteUrl)) {
      blocked.push({ t: Date.now(), method, url: req.url().slice(0, 300) });
      await route.abort();
      return;
    }
    if (!relay || req.url().startsWith('http://localhost')) {
      await route.continue();
      return;
    }
    await relayRequest(route, req);
  });
}

/**
 * A kérés kiszolgálása a Node stackjén (relay-mód). A hibát SZÁNDÉKOSAN
 * abortként adjuk vissza: a mérés szempontjából az számít, hogy a site
 * MEGKÍSÉRELTE a kérést — ez a `request` eseményben már rögzült.
 */
async function relayRequest(route, req) {
  try {
    const headers = { ...req.headers() };
    delete headers['accept-encoding']; // a Node dekódol; a böngésző ne kapjon dupla tömörítést
    delete headers['host'];
    const init = { method: req.method(), headers, redirect: 'manual' };
    const post = req.postDataBuffer();
    if (post && req.method() !== 'GET' && req.method() !== 'HEAD') init.body = post;
    const res = await fetch(req.url(), { ...init, signal: AbortSignal.timeout(30_000) });
    const body = Buffer.from(await res.arrayBuffer());
    const out = {};
    res.headers.forEach((v, k) => {
      // A tartalom-hosszt/kódolást a fulfill számolja újra.
      if (k === 'content-encoding' || k === 'content-length' || k === 'set-cookie') return;
      out[k] = v;
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    await route.fulfill({
      status: res.status,
      headers: out,
      // A Set-Cookie fejléceket KÜLÖN adjuk át — enélkül a süti-mérés vak lenne.
      ...(setCookies.length ? { headers: { ...out, 'set-cookie': setCookies.join('\n') } } : {}),
      body
    });
  } catch (err) {
    await route.abort().catch(() => {});
  }
}

/** A ping-törzsből ennyit tartunk meg (azonosító-kereséshez bőven elég). */
const POST_BODY_MAX = 4_000;

function recordRequests(context, requests) {
  context.on('request', (req) => {
    // A GA4 `/g/collect` és a Meta `/tr` gyakran POST: az azonosítók (uid,
    // user property, PII) ilyenkor a TÖRZSBEN utaznak, nem a query-ben. Az URL
    // önmagában vizsgálva hamis PASS-t adna a „reject után nincs azonosító"
    // ellenőrzésre.
    let body = null;
    try {
      const raw = req.postData();
      if (raw) body = raw.slice(0, POST_BODY_MAX);
    } catch { /* nem olvasható törzs */ }
    requests.push({
      t: Date.now(),
      method: req.method(),
      url: req.url(),
      body,
      category: classifyRequest(req.url())
    });
  });
}

/**
 * Ha a futtató környezet HTTPS-proxyn megy ki (sandbox / céges hálózat), a
 * böngészőnek EXPLICIT meg kell adni — a `HTTPS_PROXY` env-et a Chromium és a
 * WebKit magától nem veszi figyelembe, és a mérés `ERR_CONNECTION_RESET`-tel
 * halna el minden site-on. A proxy CA-ját a környezet trust store-ja adja;
 * TLS-ellenőrzést SEHOL nem kapcsolunk ki.
 */
function proxyConfig() {
  const server = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!server) return undefined;
  return { server, bypass: 'localhost,127.0.0.1,::1' };
}

async function newInstrumentedContext(browser, site, args, opts = {}) {
  const context = await browser.newContext({
    // Friss, nulla átvitt állapot minden forgatókönyvhöz.
    storageState: undefined,
    viewport: { width: 1366, height: 900 },
    locale: opts.locale || 'hu-HU',
    extraHTTPHeaders: opts.headers || undefined
  });
  context.setDefaultNavigationTimeout(args.timeout);
  context.setDefaultTimeout(15_000);
  await context.addInitScript(instrumentationScript());
  return context;
}

async function capture(context, page, requests, since) {
  const pageState = await page
    .evaluate(() => (window.__compliance ? JSON.parse(JSON.stringify(window.__compliance)) : null))
    .catch(() => null);
  const cookies = await context.cookies().catch(() => []);
  return {
    requests: requests.filter((r) => r.t >= since),
    cookies: cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      expires: c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString()
    })),
    page: pageState
      ? {
          storage: (pageState.storage || []).filter((e) => e.t >= since),
          cookieReads: pageState.cookieReads,
          cookieWrites: (pageState.cookieWrites || []).filter((e) => e.t >= since),
          dataLayer: (pageState.dataLayer || []).filter((e) => e.t >= since),
          beacons: (pageState.beacons || []).filter((e) => e.t >= since),
          blockedSubmits: pageState.blockedSubmits || []
        }
      : null
  };
}

// ── Banner-interakció (a KIZÁRÓLAGOS kattintás-felület) ─────────────────────

const probeConfig = {
  container: SELECTORS.container,
  accept: SELECTORS.accept,
  reject: SELECTORS.reject,
  settings: SELECTORS.settings,
  revisit: SELECTORS.revisit,
  acceptText: { source: TEXT_PATTERNS.accept.source, flags: TEXT_PATTERNS.accept.flags },
  rejectText: { source: TEXT_PATTERNS.reject.source, flags: TEXT_PATTERNS.reject.flags },
  settingsText: { source: TEXT_PATTERNS.settings.source, flags: TEXT_PATTERNS.settings.flags }
};

async function probeBanner(page) {
  return page.evaluate(bannerProbeScript(), probeConfig).catch(() => null);
}

/**
 * Kattintás a banner egy MEGNEVEZETT gombjára. Csak a felderített szelektorokat
 * vagy a szöveg-mintát fogadja el — semmi mást. `null`-t ad, ha nincs ilyen gomb.
 */
async function clickBannerButton(page, kind) {
  // A kattintás EREDMÉNYE számít, nem az, hogy találtunk-e gombot. Egy látható,
  // de letakart/leváló gombon a click() timeoutol — ha ezt elnyelnénk és mégis
  // „sikert" adnánk vissza, a C forgatókönyv a VÁLTOZATLAN, döntés előtti
  // állapotot értékelné „elutasítás utániként", és hamis PASS-t adna. Inkább
  // legyen a forgatókönyv bevallottan nem-elérhető.
  const attempt = async (locator, label) => {
    if (!(await locator.count().then((n) => n > 0).catch(() => false))) return null;
    if (!(await locator.isVisible().catch(() => false))) return null;
    try {
      await locator.click({ timeout: 8_000 });
      return label;
    } catch (err) {
      return { failed: label, error: String(err && err.message ? err.message : err).slice(0, 200) };
    }
  };

  let lastFailure = null;
  for (const sel of SELECTORS[kind] || []) {
    const r = await attempt(page.locator(sel).first(), sel);
    if (typeof r === 'string') return r;
    if (r) lastFailure = r;
  }
  const pattern = TEXT_PATTERNS[kind];
  if (pattern) {
    const r = await attempt(page.getByRole('button', { name: pattern }).first(), `role=button[name=${pattern}]`);
    if (typeof r === 'string') return r;
    if (r) lastFailure = r;
  }
  return lastFailure; // objektum = volt gomb, de a kattintás elbukott; null = nem volt gomb
}

/** `clickBannerButton` eredménye → sikerült-e ténylegesen kattintani. */
function clickSucceeded(result) {
  return typeof result === 'string';
}

/** Hány kattintás az elutasításig a leggyorsabb úton (1 = első rétegen ott van). */
function clicksToReject(banner) {
  if (!banner || !banner.banner_visible) return null;
  if (banner.reject) return 1;
  if (banner.settings) return 2; // beállítások megnyitása + mentés/elutasítás
  return null;
}

// ── Egyéb ellenőrzések ──────────────────────────────────────────────────────

async function detectNoscriptIframe(page) {
  return page
    .evaluate(() => {
      const html = document.documentElement.innerHTML;
      const m = html.match(/<noscript[^>]*>[\s\S]{0,400}?googletagmanager\.com\/ns\.html[\s\S]{0,200}?<\/noscript>/i);
      return m ? m[0].slice(0, 300) : null;
    })
    .catch(() => null);
}

const POLICY_LINK_RE = /(cookie|süti|adatvedelem|adatvédelem|privacy|adatkezel)/i;

async function findCookiePolicy(page, context, siteUrl) {
  const href = await page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const links = [...document.querySelectorAll('a[href]')];
      const hit = links.find((a) => re.test(a.textContent || '') || re.test(a.getAttribute('href') || ''));
      return hit ? hit.href : null;
    }, POLICY_LINK_RE.source)
    .catch(() => null);
  if (!href) return { url: null };

  // A tájékoztatót KÜLÖN kéréssel olvassuk (nem navigálunk el a mért oldalról).
  try {
    const res = await context.request.get(href, { timeout: 20_000 });
    if (!res.ok()) return { url: href, error: `HTTP ${res.status()}` };
    const text = (await res.text()).toLowerCase();
    const named = [];
    if (/\bgoogle\b/.test(text)) named.push('Google');
    if (/\bmeta\b|\bfacebook\b/.test(text)) named.push('Meta/Facebook');
    if (/cookieyes/.test(text)) named.push('CookieYes');
    return { url: href, third_parties_named: named, length: text.length, same_site: isFirstParty(href, siteUrl) };
  } catch (err) {
    return { url: href, error: String(err).slice(0, 200) };
  }
}

// ── Forgatókönyvek ──────────────────────────────────────────────────────────

async function runSite(browserName, browser, site, args, outDir) {
  const requests = [];
  const blockedFirstPartyWrites = [];
  const result = {
    site_id: site.site_id,
    browser: browserName,
    url: site.url,
    site,
    status: 'OK',
    checks: [],
    scenarios: {},
    blocked_first_party_writes: blockedFirstPartyWrites
  };

  const context = await newInstrumentedContext(browser, site, args);
  await installSafetyNet(context, site.url, blockedFirstPartyWrites, args.relay);
  recordRequests(context, requests);
  const page = await context.newPage();

  try {
    // ── A) Döntés előtt ────────────────────────────────────────────────────
    const t0 = Date.now();
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);
    const banner = await probeBanner(page);
    const beforeDecision = await capture(context, page, requests, t0);
    beforeDecision.noscript_gtm_iframe = await detectNoscriptIframe(page);

    const shotRel = join('screenshots', `${site.site_id}-${browserName}-layer1.png`);
    await page
      .screenshot({ path: join(outDir, shotRel), fullPage: false })
      .then(() => { result.screenshot = shotRel; })
      .catch(() => { result.screenshot = null; });

    result.banner = banner;
    result.scenarios.A_before_decision = beforeDecision;
    result.checks.push(...evaluateBeforeDecision(beforeDecision));
    result.checks.push(...evaluateBannerUi(banner, clicksToReject(banner)));

    const policy = await findCookiePolicy(page, context, site.url);
    result.cookie_policy = policy;
    result.checks.push(...evaluateCookiePolicy(policy));

    await context.close();

    // ── B) Elfogad mindent ─────────────────────────────────────────────────
    if (args.scenarioSet.has('B')) {
      result.scenarios.B_accept_all = await runDecisionScenario(browser, site, args, 'accept', blockedFirstPartyWrites);
    }

    // ── C) Elutasít mindent (a legfontosabb) ───────────────────────────────
    if (args.scenarioSet.has('C')) {
      const c = await runDecisionScenario(browser, site, args, 'reject', blockedFirstPartyWrites);
      result.scenarios.C_reject_all = c;
      if (c.clicked) {
        result.checks.push(...evaluateAfterReject(c));
      } else {
        // A C-blokk MINDEN ellenőrzését kiadjuk N-A-ként, ugyanazzal az okkal —
        // különben a táblázatban üres cellák maradnának, és nem lehetne
        // megkülönböztetni a „nem mértük"-et a „nincs baj"-tól.
        const reason = c.click_error
          ? `Az elutasító gombra nem sikerült kattintani (${c.click_error.error}) — a C forgatókönyv nem futott le.`
          : 'Nem volt elutasító gomb, amire kattinthattunk volna — a C forgatókönyv nem futott le.';
        for (const id of [
          'C_no_consent_bound_requests',
          'C_no_nonessential_cookies',
          'C_no_nonessential_storage_write',
          'C_pings_carry_no_identifiers'
        ]) {
          result.checks.push({ id, status: 'N-A', detail: reason, evidence: null });
        }
      }
    }

    // ── D) Visszavonás ─────────────────────────────────────────────────────
    if (args.scenarioSet.has('D')) {
      const w = await runWithdrawalScenario(browser, site, args, blockedFirstPartyWrites);
      result.scenarios.D_withdrawal = w;
      result.checks.push(...evaluateWithdrawal(w));
    }

    // ── GPC) Sec-GPC (csak megfigyelés) ────────────────────────────────────
    if (args.scenarioSet.has('GPC')) {
      result.scenarios.E_sec_gpc = await runGpcScenario(browser, site, args, blockedFirstPartyWrites);
    }
  } catch (err) {
    result.status = 'ERROR';
    result.error = String(err && err.message ? err.message : err).slice(0, 400);
    await context.close().catch(() => {});
  }

  return result;
}

async function runDecisionScenario(browser, site, args, kind, blocked) {
  const requests = [];
  const context = await newInstrumentedContext(browser, site, args);
  await installSafetyNet(context, site.url, blocked, args.relay);
  recordRequests(context, requests);
  const page = await context.newPage();
  const out = { kind, clicked: null };
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);
    // A határ a kattintás ELŐTT: a döntés-kezelőben SZINKRON induló kérések
    // (pl. egy `new Image().src = …/collect`) különben a határ elé esnének, és a
    // mérés pont a döntés KÖVETKEZMÉNYÉT hallgatná el. Az öntesztet ez a hiba
    // buktatta először.
    const boundary = Date.now();
    const clicked = await clickBannerButton(page, kind);
    out.clicked = clickSucceeded(clicked) ? clicked : null;
    if (clicked && !clickSucceeded(clicked)) out.click_error = clicked;
    if (clickSucceeded(clicked)) {
      await page.waitForTimeout(SETTLE_MS);
      const cap = await capture(context, page, requests, boundary);
      Object.assign(out, cap);
    }
  } catch (err) {
    out.error = String(err && err.message ? err.message : err).slice(0, 300);
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

/**
 * D) Elfogad → oldalfrissítés → visszavon. A visszavonó felület a CookieYes
 * „revisit" lebegő gombja; ha nincs, N/A (nem feltételezünk semmit).
 */
async function runWithdrawalScenario(browser, site, args, blocked) {
  const requests = [];
  const context = await newInstrumentedContext(browser, site, args);
  await installSafetyNet(context, site.url, blocked, args.relay);
  recordRequests(context, requests);
  const page = await context.newPage();
  const out = { skipped: true };
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);
    const accepted = await clickBannerButton(page, 'accept');
    if (!clickSucceeded(accepted)) {
      out.reason = accepted
        ? `ACCEPT_CLICK_FAILED — ${accepted.error}`
        : 'NO_ACCEPT_BUTTON — nem tudtunk consentet adni, tehát visszavonni sem.';
      return out;
    }
    await page.waitForTimeout(SETTLE_MS);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);

    const beforeCookies = await context.cookies();
    const revisit = await clickBannerButton(page, 'revisit');
    if (!clickSucceeded(revisit)) {
      out.reason = 'NO_REVISIT_UI — nincs elérhető visszavonó felület.';
      out.cookies_after_accept = beforeCookies.map((c) => c.name);
      return out;
    }
    await page.waitForTimeout(1_000);
    const boundary = Date.now();
    const rejected = await clickBannerButton(page, 'reject');
    if (!clickSucceeded(rejected)) {
      out.reason = rejected
        ? `REVISIT_REJECT_CLICK_FAILED — ${rejected.error}`
        : 'REVISIT_WITHOUT_REJECT — a visszavonó felületen nem találtunk elutasító gombot.';
      return out;
    }
    await page.waitForTimeout(SETTLE_MS);

    const cap = await capture(context, page, requests, boundary);
    const { isNonEssentialCookie, isNonEssentialStorageKey } = await import('./lib/instrument.mjs');
    const storageKeys = await page
      .evaluate(() => ({
        local: Object.keys(localStorage || {}),
        session: Object.keys(sessionStorage || {})
      }))
      .catch(() => ({ local: [], session: [] }));

    out.skipped = false;
    out.clicked = { accept: accepted, revisit, reject: rejected };
    out.remaining_non_essential = [
      ...cap.cookies.filter((c) => isNonEssentialCookie(c.name)).map((c) => ({ kind: 'cookie', name: c.name, domain: c.domain })),
      ...storageKeys.local.filter(isNonEssentialStorageKey).map((k) => ({ kind: 'localStorage', name: k })),
      ...storageKeys.session.filter(isNonEssentialStorageKey).map((k) => ({ kind: 'sessionStorage', name: k }))
    ];
    out.consent_bound_requests_after = cap.requests
      .filter((r) => ['ga4', 'google_ads', 'meta', 'gateway'].includes(r.category))
      .map((r) => ({ url: r.url.slice(0, 200), category: r.category }));
  } catch (err) {
    out.reason = `ERROR — ${String(err && err.message ? err.message : err).slice(0, 200)}`;
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

/** GPC: ugyanaz mint az A, `Sec-GPC: 1` fejléccel. CSAK megfigyelés. */
async function runGpcScenario(browser, site, args, blocked) {
  const requests = [];
  const context = await newInstrumentedContext(browser, site, args, { headers: { 'Sec-GPC': '1' } });
  await installSafetyNet(context, site.url, blocked, args.relay);
  recordRequests(context, requests);
  const page = await context.newPage();
  const out = {};
  try {
    const t0 = Date.now();
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);
    const cap = await capture(context, page, requests, t0);
    out.consent_bound_request_count = cap.requests.filter((r) =>
      ['ga4', 'google_ads', 'meta', 'gateway'].includes(r.category)
    ).length;
    out.gtm_loaded = cap.requests.some((r) => r.category === 'gtm');
    out.banner_visible = Boolean((await probeBanner(page))?.banner_visible);
    out.note = 'Csak megfigyelés — az A forgatókönyvvel összevetve látszik, változtat-e bármit a Sec-GPC fejléc.';
  } catch (err) {
    out.error = String(err && err.message ? err.message : err).slice(0, 300);
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

// ── Fő ──────────────────────────────────────────────────────────────────────

function launchOptionsFor(browserName) {
  const launchOptions = {};
  const envPath = process.env[`PW_${browserName.toUpperCase()}_EXECUTABLE`];
  if (envPath) launchOptions.executablePath = envPath;
  const proxy = proxyConfig();
  if (proxy) launchOptions.proxy = proxy;
  return launchOptions;
}

async function detectTestCountry() {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    return text.match(/^loc=(\w+)$/m)?.[1] || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const sitesPath = args.sitesFile ? resolve(process.cwd(), args.sitesFile) : join(HERE, 'sites.json');
  const config = JSON.parse(await readFile(sitesPath, 'utf8'));
  const sites = config.sites.filter((s) => !args.site || s.site_id === args.site);
  if (sites.length === 0) {
    console.error(`Nincs ilyen site: ${args.site}`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const day = startedAt.slice(0, 10);
  const outDir = args.out ? resolve(process.cwd(), args.out) : join(HERE, 'reports', day);
  await mkdir(join(outDir, 'screenshots'), { recursive: true });

  const testCountry = await detectTestCountry();
  const results = [];

  for (const browserName of browserTypes(args.browser)) {
    let browser;
    try {
      browser = await BROWSERS[browserName].launch(launchOptionsFor(browserName));
    } catch (err) {
      // Egy hiányzó böngésző NEM állítja meg a futást — a másik lefut, és a
      // riportban ott marad, hogy ez a láb nem futott.
      console.error(`[${browserName}] nem indítható: ${err.message}`);
      for (const site of sites) {
        results.push({
          site_id: site.site_id,
          browser: browserName,
          url: site.url,
          site,
          status: 'ERROR',
          error: `A böngésző nem indítható: ${String(err.message).slice(0, 200)}`,
          checks: []
        });
      }
      continue;
    }

    for (const site of sites) {
      const label = `[${browserName}] ${site.site_id}`;
      process.stdout.write(`${label} … `);
      const t = Date.now();
      let result;
      try {
        // Egy összeomlott böngésző NEM vakíthatja meg a futás hátralévő részét:
        // enélkül az első crash után MINDEN további site „Target page, context or
        // browser has been closed" ERROR-t kapna, és a riport úgy nézne ki, mintha
        // a flotta fele mérhetetlen lenne. Site-onként ellenőrizzük, és újraindítjuk.
        if (!browser.isConnected()) {
          console.log('(a böngésző elszállt — újraindítás)');
          browser = await BROWSERS[browserName].launch(launchOptionsFor(browserName));
          process.stdout.write(`${label} … `);
        }
        result = await runSite(browserName, browser, site, args, outDir);
      } catch (err) {
        result = {
          site_id: site.site_id,
          browser: browserName,
          url: site.url,
          site,
          status: 'ERROR',
          error: String(err && err.message ? err.message : err).slice(0, 400),
          checks: []
        };
      }
      const fails = result.checks.filter((c) => c.status === 'FAIL').length;
      console.log(
        result.status === 'ERROR' ? `ERROR (${result.error})` : `kész ${((Date.now() - t) / 1000).toFixed(1)}s · ${fails} FAIL`
      );
      results.push(result);
    }

    await browser.close().catch(() => {});
  }

  const run = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    browsers: browserTypes(args.browser),
    test_country: testCountry,
    run_command: `npm run compliance -- ${process.argv.slice(2).join(' ')}`.trim(),
    relay_mode: args.relay,
    scenarios: [...args.scenarioSet],
    sites_config: sitesPath,
    sites_config_comment: config._comment,
    results
  };

  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(join(outDir, 'report.md'), buildMarkdown(run));

  const totalFails = results.reduce((n, r) => n + r.checks.filter((c) => c.status === 'FAIL').length, 0);
  const errored = results.filter((r) => r.status === 'ERROR').length;
  console.log(`\nRiport: ${join(outDir, 'report.md')}`);
  console.log(`Összesen ${totalFails} FAIL, ${errored} nem mért site.`);
  // A harness MÉR — a FAIL nem a futás hibája, ezért 0-val lép ki.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
