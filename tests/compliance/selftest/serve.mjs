/**
 * Függőség nélküli statikus szerver az önteszt-fixture-höz.
 *
 * A `/api/*` POST-okat SZÁNDÉKOSAN kiszolgálná — épp az a lényeg, hogy a harness
 * safety-netje miatt SOHA nem érkezik ide egy sem. Ha ez a számláló nem nulla,
 * a védvonal lyukas, és az önteszt bukik.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const ROOT = fileURLToPath(new URL('./fixture', import.meta.url));
const PORT = Number(process.env.COMPLIANCE_SELFTEST_PORT || 4187);
const received = { posts: [] };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    received.posts.push({ method: req.method, path: url.pathname, at: new Date().toISOString() });
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/__received') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(received));
    return;
  }
  if (url.pathname === '/cookie-policy.html') {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<h1>Süti-tájékoztató</h1><p>Harmadik felek: Google, Meta (Facebook), CookieYes.</p>');
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const body = await readFile(join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, '')));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`selftest fixture: http://localhost:${PORT}`));
