# UpTrade

A personal crypto paper-trading app and trade journal. It uses live Binance prices, runs on free tiers only, and works on desktop and phone.

- **Live chart:** candlesticks from Binance (1m–1d), with your entry price and limit-order lines drawn on it.
- **Orders:** market and limit, long and short, 1–125x isolated leverage with MEXC-style fees and liquidations.
- **Positions:** live unrealized PnL. Closing a position takes two taps.
- **History:** closed trades with realized PnL, win rate, profit factor, and filters by market, setup tag and outcome.
- **Journal:** notes, setup tags, a 1–5 execution rating, and screenshots for each trade, shown next to a chart of the trade.
- **Balance:** starts at $1,000. You can add or deduct funds at any time, and every change is logged.

Stack: Next.js 16 (App Router), Tailwind v4, Supabase (Auth, Postgres, Storage), TradingView Lightweight Charts, and Binance public market data (no API key needed).

## Market data: why Binance and not MEXC

I mostly trade on MEXC, but **MEXC is blocked in our region**. Its API (`api.mexc.com`) doesn't resolve without a VPN, so a browser app can't call it. The workarounds were either to relay MEXC data through a Vercel server, polling every few seconds instead of streaming, which eats into the free tier, or to build a protobuf WebSocket decoder. Neither seemed worth it for a paper-trading journal.

So UpTrade uses **Binance's public market-data servers** (`data-api.binance.vision`, `data-stream.binance.vision`), which are reachable here and need no account or key. What this means in practice:

- Most large coins trade on both exchanges at nearly the same price, so paper results are a close stand-in.
- Coins listed **only** on MEXC aren't available.
- Small price gaps between exchanges are normal.

The same note appears in the app, in the market picker and under Account → Market data.

## Leverage, fees and liquidation

UpTrade trades **USDT-margined, isolated-margin** positions from 1x to 125x, with one netted position per coin. The numbers are the same in the database engine (`supabase/schema.sql`) and in the order form preview (`src/lib/pnl.ts`).

| | Formula |
| --- | --- |
| Margin | `size × entry ÷ leverage` |
| Fee | taker **0.02%** (market orders, and limit orders that fill immediately) · maker **0%** (limit orders that wait in the book) · charged on `size × price` |
| Unrealized PnL | long `(mark − entry) × size` · short `(entry − mark) × size` |
| ROE | `unrealized PnL ÷ margin` |
| Maintenance margin | **0.5%** of `size × price` |
| Liquidation price | long `(entry − margin/size) ÷ (1 − 0.5%)` · short `(entry + margin/size) ÷ (1 + 0.5%)` |

- **Adding to a position** uses that position's leverage, and the liquidation price is recalculated from the new average entry and total margin.
- **Partially closing** releases margin in proportion to the size closed. The liquidation price stays the same.
- **Liquidation** fills at the liquidation price, and **you lose the position's whole margin**. The price loss uses up the margin down to the 0.5% maintenance level, and that remainder is charged as a liquidation fee, as on MEXC and Binance. Your other positions and free balance are untouched.
- A closing loss can never be bigger than the margin of the part being closed.
- Liquidations run in the browser, like limit orders. They trigger live when the price touches the liquidation price. When you reopen the app, it also checks the candle highs and lows since your last fill, so a liquidation that happened while you were away is recorded at the time it happened.
- Simplifications: liquidation uses the last traded price instead of an exchange mark price, there are no funding fees, and open limit orders don't reserve margin. A limit order that can't afford its margin when it fills is cancelled with the reason.

The engine is covered by 52 checks run against real Postgres (PGlite).

## Chart indicators

Open **Indicators** on the Trade chart. Your choices are saved on each device and also apply to the chart on each journaled trade.

- **Overlays:** Volume, three moving averages (EMA or SMA with any length), Bollinger Bands, and VWAP (resets daily at 00:00 UTC)
- **Panes:** RSI (Wilder) and MACD

All of them are calculated in the browser (`src/lib/indicators.ts`) and update with each live candle.

## Setup

### 1. Supabase (free)
1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the tables, row-level security, the order engine functions, and the `journal` storage bucket.
3. Copy the **Project URL** and **anon public key** from **Project Settings → API**.

### 2. Local
```bash
cp .env.local.example .env.local   # then paste the URL and anon key
npm install
npm run dev
```
Open http://localhost:3000, create your account, and sign in.

> To keep the app single-user: after you sign up, turn off **Authentication → Sign In / Providers → Allow new users to sign up** in Supabase.

### 3. Vercel (free)
1. Import this repo at [vercel.com/new](https://vercel.com/new).
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` under **Environment Variables**, then deploy.
3. In Supabase, go to **Authentication → URL Configuration**:
   - Set **Site URL** to `https://<your-app>.vercel.app`.
   - Add these to **Redirect URLs**: `https://<your-app>.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`.

Every push to `main` redeploys. On your phone, open the site and choose **Add to Home Screen** to use it like an app.

## How it works

| Piece | Where |
| --- | --- |
| Order engine: netting, flips, cash, PnL (atomic, inside Postgres) | `supabase/schema.sql` → `_apply_fill`, `place_order`, `fill_limit_order`, `close_position`, `adjust_balance` |
| Live prices: one shared WebSocket, throttled | `src/hooks/useMarket.ts` |
| Limit order matcher and catch-up after being offline | `src/hooks/useLimitMatcher.ts` |
| Data hooks (refetch after every mutation and on tab focus) | `src/hooks/useTrading.ts`, `src/hooks/useQuery.ts` |
| Auth gate | `src/proxy.ts`, `src/lib/supabase/*` |

**Accounting.** Positions use 100% margin. Opening a position costs `qty × price`. Closing returns `qty × entry + PnL`, where PnL is `(exit − entry) × qty` for a long and `(entry − exit) × qty` for a short. Equity is your balance plus open positions valued at their entry price, plus unrealized PnL.

**Limit orders** fill in the browser. While the app is open, an order fills when the live price crosses its limit. When you next open the app, it replays the candles since each order was placed and fills any order that would have triggered while you were away, at its limit price. The fill function is idempotent, so having two devices open can't fill an order twice.
