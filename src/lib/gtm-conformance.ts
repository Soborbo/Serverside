import { TrackingErrorCode, ERROR_DESCRIPTIONS, ERROR_SEVERITY, type ErrorSeverity } from './error-codes';
import { logStructured } from '../types';

/**
 * P7 — ÉLŐ GTM conformance (READ-ONLY).
 *
 * A HIBAOSZTÁLY. A repóban eddig a `gtm/container.json` volt az igazság — de az
 * a COMMITTOLT artefakt, nem az, ami a látogató böngészőjében fut. Az élő
 * konténer kézzel szerkeszthető, és pont ott keletkeznek a legdrágább néma
 * hibák:
 *
 *   • valaki szüneteltet egy konverziós taget  → a tag OTT VAN, és nem tüzel
 *   • elír egy conversion label-t              → a konverzió MÁS akcióra megy
 *   • felvesz egy második Ads-taget            → minden lead KÉTSZER számít
 *   • kikapcsolja az Enhanced Conversions-t    → a match rate csendben leesik
 *
 * Egyik sem hagy nyomot a gateway-ledgerben: a szerver-láb tökéletesen működik
 * tovább, a napi digest zöld, és a hiba csak hetekkel később, a hirdetési
 * riportban látszik — akkorra viszont a bidding már rossz jelre tanult.
 *
 * READ-ONLY. Ez a modul SEMMIT nem ír vissza a GTM-be. Az élő konténer
 * automatikus átírása pont annak a kézi szerkeszthetőségnek a párja lenne,
 * amit itt mérünk — előbb látni akarjuk, mi történik, csak utána nyúlni bele.
 *
 * TISZTA FÜGGVÉNY. A modul nem hálózik: kap egy élő konténer-objektumot és egy
 * elvárás-leírást, és findingeket ad vissza. A beszerzés (GTM API vagy kézi
 * export) a hívó dolga — így a teljes szabályhalmaz fixture-ökkel tesztelhető,
 * GTM-hozzáférés nélkül.
 */

// ── Az élő konténer minimális alakja (GTM export format v2) ──────────

export interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
  list?: unknown[];
  map?: unknown[];
}

export interface GtmTag {
  tagId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
  firingTriggerId?: string[];
  /** A GTM a szüneteltetést a `paused` mezőben jelöli. */
  paused?: boolean;
  tagFiringOption?: string;
  consentSettings?: { consentStatus?: string; consentType?: unknown };
}

export interface GtmTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  customEventFilter?: { parameter?: GtmParameter[] }[];
}

export interface GtmVariable {
  variableId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
}

export interface LiveContainer {
  publicId?: string;
  containerVersionId?: string;
  tag?: GtmTag[];
  trigger?: GtmTrigger[];
  variable?: GtmVariable[];
}

// ── Az ELVÁRÁS ───────────────────────────────────────────────────────

export interface ExpectedContract {
  /** Melyik konténernek KELL futnia ezen a site-on (GTM-XXXXXXX). */
  publicId?: string;
  /** A kódból ténylegesen emittált dataLayer event-nevek (events.json). */
  browserEvents: string[];
  /** Már NEM emittált, de korábban létezett event-nevek — ha élnek, drift. */
  legacyEvents?: string[];
  /** Google Ads: a site elvárt conversion ID-ja (AW-XXXXXXXXX). */
  googleAdsConversionId?: string;
  /** Google Ads: az elvárt conversion label. */
  googleAdsConversionLabel?: string;
  /** Kötelező-e az Enhanced Conversions (INV-009: Ads-es site-on IGEN). */
  requireEnhancedConversions?: boolean;
  /** Meta pixel-azonosító, ha a site-on van Meta-láb. */
  metaPixelId?: string;
  /**
   * A KANONIKUS Custom HTML tagek nevei (pl. a generátor Meta-pixel tagjei).
   *
   * A Custom HTML önmagában nem tiltott — a generátor maga is használja a Meta
   * pixelhez, mert arra nincs natív GTM-tagtípus. A finding tehát nem a
   * technikára szól, hanem arra, hogy egy pénz-utat érintő Custom HTML tag
   * NEM SZEREPEL a kanonikus készletben: azt kézzel vették fel, senki nem
   * birtokolja, és nincs verziózva.
   */
  allowedCustomHtmlTags?: string[];
}

