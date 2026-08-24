import { describe, it, expect } from 'vitest';
import {
  parseConsentPayload,
  parseConsentMetricPayload,
  parseConsentId,
  decisionMatchesCategories,
  signalsFromCategories,
  isConsentProviderSbo,
  isGa4AllowedForSite,
  isBlockedByConsentState,
  MAX_REVISION,
  type ConsentLogState
} from '../src/lib/consent-log';

/**
 * Soborbo CMP · Fázis 1 — a pure mag.
 *
 * A legfontosabb, amit ezek a tesztek őriznek: a Fázis 1 INERT. Amíg a site
 * `consent.provider`-e nem `'sbo'` (és jelenleg egyetlen site-é sem az), a
 * viselkedés bitre a mai — ezt bizonyítani kell, nem érvelni róla.
 */

const validDecision = {
  consent_id: 'c1d2e3f4-aaaa-bbbb-cccc-000000000001',
  consent_event_id: 'e1d2e3f4-aaaa-bbbb-cccc-000000000002',
  revision: 1,
  decision: 'accept_all',
  cat_analytics: true,
  cat_marketing: true,
  consent_mode: 'basic',
  policy_version: '2026-08-a',
  banner_version: 'b1',
  consent_text_version: '2026-08-a',
  ruleset: 'eea_uk',
  lang: 'hu',
  country: 'hu',
  client_lib_version: '6.2.0',
  client_decided_at: '2026-08-17T10:00:00.000Z'
};

describe('a Fázis 1 INERT — provider-kapu', () => {
  it('a hiányzó consent blokk és a cookieyes UGYANAZ: nem sbo', () => {
    expect(isConsentProviderSbo({})).toBe(false);
    expect(isConsentProviderSbo({ consent: {} })).toBe(false);
    expect(isConsentProviderSbo({ consent: { provider: 'cookieyes' } })).toBe(false);
  });

  it('csak az explicit sbo kapcsol', () => {
    expect(isConsentProviderSbo({ consent: { provider: 'sbo' } })).toBe(true);
  });

  it('GA4: cookieyes-site-on a MAI szabály áll — consent nélkül is mehet', () => {
    // Ez a nulla-viselkedésváltozás bizonyítéka a GA4-lábra. Ha ez elromlik, a
    // merge egy éjszaka alatt elvágná a GA4-et az egész flottán.
    expect(isGa4AllowedForSite({}, undefined)).toBe(true);
    expect(isGa4AllowedForSite({ consent: { provider: 'cookieyes' } }, { analytics_storage: 'DENIED' })).toBe(true);
  });

  it('GA4: sbo-site-on analytics_storage=GRANTED kell', () => {
    const sbo = { consent: { provider: 'sbo' } };
    expect(isGa4AllowedForSite(sbo, { analytics_storage: 'GRANTED' })).toBe(true);
    expect(isGa4AllowedForSite(sbo, { analytics_storage: 'DENIED' })).toBe(false);
    // Hiányzó jel is tiltás: a DUAA statisztikai kivétel a GA4-et nem menti meg.
    expect(isGa4AllowedForSite(sbo, undefined)).toBe(false);
    expect(isGa4AllowedForSite(sbo, {})).toBe(false);
  });
});

