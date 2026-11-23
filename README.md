# Gold Replay

Bar-by-bar replay of XAUUSD (spot gold) with a practice trading panel. It needs no account and no API key.

**Live:** https://mostafaaelsherbiny.github.io/gold-replay/

GitHub Actions deploys the site (`.github/workflows/pages.yml`). It runs on every push to `main`, after the New York close each weekday, and on demand from the Actions tab (*Run workflow*). Each run downloads the latest 5 months of data, so the live site stays current without the data being committed. Your trades, drawings and settings stay in your own browser.

## Run it locally

```bash
npm install        # once
npm run fetch      # download the last 5 months of 1-minute data from Dukascopy (~8 MB, a few seconds)
npm start          # then open http://localhost:5174
```

Refresh the data any time with `npm run fetch`. Other ranges: `npm run fetch -- --months 12`, or `npm run fetch -- --from 2026-01-01 --to 2026-06-30`.

## Using it
1. **Choose a start:** *Select a bar on the chart*, *Random start* (the best option for unbiased practice), or a date and time in the bottom bar.
2. **Step or play:** step with → and ←, or press Space to play. *Speed* sets the number of steps per second. *Step* reveals either one whole bar or one minute at a time, so you can watch a higher-timeframe candle form.
3. **Trade:** Buy (B) and Sell (S) fill at market. The stop loss and take profit are set as dollar distances from the entry. Drag the SL and TP lines on the chart to move them, and close with X.

Trade fills work like this:
- **Bid and ask:** prices are the bid. A buy pays the spread you set, and a short exits at the ask.
- **Stop and target checks:** every minute is checked for SL and TP hits, even when you step by a whole bar.
- **Gaps:** a gap through a level fills at that minute's open.
- **Both levels in one minute:** if a single minute touches both, the stop is counted first.

**Rules and limits:**
- **Step back** is blocked past your last trade, so you can't undo trades.
- **Jumping** to another start point needs you to be flat.
- **Saved state:** trades, balance, lines and your replay position stay in this browser (localStorage). *Reset* starts the account over.
- **Lot size:** 1 lot = 100 oz, so a $1 move at 0.10 lots is $10.

## Drawing
- **Horizontal line (H):** click to place it, drag to move it, double-click to delete it.
- **Fibonacci retracement (F):** click the first point, then the second, for example a swing low and then a swing high.
  - **Snapping:** each point snaps to a candle's high or low when you click within 10px of it.
  - **Levels:** level 0 sits on the second point and level 1 on the first. The default levels are 1.414 / 1.618 through 12.414 / 12.618, all orange and extended right. The *Template* menu switches to the classic 0–1.618 set.
  - **Editing:** drag a dot to adjust a point, and drag a level to move the whole drawing. To delete a drawing, point at it and press Delete, or double-click it and choose *Delete*.
  - **Settings:** open them with the gear button, or by double-clicking a drawing. They cover the trend line, line style and width, extend, the 24 levels (value, on/off, colour), use one colour, background, reverse, prices, levels as values or percents, and label position. Changes preview live, *Cancel* undoes them, and the settings apply to every Fibonacci drawing.
  - **Persistence:** drawings stay on their candles when you change timeframe or time zone, and they're saved.
- **Clear:** deletes all drawings.

## Timeframes
1m, 5m, 15m, 30m, 1h, 4h and 1D are all built from the 1-minute data, using these boundaries:
- **Up to 1h:** bars start on UTC boundaries.
- **4h and 1D:** bars follow the forex day, which starts at 17:00 New York. Each daily bar is labelled with its trading date.

Times display in the zone you pick at the top right.

**Heikin Ashi:** switch with the *Candles / Heikin Ashi* toggle or press A. It changes only how candles are drawn:
- **Price axis and trades:** the axis label shows the real price, and orders, SL/TP and P&L all use real prices.
- **Legend:** the OHLC values are the Heikin Ashi ones, and the change figure uses real closes.
- **EMAs:** calculated on real closes.

## Data
Dukascopy's free historical feed of 1-minute bid candles. It's very close to TradingView's FX_IDC:XAUUSD but not identical to the tick, because each feed has its own liquidity providers. Volume is Dukascopy's tick volume.

The chart uses [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache-2.0).
