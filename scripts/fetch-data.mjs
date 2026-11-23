// Downloads 1-minute XAUUSD (spot gold) candles from Dukascopy's free historical feed
// and writes them to data/xauusd-m1.json for the replay app.
//
//   npm run fetch                      -> the last 5 months up to now
//   npm run fetch -- --months 8        -> the last 8 months
//   npm run fetch -- --from 2026-01-01 --to 2026-06-30
import { getHistoricalRates } from 'dukascopy-node';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'data', 'xauusd-m1.json');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
}

const to = arg('to') ? new Date(`${arg('to')}T23:59:59Z`) : new Date();
let from;
if (arg('from')) {
    from = new Date(`${arg('from')}T00:00:00Z`);
} else {
    from = new Date(to);
    from.setUTCMonth(from.getUTCMonth() - Number(arg('months') ?? 5));
    from.setUTCHours(0, 0, 0, 0);
}

console.log(`Downloading XAUUSD 1m bid candles ${from.toISOString().slice(0, 10)} -> ${to.toISOString().slice(0, 16)}Z ...`);
const started = Date.now();

const rows = await getHistoricalRates({
    instrument: 'xauusd',
    dates: { from, to },
    timeframe: 'm1',
    priceType: 'bid',
    volumes: true,
    volumeUnits: 'units',
    ignoreFlats: true, // drop the zero-volume bars Dukascopy keeps while the market is closed
    format: 'array', // [timestampMs, open, high, low, close, volume]
    batchSize: 10,
    pauseBetweenBatchesMs: 300,
    useCache: true,
    cacheFolderPath: join(root, '.dukascopy-cache'),
    retryCount: 3,
    retryOnEmpty: false, // weekends and holidays are legitimately empty
});

if (!rows.length) {
    console.error('No data came back. Check your internet connection and the dates.');
    process.exit(1);
}

rows.sort((a, b) => a[0] - b[0]);
const r3 = (x) => Math.round(x * 1000) / 1000;
const data = { symbol: 'XAUUSD', source: 'Dukascopy (bid)', tf: '1m', t: [], o: [], h: [], l: [], c: [], v: [] };
let last = -1;
for (const [ts, o, h, l, c, v] of rows) {
    const t = Math.floor(ts / 1000);
    if (t <= last) continue; // skip duplicates at batch edges
    last = t;
    data.t.push(t);
    data.o.push(r3(o));
    data.h.push(r3(h));
    data.l.push(r3(l));
    data.c.push(r3(c));
    data.v.push(Math.round(v ?? 0));
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(data));

const first = new Date(data.t[0] * 1000).toISOString();
const end = new Date(data.t.at(-1) * 1000).toISOString();
console.log(`Saved ${data.t.length.toLocaleString()} bars (${first} -> ${end}) to data/xauusd-m1.json in ${((Date.now() - started) / 1000).toFixed(0)}s`);
