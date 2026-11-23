/* Gold Replay: bar-by-bar replay of XAUUSD 1-minute data, aggregated to any timeframe,
   with a practice trading panel. Everything runs in the browser; state lives in localStorage. */
'use strict';

const { createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, CrosshairMode, LineStyle } = window.LightweightCharts;

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'gold-replay:v1';
const OZ_PER_LOT = 100;
const UP = '#26a69a';
const DOWN = '#ef5350';
const TFS = [
    { m: 1, label: '1m' }, { m: 5, label: '5m' }, { m: 15, label: '15m' }, { m: 30, label: '30m' },
    { m: 60, label: '1h' }, { m: 240, label: '4h' }, { m: 1440, label: '1D' },
];
const EMAS = [{ p: 20, color: '#4c8dff' }, { p: 50, color: '#e3b341' }, { p: 200, color: '#c678dd' }];

// Fibonacci level presets: 24 slots each, like the TradingView dialog.
const FIB_ORANGE = '#ff9800';
const FIB_TEMPLATES = {
    extensions: {
        name: 'x.414 / x.618 extensions',
        levels: Array.from({ length: 12 }, (_, k) => [k + 1.414, k + 1.618])
            .flat().map((v) => ({ v: +v.toFixed(3), on: true, color: FIB_ORANGE })),
    },
    classic: {
        name: 'Classic retracement',
        levels: [
            [0, '#9aa4b2', true], [0.236, '#ef5350', true], [0.382, '#ff9800', true], [0.5, '#4caf50', true],
            [0.618, '#e3b341', true], [0.786, '#4c8dff', true], [1, '#9aa4b2', true], [1.272, '#c678dd', true],
            [1.618, '#ec407a', true], [1.414, '#ef5350', false], [2, '#4caf50', false], [2.272, '#ff9800', false],
            [2.414, '#4caf50', false], [2.618, '#ef5350', false], [3, '#26a69a', false], [3.272, '#9aa4b2', false],
            [3.414, '#4c8dff', false], [3.618, '#c678dd', false], [4, '#ef5350', false], [4.236, '#ec407a', false],
            [4.272, '#c678dd', false], [4.414, '#ff9800', false], [4.618, '#4caf50', false], [4.764, '#26a69a', false],
        ].map(([v, color, on]) => ({ v, on, color })),
    },
};
function defaultFibStyle() {
    return {
        trend: { on: true, color: '#808080', style: 'dashed' },
        line: { style: 'solid', width: 1 },
        extend: 'right', // none | right | left | both
        levels: structuredClone(FIB_TEMPLATES.extensions.levels),
        background: { on: false, opacity: 0.08 },
        reverse: false,
        prices: true,
        showLevels: true,
        levelFormat: 'values', // values | percents
        labelH: 'left', // left | center | right
        labelV: 'middle', // top | middle | bottom
    };
}
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const TZS = [...new Set([LOCAL_TZ, 'UTC', 'Asia/Riyadh', 'Africa/Cairo', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'Asia/Tokyo'])];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ persisted state */

const DEFAULTS = {
    tf: 15, tz: LOCAL_TZ, speed: 3, unit: 'bar', chartType: 'candles', ema: [true, true, false], vol: true, cursorT: null,
    lots: 0.1, slDist: 5, tpDist: 10, spread: 0.3, startBalance: 10000, balance: 10000,
    position: null, trades: [], hlines: [], fibs: [], fibStyle: defaultFibStyle(), nextId: 1,
};
const S = loadState();

function loadState() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
    } catch { /* private window or blocked storage: start fresh */ }
    return structuredClone(DEFAULTS);
}
let saveTimer = 0;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
    if (N) S.cursorT = T[cursor];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* ignore */ }
}
addEventListener('pagehide', saveNow);

/* ------------------------------------------------------------------ data */

let N = 0;
let T, O, H, L, C, V; // 1-minute bars, columnar
let cursor = 0; // index of the last revealed 1-minute bar
let bars = []; // bars of the current timeframe built from minutes 0..cursor
const ema = EMAS.map(() => []);
const ha = []; // Heikin Ashi values per bar, kept only while the chart shows Heikin Ashi

function idxAtOrBefore(t) { // last minute index with T[i] <= t, or -1
    let lo = 0, hi = N - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (T[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}
function barIdxForMinute(i) { // index in `bars` of the bar holding minute i
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bars[mid].i0 <= i) lo = mid; else hi = mid - 1;
    }
    return lo;
}
function barIdxForTime(time) {
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid].time === time) return mid;
        if (bars[mid].time < time) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

/* ------------------------------------------------------------------ time zones */

