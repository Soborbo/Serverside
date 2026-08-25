import { describe, it, expect } from 'vitest';
import { handleAdminUI } from '../src/routes/admin-ui';

describe('handleAdminUI', () => {
  it('serves HTML with 200 and no-store cache', async () => {
    const res = handleAdminUI();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets a strict CSP that only allows same-origin fetch', () => {
    const csp = handleAdminUI().headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('the shell contains no secret and points at the admin API', async () => {
    const html = await handleAdminUI().text();
    expect(html).toContain('/api/event/admin/health-check');
    expect(html).toContain('/api/event/admin/reconciliation');
    expect(html).toContain('/api/event/admin/leads/');
    expect(html).toContain('/api/event/admin/dlq/replay');
    // The token is entered by the user at runtime — never baked into the shell.
    expect(html).toContain('X-Admin-Token');
    expect(html).not.toContain('ADMIN_API_TOKEN');
  });

  it('a fleet-health kártya be van kötve, és az UNKNOWN SAJÁT (nem zöld) stílust kap', async () => {
    const html = await handleAdminUI().text();
    expect(html).toContain('/api/event/admin/fleet-health');
    // A legfontosabb vizuális invariáns: az UNKNOWN nem oszthat osztályt a GREEN-nel,
    // és nem a zöld változóból veszi a színét. Enélkül a „nem tudjuk" egy pillantásra
    // ugyanaz lenne, mint a „rendben" — pontosan az a hiba, ami ellen a nézet épült.
    const unknownRule = /\.UNKNOWN \{[^}]*\}/.exec(html)?.[0] ?? '';
    expect(unknownRule).not.toBe('');
    expect(unknownRule).not.toContain('--pass');
    expect(unknownRule).not.toContain('46,160,67');
  });
});
