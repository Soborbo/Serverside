import { describe, it, expect } from 'vitest';
import { handleAdminUI, isAdminUiHost } from '../src/routes/admin-ui';
import type { Env } from '../src/env';

/**
 * A GATEWAY sajat, tenant-semleges hosztja. Az UI CSAK itt (es a workers.dev
 * teszt-hoszton) szolgalhato ki — lasd a hoszt-kapu teszteket a fajl aljan.
 */
const GATEWAY_HOST = 'https://tracking.soborbo.co.uk/api/event/admin-ui';

function uiRequest(url = GATEWAY_HOST): Request {
  return new Request(url);
}

describe('handleAdminUI', () => {
  it('serves HTML with 200 and no-store cache', async () => {
    const res = handleAdminUI(uiRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets a strict CSP that only allows same-origin fetch', () => {
    const csp = handleAdminUI(uiRequest()).headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('the shell contains no secret and points at the admin API', async () => {
    const html = await handleAdminUI(uiRequest()).text();
    expect(html).toContain('/api/event/admin/health-check');
    expect(html).toContain('/api/event/admin/reconciliation');
    expect(html).toContain('/api/event/admin/leads/');
    expect(html).toContain('/api/event/admin/dlq/replay');
    // The token is entered by the user at runtime — never baked into the shell.
    expect(html).toContain('X-Admin-Token');
    expect(html).not.toContain('ADMIN_API_TOKEN');
  });

  it('a fleet-health kártya be van kötve, és az UNKNOWN SAJÁT (nem zöld) stílust kap', async () => {
    const html = await handleAdminUI(uiRequest()).text();
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

describe('az admin-UI CSAK a gateway sajat hosztjan szolgalhato ki', () => {
  /**
   * A ZART RES. Az UI a GLOBALIS, FLOTTA-SZINTU admin-tokent a `sessionStorage`-be
   * teszi, ami ORIGIN-hez kotott. Amig minden ugyfel-zonan kiszolgaltuk, a token az
   * UGYFEL originjere kerult — ahonnan barmelyik ott futo szkript (site-XSS,
   * kompromittalt third-party tag, gazdatlan GTM Custom HTML) kiolvashatja. A
   * robbanasi sugar nem egy site, hanem az EGESZ flotta.
   */
  it('ugyfel-zonan 404 — a vegpontnak ott letezenie sem kell', async () => {
    const res = handleAdminUI(uiRequest('https://painlessremovals.com/api/event/admin-ui'));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Event Gateway');
  });

  it('a gateway sajat domainjen 200', () => {
    expect(handleAdminUI(uiRequest()).status).toBe(200);
  });

  it('a workers.dev teszt-hoszton 200', () => {
    expect(handleAdminUI(uiRequest('https://event-gateway.golaxo.workers.dev/api/event/admin-ui')).status).toBe(200);
  });

  it('az ADMIN_UI_HOSTS csak BOVIT — es csak a felsorolt hosztra', () => {
    const env = { ADMIN_UI_HOSTS: 'ops.example.com' } as unknown as Env;
    expect(isAdminUiHost('ops.example.com', env)).toBe(true);
    expect(isAdminUiHost('painlessremovals.com', env)).toBe(false);
    expect(isAdminUiHost('painlessremovals.com')).toBe(false);
  });

  it('nem agyazhato be (frame-ancestors + X-Frame-Options)', () => {
    const res = handleAdminUI(uiRequest());
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
