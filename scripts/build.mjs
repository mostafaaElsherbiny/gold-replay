// Assembles the static site in dist/ (what GitHub Pages serves): the app, the chart library and the data.
// Run `npm run fetch` first so data/xauusd-m1.json exists.
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const data = join(root, 'data', 'xauusd-m1.json');

try {
    await stat(data);
} catch {
    console.error('data/xauusd-m1.json is missing. Run `npm run fetch` first.');
    process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await cp(join(root, 'public'), dist, { recursive: true });
await mkdir(join(dist, 'vendor'), { recursive: true });
await cp(join(root, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'), join(dist, 'vendor/lightweight-charts.js'));
await mkdir(join(dist, 'data'), { recursive: true });
await cp(data, join(dist, 'data/xauusd-m1.json'));
console.log('Built dist/');
