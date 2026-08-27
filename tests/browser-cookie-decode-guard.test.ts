import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A BÖNGÉSZŐ-LÁB COOKIE-DEKÓDOLÁSA NEM DOBHAT.
 *
 * ── Előzmény ─────────────────────────────────────────────────────────────────
 * A 6.6.1/6.6.2 kör három őrizetlen `decodeURIComponent`-et javított a SZERVER-
 * lábon: egy hibás percent-szekvencia (`%zz`, csonka `%E0`) `URIError`-t dob, és
 * az a LEAD-útvonalon 500-as választ adott a beküldött űrlapra — vagyis
 * lead-vesztést. A javítás két helyert kapott: `safeDecodeCookieValue` (a KAPU,
 * fail-closed) és `decodeCookieValueLossy` (a TELEMETRIA, a nyers értékre esik).
 *
 * ── Amit ez a teszt őriz ─────────────────────────────────────────────────────
 * Ugyanez a minta a BÖNGÉSZŐ-lábon (`lib/gateway.ts` `getCookie`) őrizetlen
 * maradt. Ott a dobás nem 500-at ad, hanem CSENDET: a `getCookie` a
 * konverzió-dispatch útján is fut (`_ga`, `_gcl_aw`), és egy `URIError` a
 * `sendToWorker` promise-át utasítja el — a konverzió némán nem megy ki.
 * A consent-olvasás (`cookieyes-consent`) szintén rajta ül.
 *
 * Ezért: a `lib/gateway.ts`-ben NEM lehet csupasz `decodeURIComponent`.
 */

const BROWSER_LIB = fileURLToPath(new URL('../soborbo-tracking/lib/gateway.ts', import.meta.url));

describe('lib/gateway.ts — nincs őrizetlen cookie-dekódolás', () => {
  const src = readFileSync(BROWSER_LIB, 'utf8');

  it('a `decodeURIComponent` CSAK az őrző helperekben szerepel', () => {
    const lines = src.split('\n');
    const offenders = lines
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(
        (l) =>
          l.line.includes('decodeURIComponent') &&
          !l.line.startsWith('*') &&
          !l.line.startsWith('//') &&
          !/^return decodeURIComponent\(value\);$/.test(l.line)
      );
    expect(
      offenders.map((o) => `${o.no}: ${o.line}`),
      'minden cookie-dekódolás a safeDecodeCookieValue / decodeCookieValueLossy helperen át menjen',
    ).toEqual([]);
  });

  it('mindkét degradációs helper létezik — a kapu és a telemetria NEM ugyanaz', () => {
    expect(src).toMatch(/function safeDecodeCookieValue\(/);
    expect(src).toMatch(/function decodeCookieValueLossy\(/);
  });

  it('a consent-olvasás a FAIL-CLOSED ágon megy, a klikk-ID-olvasás a lossyn', () => {
    // A jogalapot olvasó ág nem eshet vissza a nyers értékre: egy fél-dekódolt
    // consent-stringből kiolvasott „advertisement:yes" hamis jogalap lenne.
    // Fordítva viszont a klikk-ID nem veszhet el egy dobás miatt.
    const consentReads = src.split('\n').filter((l) => l.includes("'cookieyes-consent'"));
    expect(consentReads.length).toBeGreaterThan(0);
    for (const line of consentReads) {
      if (line.includes('getConsentCookie(') || line.includes('function ')) continue;
      expect(line, 'a consent-süti olvasása NEM mehet a lossy getCookie-n').not.toMatch(
        /[^t]getCookie\(/,
      );
    }
    // A nem-jogalap olvasások maradnak a lossy ágon.
    expect(src).toMatch(/getCookie\('_gcl_aw'\)/);
    expect(src).toMatch(/getCookie\('_ga'\)/);
  });
});
