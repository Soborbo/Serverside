import { describe, it, expect } from 'vitest';
import {
  encodeSboConsentCookie,
  SBO_CONSENT_MAX_AGE_S,
  parseSboConsentCookie,
  type SboConsentState
} from '../lib/consent-sbo-state';
import {
  readSboConsentCookieHeader,
  readConsentFromCookie
} from '../server/backend/gateway-dispatch';

/**
 * A SITE-BACKEND consent-parserének PARITÁSA a böngésző-libbel.
 *
 * ── Mi történt, és miért ez a teszt a javítás lényege ────────────────────────
 * A `server/backend/gateway-dispatch.ts` ÖNÁLLÓAN másolódik a site-okra, tehát
 * nem importálhatja a böngésző-lib parserét — kézzel duplikált párja annak. A
 * böngésző-lib áttért a `v2` süti-formátumra (policy-verzióval), a backend
 * parsere viszont `v1`-et követelt.
 *
 * Következmény egy `provider: sbo` site-on: MINDEN valódi süti `null`-ra
 * parse-olódott volna a szerveren. A form-POST láb „nincs döntés"-t lát,
 * `require_consent: true` mellett fail-closed kihagyja a hirdetési platformokat
 * — némán, minden high-value konverzión. A böngésző-láb közben ugyanazt a sütit
 * érvényes „igen"-nek olvasta: a két láb ugyanarról a látogatóról mást gondolt.
 *
 * Ez a fájl UGYANAZON a fixture-táblán futtatja a két parsert. Ha bármelyik
 * oldal szabálya elmozdul, itt bukik — nem élesben, csendben.
 */

const POLICY = '2026-08-a';
const nowSec = () => 1_800_000_000;

function state(over: Partial<SboConsentState> = {}): SboConsentState {
  return {
    analytics: true,
    marketing: true,
    revision: 1,
    decision: 'accept_all',
    consentId: 'a1b2c3d4-e5f6-7890',
    decidedAtSec: nowSec() - 60,
    policyVersion: POLICY,
    ...over
  };
}

/** A backend oldali olvasat ugyanabból a nyers süti-értékből. */
function backend(raw: string, expectedPolicyVersion?: string) {
  return readSboConsentCookieHeader(`sbo_consent=${encodeURIComponent(raw)}`, {
    expectedPolicyVersion,
    nowSec: nowSec()
  });
}

/** A böngésző-lib olvasata ugyanarról. */
function browser(raw: string, expectedPolicyVersion?: string) {
  return parseSboConsentCookie(raw, expectedPolicyVersion, nowSec());
}

const FIXTURES: Array<[string, string]> = [
  ['érvényes accept_all', encodeSboConsentCookie(state())],
  ['érvényes reject_all', encodeSboConsentCookie(state({ analytics: false, marketing: false, decision: 'reject_all' }))],
  ['érvényes custom (analytics-only)', encodeSboConsentCookie(state({ marketing: false, decision: 'custom' }))],
  ['érvényes withdrawn', encodeSboConsentCookie(state({ analytics: false, marketing: false, decision: 'withdrawn' }))],
  // A RÉGI formátum: mindkét oldalnak el KELL utasítania. Egy szerveroldali
  // „még elfogadom a v1-et" új divergencia lenne, csak a másik irányba.
  ['RÉGI v1-es süti', `v1.1.1.1.accept_all.a1b2c3d4-e5f6-7890.${nowSec() - 60}`],
  ['hiányzó mező (7 elem, v2 fejjel)', `v2.1.1.1.accept_all.a1b2c3d4-e5f6-7890.${nowSec() - 60}`],
  ['ismeretlen decision', `v2.1.1.1.maybe.a1b2c3d4-e5f6-7890.${nowSec() - 60}.${POLICY}`],
  ['decision↔kategória ellentmondás', `v2.1.0.1.accept_all.a1b2c3d4-e5f6-7890.${nowSec() - 60}.${POLICY}`],
  ['revision=0', `v2.1.1.0.accept_all.a1b2c3d4-e5f6-7890.${nowSec() - 60}.${POLICY}`],
  ['rövid consent_id', `v2.1.1.1.accept_all.abc.${nowSec() - 60}.${POLICY}`],
  ['üres policy-verzió', `v2.1.1.1.accept_all.a1b2c3d4-e5f6-7890.${nowSec() - 60}.`],
  ['nem szám decidedAt', `v2.1.1.1.accept_all.a1b2c3d4-e5f6-7890.tegnap.${POLICY}`],
  ['LEJÁRT döntés', encodeSboConsentCookie(state({ decidedAtSec: nowSec() - SBO_CONSENT_MAX_AGE_S - 1 }))],
  ['épp még érvényes döntés', encodeSboConsentCookie(state({ decidedAtSec: nowSec() - SBO_CONSENT_MAX_AGE_S }))],
  ['üres string', '']
];

describe('sbo_consent — a site-backend és a böngésző-lib UGYANAZT olvassa', () => {
  for (const [label, raw] of FIXTURES) {
    it(`${label}: a két parser egyetért`, () => {
      const b = browser(raw, POLICY);
      const s = backend(raw, POLICY);
      expect(Boolean(s), `${label}: érvényesség-eltérés (böngésző=${Boolean(b)}, backend=${Boolean(s)})`).toBe(
        Boolean(b)
      );
      if (b && s) {
        expect(s.analytics).toBe(b.analytics);
        expect(s.marketing).toBe(b.marketing);
        expect(s.revision).toBe(b.revision);
        expect(s.consentId).toBe(b.consentId);
        expect(s.decidedAtSec).toBe(b.decidedAtSec);
        expect(s.policyVersion).toBe(b.policyVersion);
      }
    });
  }
});

describe('a konkrét regresszió, ami élesben némán ölt volna', () => {
  const raw = encodeSboConsentCookie(state());

  it('a v2 süti a BACKENDEN is érvényes döntés (a javítás előtt null volt)', () => {
    const s = backend(raw, POLICY);
    expect(s).not.toBeNull();
    expect(s!.marketing).toBe(true);
  });

  it('a teljes ConsentState is előáll — nem esik fail-closed ágra', () => {
    const consent = readConsentFromCookie(`sbo_consent=${encodeURIComponent(raw)}`, {
      expectedPolicyVersion: POLICY,
      nowSec: nowSec()
    });
    expect(consent).toEqual({
      ad_user_data: 'GRANTED',
      ad_personalization: 'GRANTED',
      ad_storage: 'GRANTED',
      analytics_storage: 'GRANTED'
    });
  });

  it('MÁS policy-verzióra adott „igen" → nincs döntés (a böngésző is újrakérdez)', () => {
    const old = encodeSboConsentCookie(state({ policyVersion: '2026-01-a' }));
    expect(backend(old, POLICY)).toBeNull();
    expect(browser(old, POLICY)).toBeNull();
  });

  it('policy-verzió megadása NÉLKÜL a süti szerkezetileg még érvényes — de a site-nak át KELL adnia', () => {
    const old = encodeSboConsentCookie(state({ policyVersion: '2026-01-a' }));
    // Ez a megengedő ág szándékos: a CookieYes-site-oknak nincs policy-verziójuk,
    // és egy kötelező mező ott minden hívást elrontana. Az sbo site-ok viszont
    // átadják — a GatewayEnv.TRACKING_POLICY_VERSION erre való.
    expect(backend(old)).not.toBeNull();
  });
});
