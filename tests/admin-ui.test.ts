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
});