export interface ConformanceFinding {
  code: TrackingErrorCode;
  severity: ErrorSeverity;
  message: string;
  site: string;
  container: string;
  /** A tag/trigger/variable azonosítója, ha értelmezhető. */
  objectId?: string;
  objectName?: string;
  expected?: string;
  actual?: string;
  remediation: string;
}

/**
 * KONVERZIÓ-KÉPES tagtípusok — amik pénzt tudnak könyvelni.
 *
 * `awct` = Google Ads Conversion Tracking, `gaawe` = GA4 event (key event
 * lehet), `sp`/`flc` = Floodlight. A Custom HTML külön ág: az önmagában nem
 * konverzió-képes, de bármit tartalmazhat — ezért tartalom szerint vizsgáljuk.
 */
const CONVERSION_CAPABLE_TYPES = new Set(['awct', 'gaawe', 'sp', 'flc', 'awc']);

/**
 * A pénz-utat érintő minták egy Custom HTML tagben.
 *
 * SZÁNDÉKOSAN SZŰK. A puszta `fbq(` a Meta pixel INICIALIZÁLÁSÁRA is illeszkedne
 * (`fbq('init', …)`), ami nem konverzió; a puszta `gtag(` pedig minden
 * config-hívásra. Egy ilyen tág minta minden konténerre zajt termelne, és a
 * hamis riasztás megtanítja az embert figyelmen kívül hagyni az igazit is.
 * Csak a ténylegesen konverziót könyvelő hívások számítanak.
 */
const MONEY_PATH_HTML =
  /(fbq\s*\(\s*['"]track['"]|gtag\s*\(\s*['"]event['"]\s*,\s*['"]conversion['"]|google_trackConversion|send_to\s*:)/;

function paramValue(obj: { parameter?: GtmParameter[] } | undefined, key: string): string | undefined {
  return obj?.parameter?.find((p) => p.key === key)?.value;
}

function paramBool(obj: { parameter?: GtmParameter[] } | undefined, key: string): boolean | undefined {
  const p = obj?.parameter?.find((x) => x.key === key);
  if (!p) return undefined;
  return p.value === 'true' || (p.value as unknown) === true;
}

/** A CUSTOM_EVENT trigger által figyelt event-név. */
export function triggerEventName(t: GtmTrigger): string | undefined {
  const f = t.customEventFilter?.[0];
  return f?.parameter?.find((p) => p.key === 'arg1')?.value;
}

function isPaused(tag: GtmTag): boolean {
  // A GTM export a szüneteltetést két néven is jelölheti a verziótól függően.
  return tag.paused === true || tag.tagFiringOption === 'PAUSED';
}

/**
 * A kifejtett `{{Const - X}}` hivatkozások feloldása a konténer változóiból —
 * enélkül minden ID/label-összevetés a `{{…}}` literálon bukna el, és sosem
 * derülne ki egy elírt érték.
 */
function resolveVars(value: string | undefined, container: LiveContainer): string | undefined {
  if (!value) return value;
  return value.replace(/\{\{([^}]+)\}\}/g, (whole, name: string) => {
    const v = container.variable?.find((x) => x.name === name);
    if (!v) return whole;
    return paramValue(v, 'value') ?? whole;
  });
}

export interface AnalyzeInput {
  site: string;
  live: LiveContainer | null;
  expected: ExpectedContract;
}

/**
 * A teljes conformance-elemzés. `live === null` → a mérés SAJÁT dependenciája
 * halt meg: ez NEM „nulla finding", hanem külön, kritikus jelzés (§17).
 */
