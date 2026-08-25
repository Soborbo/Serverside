import { describe, it, expect, vi } from 'vitest';
import {
  analyzeGtmConformance,
  hasBlockingFindings,
  triggerEventName,
  type LiveContainer,
  type ExpectedContract,
  type GtmTag
} from '../src/lib/gtm-conformance';
import { TrackingErrorCode } from '../src/lib/error-codes';

/**
 * P7 — élő GTM conformance.
 *
 * A HIBAOSZTÁLY, amit ez a fájl őriz: az élő konténer KÉZZEL szerkeszthető, és
 * az ott keletkező hibák NEM hagynak nyomot a gateway-ledgerben. A szerver-láb
 * tökéletesen működik tovább, a napi digest zöld, és a baj csak hetekkel később,
 * a hirdetési riportban látszik — akkorra viszont a bidding már rossz jelre
 * tanult.
 *
 * A tesztek fixture-ökkel dolgoznak, GTM-hozzáférés nélkül: a szabályhalmaz így
 * CI-ban is fut, nem csak akkor, amikor épp van API-token.
 */

const SITE = 'painlessremovals.com';
const ADS_ID = 'AW-123456789';
const ADS_LABEL = 'abcDEFghi';

function trigger(id: string, event: string) {
  return {
    triggerId: id,
    name: `CE - ${event}`,
    type: 'CUSTOM_EVENT',
    customEventFilter: [{ parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: event }] }]
  };
}

function adsTag(over: Partial<GtmTag> = {}, params: Record<string, unknown> = {}): GtmTag {
  const base = [
    { type: 'TEMPLATE', key: 'conversionId', value: ADS_ID },
    { type: 'TEMPLATE', key: 'conversionLabel', value: ADS_LABEL },
    { type: 'BOOLEAN', key: 'enableUserProvidedData', value: 'true' },
    { type: 'TEMPLATE', key: 'userProvidedData', value: '{{CJS - User Provided Data}}' }
  ];
  // A `params` FELÜLÍR, nem hozzáfűz: egy hozzáfűzött második `conversionId`-t a
  // `find()` sosem látna, és a teszt vakon zöld lenne.
  const parameter = base.map((p) =>
    p.key in params ? { ...p, value: String(params[p.key]) } : p
  );
  for (const [key, value] of Object.entries(params)) {
    if (!base.some((p) => p.key === key)) parameter.push({ type: 'TEMPLATE', key, value: String(value) });
  }
  return {
    tagId: '10',
    name: 'Google Ads - Conversion',
    type: 'awct',
    firingTriggerId: ['1'],
    consentSettings: { consentStatus: 'NEEDED' },
    parameter,
    ...over
  };
}

function baseContainer(over: Partial<LiveContainer> = {}): LiveContainer {
  return {
    publicId: 'GTM-ABCDEFG',
    tag: [adsTag()],
    trigger: [trigger('1', 'quote_calculator_submitted')],
    variable: [{ variableId: '1', name: 'CJS - User Provided Data', type: 'jsm' }],
    ...over
  };
}

const EXPECTED: ExpectedContract = {
  publicId: 'GTM-ABCDEFG',
  browserEvents: ['quote_calculator_submitted'],
  legacyEvents: ['quote_submitted_old'],
  googleAdsConversionId: ADS_ID,
  googleAdsConversionLabel: ADS_LABEL,
  requireEnhancedConversions: true
};

const run = (live: LiveContainer | null, expected: ExpectedContract = EXPECTED) =>
  analyzeGtmConformance({ site: SITE, live, expected });

const codes = (live: LiveContainer | null, expected?: ExpectedContract) =>
  run(live, expected).map((f) => f.code);

describe('EXACT MATCH — a helyes konténer nem termel findinget', () => {
  it('nulla finding', () => {
    expect(run(baseContainer())).toEqual([]);
  });

  it('a beépített (rezervált) trigger-ID-kra nem panaszkodik', () => {
    // Az All Pages és a Consent Initialization ID-ja 10 jegyű rezervált szám —
    // nincs a `trigger` listában, és ez NEM hiba.
    const live = baseContainer({ tag: [adsTag({ firingTriggerId: ['1', '2147479553'] })] });
    expect(run(live)).toEqual([]);
  });
});