describe('parseConsentPayload', () => {
  it('érvényes döntés → normalizált rekord', () => {
    const r = parseConsentPayload(validDecision, 'site-a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.site_id).toBe('site-a');
    expect(r.entry.decision).toBe('accept_all');
    expect(r.entry.cat_analytics).toBe(1);
    expect(r.entry.ad_user_data).toBe('GRANTED');
    expect(r.entry.analytics_storage).toBe('GRANTED');
    // Az ország normalizálva, a timestamp ISO-ra hozva.
    expect(r.entry.country).toBe('HU');
    expect(r.entry.client_decided_at).toBe('2026-08-17T10:00:00.000Z');
  });

  it('a site_id a SZERVERÉ, nem a payloadé (tenant-határ)', () => {
    // Egy hamisított site_id nem írhat másik tenant nevében.
    const r = parseConsentPayload({ ...validDecision, site_id: 'masik-site' }, 'site-a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.site_id).toBe('site-a');
  });

  it('a decision és a kategóriák ellentmondása ELUTASÍTÁS, nem javítás', () => {
    // accept_all + kikapcsolt marketing = vagy kliens-bug, vagy hamisítás.
    // Csendben eltárolni rosszabb, mint 400-at adni: a rekord bizonyíték.
    const r = parseConsentPayload({ ...validDecision, cat_marketing: false }, 'site-a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('decision_categories_mismatch');
  });

  it('a verzió-mezők KÖTELEZŐK — verzió nélkül a sor nem consent-proof', () => {
    for (const field of ['policy_version', 'banner_version', 'consent_text_version', 'ruleset']) {
      const body = { ...validDecision } as Record<string, unknown>;
      delete body[field];
      const r = parseConsentPayload(body, 'site-a');
      expect(r.ok, `${field} hiánya nem buktatta el`).toBe(false);
    }
  });

  it('a hibaokok MEGNEVEZETTEK (a 400-as választ a kliens naplózza)', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validDecision, consent_id: 'x' }, 'invalid_consent_id'],
      [{ ...validDecision, consent_event_id: '' }, 'invalid_consent_event_id'],
      [{ ...validDecision, revision: 0 }, 'invalid_revision'],
      [{ ...validDecision, revision: 1.5 }, 'invalid_revision'],
      [{ ...validDecision, revision: MAX_REVISION + 1 }, 'invalid_revision'],
      [{ ...validDecision, decision: 'maybe' }, 'invalid_decision'],
      [{ ...validDecision, cat_analytics: 'yes' }, 'invalid_categories'],
      [{ ...validDecision, consent_mode: 'turbo' }, 'invalid_consent_mode'],
      [{ ...validDecision, client_decided_at: 'tegnap' }, 'invalid_client_decided_at'],
      [{ ...validDecision, lang: 'magyar' }, 'invalid_lang'],
      [{ ...validDecision, country: 'HUN' }, 'invalid_country']
    ];
    for (const [body, reason] of cases) {
      const r = parseConsentPayload(body, 'site-a');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    }
  });

  it('reject_all és withdrawn: mindkét kategória ki', () => {
    const reject = parseConsentPayload(
      { ...validDecision, decision: 'reject_all', cat_analytics: false, cat_marketing: false },
      'site-a'
    );
    expect(reject.ok).toBe(true);
    if (reject.ok) {
      expect(reject.entry.ad_user_data).toBe('DENIED');
      expect(reject.entry.analytics_storage).toBe('DENIED');
    }
    const withdrawn = parseConsentPayload(
      { ...validDecision, decision: 'withdrawn', cat_analytics: false, cat_marketing: false, revision: 2 },
      'site-a'
    );
    expect(withdrawn.ok).toBe(true);
  });

  it('custom: csak-analytics és csak-marketing', () => {
    const onlyAnalytics = parseConsentPayload(
      { ...validDecision, decision: 'custom', cat_analytics: true, cat_marketing: false },
      'site-a'
    );
    expect(onlyAnalytics.ok).toBe(true);
    if (onlyAnalytics.ok) {
      expect(onlyAnalytics.entry.analytics_storage).toBe('GRANTED');
      expect(onlyAnalytics.entry.ad_user_data).toBe('DENIED');
      expect(onlyAnalytics.entry.ad_personalization).toBe('DENIED');
      expect(onlyAnalytics.entry.ad_storage).toBe('DENIED');
    }
    const onlyMarketing = parseConsentPayload(
      { ...validDecision, decision: 'custom', cat_analytics: false, cat_marketing: true },
      'site-a'
    );
    expect(onlyMarketing.ok).toBe(true);
    if (onlyMarketing.ok) expect(onlyMarketing.entry.analytics_storage).toBe('DENIED');
  });

  it('az ad-hármas EGYSÉG — nem csúszhat szét', () => {
    // Ha ez elromlik, magunknak gyártanánk TRK-910-005-öt (signals_inconsistent):
    // pont azt a hibát, amit a Fázis D MÁS rendszereken mér.
    const granted = signalsFromCategories(false, true);
    expect(granted.ad_user_data).toBe('GRANTED');
    expect(granted.ad_personalization).toBe('GRANTED');
    expect(granted.ad_storage).toBe('GRANTED');
    expect(granted.analytics_storage).toBe('DENIED');
  });
});

describe('cky_agreement — a párhuzamos ablak mérőszáma', () => {
  it('a SZERVER számolja, a kliens csak a nyers olvasatot küldi', () => {
    // Ha a kliens küldené az egyezést, ugyanabból a hibás fordításból jöhetne,
    // amit mérni akarunk vele. Ezért a kliens `cky_agreement`-jét figyelmen
    // kívül hagyjuk, és magunk számolunk.
    const r = parseConsentPayload(
      { ...validDecision, cky_cookie_analytics: true, cky_cookie_marketing: true, cky_agreement: 0 },
      'site-a'
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.cky_agreement).toBe(1);
  });

  it('eltérő CookieYes-olvasat → 0', () => {
    const r = parseConsentPayload(
      { ...validDecision, cky_cookie_analytics: true, cky_cookie_marketing: false },
      'site-a'
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.cky_agreement).toBe(0);
  });

  it('nincs CookieYes-olvasat → undefined (NULL a receipten), nem 0', () => {
    const r = parseConsentPayload(validDecision, 'site-a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.cky_agreement).toBeUndefined();
      expect(r.entry.cky_cookie_analytics).toBeUndefined();
    }
  });
});