export function analyzeGtmConformance(input: AnalyzeInput): ConformanceFinding[] {
  const { site, live, expected } = input;
  const findings: ConformanceFinding[] = [];
  const containerId = live?.publicId ?? 'unknown';

  const add = (
    code: TrackingErrorCode,
    detail: Partial<ConformanceFinding> & { remediation: string }
  ): void => {
    findings.push({
      code,
      severity: ERROR_SEVERITY[code],
      message: ERROR_DESCRIPTIONS[code],
      site,
      container: containerId,
      ...detail
    });
  };

  if (!live) {
    add(TrackingErrorCode.GTM_CONFORMANCE_UNAVAILABLE, {
      remediation:
        'Szerezd be az élő konténer-exportot (GTM API vagy kézi export), és futtasd újra. ' +
        'Amíg nincs adat, a site GTM-állapota UNKNOWN — nem „rendben".'
    });
    return findings;
  }

  // ── Konténer-azonosság ──────────────────────────────────────────────
  if (expected.publicId && live.publicId && expected.publicId !== live.publicId) {
    add(TrackingErrorCode.GTM_CONTAINER_MISMATCH, {
      expected: expected.publicId,
      actual: live.publicId,
      remediation: 'A site MÁS konténert tölt be, mint amit ellenőrzünk. Nézd meg a Tracking komponens gtmId propját.'
    });
  }

  const tags = live.tag ?? [];
  const triggers = live.trigger ?? [];
  const triggerById = new Map(triggers.map((t) => [t.triggerId ?? '', t]));

  // ── Trigger-lefedettség: minden emittált eventhez KELL trigger ───────
  const liveEventNames = new Map<string, GtmTrigger>();
  for (const t of triggers) {
    if (t.type !== 'CUSTOM_EVENT') continue;
    const name = triggerEventName(t);
    if (name) liveEventNames.set(name, t);
  }

  for (const ev of expected.browserEvents) {
    if (!liveEventNames.has(ev)) {
      add(TrackingErrorCode.GTM_TRIGGER_MISSING, {
        expected: ev,
        remediation: `Vegyél fel egy CUSTOM_EVENT triggert a(z) "${ev}" eseményre — enélkül a kód hiába pusholja.`
      });
    }
  }

  // Élő trigger, amit a kód SOHA nem emittál → holt vagy elavult.
  const expectedSet = new Set(expected.browserEvents);
  const legacySet = new Set(expected.legacyEvents ?? []);
  for (const [name, t] of liveEventNames) {
    if (expectedSet.has(name)) continue;
    const code = legacySet.has(name)
      ? TrackingErrorCode.GTM_LEGACY_TRIGGER_ACTIVE
      : TrackingErrorCode.GTM_EVENT_NAME_MISMATCH;
    add(code, {
      objectId: t.triggerId,
      objectName: t.name,
      actual: name,
      remediation: legacySet.has(name)
        ? `A(z) "${name}" event NYUGDÍJAZOTT, de a triggere még él. Töröld, vagy dokumentáld, miért marad.`
        : `A(z) "${name}" eventet a kód soha nem emittálja. Elírás, vagy egy kézzel felvett, nem kanonikus event.`
    });
  }

  // ── Google Ads konverziós tagek ─────────────────────────────────────
  const adsTags = tags.filter((t) => t.type === 'awct');

  if (expected.googleAdsConversionId) {
    if (adsTags.length === 0) {
      add(TrackingErrorCode.GTM_TAG_MISSING, {
        expected: 'Google Ads Conversion (awct)',
        remediation: 'A site-on Google Ads konverzió van beállítva, de a konténerben nincs awct tag — a böngésző-láb halott.'
      });
    }
    if (adsTags.length > 1) {
      add(TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG, {
        actual: `${adsTags.length} db awct tag: ${adsTags.map((t) => t.name).join(', ')}`,
        remediation: 'Minden lead ANNYISZOR számít, ahány tag tüzel. Hagyj EGYET, a többit töröld.'
      });
    }
  }

  for (const tag of adsTags) {
    const base = { objectId: tag.tagId, objectName: tag.name };

    if (isPaused(tag)) {
      add(TrackingErrorCode.GTM_TAG_PAUSED, {
        ...base,
        remediation: 'A tag ott van, és nem tüzel — a felületen „beállítottnak" látszik. Aktiváld, vagy töröld.'
      });
    }

    const id = resolveVars(paramValue(tag, 'conversionId'), live);
    if (expected.googleAdsConversionId && id && id !== expected.googleAdsConversionId) {
      add(TrackingErrorCode.GTM_CONVERSION_ID_MISMATCH, {
        ...base,
        expected: expected.googleAdsConversionId,
        actual: id,
        remediation: 'A konverziók MÁS Google Ads fiókba mennek. Javítsd a conversionId-t.'
      });
    }

    const label = resolveVars(paramValue(tag, 'conversionLabel'), live);
    if (expected.googleAdsConversionLabel && label && label !== expected.googleAdsConversionLabel) {
      add(TrackingErrorCode.GTM_CONVERSION_LABEL_MISMATCH, {
        ...base,
        expected: expected.googleAdsConversionLabel,
        actual: label,
        remediation: 'A konverziók MÁS akcióra könyvelődnek. Javítsd a conversionLabel-t.'
      });
    }

    if (expected.requireEnhancedConversions) {
      if (paramBool(tag, 'enableUserProvidedData') !== true) {
        add(TrackingErrorCode.GTM_ENHANCED_CONVERSIONS_MISSING, {
          ...base,
          remediation: 'INV-009: minden Google Ads-es site EC-kompatibilis. Kapcsold be az enableUserProvidedData-t.'
        });
      } else {
        const upd = paramValue(tag, 'userProvidedData');
        const varName = upd?.match(/^\{\{(.+)\}\}$/)?.[1];
        const exists = varName ? live.variable?.some((v) => v.name === varName) : false;
        if (!upd || !exists) {
          add(TrackingErrorCode.GTM_EC_USER_DATA_VARIABLE_MISSING, {
            ...base,
            actual: upd ?? '(nincs)',
            remediation: 'Az EC be van kapcsolva, de a user-data változó hiányzik vagy nincs bekötve — a match nem javul.'
          });
        }
      }
    }

    if (!tag.consentSettings || tag.consentSettings.consentStatus !== 'NEEDED') {
      add(TrackingErrorCode.GTM_CONSENT_SETTINGS_MISSING, {
        ...base,
        remediation: 'A konverziós tag consent-beállítás nélkül hozzájárulás előtt is tüzelhet. Állítsd be (ad_storage, ad_user_data).'
      });
    }

    // A tag olyan triggerre hivatkozik, ami nem is létezik → soha nem tüzel.
    for (const tid of tag.firingTriggerId ?? []) {
      // A beépített (rezervált) trigger-ID-k nincsenek a listában — azok rendben.
      if (tid.length >= 10) continue;
      if (!triggerById.has(tid)) {
        add(TrackingErrorCode.GTM_TRIGGER_MISSING, {
          ...base,
          expected: `trigger #${tid}`,
          remediation: 'A tag nem létező triggerre hivatkozik — soha nem tüzel.'
        });
      }
    }
  }

  // ── Meta duplikátum ─────────────────────────────────────────────────
  if (expected.metaPixelId) {
    const metaConversionTags = tags.filter(
      (t) => t.type === 'html' && /fbq\s*\(\s*['"]track['"]/.test(paramValue(t, 'html') ?? '')
    );
    const byEvent = new Map<string, GtmTag[]>();
    for (const t of metaConversionTags) {
      const ev = paramValue(t, 'html')?.match(/fbq\s*\(\s*['"]track['"]\s*,\s*['"]([^'"]+)['"]/)?.[1];
      if (!ev) continue;
      if (!byEvent.has(ev)) byEvent.set(ev, []);
      byEvent.get(ev)!.push(t);
    }
    for (const [ev, list] of byEvent) {
      if (list.length > 1) {
        add(TrackingErrorCode.GTM_DUPLICATE_CONVERSION_TAG, {
          actual: `Meta "${ev}" ${list.length} tagben: ${list.map((t) => t.name).join(', ')}`,
          remediation: 'A Meta ugyanazt az eseményt többször kapja meg — a dedup csak azonos event_id mellett véd.'
        });
      }
    }
  }

  // ── ISMERETLEN, de konverzió-képes tagek ────────────────────────────
  //
  // Ez a legfontosabb szabály: egy kézzel felvett tag, amiről senki nem tud,
  // ugyanúgy könyvel pénzt. A „nem ismerem, hagyjuk" hozzáállás pont azt a
  // duplikációt engedné be, amit fentebb kritikusnak nevezünk.
  const knownTagNames = new Set(
    tags
      .filter((t) => t.type === 'awct' || t.type === 'gclidw' || t.type === 'googtag')
      .map((t) => t.name ?? '')
  );

  for (const tag of tags) {
    const type = tag.type ?? '';
    if (type === 'html') {
      const html = paramValue(tag, 'html') ?? '';
      const isCanonical = (expected.allowedCustomHtmlTags ?? []).includes(tag.name ?? '');
      if (!isCanonical && MONEY_PATH_HTML.test(html)) {
        add(TrackingErrorCode.GTM_UNSUPPORTED_CUSTOM_HTML, {
          objectId: tag.tagId,
          objectName: tag.name,
          remediation:
            'Custom HTML a pénz-úton: nem ellenőrizhető, nem verziózott, és a kontraktuson kívül van. ' +
            'Vagy vedd fel a kanonikus generátorba, vagy dokumentáld kivételként.'
        });
      }
      continue;
    }
    if (!CONVERSION_CAPABLE_TYPES.has(type)) continue;
    // Az `awct` és a `gaawe` a kanonikus készlet része — azokat fentebb néztük.
    if (type === 'awct' || type === 'gaawe') continue;
    if (knownTagNames.has(tag.name ?? '')) continue;

    add(TrackingErrorCode.GTM_UNKNOWN_CONVERSION_TAG, {
      objectId: tag.tagId,
      objectName: tag.name,
      actual: type,
      remediation:
        'Ismeretlen, de KONVERZIÓ-KÉPES tag. Senki nem birtokolja, és pénzt tud könyvelni. ' +
        'Azonosítsd a tulajdonost, vagy töröld — ez FAIL, nem figyelmeztetés.'
    });
  }

  return findings;
}

/** Van-e olyan finding, ami blokkolja a „rendben" állapotot? */
export function hasBlockingFindings(findings: ConformanceFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

/**
 * A findingek STRUKTURÁLT LOGBA írása.
 *
 * Miért külön függvény, és miért nem az elemzőben: az `analyzeGtmConformance`
 * szándékosan tiszta (bemenet → findingek), hogy fixture-ökkel tesztelhető
 * legyen mellékhatás nélkül. A logolás viszont §13 szerint KÖTELEZŐ — minden
 * kezelhető hibaágnak strukturált, kódos nyoma kell legyen, amire riasztást és
 * runbookot lehet kötni. A kettő szétválasztva mindkét igény teljesül.
 *
 * A log SZÁNDÉKOSAN nem tartalmaz konténer-tartalmat, csak azonosítókat és a
 * várt/valós értéket — egy GTM-export teljes kiírása felesleges zaj lenne.
 */
export function reportConformanceFindings(findings: ConformanceFinding[]): void {
  for (const f of findings) {
    logStructured({
      level: f.severity === 'critical' ? 'error' : f.severity === 'warning' ? 'warn' : 'info',
      error_code: f.code,
      message: f.message,
      site_id: f.site,
      gtm_container: f.container,
      gtm_object_id: f.objectId,
      gtm_object_name: f.objectName,
      expected: f.expected,
      actual: f.actual,
      remediation: f.remediation
    });
  }
}