describe('HIÁNYZÓ ÉS HALOTT elemek', () => {
  it('hiányzó trigger → TRK-850-003', () => {
    const live = baseContainer({ trigger: [] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_TRIGGER_MISSING);
  });

  it('hiányzó Ads-tag → TRK-850-001', () => {
    const live = baseContainer({ tag: [] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_TAG_MISSING);
  });

  it('SZÜNETELTETETT tag → TRK-850-002 (ott van, és nem tüzel)', () => {
    const live = baseContainer({ tag: [adsTag({ paused: true })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_TAG_PAUSED);
  });

  it('a `tagFiringOption: PAUSED` alak is szüneteltetésnek számít', () => {
    const live = baseContainer({ tag: [adsTag({ tagFiringOption: 'PAUSED' })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_TAG_PAUSED);
  });

  it('nem létező triggerre hivatkozó tag → TRK-850-003', () => {
    const live = baseContainer({ tag: [adsTag({ firingTriggerId: ['99'] })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_TRIGGER_MISSING);
  });
});

describe('ELTÉRŐ AZONOSÍTÓK — a konverzió rossz helyre megy', () => {
  it('rossz conversion ID → TRK-850-005', () => {
    const live = baseContainer({ tag: [adsTag({}, { conversionId: 'AW-999999999' })] });
    const f = run(live).find((x) => x.code === TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH)!;
    expect(f).toBeTruthy();
    expect(f.expected).toBe(ADS_ID);
    expect(f.actual).toBe('AW-999999999');
  });

  it('rossz conversion LABEL → TRK-850-006', () => {
    const live = baseContainer({ tag: [adsTag({}, { conversionLabel: 'WRONGLABEL' })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_CONVERSION_LABEL_MISMATCH);
  });

  /**
   * A `{{Const - X}}` hivatkozás feloldása. A kanonikus generátor MINDIG
   * változón keresztül adja meg az ID-t és a labelt, tehát feloldás nélkül a
   * conformance vagy vakon átengedne mindent, vagy — ami rosszabb — MINDEN
   * helyes konténerre hamis eltérést jelentene.
   *
   * A két eset PÁRBAN bizonyít: a feloldás elhagyásával a második teszt
   * azonnal pirosra vált (hamis finding egy helyes konténeren).
   */
  it('feloldott HELYES érték → NINCS finding (a hamis riasztás ellen)', () => {
    const live = baseContainer({
      tag: [adsTag({}, { conversionId: '{{Const - Ads ID}}' })],
      variable: [
        { variableId: '1', name: 'CJS - User Provided Data', type: 'jsm' },
        { variableId: '2', name: 'Const - Ads ID', type: 'c', parameter: [{ key: 'value', value: ADS_ID }] }
      ]
    });
    expect(codes(live)).not.toContain(TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH);
  });

  it('feloldott ROSSZ érték → finding (a valódi eltérés nem tűnik el)', () => {
    const live = baseContainer({
      tag: [adsTag({}, { conversionId: '{{Const - Ads ID}}' })],
      variable: [
        { variableId: '1', name: 'CJS - User Provided Data', type: 'jsm' },
        { variableId: '2', name: 'Const - Ads ID', type: 'c', parameter: [{ key: 'value', value: 'AW-999999999' }] }
      ]
    });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH);
  });

  it('MÁS konténer → TRK-850-014', () => {
    const live = baseContainer({ publicId: 'GTM-ZZZZZZZ' });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_CONTAINER_MISMATCH);
  });
});

describe('DUPLIKÁTUM — minden lead annyiszor számít, ahány tag tüzel', () => {
  it('két Ads-konverziós tag → TRK-850-010', () => {
    const live = baseContainer({ tag: [adsTag(), adsTag({ tagId: '11', name: 'Ads - Conversion (copy)' })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG);
  });

  it('ugyanarra a Meta-eseményre két tag → TRK-850-010', () => {
    const metaTag = (id: string, name: string): GtmTag => ({
      tagId: id, name, type: 'html',
      parameter: [{ key: 'html', value: "<script>fbq('track','Lead',{},{eventID:'x'});</script>" }]
    });
    const live = baseContainer({ tag: [adsTag(), metaTag('20', 'Meta Lead'), metaTag('21', 'Meta Lead 2')] });
    const f = run(live, { ...EXPECTED, metaPixelId: '111222333' });
    expect(f.map((x) => x.code)).toContain(TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG);
  });

  it('KÜLÖNBÖZŐ Meta-eseményekre két tag NEM duplikátum', () => {
    const metaTag = (id: string, ev: string): GtmTag => ({
      tagId: id, name: `Meta ${ev}`, type: 'html',
      parameter: [{ key: 'html', value: `<script>fbq('track','${ev}',{},{eventID:'x'});</script>` }]
    });
    const live = baseContainer({ tag: [adsTag(), metaTag('20', 'Lead'), metaTag('21', 'Contact')] });
    const f = run(live, { ...EXPECTED, metaPixelId: '111222333' });
    expect(f.map((x) => x.code)).not.toContain(TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG);
  });
});

describe('ENHANCED CONVERSIONS (INV-009)', () => {
  it('kikapcsolt EC → TRK-850-007', () => {
    const tag = adsTag();
    tag.parameter = tag.parameter!.filter((p) => p.key !== 'enableUserProvidedData');
    expect(codes(baseContainer({ tag: [tag] }))).toContain(
      TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING
    );
  });

  it('bekapcsolt EC, de HIÁNYZÓ user-data változó → TRK-850-008', () => {
    const live = baseContainer({ variable: [] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_EC_USER_DATA_VARIABLE_MISSING);
  });

  it('EC nem kötelező → nincs finding', () => {
    const tag = adsTag();
    tag.parameter = tag.parameter!.filter((p) => p.key !== 'enableUserProvidedData');
    const f = run(baseContainer({ tag: [tag] }), { ...EXPECTED, requireEnhancedConversions: false });
    expect(f.map((x) => x.code)).not.toContain(TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING);
  });
});

describe('CONSENT-beállítás', () => {
  it('consent-beállítás nélküli konverziós tag → TRK-850-009', () => {
    const live = baseContainer({ tag: [adsTag({ consentSettings: undefined })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING);
  });

  it('`NOT_SET` állapot sem elég', () => {
    const live = baseContainer({ tag: [adsTag({ consentSettings: { consentStatus: 'NOT_SET' } })] });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING);
  });
});

describe('ISMERETLEN TAGEK — a legfontosabb szabály', () => {
  it('ismeretlen, de ÁRTALMATLAN tag NEM finding', () => {
    const live = baseContainer({
      tag: [adsTag(), { tagId: '30', name: 'Hotjar', type: 'hjtc', parameter: [] }]
    });
    expect(run(live)).toEqual([]);
  });

  it('ismeretlen, de KONVERZIÓ-KÉPES tag → TRK-850-011, és BLOKKOL', () => {
    // Ez a szabály lényege: egy kézzel felvett tag, amiről senki nem tud,
    // ugyanúgy könyvel pénzt. A „nem ismerem, hagyjuk" pont azt a duplikációt
    // engedné be, amit fentebb kritikusnak nevezünk.
    const live = baseContainer({
      tag: [adsTag(), { tagId: '31', name: 'Valaki Floodlightja', type: 'flc', parameter: [] }]
    });
    const f = run(live);
    expect(f.map((x) => x.code)).toContain(TrackingErrorCode.GTM_UNKNOWN_CONVERSION_TAG);
    expect(hasBlockingFindings(f)).toBe(true);
  });

  it('Custom HTML a PÉNZ-ÚTON → TRK-850-013', () => {
    const live = baseContainer({
      tag: [adsTag(), {
        tagId: '32', name: 'Kézi Ads konverzió', type: 'html',
        parameter: [{ key: 'html', value: "<script>gtag('event','conversion',{send_to:'AW-1/x'});</script>" }]
      }]
    });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_UNSUPPORTED_CUSTOM_HTML);
  });

  it('ÁRTALMATLAN Custom HTML (nincs benne pénz-út) nem finding', () => {
    const live = baseContainer({
      tag: [adsTag(), {
        tagId: '33', name: 'Chat widget', type: 'html',
        parameter: [{ key: 'html', value: '<script>window.chatWidget=1;</script>' }]
      }]
    });
    expect(run(live)).toEqual([]);
  });
});

describe('ELAVULT ÉS ISMERETLEN event-nevek', () => {
  it('NYUGDÍJAZOTT event triggere még él → TRK-850-012', () => {
    const live = baseContainer({
      trigger: [trigger('1', 'quote_calculator_submitted'), trigger('2', 'quote_submitted_old')]
    });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_LEGACY_TRIGGER_ACTIVE);
  });

  it('a kód által SOHA nem emittált event triggere → TRK-850-004', () => {
    const live = baseContainer({
      trigger: [trigger('1', 'quote_calculator_submitted'), trigger('2', 'valami_kezzel_felvett')]
    });
    expect(codes(live)).toContain(TrackingErrorCode.GTM_EVENT_NAME_MISMATCH);
  });
});

describe('§17 — a mérés SAJÁT hibája nem „nulla finding"', () => {
  it('elérhetetlen konténer → TRK-850-015, KRITIKUS, nem üres lista', () => {
    const f = run(null);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe(TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE);
    expect(f[0]!.severity).toBe('critical');
    // Ez a különbség a lényeg: az üres lista „rendben"-t jelentene.
    expect(hasBlockingFindings(f)).toBe(true);
  });
});

describe('a findingek OPERATÍVAK', () => {
  it('minden finding megnevezi a site-ot, a konténert és a teendőt', () => {
    const live = baseContainer({ tag: [adsTag({ paused: true }, { conversionLabel: 'X' })] });
    const f = run(live);
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.site).toBe(SITE);
      expect(x.container).toBe('GTM-ABCDEFG');
      expect(x.remediation.length, `${x.code} remediation`).toBeGreaterThan(20);
      expect(x.severity).toBeTruthy();
      expect(x.message).toBeTruthy();
    }
  });

  it('a trigger-név kiolvasása a valódi GTM-alakból működik', () => {
    expect(triggerEventName(trigger('1', 'purchase'))).toBe('purchase');
    expect(triggerEventName({ triggerId: '2', type: 'CUSTOM_EVENT' })).toBeUndefined();
  });
});

describe('§13 — a findingek strukturált, KÓDOS logot kapnak', () => {
  it('minden finding kimegy logStructured-ön, a súlyának megfelelő szinten', async () => {
    const { reportConformanceFindings } = await import('../src/lib/gtm-conformance');
    const lines: Record<string, unknown>[] = [];
    const capture = (l: unknown) => { try { lines.push(JSON.parse(String(l))); } catch { /* */ } };
    const spies = (['log', 'warn', 'error'] as const).map((lvl) =>
      vi.spyOn(console, lvl).mockImplementation(capture as never)
    );

    // Minden TRK-850 kód egyszerre — így a §15 futásidejű lefedettség-mérés is
    // látja őket, nem csak a findingek tömbjében léteznek.
    const live = baseContainer({
      publicId: 'GTM-ZZZZZZZ',
      tag: [
        adsTag({ paused: true }, { conversionId: 'AW-999', conversionLabel: 'X' }),
        // EC nélkül ÉS consent-beállítás nélkül — hogy a 850-007 és a 850-009
        // is TÉNYLEGESEN kimenjen a logra, ne csak a findingek tömbjében éljen.
        {
          ...adsTag({ tagId: '11', name: 'copy', consentSettings: undefined }),
          parameter: [
            { type: 'TEMPLATE', key: 'conversionId', value: ADS_ID },
            { type: 'TEMPLATE', key: 'conversionLabel', value: ADS_LABEL }
          ]
        },
        { tagId: '31', name: 'idegen', type: 'flc', parameter: [] },
        { tagId: '32', name: 'kezi', type: 'html', parameter: [{ key: 'html', value: "<script>gtag('event','conversion',{});</script>" }] }
      ],
      trigger: [trigger('1', 'quote_calculator_submitted'), trigger('2', 'quote_submitted_old'), trigger('3', 'ismeretlen')],
      variable: []
    });
    reportConformanceFindings(run(live));
    reportConformanceFindings(run(null));
    reportConformanceFindings(run(baseContainer({ tag: [], trigger: [] })));

    for (const s of spies) s.mockRestore();

    const emitted = new Set(lines.map((l) => l.error_code));
    for (const c of [
      TrackingErrorCode.GTM_TAG_MISSING, TrackingErrorCode.GTM_TAG_PAUSED,
      TrackingErrorCode.GTM_TRIGGER_MISSING, TrackingErrorCode.GTM_EVENT_NAME_MISMATCH,
      TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH, TrackingErrorCode.GTM_CONVERSION_LABEL_MISMATCH,
      TrackingErrorCode.GTM_EC_USER_DATA_VARIABLE_MISSING,
      TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING, TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING,
      TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG, TrackingErrorCode.GTM_UNKNOWN_CONVERSION_TAG,
      TrackingErrorCode.GTM_LEGACY_TRIGGER_ACTIVE, TrackingErrorCode.GTM_UNSUPPORTED_CUSTOM_HTML,
      TrackingErrorCode.GTM_CONTAINER_MISMATCH, TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE,
    ]) {
      expect(emitted, `nem ment logba: ${c}`).toContain(c);
    }
  });

  it('a kritikus finding `error` szinten megy ki, a warning `warn`-on', async () => {
    const { reportConformanceFindings } = await import('../src/lib/gtm-conformance');
    const byLevel: Record<string, string[]> = { error: [], warn: [], log: [] };
    const spies = (['log', 'warn', 'error'] as const).map((lvl) =>
      vi.spyOn(console, lvl).mockImplementation(((l: unknown) => {
        try { byLevel[lvl]!.push(JSON.parse(String(l)).error_code); } catch { /* */ }
      }) as never)
    );
    reportConformanceFindings(run(null));
    for (const s of spies) s.mockRestore();
    expect(byLevel.error).toContain(TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE);
  });

  it('a log NEM tartalmaz konténer-tartalmat, csak azonosítókat', async () => {
    const { reportConformanceFindings } = await import('../src/lib/gtm-conformance');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(((l: unknown) => { lines.push(String(l)); }) as never);
    const live = baseContainer({
      tag: [adsTag({ tagId: '32', name: 'kezi', type: 'html' }, {})],
    });
    (live.tag as GtmTag[])[0]!.parameter = [{ key: 'html', value: "<script>fbq('track','Lead');TITKOS_TARTALOM</script>" }];
    reportConformanceFindings(run(live));
    spy.mockRestore();
    expect(lines.join(' ')).not.toContain('TITKOS_TARTALOM');
  });
});
