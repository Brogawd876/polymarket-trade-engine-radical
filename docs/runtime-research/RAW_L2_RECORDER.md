# Raw Polymarket L2 Recorder

## Overview

The Raw L2 Recorder is a standalone utility designed to capture tick-level public orderbook data from Polymarket directly into the profit-critical event store. 

This establishes the data foundation for future replay, realistic markouts, and pessimistic maker fill simulation.

**Important Note:** No profitability claim, paper-readiness claim, or live-deployment recommendation is made by the presence of this recorder. 

## How to Run

Run the script from the command line:

```bash
bun run scripts/record-raw-l2.ts [--slug <market-slug> | --auto-slug <offset>] [--duration-ms <ms>] [--dry-run]
```

- `--slug`: The Polymarket slug (e.g. `btc-updown-5m-1779294600`).
- `--auto-slug`: The offset to automatically resolve a slug (e.g., `0` for current, `1` for next). Resolves dynamically using `slot.ts` without credentials.
- `--duration-ms`: The time to record in milliseconds. Defaults to 60,000 (60s).
- `--dry-run`: Skips writing to disk (uses `NoopEventWriter`).

**Output Location:** 
Data is captured in NDJSON format under `logs/events/<runId>/events.ndjson`.

## What is Captured

The recorder connects to the public `wss://ws-subscriptions-clob.polymarket.com/ws/market` feed and captures:
- `market_book_snapshot`: Full book state at initialization (including tick size).
- `market_book_delta`: Incremental bid/ask updates.
- `market_trade`: Trade events including price and size.
- `last_trade_price`: Real-time updates of the last traded price explicitly distinguished from zero-size trades.
- `market_status_change`: Tick size updates.
- Feed Health: `feed_connected`, `feed_disconnected`, `feed_decode_error`.
- Metrics: Tracks `messagesReceived`, `messagesWritten`, `writeErrorCount`, and `unknownMessageCount`. Writes are queued asynchronously for high throughput.

## What is NOT Captured

The public WebSocket does not provide perfect omniscience:
- **Trade Direction (Maker/Taker):** The public `trades` message includes a `side` field, but it is purely feed-reported and cannot be fully trusted without on-chain validation.
- **Wallet Attribution:** It is impossible to definitively map public trades to specific wallets.
- **Queue Position:** We cannot observe our exact queue position in the CLOB relative to other makers.
- **Private Orders:** Private intents or live order executions are explicitly excluded to maintain risk isolation.

## Reliability 

- **Reliable Fields:** Timestamps (`receivedTsMs`, `processedTsMs`), best bid/ask, spread, and explicit sizes in `price_change` messages.
- **Feed-Reported Only:** `side` on `market_trade` events. 

## Profit Relevance

A maker/fair-value strategy cannot be trusted unless we can reconstruct spread, depth, book movement, liquidity changes, and adverse selection after fills. 

By capturing raw L2 data, we can:
1. **Support Markouts:** Compute exact post-fill token prices at 1s, 5s, 30s using the recorded orderbook midpoint or best bid/ask, rather than relying on generic BTC ticker gaps.
2. **Support Conservative Fill Modeling:** Simulate maker executions only when the L2 depth physically trades through our presumed queue position, reducing false confidence from optimistic fill assumptions.

This makes future strategy tuning significantly more realistic and aligned with actual money-making execution constraints.
