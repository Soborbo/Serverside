import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * §18 — a Windows↔Linux lockfile-csapda őre.
 *
 * A HIBAOSZTÁLY. A Windowson futtatott `npm install|update` KIPUCOLJA a
 * lockfile-ból a más platformra való optional ágakat (`@emnapi/runtime`,
 * `@esbuild/linux-*`, `@rollup/rollup-linux-*`), miközben az ideal-tree
 * továbbra is hivatkozik rájuk. A Linux-builder `npm ci`-je ott EUSAGE-dzsel
 * bukik — a fejlesztő gépén viszont MINDEN zöld, még a `npm ci --dry-run` is.
 * 2026-08-25-én két repó CI-ját fogta meg, és eddig CSAK emlékezet védett ellene
 * („ne felejts el Windows-npm install után lockfile-t javítani").
 *
 * Ez a teszt nem a jelenlegi lockfile-t méri (azt a CI-lépés teszi) — azt
 * bizonyítja, hogy az ŐR MAGA MŰKÖDIK. Egy néma őr rosszabb, mint semmi: azt
 * hinnénk, védve vagyunk.
 */

const SCRIPT = resolve(__dirname, '..', 'scripts', 'check-lockfile-complete.mjs');

function runGuard(lock: unknown): { status: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lockguard-'));
  const path = join(dir, 'package-lock.json');
  writeFileSync(path, JSON.stringify(lock));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' });
    return { status: r.status ?? 1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Teljes lockfile: a linux-only optional ág BENNE van. */
const COMPLETE = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { sharp: '^0.33.0' } },
    'node_modules/sharp': { optionalDependencies: { '@img/sharp-linux-x64': '0.33.0', '@img/sharp-win32-x64': '0.33.0' } },
    'node_modules/@img/sharp-linux-x64': { optional: true },
    'node_modules/@img/sharp-win32-x64': { optional: true }
  }
};

/** Ugyanaz, MIUTÁN a Windows-npm kipucolta a linux-ágat. */
const PRUNED = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { sharp: '^0.33.0' } },
    'node_modules/sharp': { optionalDependencies: { '@img/sharp-linux-x64': '0.33.0', '@img/sharp-win32-x64': '0.33.0' } },
    'node_modules/@img/sharp-win32-x64': { optional: true }
  }
};

describe('lockfile-teljesség őr', () => {
  it('teljes lockfile → exit 0', () => {
    const r = runGuard(COMPLETE);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('MEGCSONKÍTOTT lockfile (a Windows-npm pruning) → exit 1', () => {
    const r = runGuard(PRUNED);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('@img/sharp-linux-x64');
  });

  it('a hibaüzenet MEGMONDJA, mi az ok és mi a javítás', () => {
    // Egy „valami nem stimmel" üzenet mellett a következő fejlesztő ugyanúgy
    // Windowson futtat majd egy npm install-t, és újratermeli a hibát.
    const r = runGuard(PRUNED);
    expect(r.stderr).toContain('npm ci');
    expect(r.stderr).toMatch(/Windows/i);
    expect(r.stderr).toContain('Javítás');
  });

  it('hiányzó gyökér-függőséget is elkap (nem csak az optional ágakat)', () => {
    const r = runGuard({
      lockfileVersion: 3,
      packages: { '': { dependencies: { vitest: '^4.0.0' } } }
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('vitest');
  });

  it('a beágyazott (nested) feloldás is helyes — a szülő node_modules is számít', () => {
    // A Node felfelé keres: egy mélyen ülő csomag a gyökér node_modules-ából is
    // feloldhat. Ha az őr ezt nem tudná, tömeges hamis riasztást adna.
    const r = runGuard({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { a: '1.0.0' } },
        'node_modules/a': { dependencies: { b: '1.0.0' } },
        'node_modules/b': {}
      }
    });
    expect(r.status).toBe(0);
  });
});

describe('a toolchain Node-igénye deklarált', () => {
  it('mindkét package.json kimondja a minimum Node-verziót', async () => {
    const root = await import('../package.json');
    const pkg = await import('../soborbo-tracking/package.json');
    // `engines` nélkül egy Node 20-on dolgozó fejlesztő EBADENGINE-nel találkozik
    // a wrangler/miniflare telepítésekor, és a CI ezt nem fogná meg — ott 24 fut.
    expect((root as { engines?: { node?: string } }).engines?.node).toBeTruthy();
    expect((pkg as { engines?: { node?: string } }).engines?.node).toBeTruthy();
  });
});
