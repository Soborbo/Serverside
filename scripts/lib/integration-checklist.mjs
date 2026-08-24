/**
 * integration-checklist.mjs — a generált `INTEGRATION.md` szövege.
 *
 * MIÉRT KÜLÖN MODUL (2026-08-24 review #4): a checklist egy GENERÁLT DOKUMENTUM, ami
 * ugyanúgy sodródhat el a valóságtól, mint a kézzel írt doksik — csak rosszabbul,
 * mert minden új site bekötésekor újratermelődik, és az onboardoló ember EBBŐL
 * dolgozik. Két bizonyított drift élt benne:
 *
 *  1. „client-lib/ (worker-tracking.ts + uuid.ts) bemásolva" — a `client-lib/` mappa
 *     F2-2 óta TÖRÖLVE; a kanonikus kliens a `soborbo-tracking` package.
 *  2. „CookieYes (GTM-ből) aktív" — egy `consent.provider: 'sbo'` confignál ez
 *     egyenesen HAMIS: ott nincs CookieYes, a consent-boot szinkron, és a
 *     `TrackingNoscript`-et KI KELL venni.
 *
 * Külön modulként a `scripts/check-doc-truth.mjs` importálni tudja, és a tiltó
 * szabályokat MINDKÉT provider-változat generált kimenetére lefuttatja — vagyis a
 * kapu nem a sablon szövegére illeszkedik, hanem arra, amit a site tényleg megkap.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src/events.json', import.meta.url)), 'utf8')
);

// A kliens által küldhető (ingress) event-nevek: server-csatornás, NEM offline.
const INGRESS_EVENTS = EVENTS.filter((e) => e.channels.includes('server') && e.kind !== 'offline');

// Run 6 gate: a high-value (server_ingress_only) eventeket a böngésző-út 403-mal
// dobja — CSAK a site backendje küldheti, per-site tokennel, a
// /api/event/conversion-server útvonalon. A checklist külön sorolja őket, hogy
// egy új site bekötése ne a böngésző-útra huzalozza a form-konverziókat
// (TRK-400-017 + néma konverzióvesztés lenne).
export const BROWSER_EVENT_NAMES = INGRESS_EVENTS.filter((e) => e.server_ingress_only !== true).map(
  (e) => e.name
);
export const SERVER_ONLY_EVENT_NAMES = INGRESS_EVENTS.filter((e) => e.server_ingress_only === true).map(
  (e) => e.name
);

/** A KV `consent.provider` — hiányzó blokk === 'cookieyes' (minden mai élő site). */
export function resolveConsentProvider(cfg) {
  return cfg?.consent?.provider === 'sbo' ? 'sbo' : 'cookieyes';
}

function consentSection(cfg, provider) {
  if (provider === 'sbo') {
    return `## Consent — SABOR CMP (\`consent.provider: "sbo"\`) ⚠️ PILOT

> Ez a config a SAJÁT CMP-t kapcsolja be. A flip **emberi, per-site pilot-döntés**,
> saját runbookkal (\`docs/cmp-fazis2-pilot-runbook.md\`) — nem az onboarding része.
> Ha ezt a szekciót látod, de nem tudtál róla, hogy pilot-site-ot kötsz be: **állj meg.**

- [ ] Site env: \`PUBLIC_TRACKING_CONSENT_PROVIDER=sbo\`
- [ ] Site env: \`PUBLIC_TRACKING_POLICY_VERSION=<adatvédelmi tájékoztató verziója>\`
      (KÖTELEZŐ mező minden consent-log soron — nélküle a döntés nem naplózható)
- [ ] \`<Tracking />\` a szinkron consent-bootot rendereli (minden-tiltott default,
      a GTM CSAK pozitív döntés után tölt) — **CookieYes szkript NINCS**
- [ ] \`<ConsentBanner policyHref="..." />\` a \`<body>\` végén
- [ ] Visszavonási út MINDEN oldalon: footer-link \`data-sb-consent-open\` attribútummal
- [ ] \`<TrackingNoscript />\` **KIVÉVE** — noscript alatt nincs consent-döntés, tehát a
      GTM-iframe consent ELŐTT futna
- [ ] A backend-dispatch átadja a \`consentId\`-t
      (\`readSboConsentCookieHeader(cookieHeader)?.consentId\`) → az offline/replay láb
      így tudja feloldani a \`consent_log\` aktuális revisionjét
- [ ] Migrációs döntés MEGVAN (\`migrate_if_equivalent\` VAGY \`reconsent_all\`) — flip után
      a korábbi CookieYes-accept-ek NEM élnek tovább maguktól`;
  }
  return `## Consent — CookieYes (\`consent.provider\` hiányzik === "cookieyes", ez a mai default)

- [ ] CookieYes aktív (a \`<Tracking cookieYesId="..." />\` tölti be) → a consent a
      \`cookieyes-consent\` sütiből jön, a gateway ezt olvassa
- [ ] \`<TrackingNoscript gtmId="GTM-XXXX" />\` a \`<body>\` elején
- [ ] A Consent Mode **default INLINE** van a \`Tracking.astro\`-ban, a GTM-snippet ELŐTT —
      NE tegyél „Consent Default" Custom HTML taget a konténerbe (nem futna elég korán)`;
}

