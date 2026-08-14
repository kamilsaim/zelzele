#!/usr/bin/env node
/**
 * Gelistirme sunucusu. Uygulama file:// ile acilmaz (service worker ve fetch
 * calismaz), o yuzden yerelde bunun uzerinden calistirilir.
 *
 *   node scripts/serve.mjs        -> http://localhost:8099
 *   PORT=3000 node scripts/serve.mjs
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Kok disina cikan yollari reddet
  const target = normalize(join(ROOT, urlPath));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('Yasak');
    return;
  }

  let file = target;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bulunamadi: ' + urlPath);
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // Gelistirirken tarayici eski surumu tutmasin
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bulunamadi: ' + urlPath);
  }
}).listen(PORT, () => {
  const lan = Object.values(networkInterfaces()).flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  console.log(`\n  Bilgisayar:  http://localhost:${PORT}`);
  if (lan) console.log(`  Telefon:     http://${lan}:${PORT}   (ayni wifi'de)`);
  console.log('\n  Durdurmak icin Ctrl+C\n');
});
