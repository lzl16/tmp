import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../public/',import.meta.url));
const port = Number(process.env.PORT || 4173);
const cloudPreview = process.argv.includes('--cloud');
const types = {'.html':'text/html; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json'};
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/config.js' && !cloudPreview) {
      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});
      res.end('window.SCOREKEEPER_CONFIG = Object.freeze({envId:""});');
      return;
    }
    const requested = path.resolve(root,'.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!requested.startsWith(root)) {res.writeHead(403);res.end();return;}
    const body = await readFile(requested);
    res.writeHead(200,{'Content-Type':types[path.extname(requested)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(body);
  } catch {res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',() => console.log(`Local: http://127.0.0.1:${port}`));
