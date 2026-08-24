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
 *   v1.<analytics 0|1>.<marketing 0|1>.<revision>.<decision>.<consent_id>.<decidedAtSec>
 *
 * A `.` a mező-elválasztó — minden mező-érték pont-mentes (a decision enum, a
 * consent_id UUID, a számok azok). A formátumnak az inline consent-boot
 * szkripttel (Tracking.astro) BITRE egyeznie kell: az a <1 kB-os párja ennek a
 * parsernek, bundler nélkül.
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

export interface SboConsentState {
  analytics: boolean;
  marketing: boolean;
  revision: number;
  decision: SboDecisionKind;
  /** A preferencia-lánc STABIL azonosítója (döntéseken át ugyanaz). */
  consentId: string;
  /** A döntés kliens-ideje, Unix SECONDS. */
  decidedAtSec: number;
}

export function encodeSboConsentCookie(s: SboConsentState): string {
  return `v1.${s.analytics ? 1 : 0}.${s.marketing ? 1 : 0}.${s.revision}.${s.decision}.${s.consentId}.${s.decidedAtSec}`;
}

/**
 * Szigorú parse: bármely mező hibája → null (nincs döntés → banner). Egy
 * megrongálódott süti "legjobb tipp" helyett újrakérdezést ér — consentet nem
 * találunk ki.
 */
export function parseSboConsentCookie(raw: string | undefined | null): SboConsentState | null {
  if (!raw) return null;
  const p = raw.split('.');
  if (p.length !== 7 || p[0] !== 'v1') return null;
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
    decidedAtSec
  };
}

/** A `sbo_consent` süti SZINKRON olvasata. null = nincs (érvényes) döntés. */
export function readSboConsent(): SboConsentState | null {
  if (typeof document === 'undefined') return null;
  try {
    const m = document.cookie.match(/(?:^|;\s*)sbo_consent=([^;]*)/);
    return parseSboConsentCookie(m ? decodeURIComponent(m[1]) : null);
  } catch {
    return null;
  }
}

/** Nyers kategória-olvasók. Nincs döntés → false (deny) — a dev-fallback a consent.ts dolga. */
export function sboAnalyticsGranted(): boolean {
  return readSboConsent()?.analytics === true;
}
export function sboMarketingGranted(): boolean {
  return readSboConsent()?.marketing === true;
}

/** A döntés kora másodpercben — a receipt `consent_age_s` mezőjéhez (TRK-910-004). */
export function sboConsentAgeSeconds(state: SboConsentState | null): number | undefined {
  if (!state) return undefined;
  const age = Math.floor(Date.now() / 1000) - state.decidedAtSec;
  return age >= 0 ? age : 0;
}
