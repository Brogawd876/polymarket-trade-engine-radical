# Trade Deck Blueprint

## Current Baseline

The first safe simulation run used `repos/polymarket-trade-engine` with:

```powershell
bun run index.ts --strategy simulation --rounds 1 --always-log
```

No `--prod` flag was used. No wallet keys, private keys, API secrets, or production credentials were used.

Artifacts:

- Console log: `repos/polymarket-trade-engine/logs/early-bird-2026-05-16-00-29-16.log`
- Structured run log: `repos/polymarket-trade-engine/logs/early-bird-btc-updown-5m-1778891400.log`
- HTML chart: `repos/polymarket-trade-engine/logs/early-bird-btc-updown-5m-1778891400.html`
- State: `repos/polymarket-trade-engine/state/early-bird.json`

Run outcome:

- Slug: `btc-updown-5m-1778891400`
- Strategy: `simulation`
- Paper entry: BUY UP, `5` shares at `0.49`
- Paper exit: SELL UP, `5` shares at `0.70`
- Simulated PnL: `+$1.05`
- Structured snapshots: `308`
- Ticker entries: `308`

## Existing Data Sources In The Trade Engine

### Structured Market Log

The per-market NDJSON log is the strongest source for run review and deck replay.

Current entry types observed:

| Type | Fields | Deck Use |
|---|---|---|
| `slot` | `slug`, `strategy`, `startTime`, `endTime`, `action` | Market identity, time window, strategy label, run boundaries |
| `orderbook_snapshot` | `up.bids`, `up.asks`, `down.bids`, `down.asks` | Live ladder, spread, liquidity, microstructure replay |
| `remaining` | `seconds` | Countdown and time-normalized chart x-axis |
| `ticker` | `assetPrice`, `coinbasePrice`, optional `binancePrice`, `okxPrice`, `bybitPrice`, `divergence` | BTC price panel, source comparison, divergence warnings |
| `market_price` | `openPrice`, `priceToBeat`, `gap` | Price-to-beat line, gap meter, UP/DOWN thesis state |
| `order` | `action`, `side`, `price`, `shares`, `status`, optional `reason` | Entry/exit markers, lifecycle table, failure diagnostics |
| `resolution` | `direction`, `openPrice`, `closePrice`, `unfilledShares`, `payout`, `pnl` | Result summary and win/loss accounting |

### Engine State

`state/early-bird.json` currently stores:

- `sessionPnl`
- `sessionLoss`
- `activeMarkets`
- `completedMarkets`
- Per completed market: `slug`, `strategyName`, `pnl`, `orderHistory`

Deck use:

- Session summary
- Recovery awareness
- Completed market list
- Strategy outcome summaries

### Existing Analysis App

The existing `analysis/` React app already parses logs through:

- `analysis/src/parse.ts`
- `analysis/src/types.ts`
- `analysis/src/aggregate.ts`
- `analysis/src/runChartData.ts`

Current app panels:

- Market runs by UP/DOWN resolution
- Strategy win/loss/PnL aggregation
- Run detail chart with order book, BTC price, price-to-beat, and order markers

Important limitation:

- `parse.ts` only treats a run as complete if it has a `resolution` entry. The first simulation run has state-level PnL and order history, but the inspected structured log tail did not show a `resolution` entry before `slot end`. The chart still renders from raw order/snapshot data, but aggregate win/loss panels may classify this run as incomplete unless a resolution entry is present.

## First Deck UI Shape

The future BTC 5-minute deck should start as an operator/research surface, not a production trading console.

### Top Bar

Purpose: immediate session orientation.

Fields:

- Current asset: `BTC`
- Market window: `5m`
- Current/selected slug
- Strategy name
- Simulation/production mode indicator, defaulting to simulation only
- Countdown to close
- Session PnL
- Active blockers/status warnings

### Market State Panel

Purpose: answer whether the market is currently UP-favored, DOWN-favored, or unstable.

Fields:

- `assetPrice`
- `priceToBeat`
- `gap`
- gap direction
- gap change over recent seconds
- source prices: Coinbase, Binance, OKX, ByBit when present
- divergence warning when sources disagree

Derived metrics to add:

- Gap velocity
- Gap z-score or normalized gap against recent volatility
- Time-adjusted gap safety

### Order Book Panel

Purpose: see executable market structure.

Fields:

- UP best bid/ask
- DOWN best bid/ask
- Spread per side
- Top 5 bid/ask levels per side
- Size/liquidity at each level
- Total displayed depth

Derived metrics to add:

- Mid price
- Bid/ask imbalance
- Liquidity within 1, 2, 5 ticks
- Slippage estimate for candidate order sizes
- Sudden book-thinning warning

### Strategy Timeline

Purpose: explain exactly what the strategy did and why.

Fields:

- Order placed
- Order filled
- Order failed
- Order expired
- Order canceled
- Emergency sell trigger
- Remaining seconds at each event
- Nearby order book at each event
- Nearby BTC/gap state at each event

Current run timeline:

- BUY UP placed at `0.49`
- BUY UP filled at `0.49`
- SELL UP placed at `0.70`
- SELL UP filled at `0.70`
- Simulated PnL `+$1.05`

### Run Review Panel

Purpose: after each simulated round, decide what happened and whether the result is meaningful.

Fields:

- Slug
- Strategy
- Start/end
- Side traded
- Entry price
- Exit price
- Shares
- Spend
- PnL
- Max favorable gap after entry
- Max adverse gap after entry
- Time in position
- Entry book spread
- Exit book spread

Derived metrics to add:

- Entry quality score
- Exit quality score
- Whether fill was strategy-driven or book drift
- Whether holding longer would have improved/worsened result

### Research Queue Panel

Purpose: keep the deck tied to the agent-portable workspace.

Fields:

- Active task from `AI_WORKSPACE/ACTIVE_TASK.md`
- Latest handoff timestamp
- Known blockers
- Next recommended research task
- Link/path to current log/chart/state artifacts

## Reusable Components From Existing Repos

### Main Base: `polymarket-trade-engine`

Use for:

- BTC 5-minute market lifecycle
- Simulation execution
- Live order book monitor
- Ticker sources
- Strategy API
- State persistence
- Structured logging
- Run analysis app

### Reference: `polyterm`

Use for:

- Market intelligence patterns
- CLI/TUI command inventory ideas
- Search/monitor/watch concepts
- Risk, notes, alerts, and local research state ideas
- Read-only wallet/portfolio UX concepts

### Reference With Blocker: `polyrec`

Use for:

- BTC terminal dashboard concept
- CSV logging ideas
- Chainlink/Binance/Polymarket combined view
- Backtest visualization ideas

Blocker:

- Missing documented external `./chainlink/btc-feed.js`.

## Near-Term Implementation Plan

1. Keep `polymarket-trade-engine` as the primary base.
2. Do not modify strategy or production code yet.
3. Extend documentation and analysis understanding first.
4. Confirm why the structured market log lacks a `resolution` entry for the completed simulation run even though `state/early-bird.json` has PnL.
5. Decide whether the first custom deck should:
   - extend the existing `analysis/` app, or
   - become a separate app that reads `logs/` and `state/`.
6. Add a normalized run summary layer that merges:
   - structured log entries,
   - state completed-market records,
   - derived order book/ticker metrics.

## Normalized Run Summary

Implemented:

- Script: `repos/polymarket-trade-engine/analysis/scripts/normalize-runs.ts`
- Command: `bun run normalize:runs`
- Output: `repos/polymarket-trade-engine/analysis/src/generated/run-summary.json`

Current normalized output merges the structured log with `state/early-bird.json` and produces one deck-ready run object with:

- `slug`
- `asset`
- `duration`
- `strategy`
- `startTime`
- `endTime`
- `outcome`
- `pnl`
- `spend`
- `orderEvents`
- `orderHistory`
- `snapshotCount`
- `tickerCount`
- first/last price-to-beat, gap, and asset price
- log/chart paths
- warnings

Current warning:

- `btc-updown-5m-1778891400: PnL found in state but no resolution entry found in structured log`

## Safety Boundary For Next Work

- Simulation and read-only monitoring only.
- No `--prod`.
- No `.env` with private keys.
- No wallet signing.
- No production order placement.
