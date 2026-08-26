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

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;

function octetLength(value: string): number {
  if (encoder) return encoder.encode(value).length;
  // Ha nincs TextEncoder (nagyon régi runtime), a `length` FELSŐ becslés helyett
  // alsó lenne — ezért inkább konzervatívan a legrosszabb esetet vesszük, hogy a
  // korlát sose engedjen át többet, mint amennyit a másik láb elfogadna.
  return value.length * 4;
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
  if (octetLength(normalized) > EMAIL_IDENTITY_MAX_OCTETS) return undefined;
  return normalized;
}
