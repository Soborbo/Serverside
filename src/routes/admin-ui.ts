/**
 * Admin UI (#18) — önálló, build-mentes egylapos dashboard, amit a Worker
 * szolgál ki a `GET /api/event/admin-ui` útvonalon. A 4 admin-endpointot
 * fogyasztja (reconciliation, lead-trail, DLQ replay, health-check).
 *
 * - Az oldal-váz NEM tartalmaz secretet → auth nélkül kiszolgálható; minden
 *   ADAT-hívás az `X-Admin-Token` headerrel megy (a token a sessionStorage-ben
 *   marad, tab-záráskor törlődik).
 * - Relatív URL-ek → multi-tenant: azon a host-on dolgozik, ahol megnyitod.
 * - Minden ledger-adat `textContent`/DOM-API-val renderelődik (nincs innerHTML
 *   nyers adatra) → XSS-védelem a vendor_message-szerű mezőkre.
 * - Szigorú CSP: csak inline style/script + same-origin fetch engedett.
 */
export function handleAdminUI(): Response {
  return new Response(ADMIN_UI_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    }
  });
}

const ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Event Gateway — Admin</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --fg:#e6e9ef; --mut:#8b93a3;
          --pass:#2ea043; --warn:#d29922; --fail:#f85149; --acc:#4493f8; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .host { color:var(--mut); font-size:12px; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  input, button, select { font:inherit; }
  input, select { background:#0c0e12; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 9px; }
  button { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:7px 13px; cursor:pointer; }
  button.sec { background:#262b35; }
  button:hover { filter:brightness(1.08); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:18px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); margin:0 0 12px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mut); font-weight:500; }
  .badge { display:inline-block; padding:1px 8px; border-radius:20px; font-size:12px; font-weight:600; }
  .PASS { background:rgba(46,160,67,.15); color:var(--pass); }
  .WARN { background:rgba(210,153,34,.15); color:var(--warn); }
  .FAIL,.critical { background:rgba(248,81,73,.15); color:var(--fail); }
  .warning { background:rgba(210,153,34,.15); color:var(--warn); }
  pre { background:#0c0e12; border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; max-height:340px; font-size:12px; }
  .mut { color:var(--mut); }
  .err { color:var(--fail); }
  .ok { color:var(--pass); }
  .hidden { display:none; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .stat { background:#0c0e12; border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .stat b { display:block; font-size:20px; }
</style>
</head>
<body>
<header>
  <h1>Event Gateway — Admin</h1>
  <span class="host" id="host"></span>
  <span style="flex:1"></span>
  <input id="token" type="password" placeholder="X-Admin-Token" style="width:240px">
  <button id="connect">Connect</button>
  <button class="sec" id="forget">Forget</button>
  <span id="authstate" class="mut"></span>
</header>
<main>
  <div class="card">
    <h2>Health check</h2>
    <div class="row"><button id="b-health">Run health-check</button></div>
    <div id="out-health"></div>
  </div>

  <div class="card">
    <h2>Reconciliation</h2>
    <div class="row">
      <label class="mut">hours</label>
      <input id="recon-hours" type="number" value="24" min="1" max="168" style="width:80px">
      <button id="b-recon">Run reconciliation</button>
    </div>
    <div id="out-recon"></div>
  </div>

  <div class="card">
    <h2>Lead trail</h2>
    <div class="row">
      <input id="lead-id" placeholder="lead_id (UUID / opaque)" style="width:340px">
      <button id="b-lead">Fetch trail</button>
    </div>
    <div id="out-lead"></div>
  </div>

  <div class="card">
    <h2>DLQ replay</h2>
    <div class="row">
      <input id="dlq-key" placeholder="R2 key (egy record)" style="width:360px">
      <button id="b-replay-key">Replay key</button>
      <button class="sec" id="b-discard-key">Discard (do-not-replay)</button>
    </div>
    <div class="row" style="margin-top:8px">
      <input id="dlq-site" placeholder="site_id (opcionális, bulk)" style="width:200px">
      <label class="mut">max</label>
      <input id="dlq-max" type="number" value="50" min="1" max="100" style="width:80px">
      <button id="b-replay-bulk">Bulk replay</button>
    </div>
    <div id="out-dlq"></div>
  </div>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  $('host').textContent = location.host;

  var KEY = 'eg_admin_token';
  function getToken() { return sessionStorage.getItem(KEY) || ''; }
  function setAuthState() {
    var t = getToken();
    $('authstate').textContent = t ? 'connected' : 'not connected';
    $('authstate').className = t ? 'ok' : 'mut';
    if (t && !$('token').value) $('token').value = t;
  }
  $('connect').addEventListener('click', function () {
    sessionStorage.setItem(KEY, $('token').value.trim());
    setAuthState();
  });
  $('forget').addEventListener('click', function () {
    sessionStorage.removeItem(KEY); $('token').value = ''; setAuthState();
  });
  setAuthState();

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-Admin-Token': getToken() };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body })
      .then(function (r) {
        return r.text().then(function (txt) {
          var body; try { body = JSON.parse(txt); } catch (e) { body = txt; }
          return { status: r.status, body: body };
        });
      });
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function badge(status) { return el('span', 'badge ' + status, status); }
  function errLine(out, res) {
    clear(out);
    var p = el('p', 'err', 'HTTP ' + res.status + ' — ' + (res.body && res.body.error ? res.body.error : 'error'));
    out.appendChild(p);
  }
  function pre(obj) { return el('pre', '', JSON.stringify(obj, null, 2)); }

  // ── Health check ──
  $('b-health').addEventListener('click', function () {
    var out = $('out-health'); clear(out); out.appendChild(el('p', 'mut', 'Running…'));
    api('/api/event/admin/health-check').then(function (res) {
      clear(out);
      if (!res.body || !res.body.checks) { errLine(out, res); return; }
      var head = el('p');
      head.appendChild(el('span', '', 'Overall: '));
      head.appendChild(badge(res.body.overall));
      head.appendChild(el('span', 'mut', '  (site ' + (res.body.site_id || '?') + ')'));
      out.appendChild(head);
      var t = el('table');
      var thead = el('tr');
      ['Check', 'Status', 'Detail'].forEach(function (h) { thead.appendChild(el('th', '', h)); });
      t.appendChild(thead);
      res.body.checks.forEach(function (c) {
        var tr = el('tr');
        tr.appendChild(el('td', '', c.name));
        var td = el('td'); td.appendChild(badge(c.status)); tr.appendChild(td);
        tr.appendChild(el('td', 'mut', c.detail));
        t.appendChild(tr);
      });
      out.appendChild(t);
    });
  });

  // ── Reconciliation ──
  $('b-recon').addEventListener('click', function () {
    var out = $('out-recon'); clear(out); out.appendChild(el('p', 'mut', 'Running…'));
    var hours = encodeURIComponent($('recon-hours').value || '24');
    api('/api/event/admin/reconciliation?hours=' + hours).then(function (res) {
      clear(out);
      if (!res.body || !res.body.summary) { errLine(out, res); return; }
      var s = res.body.summary;
      var g = el('div', 'grid');
      function stat(label, val, cls) { var d = el('div', 'stat'); d.appendChild(el('b', cls || '', val)); d.appendChild(el('span', 'mut', label)); return d; }
      g.appendChild(stat('sites checked', s.sites_checked));
      g.appendChild(stat('warnings', s.warning_count, s.warning_count ? 'warning' : ''));
      g.appendChild(stat('critical', s.critical_count, s.critical_count ? 'critical' : ''));
      var worst = el('div', 'stat'); var b = el('b', '', ''); b.appendChild(badge(s.worst === 'none' ? 'PASS' : (s.worst === 'critical' ? 'FAIL' : 'WARN'))); worst.appendChild(b); worst.appendChild(el('span', 'mut', 'worst')); g.appendChild(worst);
      out.appendChild(g);
      if (s.findings && s.findings.length) {
        var t = el('table');
        var thead = el('tr');
        ['Site', 'Platform', 'Kind', 'Severity', 'Detail'].forEach(function (h) { thead.appendChild(el('th', '', h)); });
        t.appendChild(thead);
        s.findings.forEach(function (f) {
          var tr = el('tr');
          tr.appendChild(el('td', '', f.site_id));
          tr.appendChild(el('td', '', f.platform));
          tr.appendChild(el('td', '', f.kind));
          var td = el('td'); td.appendChild(badge(f.severity === 'critical' ? 'FAIL' : 'WARN')); tr.appendChild(td);
          tr.appendChild(el('td', 'mut', f.detail));
          t.appendChild(tr);
        });
        out.appendChild(t);
      } else {
        out.appendChild(el('p', 'ok', 'No drift findings.'));
      }
    });
  });

  // ── Lead trail ──
  $('b-lead').addEventListener('click', function () {
    var out = $('out-lead'); clear(out);
    var id = $('lead-id').value.trim();
    if (!id) { out.appendChild(el('p', 'err', 'lead_id required')); return; }
    out.appendChild(el('p', 'mut', 'Fetching…'));
    api('/api/event/admin/leads/' + encodeURIComponent(id)).then(function (res) {
      clear(out);
      if (!res.body || !res.body.trail) { errLine(out, res); return; }
      var tr = res.body.trail;
      out.appendChild(el('p', res.body.found ? 'ok' : 'mut', res.body.found ? 'Found.' : 'No records for this lead_id.'));
      [['events_raw', tr.events], ['deliveries', tr.deliveries], ['consent_receipts', tr.consent_receipts], ['lead_status', tr.lead_status]].forEach(function (pair) {
        out.appendChild(el('h3', 'mut', pair[0] + ' (' + (pair[1] ? pair[1].length : 0) + ')'));
        out.appendChild(pre(pair[1] || []));
      });
    });
  });

  // ── DLQ ──
  function dlqPost(payload, out) {
    clear(out); out.appendChild(el('p', 'mut', 'Working…'));
    api('/api/event/admin/dlq/replay', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      clear(out);
      if (res.status >= 400) { errLine(out, res); return; }
      out.appendChild(pre(res.body));
    });
  }
  $('b-replay-key').addEventListener('click', function () {
    var k = $('dlq-key').value.trim();
    if (!k) { var o = $('out-dlq'); clear(o); o.appendChild(el('p', 'err', 'key required')); return; }
    dlqPost({ key: k }, $('out-dlq'));
  });
  $('b-discard-key').addEventListener('click', function () {
    var k = $('dlq-key').value.trim();
    if (!k) { var o = $('out-dlq'); clear(o); o.appendChild(el('p', 'err', 'key required')); return; }
    dlqPost({ key: k, discard: true }, $('out-dlq'));
  });
  $('b-replay-bulk').addEventListener('click', function () {
    var payload = { max: parseInt($('dlq-max').value, 10) || 50 };
    var site = $('dlq-site').value.trim();
    if (site) payload.site_id = site;
    dlqPost(payload, $('out-dlq'));
  });
})();
</script>
</body>
</html>`;
