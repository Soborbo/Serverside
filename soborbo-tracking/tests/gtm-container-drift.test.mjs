// .mjs szándékosan: node-oldali harness (child_process/fs), a böngészős tsconfig
// node-típusok nélkül fut — lásd tests/check-event-contract-script.test.mjs.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = resolve(HERE, '../gtm/gen-container.mjs');
const COMMITTED = resolve(HERE, '../gtm/container.json');

describe('gtm/container.json ↔ gen-container.mjs', () => {
  it('a committolt export a generátor AKTUÁLIS kimenete (nincs kézi drift)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gtm-gen-'));
    try {
      const out = join(dir, 'container.json');
      const r = spawnSync(process.execPath, [GEN, out], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(readFileSync(COMMITTED, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