describe('parseConsentMetricPayload — ID-MENTES', () => {
  it('érvényes megjelenés-ping', () => {
    const r = parseConsentMetricPayload(
      { banner_version: 'b1', lang: 'hu', device_class: 'mobile', interaction_ms: 2500 },
      'site-a'
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.interaction_ms).toBe(2500);
  });

  it('azonosítót hordozó ping ELUTASÍTVA, nem megtisztítva', () => {
    // A banner megjelenésekor még nincs döntés: egy consent_id ott azonosító-
    // gyűjtés lenne consent ELŐTT. Néma megtisztítás mellett a kliens-bug
    // hónapokig fennmaradna.
    for (const field of ['consent_id', 'consent_event_id', 'user_id', 'client_id', 'email']) {
      const r = parseConsentMetricPayload({ banner_version: 'b1', [field]: 'x' }, 'site-a');
      expect(r.ok, `${field} átment`).toBe(false);
      if (!r.ok) expect(r.reason).toBe(`identifier_not_allowed:${field}`);
    }
  });

  it('döntés nélküli megjelenés: interaction_ms hiányozhat', () => {
    const r = parseConsentMetricPayload({ banner_version: 'b1' }, 'site-a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.interaction_ms).toBeUndefined();
  });

  it('ismeretlen device_class elutasítva (nem ujjlenyomat-mező)', () => {
    const r = parseConsentMetricPayload({ banner_version: 'b1', device_class: 'iPhone 15 Pro' }, 'site-a');
    expect(r.ok).toBe(false);
  });
});

describe('parseConsentId — a konverziós út kötése', () => {
  it('érvényes ID átmegy', () => {
    expect(parseConsentId('c1d2e3f4-aaaa-bbbb-cccc-000000000001')).toBe(
      'c1d2e3f4-aaaa-bbbb-cccc-000000000001'
    );
  });

  it('rossz forma → undefined, NEM hiba: a kötés sosem buktathat konverziót', () => {
    expect(parseConsentId(undefined)).toBeUndefined();
    expect(parseConsentId(42)).toBeUndefined();
    expect(parseConsentId('x')).toBeUndefined();
    expect(parseConsentId('a'.repeat(200))).toBeUndefined();
    expect(parseConsentId({ id: 'x' })).toBeUndefined();
  });
});

describe('isBlockedByConsentState — az offline/replay kapu', () => {
  const state = (over: Partial<ConsentLogState>): ConsentLogState => ({
    consent_id: 'c1',
    revision: 1,
    decision: 'accept_all',
    cat_analytics: true,
    cat_marketing: true,
    ad_user_data: 'GRANTED',
    ad_personalization: 'GRANTED',
    ad_storage: 'GRANTED',
    analytics_storage: 'GRANTED',
    client_decided_at: '2026-08-17T10:00:00.000Z',
    server_received_at: '2026-08-17T10:00:01.000Z',
    ...over
  });

  it('null → NEM blokkol (visszaesés a mai, receipt-alapú szabályra)', () => {
    // Ez az inertség sarokköve: a CookieYes-oldalakon soha nincs consent_id,
    // tehát itt mindig null jön. Fail-closed viselkedés bevezetése néma
    // konverzió-vesztés lenne az EGÉSZ flottán.
    expect(isBlockedByConsentState(null)).toBe(false);
  });

  it('withdrawn → blokkol', () => {
    expect(
      isBlockedByConsentState(
        state({ decision: 'withdrawn', ad_user_data: 'DENIED', cat_marketing: false })
      )
    ).toBe(true);
  });

  it('a nap-1 GRANTED / nap-3 visszavonás eset: a LEGFRISSEBB revision dönt', () => {
    // A hívó a MAX(revision)-t kapja (ledger.getConsentState) — ez a teszt azt
    // rögzíti, hogy az így kapott withdrawn állapot tényleg blokkol, akkor is,
    // ha a capture-kori receipt GRANTED volt.
    expect(isBlockedByConsentState(state({ revision: 2, decision: 'withdrawn', ad_user_data: 'DENIED' }))).toBe(
      true
    );
  });

  it('érvényes GRANTED → nem blokkol', () => {
    expect(isBlockedByConsentState(state({}))).toBe(false);
  });

  it('reject_all → blokkol (ad_user_data nem GRANTED)', () => {
    expect(
      isBlockedByConsentState(
        state({ decision: 'reject_all', ad_user_data: 'DENIED', cat_marketing: false })
      )
    ).toBe(true);
  });
});

describe('decisionMatchesCategories', () => {
  it('a négy döntés-fajta teljes igazságtáblája', () => {
    expect(decisionMatchesCategories('accept_all', true, true)).toBe(true);
    expect(decisionMatchesCategories('accept_all', true, false)).toBe(false);
    expect(decisionMatchesCategories('reject_all', false, false)).toBe(true);
    expect(decisionMatchesCategories('reject_all', true, false)).toBe(false);
    expect(decisionMatchesCategories('withdrawn', false, false)).toBe(true);
    expect(decisionMatchesCategories('withdrawn', false, true)).toBe(false);
    expect(decisionMatchesCategories('custom', true, false)).toBe(true);
    expect(decisionMatchesCategories('custom', false, true)).toBe(true);
    // A mindkettő-be / mindkettő-ki a saját nevén megy, nem custom-ként.
    expect(decisionMatchesCategories('custom', true, true)).toBe(false);
    expect(decisionMatchesCategories('custom', false, false)).toBe(false);
  });
});
