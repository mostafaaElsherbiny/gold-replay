// Zero-dependency static server for the replay app: `npm start`, then open http://localhost:5174
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5174);

const routes = {
    '/vendor/lightweight-charts.js': join(root, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'),
    '/data/xauusd-m1.json': join(root, 'data/xauusd-m1.json'),
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = routes[path] ?? join(root, 'public', normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(root)) file = '';
    try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(await readFile(file));
    } catch {
        const missingData = path.startsWith('/data/');
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(missingData ? 'No data yet: run `npm run fetch` first.' : 'Not found');
    }
}).listen(port, '127.0.0.1', () => console.log(`Gold Replay running at http://localhost:${port}`));
