import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A flip-readiness őr KV-config ága. A CMP-FLIP-008 (2026-11-03): EEA/UK alatt
 * a basic a kötelező alap — advanced csak dokumentált jogi jóváhagyással.
 */
function run(consent: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-'));
  const file = path.join(dir, 'cfg.json');
  fs.writeFileSync(file, JSON.stringify({ site_id: 'teszt', require_consent: true, consent }));
  const res = spawnSync(process.execPath, ['scripts/check-cmp-flip-readiness.mjs', 'teszt.example', '--config', file], {
    encoding: 'utf8'
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('check-cmp-flip-readiness — consent.mode (CMP-FLIP-008)', () => {
  it('basic mód: átmegy', () => {
    const r = run({ provider: 'sbo', mode: 'basic' });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/CMP-FLIP-008/);
  });

  it('advanced jóváhagyás nélkül: blokkoló', () => {
    const r = run({ provider: 'sbo', mode: 'advanced' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/❌ CMP-FLIP-008/);
  });

  it('advanced formailag hibás jóváhagyással: blokkoló', () => {
    const r = run({ provider: 'sbo', mode: 'advanced', advanced_approval: 'igen' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/❌ CMP-FLIP-008/);
  });

  it('advanced dátumozott, hivatkozott jóváhagyással: figyelmeztetés, de átmegy', () => {
    const r = run({ provider: 'sbo', mode: 'advanced', advanced_approval: '2026-12-01:dpo-memo-2026-12' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/⚠️ {2}CMP-FLIP-008/);
  });
});
