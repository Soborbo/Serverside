import { describe, it, expect } from 'vitest';
import {
  computeSiteDrift,
  assembleReconInputs,
  summarize,
  DEFAULT_THRESHOLDS,
  type SiteReconInput
} from '../src/lib/reconciliation';

/**
 * vNext P1 — RECONCILIATION BUSINESS-LEG: a MAI VAKSÁG rögzítése.
 *
 * ⚠️ EZ EGY SZÁNDÉKOSAN „FORDÍTOTT" TESZTFÁJL. Nem azt bizonyítja, hogy a kód JÓ —
 * azt bizonyítja, hogy a kód MA VAK, méghozzá pontosan hol. A P1 implementációjakor
 * ezeket az elvárásokat MEG KELL FORDÍTANI (a `docs/vnext-P1-reconciliation-business-leg.md`
 * mindegyikhez megadja, melyik findingnek kell megszületnie). Ha valaki a P1-et
 * megvalósítja és ez a fájl VÁLTOZATLANUL zöld marad, akkor az implementáció nem ér
 * a lényegig.
 *
 * A bizonyítandó állítás (a terv „RED TEST"-je): egy szándékosan KIKAPCSOLT Google
 * offline-láb mellett a mai reconciliation ZÖLDEN megy át. Három, egymástól független
 * szerkezeti ok teszi vakká — mindhárom külön teszt alább.
 */

const NO_DELIVERIES = (): SiteReconInput['platforms'] => [
  { platform: 'meta', accepted: 60, rejected: 0, skipped: 0 },
  { platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 },
  { platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 },
  { platform: 'msads', accepted: 0, rejected: 0, skipped: 0 }
];

describe('P1 RED — a halott Google offline-láb MA nem termel findingot', () => {
  it('50 lead_status érkezett, NULLA offline kézbesítés → ZÉRÓ finding (ez a hiba)', () => {
    const input: SiteReconInput = {
      site_id: 'painless',
      events_total: 80,
      ad_eligible: 60,
      // A CRM 50 lifecycle-státuszt küldött be. Ez a mező LÉTEZIK és FELTÖLTŐDIK
      // (lib/reconciliation.ts:35 + :249), de SENKI NEM OLVASSA — holt súly.
      lead_status_total: 50,
      platforms: NO_DELIVERIES()
    };

    const findings = computeSiteDrift(input, DEFAULT_THRESHOLDS);

    // MA: üres. Az 50 beérkezett üzleti esemény mellé nulla Google-feltöltés
    // tartozik, és a monitor zöld.
    expect(findings).toEqual([]);
    expect(summarize([input]).worst).toBe('none');

    // P1 UTÁN ITT ENNEK KELL ÁLLNIA:
    //   expect(findings.map(f => f.kind)).toContain('offline_zero_delivery');
    //   expect(summarize([input]).worst).toBe('critical');
  });

  it('OK #1 — a `lead_status_total` bekerül a structba, de egyetlen számítás sem használja', () => {
    const withLeads: SiteReconInput = {
      site_id: 'painless',
      events_total: 80,
      ad_eligible: 60,
      lead_status_total: 500,
      platforms: NO_DELIVERIES()
    };
    const withoutLeads: SiteReconInput = { ...withLeads, lead_status_total: 0 };

    // 500 üzleti esemény vagy 0 — a kimenet BITRE UGYANAZ. Ez a bizonyíték arra,
    // hogy a mező holt súly: az üzleti darabszám nem befolyásol semmit.
    expect(computeSiteDrift(withLeads)).toEqual(computeSiteDrift(withoutLeads));
  });

  it('OK #2 — a `gads` platform ki sem kerül a PlatformCounts-ba, tehát nincs mit mérni', () => {
    const inputs = assembleReconInputs(
      [{ site_id: 'painless', total: 80, ad_eligible: 60 }],
      [
        { site_id: 'painless', platform: 'meta', accepted: 60, rejected: 0, skipped: 0 },
        // Még ha a lekérdezés vissza IS adna gads-sorokat, az összefésülés eldobja:
        // a PLATFORMS lista (lib/reconciliation.ts:214) nem tartalmazza a 'gads'-ot.
        { site_id: 'painless', platform: 'gads', accepted: 0, rejected: 40, skipped: 0 }
      ],
      [{ site_id: 'painless', total: 50 }]
    );

    const platforms = inputs[0].platforms.map((p) => p.platform);
    expect(platforms).not.toContain('gads');
    // …és így a 40 elbukott Google-feltöltés vendor_failure_rate-je sem születik meg.
    expect(computeSiteDrift(inputs[0])).toEqual([]);

    // P1 UTÁN: a 'gads' offline lábnak SAJÁT alapja legyen (lead_status), nem a
    // böngésző-fan-out ad_eligible-je — lásd a tervdokumentum §2.1-ét.
  });

  it('OK #3 — a coverage-alap csak a Metára van értelmezve, más platform null-t kap', () => {
    // A COVERAGE_PLATFORMS = {'meta'} SZÁNDÉKOS és HELYES a böngésző-fan-outra
    // (a forwarderek csak click-ID jelenlétében tüzelnek). A hiba az, hogy az
    // OFFLINE lábnak emiatt EGYÁLTALÁN NINCS coverage-fogalma — nem az, hogy a
    // Meta-formula rossz. Ezért a P1 NEM az ad_eligible-t terjeszti ki a gads-ra.
    const input: SiteReconInput = {
      site_id: 'painless',
      events_total: 80,
      ad_eligible: 60,
      lead_status_total: 50,
      platforms: [
        { platform: 'meta', accepted: 60, rejected: 0, skipped: 0 },
        { platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'msads', accepted: 0, rejected: 0, skipped: 0 }
      ]
    };
    // A nulla-kézbesítésű forwarderek NEM adnak hamis 0%-os coverage_drift-et…
    expect(computeSiteDrift(input)).toEqual([]);
    // …de ugyanez a mechanizmus némítja el az offline lábat is.
  });
});

