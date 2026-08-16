/**
 * Függőség nélküli statikus szerver a Playwright-fixture-höz.
 *
 * Két dolgot csinál:
 *  1. kiszolgálja a tests/e2e/dist build-et,
 *  2. elnyeli a `/api/event/conversion` POST-okat 204-gyel, és megjegyzi a
 *     body-kat (a `/__posts` végponton lekérdezhetők) — így a teszt látja, MIT
 *     küldött volna a böngésző-leg, valódi gateway nélkül.
 *
 * Kifelé menő hálózat NINCS: a fixture nem tölt GTM-et, Pixelt vagy bármi
 * harmadik felet, tehát bármely külső kérés a tesztben eleve hiba.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const ROOT = fileURLToPath(new URL('./dist', import.meta.url));
const PORT = Number(process.env.E2E_PORT || 4173);
const posts = [];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/event/conversion') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { posts.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* ignore */ }
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/__posts') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(posts));
    return;
  }
  if (url.pathname === '/__posts/reset') {
    posts.length = 0;
    res.writeHead(204).end();
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`e2e fixture on http://localhost:${PORT}`);
});