export function integrationChecklist(cfg) {
  const host = cfg.hostnames[0];
  const provider = resolveConsentProvider(cfg);
  const consentRequired = cfg.require_consent === true;

  return `# Integrációs ellenőrzőlista — ${cfg.site_id} (${host})

**Consent-provider:** \`${provider}\`${provider === 'sbo' ? ' — ⚠️ PILOT' : ' (default)'} ·
**require_consent:** \`${consentRequired}\`

## Worker oldal
- [ ] KV-bejegyzés(ek) feltöltve (lásd kv-put.sh / a fenti parancsok)
- [ ] wrangler.toml: route-blokk hozzáadva (lásd routes.toml) → \`wrangler deploy\`
- [ ] (ha Google Ads OFFLINE lábat vársz) OAuth elvégezve a customer_id-ra:
      GET /api/event/oauth-init (X-Admin-Token). Ha a site Ads-konverziói böngésző-oldaliak
      (AWCT + EC a GTM-ből), ez NEM kell a pénzúthoz — lásd docs/gads-oauth-repair-runbook.md
${cfg.meta?.test_event_code ? '- [ ] ⛔ test_event_code JELEN VAN — ez a kimenet NEM production-config (lásd a fájl tetején a bannert)' : ''}

## CRM offline-loop (server-to-server)
- [ ] CRM-deploy secretjei beállítva a crm-secret.env-ből: \`TRACKING_WORKER_URL\` + \`TRACKING_ADMIN_TOKEN\`
- [ ] A KV site-config tartalmazza a \`crm_token_sha256\`-ot (a kv-put.sh ezt felteszi) → a globális
      ADMIN_API_TOKEN MÁR NEM ír ehhez a site-hoz (tenant-izoláció)
- [ ] Teszt: a CRM \`lezart_nyert\` → POST /api/event/lead-status → 200; ROSSZ tokennel → 401

## Astro site oldal
- [ ] A kanonikus \`soborbo-tracking\` package telepítve (\`lib/\` + \`components/\`) a package
      saját \`INSTALL.md\`-je szerint. A régi flat \`client-lib/\` (worker-tracking.ts + uuid.ts)
      **TÖRÖLVE (F2-2)** — abból ne indulj ki.
- [ ] Böngésző-út: a gateway Origin allow-listtel kapuz — Turnstile NEM kell a tracking
      miatt (Run 6 kivette a gateway-ből). Ha a site a saját formját védi Turnstile-lal,
      az független ettől.
- [ ] BÖNGÉSZŐ konverziós pontokon (klikk-eventek): \`trackConversion('<event_name>', { value, currency, user_data })\`
      Böngésző-úton engedett event-nevek: ${BROWSER_EVENT_NAMES.join(', ')}
- [ ] SZERVER-ONLY konverziók (form/lead/purchase) a SITE BACKENDJÉBŐL mennek:
      POST /api/event/conversion-server + X-Admin-Token (per-site token, lásd crm-secret.env),
      a böngésző event_id-jét újrahasznosítva (Pixel↔CAPI dedup). Böngésző-úton ezek 403-at
      kapnak (TRK-400-017): ${SERVER_ONLY_EVENT_NAMES.join(', ')}

${consentSection(cfg, provider)}

## Ellenőrzés (deploy után)
- [ ] curl https://${host}/api/event/health → {"status":"ok"}
- [ ] Meta Events Manager → Test Events: a böngésző + szerver event AZONOS event_id-vel (dedup)
- [ ] Google Ads → Conversions: a feltöltés megjelenik (gclid match vagy Enhanced Conversions)
- [ ] Cloudflare Workers Logs: nincs TRK-* error 24h-n át

> A szerver NEM küld GA4-et (Modell 2 / Run 6): az on-site GA4 a böngészőé (GTM), az
> offline GA4-láb kikapcsolt. GA4 DebugView-ban tehát a BÖNGÉSZŐ eseményét ellenőrzöd,
> nem a gateway-ét.
`;
}
