/**
 * Soborbo CMP · Fázis 2 — a saját consent-állapot SZINKRON olvasata.
 *
 * EZ A MODUL SZÁNDÉKOSAN FÜGGŐSÉG-MENTES (se persistence, se config, se uuid):
 * a `consent.ts` provider-elágazása és a `gateway.ts` payload-építése importálja,
 * és mindkettő mögött ott a persistence→consent import-lánc — bármi más import
 * itt kört zárna. A döntés-RÖGZÍTÉS (cookie-írás, POST, purge) a
 * `consent-sbo.ts`-ben él.
 *
 * MIÉRT KIZÁRÓLAG SÜTI, SZINKRON: a CookieYes `getCkyConsent()` betöltési
 * versenye (Fázis D fő diagnózisa) pont az aszinkron API-függésből származik —
 * a consent-boot inline szkript és ez az olvasó ugyanabból az egy, szinkronban
 * elérhető forrásból dolgozik, így betöltési verseny NEM LÉTEZIK.
 *
 * Süti-formátum (`sbo_consent`, first-party):
 *   v2.<analytics 0|1>.<marketing 0|1>.<revision>.<decision>.<consent_id>.<decidedAtSec>.<policy_version>
 *
 * A `.` a mező-elválasztó — minden mező-érték pont-mentes (a decision enum, a
 * consent_id UUID, a számok azok, és a policy-verzió is: `2026-08-a`). A
 * formátumnak az inline consent-boot szkripttel (Tracking.astro) BITRE egyeznie
 * kell: az a <1 kB-os párja ennek a parsernek, bundler nélkül. A `tests/
 * consent-boot-parity.test.ts` ezt az egyezést kényszeríti ki.
 *
 * MIÉRT KERÜLT BELE A POLICY-VERZIÓ (v1 → v2). A hozzájárulás ahhoz a
 * SZÖVEGHEZ kötődik, amit a látogató elolvasott (GDPR Art. 7(1); ICO: ha a
 * célok vagy a tevékenységek változnak, ÚJ hozzájárulást kell kérni). A v1-es
 * süti ezt nem hordozta, tehát egy szövegváltozás után a régi „igen" némán
 * továbbélt volna egy olyan tájékoztatásra, amit az illető sosem látott.
 * Mostantól a verzió-eltérés = NINCS DÖNTÉS → a banner újra kérdez.
 *
 * A v1-es sütik ELDOBÁSA szándékos és költségmentes: éles rendszerben NULLA
 * darab létezik belőlük (egyetlen site sem futott még `provider: sbo`-val,
 * a `consent_log` üres). Ez a formátumváltás utolsó ingyenes pillanata.
 */

export const SBO_CONSENT_COOKIE = 'sbo_consent';

/** A döntés-változásra a kliens ezt a DOM-eventet kapja (CustomEvent, detail: state). */
export const SBO_CONSENT_EVENT = 'sbo_consent_update';

/**
 * Süti-élettartam: 180 nap — a szerver CONSENT_MAX_AGE_S (ICO-ajánlás)
 * tükörértéke. Lejárat után a banner újra megjelenik, ami pontosan a szándék.
 */
export const SBO_CONSENT_MAX_AGE_S = 180 * 24 * 60 * 60;

export type SboDecisionKind = 'accept_all' | 'reject_all' | 'custom' | 'withdrawn';

const DECISIONS: ReadonlySet<string> = new Set(['accept_all', 'reject_all', 'custom', 'withdrawn']);
const ID_RE = /^[A-Za-z0-9_:-]{8,64}$/;
/**
 * A policy-verzió MEZŐ-ÉRTÉKE nem tartalmazhat pontot (az a mező-elválasztó),
 * és nem lehet üres. A `2026-08-a` alak ennek megfelel.
 */
const POLICY_VERSION_RE = /^[A-Za-z0-9_:-]{1,64}$/;

export interface SboConsentState {
  analytics: boolean;
  marketing: boolean;
  revision: number;
  decision: SboDecisionKind;
  /** A preferencia-lánc STABIL azonosítója (döntéseken át ugyanaz). */
  consentId: string;
  /** A döntés kliens-ideje, Unix SECONDS. */
  decidedAtSec: number;
  /**
   * MELYIK tájékoztató-szöveghez adta a hozzájárulást. Eltérés a jelenlegitől
   * = a döntés érvénytelen, mert nem arra vonatkozott, amit ma mutatunk.
   */
  policyVersion: string;
}

