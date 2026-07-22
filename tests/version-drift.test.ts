import { describe, it, expect } from 'vitest';
import { classifyVersion } from '../scripts/check-version-drift.mjs';

// Az ancestry-t egy injektált predikátum dönti el — a teszt így nem igényel
// git-repót, és minden ágat determinisztikusan fed.
const YES = () => true;
const NO = () => false;
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('classifyVersion — F4-1(b) drift-osztályozó', () => {
  it('unknown bélyeg → UNSTAMPED (a deploy nem a [build] hookon ment ki)', () => {
    const v = classifyVersion({ build_commit: 'unknown', build_dirty: false }, YES);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('UNSTAMPED');
  });

  it('hiányzó build_commit → UNSTAMPED', () => {
    expect(classifyVersion({}, YES).code).toBe('UNSTAMPED');
  });

  it('dirty deploy → DIRTY (a commit ancestry ellenére is bukik)', () => {
    const v = classifyVersion({ build_commit: SHA, build_dirty: true }, YES);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('DIRTY');
  });

  it('nem-SHA alakú commit → MALFORMED', () => {
    const v = classifyVersion({ build_commit: 'v1.2.3', build_dirty: false }, YES);
    expect(v.code).toBe('MALFORMED');
  });

  it('valós SHA, de NEM őse a main-nek → DRIFT', () => {
    const v = classifyVersion({ build_commit: SHA, build_dirty: false }, NO);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('DRIFT');
  });

  it('valós SHA, ami őse a main-nek → OK', () => {
    const v = classifyVersion({ build_commit: SHA, build_dirty: false }, YES);
    expect(v.ok).toBe(true);
    expect(v.code).toBe('OK');
  });

  it('rövid (7-hex) SHA is elfogadott, ha ancestor', () => {
    expect(classifyVersion({ build_commit: 'a1b2c3d', build_dirty: false }, YES).ok).toBe(true);
  });

  it('a dirty a malformed/ancestry ELŐTT bukik (precedencia)', () => {
    // dirty=true + nem-ancestor → a DIRTY-t jelentjük (az a gyökér-ok).
    expect(classifyVersion({ build_commit: SHA, build_dirty: true }, NO).code).toBe('DIRTY');
  });
});
