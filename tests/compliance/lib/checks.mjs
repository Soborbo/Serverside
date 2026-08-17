/**
 * A rögzített megfigyelésekből PASS / FAIL / N-A — tiszta függvények.
 *
 * SZABÁLY: minden FAIL mellé NYERS BIZONYÍTÉK kerül (mely request, mely süti,
 * mely storage-kulcs). Az állítás önmagában nem elég — a riport azért készül,
 * hogy reggel el lehessen dönteni, mit kell javítani, ne azért, hogy higgyünk neki.
 */

import { CONSENT_BOUND_CATEGORIES, inspectPingForIdentifiers, summarizeRequest } from './classify.mjs';
import { isNonEssentialCookie, isNonEssentialStorageKey } from './instrument.mjs';
import { compareButtonProminence } from './banner.mjs';

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const NA = 'N-A';
export const INFO = 'INFO';

const check = (id, status, detail, evidence = null) => ({ id, status, detail, evidence });

/** Consent-kötött (mérési/marketing) requestek egy felvételből. */
export function consentBoundRequests(capture) {
  return (capture.requests || []).filter((r) => CONSENT_BOUND_CATEGORIES.includes(r.category));
}

export function nonEssentialCookies(capture) {
  return (capture.cookies || []).filter((c) => isNonEssentialCookie(c.name));
}

export function nonEssentialStorage(capture, ops) {
  return (capture.page?.storage || []).filter((e) => ops.includes(e.op) && isNonEssentialStorageKey(e.key));
}

/**
 * Volt-e `consent default` a dataLayerben, és mikor.
 *
 * KÉT alakot fogadunk el, mert a flottán mindkettő előfordul:
 *   gtag-stílus:  dataLayer.push(arguments)  → args = ['consent','default',{…}]
 *   tömb-stílus:  dataLayer.push(['consent','default',{…}]) → args = [[…]]
 */
export function consentDefaultPush(capture) {
  const isDefault = (a) => Array.isArray(a) && a[0] === 'consent' && a[1] === 'default';
  return (capture.page?.dataLayer || []).find(
    (e) => isDefault(e.args) || (Array.isArray(e.args) && e.args.some(isDefault))
  );
}

function firstGtmRequest(capture) {
  return (capture.requests || []).find((r) => r.category === 'gtm');
}

/**
 * A „döntés előtt" (A) forgatókönyv értékelése.
 * Ez a legsúlyosabb blokk: itt a felhasználó még semmit nem mondott.
 */