describe('P1 RED — a config-hiány és a consent-tiltás ma megkülönböztethetetlen', () => {
  it('a skipped kivonódik a coverage-alapból, tehát a TELJESEN skipped láb néma', () => {
    // A kivonás önmagában helyes (egy szándékosan meta-nélküli site ne riasszon
    // minden nap). A következménye viszont: egy 100%-ban skipped láb alapja 0-ra
    // esik, a minSample-őr elnémítja, és a „minden kimaradt" ugyanúgy néz ki, mint
    // a „nincs is ilyen láb". Az offline oldalon EZT kell szétválasztania a
    // P1 `offline_config_missing` findingnek.
    const allSkipped: SiteReconInput = {
      site_id: 'lomtalan',
      events_total: 60,
      ad_eligible: 60,
      lead_status_total: 0,
      platforms: [
        { platform: 'meta', accepted: 0, rejected: 0, skipped: 60 },
        { platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'msads', accepted: 0, rejected: 0, skipped: 0 }
      ]
    };
    expect(computeSiteDrift(allSkipped)).toEqual([]);
  });
});

describe('P1 — amit a business-leg NEM ronthat el (regressziós korlátok)', () => {
  it('a MEGLÉVŐ Meta coverage_drift és vendor_failure_rate változatlanul működik', () => {
    // Ezt a két findinget a P1 nem érintheti — a business-leg ÚJ láb a meglévő
    // computeSiteDrift-ben, nem a Meta-formula átírása.
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

  it('a minSample-őr megmarad: apró mintán NINCS riasztás', () => {
    const tiny: SiteReconInput = {
      site_id: 'newsite',
      events_total: 2,
      ad_eligible: 2,
      lead_status_total: 1,
      platforms: [
        { platform: 'meta', accepted: 0, rejected: 1, skipped: 0 },
        { platform: 'tiktok', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'linkedin', accepted: 0, rejected: 0, skipped: 0 },
        { platform: 'msads', accepted: 0, rejected: 0, skipped: 0 }
      ]
    };
    expect(computeSiteDrift(tiny)).toEqual([]);
  });
});
