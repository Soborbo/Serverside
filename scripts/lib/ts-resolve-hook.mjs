/**
 * Kiterjesztés-nélküli relatív importok feloldása `.ts`-re.
 *
 * MIÉRT KELL. A `src/` TypeScript-forrásai `moduleResolution: 'bundler'` alatt
 * kiterjesztés nélkül importálnak (`from './error-codes'`) — ez a wrangler és a
 * vitest számára rendben van, a Node NYERS ESM-resolvere viszont nem találja
 * meg. Enélkül minden olyan szkript elbukna, ami közvetlenül a `src/`-ből akar
 * futásidejű logikát használni (error-code katalógus, GTM-conformance).
 *
 * A HOOK SZÁNDÉKOSAN SZŰK: csak relatív, kiterjesztés nélküli specifikátorokra
 * próbál `.ts`-t, és ha az sincs, továbbadja az eredetit. Így egy hiányzó modul
 * továbbra is a szokásos, érthető hibát adja — nem nyeljük el a hibát azért,
 * hogy „működjön".
 *
 * Használat: `node --experimental-transform-types --import ./scripts/lib/ts-resolve-hook.mjs …`
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const hasExtension = /\.[cm]?[jt]sx?$|\.json$/.test(specifier);
    if (isRelative && !hasExtension) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Nincs `.ts` — essen vissza az eredetire, hogy a hibaüzenet a VALÓDI
        // hiányzó modult nevezze meg, ne a mi kiegészítésünket.
      }
    }
    return nextResolve(specifier, context);
  }
});
