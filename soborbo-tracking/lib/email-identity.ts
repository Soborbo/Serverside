/**
 * AZ E-MAIL MINT IDENTITÁS — EGY NORMALIZÁLÓ, KÉT LÁB.
 *
 * ── Miért külön, függőség nélküli modul ──────────────────────────────────────
 * Ezt a függvényt a böngésző-csomag ÉS a Worker `src/lib/hash.ts` is importálja.
 * Ezért NULLA importja van (se `./config`, se DOM, se `import.meta.env`): egy
 * böngésző-only függőség a Worker-buildet törné, egy Worker-only függőség pedig
 * a vendorolt site-példányt.
 *
 * ── A hiba, amit felszámol ───────────────────────────────────────────────────
 * A szabály eddig három helyen élt, három különböző viselkedéssel:
 *
 *   böngésző-csomag  trim → lowercase → slice(0, 254)   ← CSONKÍTOTT
 *   Worker hash.ts   trim → lowercase → `@`-őr          ← nem csonkított
 *   painless site    trim → lowercase                   ← se cap, se őr
 *
 * A csonkítás a legrosszabb kimenet: 254 oktet fölött a böngésző egy
 * MESTERSÉGESEN MÁS stringet állít elő (`…@exam`), és arra képez hash-t —
 * a szerver ugyanabból a címből mást. Egy identitás, két hash.
 *
 * ── A szabály ────────────────────────────────────────────────────────────────
 *   trim → lowercase → `@`-őr → >254 OKTET esetén ELDOBÁS → különben változatlan
 *
 * A 254-nek szabványos alapja van: az RFC 5321 forward-path 256 oktet, amiből a
 * `<`/`>` levonása után a mailbox gyakorlati maximuma 254. Ebből viszont az
 * következik, hogy a hosszabb cím ÉRVÉNYTELEN — nem az, hogy le kell vágni.
 * Ezért 254 fölött `undefined`, SOHA nem csonkítás.
 *
 * OKTET, nem `String.length`: az RFC oktetben adja meg a korlátot, és egy
 * ékezetes helyi rész UTF-8-ban két oktet karakterenként. A `length`-re épülő
 * ellenőrzés átengedne egy 260 oktetes címet, és a két láb megint más
 * byte-sorozatot hashelne.
 *
 * ── Amit SZÁNDÉKOSAN nem csinál ──────────────────────────────────────────────
 * Nem strippel plus-suffixet és nem strippel Gmail-pontot: a Meta a LITERAL
 * stringet hasheli (CLAUDE.md 1.). A Google Data Manager ezzel ellentétes
 * szabályát a `normalizeEmailForGoogle` építi EBBŐL a kimenetből — ott a
 * divergencia szándékos és dokumentált.
 *
 * Nem validál teljes RFC-szintaxist. Az `@`-őr SZINTAKTIKAI MINIMUM: azt szűri,
 * ami biztosan nem cím. Egy szigorúbb parser a két lábon megint szétsodródhatna,
 * és a hamis negatív itt drágább, mint a hamis pozitív.
 */

/** RFC 5321 — a mailbox gyakorlati maximuma oktetben. */
export const EMAIL_IDENTITY_MAX_OCTETS = 254;

/**
 * UTF-8 OKTETSZÁMLÁLÁS — SZÁNDÉKOSAN RUNTIME-FÜGGETLEN.
 *
 * Itt NINCS `typeof TextEncoder !== 'undefined'` elágazás, és ez a lényeg. Egy
 * feature-detect két kódutat jelent, két kódút pedig azt, hogy ugyanarra a
 * címre két runtime KÜLÖNBÖZŐ döntést hozhat — pontosan az az identity-
 * aszimmetria, amit ez a modul felszámol. Egy korábbi változat `length * 4`-gyel
 * becsült, ha nem volt `TextEncoder`; egy 87 oktetes ASCII cím így 348-nak
 * számított, tehát a böngésző ELDOBTA, amit a Worker ELFOGADOTT.
 *
 * Az invariáns nem az, hogy „ne engedjen át többet, mint a másik láb", hanem
 * hogy UGYANARRA A STRINGRE MINDEN RUNTIME UGYANAZT A SZÁMOT ADJA.
 *
 * A `TextEncoder` ettől még használható — de csak ORÁKULUMKÉNT a tesztben, ami
 * bizonyítja, hogy ez a számláló ugyanazt adja. Lásd
 * `tests/email-identity-parity.test.ts`.
 *
 * A surrogate-kezelés a `TextEncoder` viselkedését követi:
 *   - érvényes surrogate pár (U+10000..U+10FFFF) → 4 oktet
 *   - MAGÁNYOS surrogate (pár nélküli high vagy low) → 3 oktet, mert a
 *     `TextEncoder` U+FFFD replacement characterre cseréli (EF BF BD)
 */
export function utf8OctetLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        // Magányos high surrogate → U+FFFD.
        bytes += 3;
      }
    } else {
      // BMP (a magányos low surrogate is ide esik → U+FFFD, szintén 3).
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Az e-mail kanonikus identitás-alakja hash-eléshez.
 *
 * @returns a normalizált cím, vagy `undefined`, ha nem használható identitásnak
 *          (üres, `@` nélküli, vagy 254 oktetnél hosszabb).
 */
export function normalizeEmailIdentity(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  if (!normalized.includes('@')) return undefined;
  if (utf8OctetLength(normalized) > EMAIL_IDENTITY_MAX_OCTETS) return undefined;
  return normalized;
}