export function encodeSboConsentCookie(s: SboConsentState): string {
  return `v2.${s.analytics ? 1 : 0}.${s.marketing ? 1 : 0}.${s.revision}.${s.decision}.${s.consentId}.${s.decidedAtSec}.${s.policyVersion}`;
}

/**
 * Szigorú parse: bármely mező hibája → null (nincs döntés → banner). Egy
 * megrongálódott süti "legjobb tipp" helyett újrakérdezést ér — consentet nem
 * találunk ki.
 */
/**
 * @param expectedPolicyVersion Ha megadod, a süti policy-verziójának EGYEZNIE
 *   kell vele — különben `null` (nincs döntés → a banner újra kérdez).
 * @param nowSec Tesztelhetőség; alapból a jelen.
 */
export function parseSboConsentCookie(
  raw: string | undefined | null,
  expectedPolicyVersion?: string,
  nowSec?: number
): SboConsentState | null {
  if (!raw) return null;
  const p = raw.split('.');
  if (p.length !== 8 || p[0] !== 'v2') return null;
  if ((p[1] !== '0' && p[1] !== '1') || (p[2] !== '0' && p[2] !== '1')) return null;
  const revision = parseInt(p[3], 10);
  if (!Number.isInteger(revision) || revision < 1 || revision > 10_000 || String(revision) !== p[3]) {
    return null;
  }
  if (!DECISIONS.has(p[4])) return null;
  if (!ID_RE.test(p[5])) return null;
  const decidedAtSec = parseInt(p[6], 10);
  if (!Number.isInteger(decidedAtSec) || decidedAtSec <= 0 || String(decidedAtSec) !== p[6]) {
    return null;
  }
  if (!POLICY_VERSION_RE.test(p[7])) return null;
  const policyVersion = p[7];
  // A policy-verzió eltérése NEM „régi, de jó" döntés: más szöveghez adták.
  if (expectedPolicyVersion !== undefined && policyVersion !== expectedPolicyVersion) return null;
  // LEJÁRAT — a süti max-age mellé, defenzívan. A max-age a böngészőben él, és
  // egy kézzel visszaírt (vagy átvitt) süti attól még „friss"-nek látszana.
  // TRK-910-004 (CONSENT_EXPIRED) így már nem csak deklarált, hanem élesített.
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (now - decidedAtSec > SBO_CONSENT_MAX_AGE_S) return null;
  const analytics = p[1] === '1';
  const marketing = p[2] === '1';
  // A decision és a kategóriák egymásból következnek — az ellentmondó sütit
  // eldobjuk, ugyanazzal az elvvel, ahogy a szerver 400-at ad rá
  // (consent-log.ts decisionMatchesCategories).
  const matches =
    p[4] === 'accept_all'
      ? analytics && marketing
      : p[4] === 'custom'
        ? analytics !== marketing
        : !analytics && !marketing;
  if (!matches) return null;
  return {
    analytics,
    marketing,
    revision,
    decision: p[4] as SboDecisionKind,
    consentId: p[5],
    decidedAtSec,
    policyVersion
  };
}

/**
 * A `sbo_consent` süti SZINKRON olvasata. null = nincs (érvényes) döntés.
 *
 * @param expectedPolicyVersion A jelenleg mutatott tájékoztató verziója. A hívó
 *   (consent.ts / consent-sbo.ts) a `trackingConfig.policyVersion`-t adja át;
 *   elhagyva a verzió-kapu KIMARAD — ezt csak diagnosztika használhatja.
 */
export function readSboConsent(expectedPolicyVersion?: string): SboConsentState | null {
  if (typeof document === 'undefined') return null;
  try {
    const m = document.cookie.match(/(?:^|;\s*)sbo_consent=([^;]*)/);
    return parseSboConsentCookie(m ? decodeURIComponent(m[1]) : null, expectedPolicyVersion);
  } catch {
    return null;
  }
}

/** Nyers kategória-olvasók. Nincs döntés → false (deny) — a dev-fallback a consent.ts dolga. */
export function sboAnalyticsGranted(expectedPolicyVersion?: string): boolean {
  return readSboConsent(expectedPolicyVersion)?.analytics === true;
}
export function sboMarketingGranted(expectedPolicyVersion?: string): boolean {
  return readSboConsent(expectedPolicyVersion)?.marketing === true;
}

/** A döntés kora másodpercben — a receipt `consent_age_s` mezőjéhez (TRK-910-004). */
export function sboConsentAgeSeconds(state: SboConsentState | null): number | undefined {
  if (!state) return undefined;
  const age = Math.floor(Date.now() / 1000) - state.decidedAtSec;
  return age >= 0 ? age : 0;
}
