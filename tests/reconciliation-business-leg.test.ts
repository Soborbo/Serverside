import { describe, it, expect } from 'vitest';
import {
  computeSiteDrift,
  computeOfflineDrift,
  deriveOfflineState,
  reportOfflineLeg,
  assembleOfflineLegs,
  appendOfflineOnlySites,
  assembleReconInputs,
  countsAgainstOfflineCoverage,
  OFFLINE_SKIP_CLASSIFICATION,
  ALL_SKIP_REASONS,
  summarize,
  fetchReconInputs,
  DEFAULT_OFFLINE_THRESHOLDS,
  type SiteReconInput,
  type OfflineLegInput
} from '../src/lib/reconciliation';

/**
 * vNext P1.1 — RECONCILIATION BUSINESS-LEG (implementálva 2026-08-24).
 *
 * Ez a fájl korábban a MAI VAKSÁGOT rögzítette (RED-baseline): bizonyította, hogy egy
 * szándékosan kikapcsolt Google offline-láb mellett a monitor ZÖLDEN megy át. A P1.1
 * implementációjával az elvárások MEG VANNAK FORDÍTVA — a tervdokumentum §5
 * táblázata soronként megadta, melyik findingnek kell megszületnie.
 *
 * A vakságnak három szerkezeti oka volt, mindhárom lezárva:
 *  1. a `lead_status_total` holt súly volt → az `offline_legs` UGYANABBÓL a
 *     sorhalmazból épül, event-típusonként;
 *  2. a `gads` ki sem került a PlatformCounts-ba, és a delivery-lekérdezés
 *     `origin IN ('fanout','retry')`-ra szűrt → az offline lábnak SAJÁT lekérdezése
 *     van (`origin='offline'`), saját alappal;
 *  3. a coverage-alap csak a Metára volt értelmezett → az offline lábnak saját
 *     formulája van, `ad_eligible` NÉLKÜL.
 *
 * A 2026-08-24-i review két kötelező korrekciója szintén itt van bizonyítva:
 *  A. NEM minden skip veszteség (`countsAgainstOfflineCoverage`);
 *  B. dependency-állapotgép (BLOCKED_DEPENDENCY / UNARMED / ARMED) — hiányzó
 *     előfeltétel esetén NINCS drift-finding, mert azt a health-check már jelzi.
 */

const leg = (over: Partial<OfflineLegInput> = {}): OfflineLegInput => ({
  site_id: 'painless',
  event_name: 'revenue_confirmed',
  received: 0,
  accepted: 0,
  rejected: 0,
  skips: {},
  received_7d: 0,
  accepted_7d: 0,
  skips_7d: {},
  blocked_by: null,
  last_accepted_at: null,
  ...over
});

const YESTERDAY = '2026-08-23T09:00:00.000Z';

