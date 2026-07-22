import { describe, it, expect } from 'vitest';
import { handleVersion } from '../src/routes/version';

describe('handleVersion — build-bélyeg endpoint (F4-1(b))', () => {
  it('200 + application/json', async () => {
    const res = handleVersion();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('a bélyeg-mezőket adja vissza (build_commit / build_dirty / built_at)', async () => {
    const body = await handleVersion().json();
    // A commitolt placeholder 'unknown'; deploy után valós 7–40 hex SHA. A route
    // szerződése: a mező JELEN VAN és a helyes típusú — a CI-job innen olvassa.
    expect(body.build_commit).toMatch(/^(unknown|[0-9a-f]{7,40})$/);
    expect(typeof body.build_dirty).toBe('boolean');
    expect(typeof body.built_at).toBe('string');
    expect(body.version).toBe('0.1.0');
  });

  it('SOHA nem szivárogtat titkot/PII-t (csak a bélyeg-mezők)', async () => {
    const body = await handleVersion().json();
    expect(Object.keys(body).sort()).toEqual(['build_commit', 'build_dirty', 'built_at', 'version']);
  });
});