export function evaluateBeforeDecision(capture) {
  const out = [];

  const bound = consentBoundRequests(capture);
  out.push(
    check(
      'A_no_consent_bound_requests',
      bound.length === 0 ? PASS : FAIL,
      bound.length === 0
        ? 'Döntés előtt nem ment GA4/Ads/Meta/gateway kérés.'
        : `${bound.length} consent-kötött kérés ment döntés ELŐTT.`,
      bound.slice(0, 20).map(summarizeRequest)
    )
  );

  const gtm = firstGtmRequest(capture);
  out.push(
    check(
      'A_gtm_not_loaded_before_decision',
      gtm ? FAIL : PASS,
      gtm
        ? 'A GTM konténer döntés ELŐTT betöltött → nem Basic Consent Mode (advanced / mindig-be állapot).'
        : 'A GTM döntés előtt nem töltött be (Basic Consent Mode-konform).',
      gtm ? [summarizeRequest(gtm)] : null
    )
  );

  const cookies = nonEssentialCookies(capture);
  out.push(
    check(
      'A_no_nonessential_cookies',
      cookies.length === 0 ? PASS : FAIL,
      cookies.length === 0
        ? 'Döntés előtt nem íródott nem-esszenciális süti.'
        : `${cookies.length} nem-esszenciális süti döntés ELŐTT.`,
      cookies.slice(0, 25).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }))
    )
  );

  const writes = nonEssentialStorage(capture, ['setItem']);
  out.push(
    check(
      'A_no_nonessential_storage_write',
      writes.length === 0 ? PASS : FAIL,
      writes.length === 0 ? 'Nincs nem-esszenciális storage-ÍRÁS.' : `${writes.length} nem-esszenciális storage-írás.`,
      writes.slice(0, 25)
    )
  );

  const reads = nonEssentialStorage(capture, ['getItem']);
  out.push(
    check(
      'A_no_nonessential_storage_read',
      reads.length === 0 ? PASS : FAIL,
      reads.length === 0
        ? 'Nincs nem-esszenciális storage-OLVASÁS.'
        : `${reads.length} nem-esszenciális storage-OLVASÁS (a PECR alatt ez is engedélyköteles).`,
      reads.slice(0, 25)
    )
  );

  const def = consentDefaultPush(capture);
  let status = NA;
  let detail = 'Nincs GTM és nincs consent default — nincs mit sorrendezni.';
  if (def && gtm) {
    const ok = def.t <= gtm.t;
    status = ok ? PASS : FAIL;
    detail = ok
      ? `A consent default ${gtm.t - def.t} ms-mal a GTM-kérés ELŐTT futott.`
      : `A consent default ${def.t - gtm.t} ms-mal a GTM-kérés UTÁN futott.`;
  } else if (gtm && !def) {
    status = FAIL;
    detail =
      'A GTM betöltött, de a dataLayerben NEM figyeltünk meg `consent default` push-t (a konténeren belüli CMP-sablon is adhatja — ez a mérés korlátja, nem cáfolat).';
  } else if (def && !gtm) {
    status = PASS;
    detail = 'Van consent default, GTM-kérés nélkül.';
  }
  out.push(
    check('A_consent_default_before_gtm', status, detail, {
      default_push_t: def?.t ?? null,
      gtm_request_t: gtm?.t ?? null,
      gtm_url: gtm ? summarizeRequest(gtm).url : null,
      datalayer_sample: (capture.page?.dataLayer || []).slice(0, 8)
    })
  );

  out.push(
    check(
      'A_noscript_iframe_absent',
      capture.noscript_gtm_iframe ? FAIL : PASS,
      capture.noscript_gtm_iframe
        ? 'A HTML tartalmazza a GTM `ns.html` noscript iframe-et — JS nélkül nincs consent-panel, tehát ez consent nélküli betöltés.'
        : 'Nincs GTM noscript iframe a HTML-ben.',
      capture.noscript_gtm_iframe ? { snippet: capture.noscript_gtm_iframe } : null
    )
  );

  out.push(
    check(
      'A_document_cookie_reads',
      INFO,
      `${capture.page?.cookieReads ?? 0} db \`document.cookie\` olvasás döntés előtt (a CMP saját olvasásait is tartalmazza — kontextus, nem ítélet).`,
      null
    )
  );

  return out;
}