const dtfCache = new Map();
const offCache = new Map();
function tzOff(tz, utcSec) { // seconds to add to UTC to get wall-clock time in tz
    if (tz === 'UTC') return 0;
    const hour = Math.floor(utcSec / 3600);
    const key = tz + '|' + hour;
    let off = offCache.get(key);
    if (off === undefined) {
        let dtf = dtfCache.get(tz);
        if (!dtf) {
            dtf = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
                hour: 'numeric', minute: 'numeric', second: 'numeric',
            });
            dtfCache.set(tz, dtf);
        }
        const p = Object.fromEntries(dtf.formatToParts(new Date(hour * 3600000)).map((x) => [x.type, x.value]));
        off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - hour * 3600;
        offCache.set(key, off);
    }
    return off;
}
const pad = (n) => String(n).padStart(2, '0');
function fmtWall(utcSec) {
    const d = new Date((utcSec + tzOff(S.tz, utcSec)) * 1000);
    return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function toInputValue(utcSec) {
    const d = new Date((utcSec + tzOff(S.tz, utcSec)) * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fromInputValue(str) { // wall-clock "YYYY-MM-DDTHH:MM" in S.tz -> UTC seconds
    const [d, tm] = str.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [hh, mi] = (tm || '00:00').split(':').map(Number);
    const wall = Date.UTC(y, mo - 1, da, hh, mi) / 1000;
    let utc = wall - tzOff(S.tz, wall);
    utc = wall - tzOff(S.tz, utc);
    return utc;
}

/* ------------------------------------------------------------------ timeframe buckets */

// Up to 1h, bars start on UTC boundaries. 4h and daily bars follow the forex day, which
// starts at 17:00 New York (so the Sunday-evening open begins Monday's daily bar).
function bucket(t) {
    const tf = S.tf * 60;
    if (S.tf < 240) return t - (t % tf);
    const off = tzOff('America/New_York', t) - 17 * 3600;
    const local = t + off;
    return local - (((local % tf) + tf) % tf) - off;
}
function chartTime(b) { // the timestamp the chart shows: wall-clock time in the chosen zone, as if it were UTC
    if (S.tf >= 1440) { // label a forex day by its trading date
        const d = new Date((b + tzOff('America/New_York', b) + 7 * 3600) * 1000);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    }
    return b + tzOff(S.tz, b);
}
function extendBar(bar, i) {
    if (H[i] > bar.h) bar.h = H[i];
    if (L[i] < bar.l) bar.l = L[i];
    bar.c = C[i];
    bar.v += V[i];
    bar.i1 = i;
}
function addMinute(i) {
    const b = bucket(T[i]);
    const last = bars[bars.length - 1];
    if (last && last.b === b) { extendBar(last, i); return; }
    let time = chartTime(b);
    if (last && time <= last.time) time = last.time + 1; // the clocks went back: keep times ascending
    bars.push({ b, time, o: O[i], h: H[i], l: L[i], c: C[i], v: V[i], i0: i, i1: i });
}
function aggregateAll() {
    bars = [];
    for (let i = 0; i <= cursor; i++) addMinute(i);
}

/* ------------------------------------------------------------------ chart */

const chartEl = $('#chart');
const chart = createChart(chartEl, {
    autoSize: true,
    layout: { background: { color: '#0e1013' }, textColor: '#8a93a3', fontSize: 12, attributionLogo: true },
    grid: { vertLines: { color: '#171b21' }, horzLines: { color: '#171b21' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#262b34', scaleMargins: { top: 0.08, bottom: 0.12 } },
    timeScale: { borderColor: '#262b34', timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8 },
    localization: {
        priceFormatter: (p) => p.toFixed(2),
        timeFormatter: (t) => {
            const d = new Date(t * 1000);
            const day = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
            return S.tf >= 1440 ? day : `${day}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
    },
});
const volume = chart.addSeries(HistogramSeries, {
    priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
});
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
const emaSeries = EMAS.map((e) => chart.addSeries(LineSeries, {
    color: e.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
}));
const candles = chart.addSeries(CandlestickSeries, {
    upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
});
const markers = createSeriesMarkers(candles, []);
let markersDirty = false;

// Heikin Ashi: close = average of the real OHLC, open = midpoint of the previous HA candle's body.
// Each HA candle depends on the one before, so callers must go through the bars in order.
function haAt(j) {
    const b = bars[j];
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = j === 0 ? (b.o + b.c) / 2 : (ha[j - 1].o + ha[j - 1].c) / 2;
    ha[j] = { o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c };
    return ha[j];
}
function toCandle(b, j) {
    if (S.chartType !== 'ha') return { time: b.time, open: b.o, high: b.h, low: b.l, close: b.c };
    const x = haAt(j);
    return { time: b.time, open: x.o, high: x.h, low: x.l, close: x.c };
}
const toVol = (b) => ({ time: b.time, value: b.v, color: b.c >= b.o ? 'rgba(38,166,154,.32)' : 'rgba(239,83,80,.32)' });
function emaAt(k, j) {
    const a = 2 / (EMAS[k].p + 1);
    ema[k][j] = j === 0 ? bars[0].c : a * bars[j].c + (1 - a) * ema[k][j - 1];
    return { time: bars[j].time, value: ema[k][j] };
}
function setAll() {
    ha.length = 0;
    candles.setData(bars.map(toCandle));
    volume.setData(bars.map(toVol));
    EMAS.forEach((_, k) => {
        ema[k] = [];
        emaSeries[k].setData(bars.map((__, j) => emaAt(k, j)));
    });
    markersDirty = true;
}
function pushFrom(j0) { // send bars[j0..] (changed or new) to the chart
    if (bars.length - j0 > 400) return setAll();
    for (let j = Math.max(0, j0); j < bars.length; j++) {
        candles.update(toCandle(bars[j], j));
        volume.update(toVol(bars[j]));
        EMAS.forEach((_, k) => emaSeries[k].update(emaAt(k, j)));
    }
}
function applyIndicatorVisibility() {
    EMAS.forEach((_, k) => emaSeries[k].applyOptions({ visible: !!S.ema[k] }));
    volume.applyOptions({ visible: !!S.vol });
}

/* ------------------------------------------------------------------ replay engine */

function advanceTo(target) {
    target = Math.min(target, N - 1);
    if (target <= cursor) return;
    const j0 = bars.length - 1;
    for (let i = cursor + 1; i <= target; i++) {
        cursor = i;
        addMinute(i);
        checkExits(i);
    }
    pushFrom(j0);
    afterMove();
}

function retreatTo(target) {
    target = Math.max(0, target);
    if (target >= cursor) return;
    let popped = 0;
    while (bars.length > 1 && bars[bars.length - 1].i0 > target) { bars.pop(); popped++; }
    const last = bars[bars.length - 1];
    if (last.i1 > target) { // rebuild the bar that is now partly hidden
        const i0 = last.i0;
        Object.assign(last, { o: O[i0], h: H[i0], l: L[i0], c: C[i0], v: V[i0], i1: i0 });
        for (let i = i0 + 1; i <= target; i++) extendBar(last, i);
    }
    cursor = target;
    if (popped > 300) {
        setAll();
    } else {
        if (popped) {
            candles.pop(popped);
            volume.pop(popped);
            emaSeries.forEach((s) => s.pop(popped));
            EMAS.forEach((_, k) => { ema[k].length = bars.length; });
            ha.length = Math.min(ha.length, bars.length);
        }
        pushFrom(bars.length - 1);
    }
    markersDirty = true;
    afterMove();
}

function endOfBarFrom(i) { // last minute of the bar that minute i belongs to
    const b = bucket(T[i]);
    while (i + 1 < N && bucket(T[i + 1]) === b) i++;
    return i;
}

function stepForward() {
    if (cursor >= N - 1) {
        pause();
        toast('That was the latest bar. Run "npm run fetch" to download newer data.');
        return false;
    }
    advanceTo(S.unit === 'minute' ? cursor + 1 : endOfBarFrom(cursor + 1));
    return true;
}

function stepBack() {
    pause();
    if (cursor <= 0) return;
    const target = S.unit === 'minute' ? cursor - 1 : bars[bars.length - 1].i0 - 1;
    if (target < lockIndex()) {
        toast(S.position ? 'Close the position before stepping back past its entry.' : 'You can’t step back past your last trade.');
        return;
    }
    retreatTo(target);
}

// The earliest minute you may step back to without undoing a trade.
function lockIndex() {
    let lock = -1;
    const now = T[cursor];
    const see = (t) => { if (t != null && t <= now) lock = Math.max(lock, idxAtOrBefore(t)); };
    for (const tr of S.trades) { see(tr.entryT); see(tr.exitT); }
    if (S.position) see(S.position.entryT);
    return lock;
}

function seek(target) {
    if (S.position) { toast('Close your open position first.'); return false; }
    pause();
    cursor = Math.max(0, Math.min(N - 1, target));
    aggregateAll();
    setAll();
    chart.timeScale().scrollToRealTime();
    $('#startCard').hidden = true;
    afterMove();
    return true;
}

function randomStart() {
    const lo = Math.floor(N * 0.15); // keep a few weeks of history on the left
    const hi = Math.max(lo + 1, N - 1 - 7 * 1380); // and about a week of bars still to play
    seek(endOfBarFrom(lo + Math.floor(Math.random() * (hi - lo))));
}

let playing = false;
let playTimer = 0;
function play() {
    if (cursor >= N - 1) { toast('Pick a start point first: Select bar, Random, or a date.'); return; }
    playing = true;
    setPlayIcon();
    tick();
}
function tick() {
    if (!playing) return;
    if (stepForward()) playTimer = setTimeout(tick, 1000 / S.speed);
}
function pause() {
    playing = false;
    clearTimeout(playTimer);
    setPlayIcon();
}
function setPlayIcon() {
    $('#playIcon').innerHTML = playing
        ? '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/>'
        : '<path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/>';
}

/* ------------------------------------------------------------------ trading */

const round2 = (x) => Math.round(x * 100) / 100;
const bid = () => C[cursor];
const ask = () => C[cursor] + S.spread;
const pnlFor = (p, exit) => (exit - p.entry) * p.side * OZ_PER_LOT * p.lots;

function openPosition(side) {
    if (S.position) { toast('You already have a position. Close it first (X).'); return; }
    if (!(S.lots > 0)) { toast('Set a lot size first.'); return; }
    const entry = side > 0 ? ask() : bid();
    S.position = {
        side, lots: S.lots, entry, entryT: T[cursor],
        sl: S.slDist > 0 ? round2(entry - side * S.slDist) : null,
        tp: S.tpDist > 0 ? round2(entry + side * S.tpDist) : null,
    };
    drawPositionLines();
    markersDirty = true;
    afterMove();
}

function closePosition(price, reason, i) {
    const p = S.position;
    if (!p) return;
    const pnl = round2(pnlFor(p, price));
    S.balance = round2(S.balance + pnl);
    S.trades.push({
        id: S.nextId++, side: p.side, lots: p.lots, entry: p.entry, exit: price,
        entryT: p.entryT, exitT: T[i], sl: p.sl, tp: p.tp, pnl, reason,
    });
    S.position = null;
    drawPositionLines();
    markersDirty = true;
    renderTrades();
    if (reason !== 'Manual') {
        pause();
        toast(`${reason === 'TP' ? 'Take profit' : 'Stop loss'} hit at ${price.toFixed(2)}: ${fmtUsd(pnl, true)}`);
    }
}

function manualClose() {
    const p = S.position;
    if (!p) return;
    closePosition(p.side > 0 ? bid() : ask(), 'Manual', cursor);
    afterMove();
}

// Runs on every newly revealed minute. Longs exit on the bid, shorts on the ask (bid + spread).
// A gap through a level fills at the open; if one minute touches both, the stop counts first.
function checkExits(i) {
    const p = S.position;
    if (!p) return;
    const add = p.side < 0 ? S.spread : 0;
    const o = O[i] + add, h = H[i] + add, l = L[i] + add;
    if (p.side > 0) {
        if (p.sl != null && l <= p.sl) return closePosition(Math.min(o, p.sl), 'SL', i);
        if (p.tp != null && h >= p.tp) return closePosition(Math.max(o, p.tp), 'TP', i);
    } else {
        if (p.sl != null && h >= p.sl) return closePosition(Math.max(o, p.sl), 'SL', i);
        if (p.tp != null && l <= p.tp) return closePosition(Math.min(o, p.tp), 'TP', i);
    }
}

let posLines = {};
function lineTitle(kind) {
    const p = S.position;
    if (kind === 'entry') return `${p.side > 0 ? 'LONG' : 'SHORT'} ${p.lots}`;
    return `${kind.toUpperCase()} ${fmtUsd(pnlFor(p, p[kind]), true)}`;
}
function drawPositionLines() {
    Object.values(posLines).forEach((l) => candles.removePriceLine(l));
    posLines = {};
    const p = S.position;
    if (!p) return;
    posLines.entry = candles.createPriceLine({ price: p.entry, color: '#8a93a3', lineWidth: 1, lineStyle: LineStyle.Dashed, title: lineTitle('entry') });
    if (p.sl != null) posLines.sl = candles.createPriceLine({ price: p.sl, color: DOWN, lineWidth: 1, lineStyle: LineStyle.Solid, title: lineTitle('sl') });
    if (p.tp != null) posLines.tp = candles.createPriceLine({ price: p.tp, color: UP, lineWidth: 1, lineStyle: LineStyle.Solid, title: lineTitle('tp') });
}
function setLevel(kind, price) {
    const p = S.position;
    if (!p) return;
    p[kind] = price == null ? null : round2(price);
    if (posLines[kind] && p[kind] != null) {
        posLines[kind].applyOptions({ price: p[kind], title: lineTitle(kind) });
    } else {
        drawPositionLines();
    }
    renderPosition();
    save();
}

/* ------------------------------------------------------------------ horizontal lines + dragging */

let hlineObjs = [];
function drawHlines() {
    hlineObjs.forEach((l) => candles.removePriceLine(l));
    hlineObjs = S.hlines.map((price) => candles.createPriceLine({
        price, color: '#5b8def', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '',
    }));
}

/* ------------------------------------------------------------------ Fibonacci retracement */

// Drawn from point 1 to point 2 the TradingView way: level 0 sits on point 2 and level 1 on point 1,
// so drawing swing low -> swing high measures pullbacks from the high. "Reverse" swaps the two.
// How it looks (levels, colours, lines, labels) comes from S.fibStyle and applies to every drawing.
let fibDraft = null; // { a, b } while the second point is being placed
let fibGeoms = []; // screen geometry, recomputed whenever the chart redraws

// Anchors are { t: UTC minute, p: price }, so they stay on the same candle across timeframes and time zones.
function anchorBar(t) { // index in `bars` of the bar holding minute t, or null if it isn't revealed yet
    if (t > T[cursor]) return null;
    const i = idxAtOrBefore(t);
    return i < 0 ? null : barIdxForMinute(i);
}
function anchorAt(x, y) { // the anchor under a pane point; snaps to the candle's high or low within 10px
    const lg = chart.timeScale().coordinateToLogical(x);
    let p = candles.coordinateToPrice(y);
    if (lg == null || p == null) return null;
    const j = Math.max(0, Math.min(bars.length - 1, Math.round(lg)));
    const shown = S.chartType === 'ha' && ha[j] ? ha[j] : bars[j];
    let best = 10;
    for (const level of [shown.h, shown.l]) {
        const ly = candles.priceToCoordinate(level);
        if (ly != null && Math.abs(ly - y) <= best) { best = Math.abs(ly - y); p = level; }
    }
    return { t: T[bars[j].i0], p };
}
function fibGeom(f) {
    const ja = anchorBar(f.a.t), jb = anchorBar(f.b.t);
    if (ja == null || jb == null) return null;
    const ts = chart.timeScale();
    const xA = ts.logicalToCoordinate(ja), xB = ts.logicalToCoordinate(jb);
    const yA = candles.priceToCoordinate(f.a.p), yB = candles.priceToCoordinate(f.b.p);
    if (xA == null || xB == null || yA == null || yB == null) return null;
    const st = S.fibStyle;
    const [one, zero] = st.reverse ? [f.b.p, f.a.p] : [f.a.p, f.b.p]; // prices of level 1 and level 0
    const levels = st.levels.filter((l) => l.on && Number.isFinite(l.v)).map((l) => {
        const price = zero + (one - zero) * l.v;
        return { lv: l.v, color: l.color, price, y: candles.priceToCoordinate(price) };
    });
    const width = ts.width();
    const x1 = Math.min(xA, xB), x2 = Math.max(xA, xB);
    const left = st.extend === 'left' || st.extend === 'both' ? 0 : x1;
    const right = st.extend === 'right' || st.extend === 'both' ? width : x2;
    return { xA, yA, xB, yB, left, right, width, levels };
}
function fibAt(x, y) { // what part of a Fibonacci drawing is under a pane point
    if (!N) return null;
    for (let k = S.fibs.length - 1; k >= 0; k--) {
        const g = fibGeom(S.fibs[k]);
        if (!g) continue;
        if (Math.hypot(x - g.xA, y - g.yA) <= 7) return { kind: 'fibA', idx: k };
        if (Math.hypot(x - g.xB, y - g.yB) <= 7) return { kind: 'fibB', idx: k };
        const onLevel = g.levels.some((l) => l.y != null && Math.abs(l.y - y) <= 4);
        if (onLevel && x >= g.left - 3 && x <= g.right + 3) return { kind: 'fibMove', idx: k };
    }
    return null;
}

const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const DASHES = { solid: [], dashed: [6, 4], dotted: [1.5, 3] };
function fibLabel(st, l) {
    const lv = st.levelFormat === 'percents' ? `${+(l.lv * 100).toFixed(2)}%` : String(+l.lv.toFixed(4));
    return [st.showLevels ? lv : '', st.prices ? `(${l.price.toFixed(2)})` : ''].filter(Boolean).join(' ');
}
function drawFibs(ctx) {
    const st = S.fibStyle;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    for (const g of fibGeoms) {
        if (st.background.on) { // fill between neighbouring levels with the outer level's colour
            const sorted = [...g.levels].sort((p, q) => p.lv - q.lv);
            for (let k = 0; k < sorted.length - 1; k++) {
                const u = sorted[k], v = sorted[k + 1];
                if (u.y == null || v.y == null) continue;
                ctx.fillStyle = rgba(v.color, st.background.opacity);
                ctx.fillRect(g.left, Math.min(u.y, v.y), g.right - g.left, Math.abs(v.y - u.y));
            }
        }
        ctx.lineWidth = st.line.width;
        ctx.setLineDash(DASHES[st.line.style] ?? []);
        const crisp = st.line.width % 2 ? 0.5 : 0;
        for (const l of g.levels) {
            if (l.y == null) continue;
            const y = Math.round(l.y) + crisp;
            ctx.strokeStyle = l.color;
            ctx.beginPath();
            ctx.moveTo(g.left, y);
            ctx.lineTo(g.right, y);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        if (st.showLevels || st.prices) {
            let x, align;
            if (st.labelH === 'center') { x = (g.left + g.right) / 2; align = 'center'; }
            else if (st.labelH === 'right') {
                [x, align] = g.right >= g.width - 1 ? [g.right - 6, 'right'] : [g.right + 6, 'left'];
            } else { // left: just before the lines start, or inside them when they run off the left edge
                [x, align] = g.left <= 1 ? [6, 'left'] : [g.left - 6, 'right'];
            }
            const [base, dy] = { top: ['bottom', -3], middle: ['middle', 0], bottom: ['top', 3] }[st.labelV] ?? ['middle', 0];
            ctx.textAlign = align;
            ctx.textBaseline = base;
            for (const l of g.levels) {
                if (l.y == null) continue;
                const label = fibLabel(st, l);
                ctx.lineWidth = 3; // dark outline keeps the label readable over candles
                ctx.strokeStyle = '#0e1013';
                ctx.strokeText(label, x, l.y + dy);
                ctx.fillStyle = l.color;
                ctx.fillText(label, x, l.y + dy);
            }
            ctx.textAlign = 'left';
        }

        if (st.trend.on) {
            ctx.lineWidth = 1;
            ctx.strokeStyle = st.trend.color;
            ctx.setLineDash(DASHES[st.trend.style] ?? []);
            ctx.beginPath();
            ctx.moveTo(g.xA, g.yA);
            ctx.lineTo(g.xB, g.yB);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.lineWidth = 1;
        for (const [x, y] of [[g.xA, g.yA], [g.xB, g.yB]]) {
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#0e1013';
            ctx.fill();
            ctx.strokeStyle = '#d8dde5';
            ctx.stroke();
        }
    }
}

let fibRequestUpdate = null;
const fibRenderer = { draw: (target) => target.useMediaCoordinateSpace(({ context }) => drawFibs(context)) };
const fibView = { zOrder: () => 'top', renderer: () => fibRenderer };
candles.attachPrimitive({
    attached: ({ requestUpdate }) => { fibRequestUpdate = requestUpdate; },
    detached: () => { fibRequestUpdate = null; },
    updateAllViews: () => {
        fibGeoms = N ? [...S.fibs, ...(fibDraft ? [fibDraft] : [])].map(fibGeom).filter(Boolean) : [];
    },
    paneViews: () => [fibView],
});
const redrawFibs = () => fibRequestUpdate?.();

/* ------------------------------------------------------------------ Fibonacci settings dialog */

const fibModal = $('#fibModal');
let fibBefore = null; // the style when the dialog opened, restored by Cancel
let fibEditIdx = null; // the drawing the dialog was opened from, for Delete

$('#fsLevels').innerHTML = Array.from({ length: 24 }, (_, k) => `<div class="lvl" data-k="${k}">`
    + `<input type="checkbox" data-f="on" aria-label="Show level ${k + 1}">`
    + `<input type="number" step="0.001" data-f="v" aria-label="Level ${k + 1} value">`
    + `<input type="color" data-f="color" aria-label="Level ${k + 1} colour"></div>`).join('');
$('#fsTemplate').insertAdjacentHTML('beforeend',
    Object.entries(FIB_TEMPLATES).map(([id, t]) => `<option value="${id}">${t.name}</option>`).join(''));

function fillFibForm() {
    const st = S.fibStyle;
    $('#fsTrendOn').checked = st.trend.on;
    $('#fsTrendColor').value = st.trend.color;
    $('#fsTrendStyle').value = st.trend.style;
    $('#fsLineStyle').value = st.line.style;
    $('#fsLineWidth').value = String(st.line.width);
    $('#fsExtend').value = st.extend;
    document.querySelectorAll('#fsLevels .lvl').forEach((row, k) => {
        const l = st.levels[k] ?? { v: null, on: false, color: FIB_ORANGE };
        row.querySelector('[data-f=on]').checked = l.on;
        row.querySelector('[data-f=v]').value = Number.isFinite(l.v) ? String(l.v) : '';
        row.querySelector('[data-f=color]').value = l.color;
        row.classList.toggle('off', !l.on);
    });
    $('#fsOneColor').value = st.levels[0]?.color ?? FIB_ORANGE;
    $('#fsBgOn').checked = st.background.on;
    $('#fsBgOpacity').value = String(st.background.opacity);
    $('#fsReverse').checked = st.reverse;
    $('#fsPrices').checked = st.prices;
    $('#fsShowLevels').checked = st.showLevels;
    $('#fsLevelFormat').value = st.levelFormat;
    $('#fsLabelH').value = st.labelH;
    $('#fsLabelV').value = st.labelV;
}
function readFibForm() { // every change previews live on the chart
    S.fibStyle = {
        trend: { on: $('#fsTrendOn').checked, color: $('#fsTrendColor').value, style: $('#fsTrendStyle').value },
        line: { style: $('#fsLineStyle').value, width: +$('#fsLineWidth').value },
        extend: $('#fsExtend').value,
        levels: [...document.querySelectorAll('#fsLevels .lvl')].map((row) => {
            const on = row.querySelector('[data-f=on]').checked;
            const raw = row.querySelector('[data-f=v]').value;
            row.classList.toggle('off', !on);
            return { v: raw === '' ? null : parseFloat(raw), on, color: row.querySelector('[data-f=color]').value };
        }),
        background: { on: $('#fsBgOn').checked, opacity: +$('#fsBgOpacity').value },
        reverse: $('#fsReverse').checked,
        prices: $('#fsPrices').checked,
        showLevels: $('#fsShowLevels').checked,
        levelFormat: $('#fsLevelFormat').value,
        labelH: $('#fsLabelH').value,
        labelV: $('#fsLabelV').value,
    };
    redrawFibs();
}
function openFibSettings(idx = null) {
    pause();
    if (tool) setTool(tool);
    fibBefore = structuredClone(S.fibStyle);
    fibEditIdx = idx;
    $('#fsDelete').hidden = idx == null;
    $('#fsTemplate').value = '';
    fillFibForm();
    fibModal.hidden = false;
    $('#fsTrendOn').focus();
}
function closeFibSettings(keep) {
    if (!keep && fibBefore) S.fibStyle = fibBefore;
    fibBefore = null;
    fibEditIdx = null;
    fibModal.hidden = true;
    redrawFibs();
    save();
}
$('#fibForm').addEventListener('input', (e) => {
    if (e.target.id === 'fsOneColor') {
        document.querySelectorAll('#fsLevels [data-f=color]').forEach((el) => { el.value = e.target.value; });
    }
    readFibForm();
});
$('#fibForm').addEventListener('change', readFibForm);
$('#fsTemplate').addEventListener('change', (e) => {
    const t = FIB_TEMPLATES[e.target.value];
    if (!t) return;
    S.fibStyle.levels = structuredClone(t.levels);
    fillFibForm();
    redrawFibs();
});
$('#fsDelete').onclick = () => {
    if (fibEditIdx != null) S.fibs.splice(fibEditIdx, 1);
    closeFibSettings(true);
};
fibModal.addEventListener('click', (e) => {
    if (e.target === fibModal) return closeFibSettings(false); // click outside the dialog
    const act = e.target.closest('[data-fib]')?.dataset.fib;
    if (act) closeFibSettings(act === 'ok');
});
$('#fibSettingsBtn').onclick = () => openFibSettings(null);

/* ------------------------------------------------------------------ tools */

let tool = null; // 'hline' | 'fib' | 'select' | null
function setTool(next) {
    tool = tool === next ? null : next;
    $('#hlineBtn').classList.toggle('on', tool === 'hline');
    $('#fibBtn').classList.toggle('on', tool === 'fib');
    $('#selectBtn').classList.toggle('on', tool === 'select');
    chartEl.classList.toggle('adding', tool === 'hline' || tool === 'fib');
    chartEl.classList.toggle('selecting', tool === 'select');
    $('#selectShade').hidden = true;
    if (tool !== 'fib' && fibDraft) { fibDraft = null; redrawFibs(); }
    if (tool === 'fib') toast('Fibonacci: click the first point, then the second (e.g. swing low, then swing high). Esc cancels.');
    if (tool === 'select') {
        $('#startCard').hidden = true;
        toast('Click the bar where the replay should start. Esc cancels.');
    }
}

function lineAt(y) { // the draggable line nearest to pane y (within 6px)
    const cands = S.hlines.map((price, idx) => ({ kind: 'h', idx, price }));
    if (S.position?.sl != null) cands.push({ kind: 'sl', price: S.position.sl });
    if (S.position?.tp != null) cands.push({ kind: 'tp', price: S.position.tp });
    let best = null;
    for (const c of cands) {
        const yy = candles.priceToCoordinate(c.price);
        if (yy == null) continue;
        const dist = Math.abs(yy - y);
        if (dist <= 6 && (!best || dist < best.dist)) best = { ...c, dist };
    }
    return best;
}
function panePoint(e) {
    const r = chartEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const inPane = x >= 0 && x <= chart.timeScale().width() && y >= 0 && y <= r.height - chart.timeScale().height();
    return { x, y, inPane };
}

let drag = null;
let hoverFib = null;
let downAt = null; // where the last press started, to tell a click from a pan
function onPointerDown(e) {
    downAt = { x: e.clientX, y: e.clientY };
    if (tool || e.button !== 0) return;
    const pt = panePoint(e);
    if (!pt.inPane) return;
    const hit = fibAt(pt.x, pt.y) ?? lineAt(pt.y);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation(); // keep the chart from starting a pan
    if (hit.kind === 'fibMove') {
        const f = S.fibs[hit.idx];
        hit.start = {
            logical: chart.timeScale().coordinateToLogical(pt.x), price: candles.coordinateToPrice(pt.y),
            ja: anchorBar(f.a.t), jb: anchorBar(f.b.t), pa: f.a.p, pb: f.b.p,
        };
    }
    drag = hit;
    chartEl.classList.add(hit.kind.startsWith('fib') ? 'grab' : 'ns-drag');
}
chartEl.addEventListener('pointerdown', onPointerDown, true);
chartEl.addEventListener('mousedown', (e) => { if (drag) { e.preventDefault(); e.stopPropagation(); } }, true);
chartEl.addEventListener('touchstart', (e) => { if (drag) e.stopPropagation(); }, true);
addEventListener('pointermove', (e) => {
    const pt = panePoint(e);
    if (!drag) {
        if (!tool) {
            const fibHit = pt.inPane ? fibAt(pt.x, pt.y) : null;
            hoverFib = fibHit ? fibHit.idx : null; // Delete / Backspace removes the drawing under the mouse
            chartEl.classList.toggle('grab', !!fibHit);
            chartEl.classList.toggle('ns-drag', !fibHit && pt.inPane && !!lineAt(pt.y));
        }
        return;
    }
    if (drag.kind === 'fibA' || drag.kind === 'fibB') {
        const anchor = anchorAt(pt.x, pt.y);
        if (anchor) { S.fibs[drag.idx][drag.kind === 'fibA' ? 'a' : 'b'] = anchor; redrawFibs(); }
        return;
    }
    if (drag.kind === 'fibMove') { // move the whole drawing by whole bars and by price
        const s = drag.start;
        const lg = chart.timeScale().coordinateToLogical(pt.x);
        const pr = candles.coordinateToPrice(pt.y);
        if (lg == null || pr == null || s.logical == null || s.price == null) return;
        const dL = Math.round(lg - s.logical), dP = pr - s.price;
        const barAt = (j) => bars[Math.max(0, Math.min(bars.length - 1, j + dL))];
        S.fibs[drag.idx] = { a: { t: T[barAt(s.ja).i0], p: s.pa + dP }, b: { t: T[barAt(s.jb).i0], p: s.pb + dP } };
        redrawFibs();
        return;
    }
    const price = candles.coordinateToPrice(pt.y);
    if (price == null) return;
    if (drag.kind === 'h') {
        S.hlines[drag.idx] = round2(price);
        hlineObjs[drag.idx].applyOptions({ price: S.hlines[drag.idx] });
    } else {
        setLevel(drag.kind, price);
    }
});
addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    chartEl.classList.remove('ns-drag', 'grab');
    save();
});

// Tool clicks use the native event: the chart's own click callback drops a click that comes
// soon after another one, which would lose the second point of a quickly drawn Fibonacci.
chartEl.addEventListener('click', (e) => {
    if (!tool) return;
    const pt = panePoint(e);
    if (!pt.inPane || (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5)) return; // that was a pan
    if (tool === 'hline') {
        const price = candles.coordinateToPrice(pt.y);
        if (price != null) { S.hlines.push(round2(price)); drawHlines(); save(); }
        setTool(null);
    } else if (tool === 'fib') {
        const anchor = anchorAt(pt.x, pt.y);
        if (!anchor) return;
        if (!fibDraft) {
            fibDraft = { a: anchor, b: anchor };
        } else {
            S.fibs.push({ a: fibDraft.a, b: anchor });
            fibDraft = null;
            setTool(null);
            save();
        }
        redrawFibs();
    } else if (tool === 'select') {
        const lg = chart.timeScale().coordinateToLogical(pt.x);
        const j = Math.max(0, Math.min(bars.length - 1, Math.round(lg ?? bars.length - 1)));
        setTool(null);
        seek(bars[j].i1);
    }
});
// A native listener too: pressing on a drawing is captured for dragging, so the chart never sees that double-click.
// Double-clicking a Fibonacci opens its settings (as on TradingView); a horizontal line is deleted.
chartEl.addEventListener('dblclick', (e) => {
    const pt = panePoint(e);
    if (tool || !pt.inPane) return;
    const fib = fibAt(pt.x, pt.y);
    if (fib) { openFibSettings(fib.idx); return; }
    const hit = lineAt(pt.y);
    if (hit?.kind === 'h') { S.hlines.splice(hit.idx, 1); drawHlines(); save(); }
});

/* ------------------------------------------------------------------ legend + select shade */

function renderLegend(bar, prevClose) {
    const el = $('#legend');
    if (!bar) { el.innerHTML = ''; return; }
    const cls = bar.c >= bar.o ? 'up' : 'down';
    const chg = prevClose ? bar.realC - prevClose : 0; // the change always uses real closes
    const pct = prevClose ? (chg / prevClose) * 100 : 0;
    const tf = TFS.find((x) => x.m === S.tf).label + (S.chartType === 'ha' ? ' · Heikin Ashi' : '');
    const emaTxt = EMAS.map((e, k) => (S.ema[k] && bar.ema?.[k] != null
        ? `<span style="color:${e.color}">EMA ${e.p} ${bar.ema[k].toFixed(2)}</span>` : '')).join('');
    el.innerHTML = `<span class="title">XAUUSD · ${tf}</span>`
        + `<span><b>O</b><span class="${cls}">${bar.o.toFixed(2)}</span></span>`
        + `<span><b>H</b><span class="${cls}">${bar.h.toFixed(2)}</span></span>`
        + `<span><b>L</b><span class="${cls}">${bar.l.toFixed(2)}</span></span>`
        + `<span><b>C</b><span class="${cls}">${bar.c.toFixed(2)}</span></span>`
        + `<span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`
        + emaTxt;
}
function legendFor(j) {
    if (j < 0 || j >= bars.length) return renderLegend(null);
    const b = bars[j];
    const shown = S.chartType === 'ha' && ha[j] ? ha[j] : b;
    renderLegend({ o: shown.o, h: shown.h, l: shown.l, c: shown.c, realC: b.c, ema: EMAS.map((_, k) => ema[k][j]) }, j > 0 ? bars[j - 1].c : null);
}
let hovering = false;
chart.subscribeCrosshairMove((param) => {
    if (tool === 'fib' && fibDraft && param.point) { // live preview while placing the second point
        const anchor = anchorAt(param.point.x, param.point.y);
        if (anchor) { fibDraft.b = anchor; redrawFibs(); }
    }
    if (tool === 'select' && param.point) {
        const shade = $('#selectShade');
        shade.hidden = false;
        shade.style.left = `${param.point.x}px`;
        shade.style.right = `${chartEl.clientWidth - chart.timeScale().width()}px`;
    }
    hovering = param.time != null;
    legendFor(hovering ? barIdxForTime(param.time) : bars.length - 1);
});

/* ------------------------------------------------------------------ side panel */

function fmtUsd(x, sign = false) {
    const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}$${s}`;
}
const pnlClass = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function openPnl() {
    const p = S.position;
    return p ? pnlFor(p, p.side > 0 ? bid() : ask()) : 0;
}

function renderAccount() {
    const op = openPnl();
    $('#balance').textContent = fmtUsd(S.balance);
    $('#equity').textContent = fmtUsd(S.balance + op);
    const el = $('#openPnl');
    el.textContent = S.position ? fmtUsd(op, true) : '—';
    el.className = pnlClass(op);
    $('#bidPx').textContent = bid().toFixed(2);
    $('#askPx').textContent = ask().toFixed(2);
}

function renderRisk() {
    const parts = [];
    const risk = S.slDist * OZ_PER_LOT * S.lots;
    const reward = S.tpDist * OZ_PER_LOT * S.lots;
    if (S.slDist > 0) parts.push(`Risk ${fmtUsd(risk)} (${((risk / S.balance) * 100).toFixed(2)}%)`);
    if (S.tpDist > 0) parts.push(`Reward ${fmtUsd(reward)}`);
    if (S.slDist > 0 && S.tpDist > 0) parts.push(`R:R 1:${(S.tpDist / S.slDist).toFixed(2)}`);
    $('#riskLine').textContent = parts.join(' · ') || 'No stop loss or take profit.';
}

function renderPosition() {
    const p = S.position;
    $('#positionCard').hidden = !p;
    $('#buyBtn').disabled = $('#sellBtn').disabled = !!p;
    if (!p) return;
    const op = openPnl();
    const side = $('#posSide');
    side.textContent = `${p.side > 0 ? 'LONG' : 'SHORT'} ${p.lots}`;
    side.className = `side ${p.side > 0 ? 'long' : 'short'}`;
    const pnlEl = $('#posPnl');
    pnlEl.textContent = fmtUsd(op, true);
    pnlEl.className = pnlClass(op);
    const lvl = (k) => (p[k] == null ? '—' : `${p[k].toFixed(2)} <span class="muted">(${fmtUsd(pnlFor(p, p[k]), true)})</span>`);
    $('#posRows').innerHTML = `<div class="kv"><span>Entry</span><span>${p.entry.toFixed(2)}</span></div>`
        + `<div class="kv"><span>Stop loss</span><span>${lvl('sl')}</span></div>`
        + `<div class="kv"><span>Take profit</span><span>${lvl('tp')}</span></div>`
        + `<div class="kv"><span>Opened</span><span>${fmtWall(p.entryT + 60)}</span></div>`;
    $('#slToggleBtn').textContent = p.sl == null ? '+ SL' : 'Remove SL';
    $('#tpToggleBtn').textContent = p.tp == null ? '+ TP' : 'Remove TP';
}

function renderStats() {
    const tr = S.trades;
    const wins = tr.filter((t) => t.pnl > 0);
    const losses = tr.filter((t) => t.pnl < 0);
    const gross = (xs) => xs.reduce((a, t) => a + t.pnl, 0);
    const net = gross(tr);
    const pf = losses.length ? gross(wins) / Math.abs(gross(losses)) : wins.length ? Infinity : 0;
    let peak = S.startBalance, eq = S.startBalance, mdd = 0;
    for (const t of tr) { eq += t.pnl; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
    const cell = (label, value, cls = '') => `<div><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
    $('#stats').innerHTML = cell('Net P&L', fmtUsd(net, true), pnlClass(net))
        + cell('Trades', tr.length)
        + cell('Win rate', tr.length ? `${Math.round((wins.length / tr.length) * 100)}%` : '—')
        + cell('Profit factor', !tr.length ? '—' : pf === Infinity ? '∞' : pf.toFixed(2))
        + cell('Avg win', wins.length ? fmtUsd(gross(wins) / wins.length) : '—', 'pos')
        + cell('Avg loss', losses.length ? fmtUsd(gross(losses) / losses.length) : '—', 'neg')
        + cell('Max drawdown', mdd ? fmtUsd(-mdd) : '—', mdd ? 'neg' : '')
        + cell('Return', `${(((S.balance - S.startBalance) / S.startBalance) * 100).toFixed(2)}%`, pnlClass(S.balance - S.startBalance));
}

function renderTrades() {
    const rows = [...S.trades].reverse().map((t) => `<tr title="Opened ${fmtWall(t.entryT + 60)} · closed ${fmtWall(t.exitT + 60)}">`
        + `<td>${t.id}</td><td class="${t.side > 0 ? 'pos' : 'neg'}">${t.side > 0 ? 'Buy' : 'Sell'} ${t.lots}</td>`
        + `<td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td>`
        + `<td class="${pnlClass(t.pnl)}">${fmtUsd(t.pnl, true)}</td><td class="why">${t.reason}</td></tr>`);
    $('#tradeRows').innerHTML = rows.join('') || '<tr class="empty"><td colspan="6">No trades yet.</td></tr>';
    renderStats();
}

function refreshMarkers() {
    const now = T[cursor];
    const list = [];
    const at = (t) => {
        if (t == null || t > now) return null;
        const i = idxAtOrBefore(t);
        return i < 0 ? null : bars[barIdxForMinute(i)].time;
    };
    const entry = (side, lots, t) => {
        const time = at(t);
        if (time == null) return;
        list.push(side > 0
            ? { time, position: 'belowBar', shape: 'arrowUp', color: UP, text: `Buy ${lots}` }
            : { time, position: 'aboveBar', shape: 'arrowDown', color: DOWN, text: `Sell ${lots}` });
    };
    for (const tr of S.trades) {
        entry(tr.side, tr.lots, tr.entryT);
        const time = at(tr.exitT);
        if (time != null) {
            list.push({ time, position: tr.side > 0 ? 'aboveBar' : 'belowBar', shape: 'circle', color: tr.pnl >= 0 ? UP : DOWN, text: fmtUsd(tr.pnl, true) });
        }
    }
    if (S.position) entry(S.position.side, S.position.lots, S.position.entryT);
    list.sort((a, b) => a.time - b.time);
    markers.setMarkers(list);
    markersDirty = false;
}

// On Heikin Ashi the last HA close is not a tradable price, so the axis shows the real price instead.
let realPriceLine = null;
function updateRealPriceLine() {
    if (S.chartType !== 'ha') {
        if (realPriceLine) { candles.removePriceLine(realPriceLine); realPriceLine = null; }
        return;
    }
    const last = bars[bars.length - 1];
    const opts = { price: C[cursor], color: last.c >= last.o ? UP : DOWN, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '' };
    if (realPriceLine) realPriceLine.applyOptions(opts);
    else realPriceLine = candles.createPriceLine(opts);
}

function setChartType(type) {
    S.chartType = type === 'ha' ? 'ha' : 'candles';
    document.querySelectorAll('#chartTypes button').forEach((b) => b.classList.toggle('on', b.dataset.type === S.chartType));
    const real = S.chartType !== 'ha';
    candles.applyOptions({ lastValueVisible: real, priceLineVisible: real });
    if (N) {
        setAll();
        afterMove();
    }
}

function afterMove() {
    const atEnd = cursor >= N - 1;
    updateRealPriceLine();
    const badge = $('#modeBadge');
    badge.textContent = atEnd ? 'LATEST' : 'REPLAY';
    badge.classList.toggle('live', atEnd);
    $('#clock').textContent = `${fmtWall(T[cursor] + 60)}${S.tz === 'UTC' ? ' UTC' : ''}`;
    $('#fwdBtn').disabled = atEnd;
    $('#backBtn').disabled = cursor <= Math.max(0, lockIndex());
    if (markersDirty) refreshMarkers();
    if (S.position) {
        for (const k of ['sl', 'tp']) if (posLines[k]) posLines[k].applyOptions({ title: lineTitle(k) });
    }
    renderAccount();
    renderPosition();
    if (!hovering) legendFor(bars.length - 1);
    save();
}

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;
function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ------------------------------------------------------------------ controls */

function setTimeframe(m) {
    if (m === S.tf) return;
    S.tf = m;
    document.querySelectorAll('#tfs button').forEach((b) => b.classList.toggle('on', +b.dataset.m === m));
    aggregateAll();
    setAll();
    chart.timeScale().scrollToRealTime();
    afterMove();
}

function buildToolbar() {
    $('#tfs').innerHTML = TFS.map((t) => `<button data-m="${t.m}" class="${t.m === S.tf ? 'on' : ''}">${t.label}</button>`).join('');
    $('#tfs').addEventListener('click', (e) => { const m = +e.target.dataset?.m; if (m) setTimeframe(m); });
    $('#chartTypes').addEventListener('click', (e) => { const t = e.target.dataset?.type; if (t) setChartType(t); });

    const chips = EMAS.map((e, k) => `<button class="chip ${S.ema[k] ? 'on' : ''}" data-ema="${k}" style="--chip-color:${e.color}">EMA ${e.p}</button>`);
    chips.push(`<button class="chip ${S.vol ? 'on' : ''}" data-vol="1" style="--chip-color:#8a93a3">Vol</button>`);
    $('#indicatorChips').innerHTML = chips.join('');
    $('#indicatorChips').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.ema != null) S.ema[+b.dataset.ema] = !S.ema[+b.dataset.ema];
        else S.vol = !S.vol;
        b.classList.toggle('on');
        applyIndicatorVisibility();
        legendFor(bars.length - 1);
        save();
    });

    const tzName = (z) => (z === LOCAL_TZ ? `${z.split('/').pop().replace('_', ' ')} (this computer)` : z === 'UTC' ? 'UTC' : z.split('/').pop().replace('_', ' '));
    if (!TZS.includes(S.tz)) S.tz = LOCAL_TZ;
    $('#tzSelect').innerHTML = TZS.map((z) => `<option value="${z}" ${z === S.tz ? 'selected' : ''}>${tzName(z)}</option>`).join('');
    $('#tzSelect').addEventListener('change', (e) => {
        S.tz = e.target.value;
        aggregateAll();
        setAll();
        chart.timeScale().scrollToRealTime();
        setJumpBounds();
        afterMove();
    });
}

function setJumpBounds() {
    const input = $('#jumpInput');
    input.min = toInputValue(T[0]);
    input.max = toInputValue(T[N - 1]);
    if (!input.value) input.value = toInputValue(T[Math.floor(N / 2)]);
}

function bindControls() {
    $('#playBtn').onclick = () => (playing ? pause() : play());
    $('#fwdBtn').onclick = () => { pause(); stepForward(); };
    $('#backBtn').onclick = stepBack;
    $('#selectBtn').onclick = () => setTool('select');
    $('#randomBtn').onclick = randomStart;
    $('#endBtn').onclick = () => {
        if (S.position) { toast('Close your open position first, or press Play.'); return; }
        seek(N - 1);
    };
    $('#jumpBtn').onclick = () => {
        const v = $('#jumpInput').value;
        if (!v) return;
        const i = idxAtOrBefore(fromInputValue(v) - 60); // reveal every bar that closed by then
        if (i < 0) { toast('That is before the first bar in the data.'); return; }
        seek(i);
    };
    $('#jumpInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#jumpBtn').click(); });

    const speed = $('#speedSelect');
    speed.value = String(S.speed);
    speed.onchange = () => { S.speed = +speed.value; save(); };
    const unit = $('#unitSelect');
    unit.value = S.unit;
    unit.onchange = () => { S.unit = unit.value; save(); };

    const num = (id, key, after) => {
        const el = $(id);
        el.value = S[key];
        el.addEventListener('input', () => {
            const v = parseFloat(el.value);
            S[key] = Number.isFinite(v) && v >= 0 ? v : 0;
            after?.();
            save();
        });
    };
    num('#lotsInput', 'lots', renderRisk);
    num('#slInput', 'slDist', renderRisk);
    num('#tpInput', 'tpDist', renderRisk);
    num('#spreadInput', 'spread', () => { renderAccount(); renderPosition(); });

    $('#buyBtn').onclick = () => openPosition(1);
    $('#sellBtn').onclick = () => openPosition(-1);
    $('#closeBtn').onclick = manualClose;
    $('#beBtn').onclick = () => setLevel('sl', S.position.entry);
    $('#slToggleBtn').onclick = () => {
        const p = S.position;
        setLevel('sl', p.sl == null ? p.entry - p.side * (S.slDist || 5) : null);
    };
    $('#tpToggleBtn').onclick = () => {
        const p = S.position;
        setLevel('tp', p.tp == null ? p.entry + p.side * (S.tpDist || 10) : null);
    };

    $('#hlineBtn').onclick = () => setTool('hline');
    $('#fibBtn').onclick = () => setTool('fib');
    $('#clearLinesBtn').onclick = () => { S.hlines = []; S.fibs = []; drawHlines(); redrawFibs(); save(); };

    $('#exportBtn').onclick = exportCsv;
    $('#resetBtn').onclick = () => {
        const input = prompt('Reset the account and delete the trade history.\nStarting balance ($):', String(S.startBalance));
        if (input == null) return;
        const start = parseFloat(input);
        S.startBalance = Number.isFinite(start) && start > 0 ? start : 10000;
        S.balance = S.startBalance;
        S.trades = [];
        S.position = null;
        S.nextId = 1;
        drawPositionLines();
        markersDirty = true;
        renderTrades();
        afterMove();
        renderRisk();
    };

    $('#startCard').addEventListener('click', (e) => {
        const act = e.target.dataset?.act;
        if (act === 'select') setTool('select');
        if (act === 'random') randomStart();
    });
    $('#startCardClose').onclick = () => { $('#startCard').hidden = true; };

    addEventListener('keydown', (e) => {
        if (!fibModal.hidden) { // while the settings dialog is open, only Esc does anything
            if (e.key === 'Escape') closeFibSettings(false);
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && hoverFib != null && !e.target.closest?.('input, select, textarea')) {
            S.fibs.splice(hoverFib, 1);
            hoverFib = null;
            chartEl.classList.remove('grab');
            redrawFibs();
            save();
            return;
        }
        if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); stepForward(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBack(); }
        else if (k === 'b') openPosition(1);
        else if (k === 's') openPosition(-1);
        else if (k === 'x') manualClose();
        else if (k === 'h') setTool('hline');
        else if (k === 'f') setTool('fib');
        else if (k === 'r') randomStart();
        else if (k === 'a') setChartType(S.chartType === 'ha' ? 'candles' : 'ha');
        else if (e.key === 'Escape') { if (tool) setTool(tool); }
        else if (/^[1-7]$/.test(e.key)) setTimeframe(TFS[+e.key - 1].m);
    });
}

function exportCsv() {
    if (!S.trades.length) { toast('No trades to export yet.'); return; }
    const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const lines = ['id,side,lots,entry_time_utc,entry,exit_time_utc,exit,stop_loss,take_profit,pnl_usd,reason'];
    for (const t of S.trades) {
        lines.push([t.id, t.side > 0 ? 'buy' : 'sell', t.lots, iso(t.entryT + 60), t.entry.toFixed(3), iso(t.exitT + 60), t.exit.toFixed(3),
            t.sl ?? '', t.tp ?? '', t.pnl.toFixed(2), t.reason].join(','));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `gold-replay-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------------ boot */

async function boot() {
    let data;
    try {
        const res = await fetch('data/xauusd-m1.json');
        if (!res.ok) throw new Error(await res.text());
        data = await res.json();
    } catch (err) {
        $('#legend').innerHTML = `<span class="title">Couldn’t load the data. ${String(err.message || err)}</span>`;
        return;
    }
    N = data.t.length;
    T = Float64Array.from(data.t);
    O = Float64Array.from(data.o);
    H = Float64Array.from(data.h);
    L = Float64Array.from(data.l);
    C = Float64Array.from(data.c);
    V = Float64Array.from(data.v);
    const day = (t) => fmtWall(t).split(',')[0].split(' ').slice(1, 3).join(' '); // "23 Jun"
    $('#source').textContent = `${data.source.split(' ')[0]} · ${day(T[0])} – ${day(T[N - 1])} ${new Date(T[N - 1] * 1000).getUTCFullYear()}`;
    $('.brand').title = `Gold spot, ${data.source}: ${fmtWall(T[0])} to ${fmtWall(T[N - 1] + 60)}`;

    cursor = N - 1;
    if (S.cursorT != null) {
        const i = idxAtOrBefore(S.cursorT);
        if (i >= 0) cursor = i;
    }
    if (S.position && !(S.position.entryT <= T[cursor])) S.position = null; // data changed under a saved position

    buildToolbar();
    bindControls();
    applyIndicatorVisibility();
    aggregateAll();
    setChartType(S.chartType); // also draws the bars
    chart.timeScale().scrollToRealTime();
    drawHlines();
    drawPositionLines();
    setJumpBounds();
    renderRisk();
    renderTrades();
    afterMove();
    if (cursor >= N - 1) $('#startCard').hidden = false;
}

boot();