// ═══════════════════════════════════════════════════════════════════════════
describe('P1.1 — a halott Google offline-láb MOST már findingot termel', () => {
  it('REGRESSZIÓ (24h): ment, most nem → CRITICAL offline_zero_delivery, volumen NÉLKÜL is', () => {
    // Ez adja a tervi DoD-t („a kikapcsolt offline-láb 24 órán belül piros"): a
    // bizonyíték nem a darabszám, hanem hogy KORÁBBAN ment, MOST meg nem. Egy ritka
    // lifecycle-eseménynél (a ledgerben 2026-07-20-án ÖSSZESEN 7 lead_status sor volt)
    // egy 10-es mintaküszöb soha nem sülne el.
    const findings = computeOfflineDrift(
      leg({ received: 2, accepted: 0, last_accepted_at: YESTERDAY })
    );
    expect(findings.map((f) => f.kind)).toContain('offline_zero_delivery');
    const f = findings[0];
    expect(f.severity).toBe('critical');
    expect(f.platform).toBe('gads');
    expect(f.event_name).toBe('revenue_confirmed');
    expect(f.detail).toContain('LEALLT');
  });

  it('ABSZOLÚT (7 nap): sosem ment, de jönnek a státuszok → CRITICAL', () => {
    const findings = computeOfflineDrift(
      leg({ received: 1, received_7d: 6, accepted_7d: 0, last_accepted_at: null })
    );
    expect(findings.map((f) => f.kind)).toContain('offline_zero_delivery');
    expect(findings[0].detail).toContain('MEG SOHA');
    expect(findings[0].expected).toBe(6);
  });

  it('a teljes láncon át is átér: computeSiteDrift → summarize CRITICAL', () => {
    const input: SiteReconInput = {
      site_id: 'painless',
      events_total: 80,
      ad_eligible: 60,
      lead_status_total: 50,
      platforms: [{ platform: 'meta', accepted: 60, rejected: 0, skipped: 0 }],
      offline_legs: [
        leg({ received: 50, received_7d: 50, accepted: 0, accepted_7d: 0, last_accepted_at: YESTERDAY })
      ]
    };
    const kinds = computeSiteDrift(input).map((f) => f.kind);
    expect(kinds).toContain('offline_zero_delivery');
    expect(summarize([input]).worst).toBe('critical');
  });

  it('a `lead_status_total` MÁR NEM holt súly: az üzleti darabszám kimenetet változtat', () => {
    // A RED-baseline pont az ELLENKEZŐJÉT bizonyította: 500 vagy 0 esemény mellett a
    // kimenet bitre ugyanaz volt.
    const withLeads: SiteReconInput = {
      site_id: 'painless',
      events_total: 80,
      ad_eligible: 60,
      lead_status_total: 500,
      platforms: [{ platform: 'meta', accepted: 60, rejected: 0, skipped: 0 }],
      offline_legs: [leg({ received: 500, received_7d: 500, last_accepted_at: YESTERDAY })]
    };
    const withoutLeads: SiteReconInput = { ...withLeads, lead_status_total: 0, offline_legs: [] };
    expect(computeSiteDrift(withLeads)).not.toEqual(computeSiteDrift(withoutLeads));
    expect(computeSiteDrift(withoutLeads)).toEqual([]);
  });

  it('a `gads` offline láb SAJÁT alappal jelenik meg, nem a böngésző-fan-out listáján', () => {
    // Az `assembleReconInputs` PLATFORMS-listája továbbra sem tartalmaz 'gads'-ot —
    // és ez HELYES: az offline kézbesítés origin='offline', a fan-out lekérdezés
    // pedig origin IN ('fanout','retry'). A gads az offline_legs-en jön be.
    const legs = new Map([['painless', [leg({ received: 5, last_accepted_at: YESTERDAY })]]]);
    const inputs = assembleReconInputs(
      [{ site_id: 'painless', total: 80, ad_eligible: 60 }],
      [{ site_id: 'painless', platform: 'meta', accepted: 60, rejected: 0, skipped: 0 }],
      [{ site_id: 'painless', total: 5 }],
      legs
    );
    expect(inputs[0].platforms.map((p) => p.platform)).not.toContain('gads');
    expect(inputs[0].offline_legs).toHaveLength(1);
    expect(computeSiteDrift(inputs[0]).map((f) => f.kind)).toContain('offline_zero_delivery');
  });

  it('CSAK offline forgalmat kapott site sem esik ki a mérésből', () => {
    // Az assembleReconInputs az events_raw sorokból indul. A CRM-lifecycle napokkal a
    // capture UTÁN érkezik, tehát teljesen normális, hogy egy 24 órában csak
    // revenue_confirmed jön be, böngésző-event nem — enélkül az ilyen site halott
    // offline lába láthatatlan maradna.
    const legs = new Map([['lomtalan', [leg({ site_id: 'lomtalan', received: 4, received_7d: 9, last_accepted_at: YESTERDAY })]]]);
    const inputs = appendOfflineOnlySites([], legs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].site_id).toBe('lomtalan');
    expect(computeSiteDrift(inputs[0]).map((f) => f.kind)).toContain('offline_zero_delivery');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('review #1 — NEM minden skip veszteség (countsAgainstOfflineCoverage)', () => {
  it('3 lead_status, mindhárom visszavont consenttel → NINCS finding', () => {
    // A review konkrét ellenpéldája: ez nem halott láb, hanem PONTOSAN HELYES
    // működés. Riasztani rá hamis pozitív.
    const findings = computeOfflineDrift(
      leg({
        received: 3,
        accepted: 0,
        skips: { consent_withdrawn: 3 },
        received_7d: 3,
        accepted_7d: 0,
        skips_7d: { consent_withdrawn: 3 },
        last_accepted_at: YESTERDAY
      })
    );
    expect(findings).toEqual([]);
  });

  it('ugyanaz a 3 státusz HIÁNYZÓ CONFIG miatt kihagyva → CRITICAL', () => {
    // Azonos darabszám, azonos „0 accepted" — a KÜLÖNBSÉG a skip OKA.
    const findings = computeOfflineDrift(
      leg({
        received: 3,
        accepted: 0,
        skips: { not_configured: 3 },
        received_7d: 3,
        accepted_7d: 0,
        skips_7d: { not_configured: 3 },
        last_accepted_at: YESTERDAY
      })
    );
    expect(findings.map((f) => f.kind)).toContain('offline_zero_delivery');
  });

  it('vegyes: 10-ből 6 consent-tiltás, 4 kézbesítve → TELJES lefedettség, nincs finding', () => {
    const findings = computeOfflineDrift(
      leg({
        received: 10,
        accepted: 4,
        skips: { consent_denied: 6 },
        received_7d: 10,
        accepted_7d: 4,
        skips_7d: { consent_denied: 6 },
        last_accepted_at: YESTERDAY
      })
    );
    expect(findings).toEqual([]);
    expect(reportOfflineLeg(leg({ received: 10, skips: { consent_denied: 6 } })).expected).toBe(4);
  });

  it('policy-skip és hiba-skip KEVERVE: csak a hiba számít a nevezőbe', () => {
    // 10 beérkezés: 6 consent-tiltás (policy) + 4 no_identifiers (adatminőség).
    // Elvárt = 10 − 6 = 4; kézbesített 0 → a láb halott azon a 4-en.
    const r = reportOfflineLeg(
      leg({ received: 10, skips: { consent_denied: 6, no_identifiers: 4 } })
    );
    expect(r.expected).toBe(4);
  });

  it('ISMERETLEN skip-ok VESZTESÉGNEK számít (a pénzúton nincs „nem tudjuk, miért")', () => {
    expect(countsAgainstOfflineCoverage(null)).toBe(true);
    expect(countsAgainstOfflineCoverage(undefined)).toBe(true);
    expect(countsAgainstOfflineCoverage('')).toBe(true);
    expect(countsAgainstOfflineCoverage('valami_uj_ok_amit_meg_nem_ismerunk')).toBe(true);
  });

  it('MINDEN ismert skip-ok explicit osztályozva van (teljességi őr)', () => {
    // Enélkül egy új SkipReason csendben az „ismeretlen → veszteség" ágra esne, és
    // egy legitim policy-skip hamis CRITICAL-t adna.
    const unclassified = ALL_SKIP_REASONS.filter(
      (r) => OFFLINE_SKIP_CLASSIFICATION[r] === undefined
    );
    expect(
      unclassified,
      `Ezek a skip-okok nincsenek osztályozva az offline coverage-hez: ${unclassified.join(', ')}`
    ).toEqual([]);
  });

  it('a policy/hiba szétválasztás NEM azonos a retryability-vel', () => {
    // A `no_identifiers` TERMINÁLIS (a retry sem segítene), de coverage-szempontból
    // VESZTESÉG: jött egy lead, akit nem tudunk feltölteni. A két tengely külön él.
    expect(countsAgainstOfflineCoverage('no_identifiers')).toBe(true);
    expect(countsAgainstOfflineCoverage('consent_denied')).toBe(false);
    expect(countsAgainstOfflineCoverage('not_configured')).toBe(true);
    expect(countsAgainstOfflineCoverage('dedup')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('review #2 — dependency-állapotgép (BLOCKED / UNARMED / ARMED)', () => {
  it('BLOCKED_DEPENDENCY → NINCS drift-finding (a health-check már jelzi)', () => {
    for (const reason of [
      'customer_id_missing',
      'conversion_action_missing',
      'oauth_secret_missing',
      'oauth_token_missing'
    ] as const) {
      const l = leg({
        received: 20,
        received_7d: 40,
        accepted: 0,
        accepted_7d: 0,
        blocked_by: reason,
        last_accepted_at: YESTERDAY
      });
      expect(deriveOfflineState(l)).toBe('BLOCKED_DEPENDENCY');
      expect(computeOfflineDrift(l), `blocked_by=${reason}`).toEqual([]);
    }
  });

  it('a blokkolt láb NEM néma: a riportsor kimegy, állapottal és okkal', () => {
    const r = reportOfflineLeg(
      leg({ received: 20, blocked_by: 'oauth_secret_missing', last_accepted_at: null })
    );
    expect(r.state).toBe('BLOCKED_DEPENDENCY');
    expect(r.blocked_by).toBe('oauth_secret_missing');
    expect(r.received).toBe(20);
    expect(r.delivered).toBe(0);
  });

  it('UNARMED: nincs bizonyított feltöltés → a 24h regresszió-detektor NEM sül el', () => {
    const l = leg({ received: 2, accepted: 0, received_7d: 2, accepted_7d: 0, last_accepted_at: null });
    expect(deriveOfflineState(l)).toBe('UNARMED');
    // 2 < offlineMinSample(3) → az abszolút detektor sem szól. Csend, helyesen:
    // egy most bekötött site első napján nincs mit riasztani.
    expect(computeOfflineDrift(l)).toEqual([]);
  });

  it('UNARMED: az ABSZOLÚT (7 napos) detektor viszont él, ha összegyűlt a minta', () => {
    const l = leg({ received: 1, received_7d: 5, accepted_7d: 0, last_accepted_at: null });
    expect(deriveOfflineState(l)).toBe('UNARMED');
    expect(computeOfflineDrift(l).map((f) => f.kind)).toContain('offline_zero_delivery');
  });

  it('ARMED csak BIZONYÍTOTT feltöltés után', () => {
    expect(deriveOfflineState(leg({ last_accepted_at: YESTERDAY }))).toBe('ARMED');
    expect(deriveOfflineState(leg({ last_accepted_at: null }))).toBe('UNARMED');
    // A blokkolt állapot MEGELŐZI az armed-et: hiába volt korábban sikeres feltöltés,
    // ha most hiányzik egy előfeltétel, a mérés nem értelmes.
    expect(deriveOfflineState(leg({ last_accepted_at: YESTERDAY, blocked_by: 'oauth_token_missing' }))).toBe(
      'BLOCKED_DEPENDENCY'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('P1.1 — coverage drift és vendor failure az offline lábon', () => {
  it('részleges kiesés → offline_coverage_drift (NEM zero_delivery)', () => {
    const findings = computeOfflineDrift(
      leg({ received: 10, accepted: 5, received_7d: 10, accepted_7d: 5, last_accepted_at: YESTERDAY })
    );
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('offline_coverage_drift');
    expect(kinds).not.toContain('offline_zero_delivery');
    expect(findings[0].expected).toBe(10);
    expect(findings[0].delivered).toBe(5);
  });

  it('nulla kézbesítésnél NEM duplázunk (csak zero_delivery szól, coverage nem)', () => {
    const kinds = computeOfflineDrift(
      leg({ received: 10, accepted: 0, received_7d: 10, accepted_7d: 0, last_accepted_at: YESTERDAY })
    ).map((f) => f.kind);
    expect(kinds).toContain('offline_zero_delivery');
    expect(kinds).not.toContain('offline_coverage_drift');
  });

  it('magas elutasítási arány → offline_vendor_failure a P1.3 mezőkkel', () => {
    const findings = computeOfflineDrift(
      leg({
        received: 10,
        accepted: 6,
        rejected: 4,
        received_7d: 10,
        accepted_7d: 6,
        last_accepted_at: YESTERDAY
      })
    );
    const vf = findings.find((f) => f.kind === 'offline_vendor_failure')!;
    expect(vf.severity).toBe('critical');
    expect(vf.failure_rate).toBeCloseTo(0.4, 4);
    expect(vf.last_successful_upload).toBe(YESTERDAY);
    expect(vf.event_name).toBe('revenue_confirmed');
  });

  it('apró minta → csend (az offline minSample külön, kisebb: 3)', () => {
    expect(DEFAULT_OFFLINE_THRESHOLDS.offlineMinSample).toBe(3);
    const findings = computeOfflineDrift(
      leg({ received: 2, accepted: 1, rejected: 1, received_7d: 2, accepted_7d: 1, last_accepted_at: YESTERDAY })
    );
    expect(findings).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('P1.1 — sorösszefésülés (assembleOfflineLegs)', () => {
  const noBlock = () => null;

  it('a skip_reason bontás megmarad, a null „unknown"-ként (veszteségként) jön be', () => {
    const legs = assembleOfflineLegs(
      [{ site_id: 'painless', event_name: 'lead_qualified', received: 5 }],
      [{ site_id: 'painless', event_name: 'lead_qualified', received: 9 }],
      [
        { site_id: 'painless', event_name: 'lead_qualified', accepted: 0, rejected: 0, skipped: 2, skip_reason: 'consent_denied' },
        { site_id: 'painless', event_name: 'lead_qualified', accepted: 0, rejected: 0, skipped: 1, skip_reason: null }
      ],
      [],
      [],
      noBlock
    );
    const l = legs.get('painless')![0];
    expect(l.skips).toEqual({ consent_denied: 2, unknown: 1 });
    // Elvárt = 5 − 2 (policy) = 3; az „unknown" NEM vonódik le.
    expect(reportOfflineLeg(l).expected).toBe(3);
  });

  it('event-típusonként KÜLÖN láb (a lead_qualified halála nem tűnik el a revenue mögött)', () => {
    // A 7 napos ablak a 24 órás SZUPERHALMAZA — a fixture ezt tükrözi, különben a
    // revenue-láb is hamisan „7 napja nem szállít"-nak látszana.
    const received = [
      { site_id: 'painless', event_name: 'lead_qualified', received: 4 },
      { site_id: 'painless', event_name: 'revenue_confirmed', received: 4 }
    ];
    const delivered = [
      { site_id: 'painless', event_name: 'revenue_confirmed', accepted: 4, rejected: 0, skipped: 0, skip_reason: null }
    ];
    const legs = assembleOfflineLegs(
      received,
      received,
      delivered,
      delivered,
      [
        { site_id: 'painless', event_name: 'lead_qualified', last_accepted_at: YESTERDAY },
        { site_id: 'painless', event_name: 'revenue_confirmed', last_accepted_at: YESTERDAY }
      ],
      noBlock
    );
    const kinds = legs.get('painless')!.flatMap((l) => computeOfflineDrift(l).map((f) => f.kind));
    expect(kinds).toContain('offline_zero_delivery'); // a lead_qualified láb
    expect(kinds.filter((k) => k === 'offline_zero_delivery')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('P1.1 — regressziós korlátok: a böngésző-oldali formulák ÉRINTETLENEK', () => {
  it('a meglévő Meta coverage_drift és vendor_failure_rate változatlanul működik', () => {
    const brokenMeta: SiteReconInput = {
      site_id: 'painless',
      events_total: 100,
      ad_eligible: 100,
      lead_status_total: 0,
      platforms: [
        { platform: 'meta', accepted: 50, rejected: 20, skipped: 0 },
        { platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'msads', accepted: 0, rejected: 0, skipped: 0 }
      ]
    };
    const kinds = computeSiteDrift(brokenMeta).map((f) => f.kind);
    expect(kinds).toContain('vendor_failure_rate');
    expect(kinds).toContain('coverage_drift');
  });

  it('offline_legs NÉLKÜLI input változatlanul viselkedik (nincs regresszió)', () => {
    const noOffline: SiteReconInput = {
      site_id: 'painless',
      events_total: 60,
      ad_eligible: 60,
      lead_status_total: 0,
      platforms: [{ platform: 'meta', accepted: 60, rejected: 0, skipped: 0 }]
    };
    expect(computeSiteDrift(noOffline)).toEqual([]);
  });

  it('a böngésző-oldali minSample-őr megmarad: apró mintán NINCS riasztás', () => {
    const tiny: SiteReconInput = {
      site_id: 'newsite',
      events_total: 2,
      ad_eligible: 2,
      lead_status_total: 1,
      platforms: [{ platform: 'meta', accepted: 0, rejected: 1, skipped: 0 }]
    };
    expect(computeSiteDrift(tiny)).toEqual([]);
  });
});

/**
 * 2026-08-24 merge-gate review (#71 hotfix) — HIGH.
 *
 * A 7 napos ABSZOLÚT detektor kihagyta pont azt az esetet, amire készült: az
 * `assembleOfflineLegs` KIZÁRÓLAG a `received24` sorain iterált, a `received7d` csak
 * kiegészítette a már meglévő kulcsokat. Egy 4 nappal ezelőtt beérkezett, azóta soha
 * nem kézbesített lifecycle-esemény így NEM kapott lábat.
 *
 * A korábbi teszt ezt NEM fogta meg, mert `received: 1, received_7d: 6`-tal dolgozott —
 * vagyis szándékosan volt 24 órás kulcs is.
 */
describe('#71 HIGH — a CSAK 7 napos ablakban létező láb is megszületik', () => {
  const noBlock = () => null;

  it('0 esemény 24h-ban, 4 esemény 7 napban, 0 accepted valaha → CRITICAL', () => {
    const legs = assembleOfflineLegs(
      [], // received24: ÜRES — az elmúlt 24 órában nem jött lifecycle-esemény
      [{ site_id: 'painless', event_name: 'revenue_confirmed', received: 4 }],
      [],
      [],
      [],
      noBlock
    );
    const siteLegs = legs.get('painless');
    expect(siteLegs, 'nem született láb a csak-7-napos kulcsból').toBeDefined();
    expect(siteLegs).toHaveLength(1);

    const l = siteLegs![0];
    // A hiányzó 24 órás érték NULLA, nem a 7 napos — különben a regresszió-detektor
    // is elsülne, holott az elmúlt 24 órában nincs mit várni.
    expect(l.received).toBe(0);
    expect(l.received_7d).toBe(4);
    expect(deriveOfflineState(l)).toBe('UNARMED');

    const kinds = computeOfflineDrift(l).map((f) => f.kind);
    expect(kinds).toContain('offline_zero_delivery');
    expect(computeOfflineDrift(l)[0].detail).toContain('MEG SOHA');
  });

  it('a 24 órás és a csak-7-napos kulcsok EGYÜTT jönnek ki (unió, nem felülírás)', () => {
    const legs = assembleOfflineLegs(
      [{ site_id: 'painless', event_name: 'lead_qualified', received: 2 }],
      [
        { site_id: 'painless', event_name: 'lead_qualified', received: 5 },
        { site_id: 'painless', event_name: 'revenue_confirmed', received: 4 }
      ],
      [],
      [],
      [],
      noBlock
    );
    const names = legs.get('painless')!.map((l) => l.event_name);
    expect(names).toContain('lead_qualified');
    expect(names).toContain('revenue_confirmed');
    expect(names).toHaveLength(2);
  });

  it('a csak-7-napos láb is tiszteli a dependency-állapotgépet', () => {
    // Blokkolt előfeltétel → nincs finding, akkor sem, ha a 7 napos ablakban lenne minta.
    const legs = assembleOfflineLegs(
      [],
      [{ site_id: 'painless', event_name: 'revenue_confirmed', received: 9 }],
      [],
      [],
      [],
      () => 'oauth_secret_missing' as const
    );
    const l = legs.get('painless')![0];
    expect(deriveOfflineState(l)).toBe('BLOCKED_DEPENDENCY');
    expect(computeOfflineDrift(l)).toEqual([]);
  });
});

/**
 * 2026-08-24 Codex-review a #71 hotfixen — P2.
 *
 * A `monitoring`-szűrő kapcsolója KIZÁRÓLAG a felsorolás TELJESSÉGE lehet, nem a lista
 * HOSSZA. Egy sikeres felsorolás is adhat üres listát — akkor, ha MINDEN site
 * `monitoring: false`. Az „üres → ne szűrj" szabály ilyenkor pont a kifejezetten
 * kikapcsolt site-okat engedné vissza, és a történelmi lead_status soraikból a 7 napos
 * kulcs-unión át hamis `offline_zero_delivery` keletkezne.
 *
 * Ez a rés a KULCS-UNIÓ FIXSZEL LETT SÚLYOSABB: előtte egy `monitoring: false` site
 * 24 órás sor híján lábat sem kapott.
 *
 * A tesztek a VALÓDI hívási ponton mennek át (`fetchReconInputs`), nem a szabály
 * újrafogalmazásán: egy szabály-restatement teszt akkor is zöld maradna, ha a
 * tényleges kifejezés elromlik.
 */
describe('#71 Codex P2 — a szűrő kapcsolója a TELJESSÉG, nem a lista hossza', () => {
  /** Egy site-nak VAN 7 napos lifecycle-sora, de 24 órás nincs, és sosem volt accepted. */
  function ledgerWithHistoricalLifecycle() {
    const rows = (sql: string) => {
      if (sql.includes('AS received')) {
        return { results: [{ site_id: 'dummy-site', event_name: 'revenue_confirmed', received: 6 }] };
      }
      return { results: [] };
    };
    return {
      prepare: (sql: string) => ({
        bind: () => ({ all: async () => rows(sql) }),
        all: async () => rows(sql)
      })
    };
  }

  const env = () => ({ LEDGER: ledgerWithHistoricalLifecycle() }) as any;
  const SINCE = '2026-08-23T00:00:00.000Z';

  it('TELJES felsorolás + ÜRES lista (minden site monitoring:false) → NINCS láb, nincs finding', async () => {
    // Ez a rés: az „üres → ne szűrj" szabály a kifejezetten KIKAPCSOLT site-ot engedte
    // vissza, és a történelmi sorából hamis offline_zero_delivery keletkezett volna.
    const inputs = await fetchReconInputs(env(), SINCE, [], true);
    expect(inputs).not.toBeNull();
    expect(inputs!.flatMap((i) => i.offline_legs ?? [])).toEqual([]);
    expect(summarize(inputs!).findings).toEqual([]);
  });

  it('NEM teljes felsorolás + üres lista → a láb MEGSZÜLETIK (a csend rosszabb)', async () => {
    const inputs = await fetchReconInputs(env(), SINCE, [], false);
    const legs = inputs!.flatMap((i) => i.offline_legs ?? []);
    expect(legs).toHaveLength(1);
    expect(legs[0].site_id).toBe('dummy-site');
    // …és a 7 napos abszolút detektor szól rá.
    expect(computeOfflineDrift(legs[0]).map((f) => f.kind)).toContain('offline_zero_delivery');
  });

  it('TELJES felsorolás + a site RAJTA VAN a listán → a láb megszületik', async () => {
    const cfg = { site_id: 'dummy-site', country_code: 'HU', currency: 'HUF' } as any;
    const inputs = await fetchReconInputs(env(), SINCE, [cfg], true);
    expect(inputs!.flatMap((i) => i.offline_legs ?? [])).toHaveLength(1);
  });

  it('TELJES felsorolás + MÁS site van a listán → a láb kimarad', async () => {
    const cfg = { site_id: 'masik', country_code: 'HU', currency: 'HUF' } as any;
    const inputs = await fetchReconInputs(env(), SINCE, [cfg], true);
    expect(inputs!.flatMap((i) => i.offline_legs ?? [])).toEqual([]);
  });
});