/** Az „elutasít mindent" (C) forgatókönyv — a legfontosabb blokk. */
export function evaluateAfterReject(capture) {
  const out = [];
  const bound = consentBoundRequests(capture);
  out.push(
    check(
      'C_no_consent_bound_requests',
      bound.length === 0 ? PASS : FAIL,
      bound.length === 0
        ? 'Elutasítás után nem ment GA4/Ads/Meta/gateway kérés.'
        : `${bound.length} consent-kötött kérés ELUTASÍTÁS UTÁN.`,
      bound.slice(0, 20).map(summarizeRequest)
    )
  );

  const cookies = nonEssentialCookies(capture);
  out.push(
    check(
      'C_no_nonessential_cookies',
      cookies.length === 0 ? PASS : FAIL,
      cookies.length === 0 ? 'Elutasítás után nincs nem-esszenciális süti.' : `${cookies.length} nem-esszenciális süti elutasítás után.`,
      cookies.slice(0, 25).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }))
    )
  );

  const writes = nonEssentialStorage(capture, ['setItem']);
  out.push(
    check(
      'C_no_nonessential_storage_write',
      writes.length === 0 ? PASS : FAIL,
      writes.length === 0 ? 'Nincs nem-esszenciális storage-írás.' : `${writes.length} nem-esszenciális storage-írás elutasítás után.`,
      writes.slice(0, 25)
    )
  );

  // Ha MÉGIS megy ping (advanced mód), abban SEMMILYEN saját azonosító nem lehet.
  const pings = (capture.requests || []).filter((r) => ['ga4', 'google_ads', 'meta'].includes(r.category));
  if (pings.length === 0) {
    out.push(check('C_pings_carry_no_identifiers', NA, 'Nem ment ping elutasítás után — nincs mit vizsgálni.'));
  } else {
    const leaks = [];
    for (const p of pings) {
      const found = inspectPingForIdentifiers(p.url);
      if (found.params.length || found.hasEmailLike) {
        leaks.push({ url: summarizeRequest(p).url, params: found.params, email_like: found.hasEmailLike });
      }
    }
    out.push(
      check(
        'C_pings_carry_no_identifiers',
        leaks.length === 0 ? PASS : FAIL,
        leaks.length === 0
          ? `${pings.length} ping ment, de saját azonosítót/PII-t egyikben sem találtunk.`
          : `${leaks.length} pingben saját azonosító vagy PII-gyanús érték van.`,
        leaks.length ? leaks : { pings: pings.slice(0, 10).map(summarizeRequest) }
      )
    );
  }

  return out;
}

/** Banner-UI (első réteg) — a NAIH-féle „nehezített elutasítás" mérése. */
export function evaluateBannerUi(banner, clicksToReject) {
  const out = [];
  if (!banner || !banner.banner_visible) {
    // MINDHÁROM ellenőrzést kiadjuk N-A-ként. Ha csak az elsőt adnánk ki, a
    // táblázatban üres cella maradna — az pedig megkülönböztethetetlen a
    // „nem mértük" és a „nincs baj" között. Egy riport akkor ér valamit, ha
    // minden cellája megmondja, MIÉRT olyan, amilyen.
    const reason =
      'NO_BANNER_OBSERVED — nem láttunk bannert. Ez NEM bizonyítja, hogy nincs CMP: lehet geo-alapú megjelenítés (lásd a riport teszt-ország mezőjét).';
    out.push(check('UI_reject_button_present', NA, reason));
    out.push(check('UI_reject_equal_prominence', NA, reason));
    out.push(check('UI_clicks_to_reject', NA, reason));
    return out;
  }

  out.push(
    check(
      'UI_reject_button_present',
      banner.reject ? PASS : FAIL,
      banner.reject
        ? `Van elutasító gomb az első rétegen: "${banner.reject.text}"`
        : 'NINCS elutasító gomb az első rétegen (a NAIH TV2-bírság tárgya).',
      banner.reject || { accept: banner.accept, settings: banner.settings }
    )
  );

  const prominence = compareButtonProminence(banner.accept, banner.reject);
  out.push(
    check(
      'UI_reject_equal_prominence',
      prominence.comparable ? (prominence.equal_prominence ? PASS : FAIL) : NA,
      prominence.comparable
        ? prominence.equal_prominence
          ? 'Az elfogad/elutasít gomb mérhetően egyenrangú.'
          : `Az elutasítás vizuálisan hátrébb sorolt: ${prominence.failures.join('; ')}`
        : `Nem összehasonlítható: ${prominence.reason}`,
      prominence
    )
  );

  out.push(
    check(
      'UI_clicks_to_reject',
      clicksToReject === null ? FAIL : clicksToReject <= 1 ? PASS : FAIL,
      clicksToReject === null
        ? 'Az elutasítás a mért úton NEM volt elérhető.'
        : `Az elutasítás ${clicksToReject} kattintás az első rétegtől (elvárás: 1, ugyanannyi mint az elfogadás).`,
      { clicks: clicksToReject }
    )
  );

  return out;
}

/** Visszavonás (D) — töröl-e a site bármit a nyugvó adatból. */
export function evaluateWithdrawal(withdrawal) {
  if (!withdrawal || withdrawal.skipped) {
    return [
      check(
        'D_withdrawal_purges',
        NA,
        withdrawal?.reason || 'NO_REVISIT_UI — nincs elérhető visszavonó felület az oldalon.'
      )
    ];
  }
  const remaining = withdrawal.remaining_non_essential || [];
  return [
    check(
      'D_withdrawal_purges',
      remaining.length === 0 ? PASS : FAIL,
      remaining.length === 0
        ? 'Visszavonás után nem maradt nem-esszenciális süti/storage.'
        : `Visszavonás után ${remaining.length} nem-esszenciális elem MARADT.`,
      remaining.slice(0, 25)
    ),
    check(
      'D_no_requests_after_withdrawal',
      (withdrawal.consent_bound_requests_after || []).length === 0 ? PASS : FAIL,
      `${(withdrawal.consent_bound_requests_after || []).length} consent-kötött kérés a visszavonás UTÁN.`,
      (withdrawal.consent_bound_requests_after || []).slice(0, 10)
    )
  ];
}

/** Süti-tájékoztató: link megléte + a harmadik felek NÉVSZERINTI említése. */
export function evaluateCookiePolicy(policy) {
  if (!policy || !policy.url) {
    return [check('MISC_cookie_policy', FAIL, 'Nem találtunk süti-/adatvédelmi tájékoztató linket a nyitóoldalon.')];
  }
  if (policy.error) {
    return [check('MISC_cookie_policy', INFO, `A tájékoztató nem volt letölthető: ${policy.error}`, { url: policy.url })];
  }
  const named = policy.third_parties_named || [];
  // SZÁNDÉKOSAN nem jogi értékelés: kulcsszó-keresés, semmi több.
  return [
    check(
      'MISC_cookie_policy_names_third_parties',
      named.length >= 2 ? PASS : FAIL,
      named.length
        ? `A tájékoztató megnevezi: ${named.join(', ')} (kulcsszó-keresés, NEM jogi értékelés).`
        : 'A tájékoztatóban nem találtunk Google/Meta említést (kulcsszó-keresés, NEM jogi értékelés).',
      { url: policy.url, matched: named }
    )
  ];
}

/** A riport táblázatának oszlopai — a „mi bukik hol" egy pillantásra. */
export const TABLE_COLUMNS = [
  { id: 'A_no_consent_bound_requests', label: 'A: nincs tag consent előtt' },
  { id: 'A_gtm_not_loaded_before_decision', label: 'A: GTM nem tölt' },
  { id: 'A_no_nonessential_cookies', label: 'A: nincs süti' },
  { id: 'A_no_nonessential_storage_write', label: 'A: nincs storage-írás' },
  { id: 'A_no_nonessential_storage_read', label: 'A: nincs storage-olvasás' },
  { id: 'A_noscript_iframe_absent', label: 'A: nincs noscript iframe' },
  { id: 'UI_reject_button_present', label: 'UI: van reject' },
  { id: 'UI_reject_equal_prominence', label: 'UI: egyenrangú' },
  { id: 'UI_clicks_to_reject', label: 'UI: 1 kattintás' },
  { id: 'C_no_consent_bound_requests', label: 'C: nincs tag reject után' },
  { id: 'C_no_nonessential_cookies', label: 'C: nincs süti reject után' },
  { id: 'C_pings_carry_no_identifiers', label: 'C: ping azonosító nélkül' },
  { id: 'D_withdrawal_purges', label: 'D: visszavonás töröl' }
];
