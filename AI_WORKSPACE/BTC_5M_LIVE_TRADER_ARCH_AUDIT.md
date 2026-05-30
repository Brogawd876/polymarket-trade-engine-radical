# BTC 5-Minute Live-Trader Architecture Audit

**Timestamp:** 2026-05-15T21:07:32-04:00  
**Agent/Tool:** OpenAI Codex  
**Scope:** Read-only architecture audit of `repos/polymarket-trade-engine` against the bot-first BTC 5-minute live-trader goal. No live trading was run and no credentials were requested.

## Executive Verdict

`polymarket-trade-engine` is still the correct primary base for the project, but it is not yet a serious live-trading bot. It is the best base because it already has BTC/ETH/etc. Up/Down market slot targeting, Polymarket CLOB order book ingestion, Polymarket user-channel fill tracking, simulated and production client separation, strategy callbacks, state persistence, per-round logs, and a working analysis app.

The project direction is now bot-first, deck-second: **Build a modular, low-latency, bot-first Polymarket BTC 5-minute trading system with a local operator deck for monitoring, override, and review.**

The biggest correction needed is architecture, not UI. The engine must split resolution-truth BTC data, Polymarket venue data, and external predictive exchange feeds into separate timestamped adapters before adding more strategy or deck features.

## A. Market Lifecycle And BTC 5M Market Targeting

The engine discovers BTC Up/Down markets by computing Polymarket slugs locally, then fetching metadata from Gamma:

- `utils/slot.ts:getSlotTS` aligns current time to 5m or 15m windows using `MARKET_WINDOW`.
- `utils/slot.ts:getSlug` creates slugs such as `btc-updown-5m-{slotStartSec}` from `MARKET_ASSET` and `MARKET_WINDOW`.
- `engine/early-bird.ts:206` creates a new lifecycle from `getSlug(this._slotOffset)`.
- `tracker/api-queue.ts:52` fetches `https://gamma-api.polymarket.com/events?slug={slug}`.
- `engine/market-lifecycle.ts:264` extracts `conditionId` and `clobTokenIds` from the Gamma event.

Current/next market targeting is partially automatic:

- `slotOffset=1` means the engine targets the next slot by default.
- `--rounds` allows finite runs; `null` means unlimited.
- `engine/early-bird.ts` ticks every 100ms and creates a new lifecycle when `getSlug(slotOffset)` changes.
- `scripts/orderbook.ts` has a separate `--continuous` mode that rotates slots, but the production engine path uses `EarlyBird`.

A 5-minute round is represented as one `MarketLifecycle` with a slug, two CLOB token IDs, pending orders, completed order history, a state machine, slot start/end timestamps, an order book, a user channel, and a logger.

Close and resolution boundaries:

- `MarketLifecycle.slotStartMs` and `slotEndMs` parse the slug with `slotFromSlug`.
- `_handleRunning` transitions to `STOPPING` at `Date.now() >= slotEndMs`.
- `_waitForResolution` polls `APIQueue.queueMarketPrice` until `closePrice` exists.
- `_computePnl` resolves UP if `closePrice > openPrice`.

Judgment: suitable as a base for continuous 24/7 round-to-round trading, but still session/script oriented. The lifecycle loop is continuous, but it lacks a robust scheduler, durable feed-state model, health supervisor, per-feed latency accounting, and explicit rollover no-trade zone.

## B. Polymarket Venue Data Ingestion

Current Polymarket-side ingestion:

- Market metadata: `APIQueue.queueEventDetails` via Gamma events.
- CLOB order book websocket: `tracker/orderbook.ts` uses `wss://ws-subscriptions-clob.polymarket.com/ws/market`.
- Order book snapshots: `book` messages populate full bids/asks.
- Incremental order book updates: `price_change` messages update bids/asks.
- Tick size: `tick_size_change` and initial `book.tick_size`.
- Fee rates: `last_trade_price.fee_rate_bps`.
- Best bid/ask and liquidity: `bestBidInfo`, `bestAskInfo`.
- Top-five book logging: `getSnapshotData`.
- User order/trade events: `engine/user-channel.ts` uses `wss://ws-subscriptions-frontend-clob.polymarket.com/ws/user`.

Data available to strategy logic:

- `ctx.orderBook.bestAskInfo("UP" | "DOWN")`
- `ctx.orderBook.bestBidInfo("UP" | "DOWN")`
- `ctx.orderBook.bestBidPrice`
- `ctx.clobTokenIds`
- `ctx.pendingOrders`, `ctx.orderHistory`
- `ctx.getMarketResult()`
- `ctx.ticker`
- `ctx.postOrders`, `ctx.cancelOrders`, `ctx.emergencySells`

Data logged but not fully used:

- Top-five order book snapshots are logged every second, but the strategy mostly uses only top-of-book.
- Ticker prices from configured feeds are logged, but not stored as normalized event stream records.
- Fee rate is used for order placement and FOK fill accounting, but not centralized in an EV/slippage model.

Missing for a serious live trader:

- Raw venue event timestamps, receive timestamps, and sequence/order information.
- Full depth metrics beyond top-five snapshots for research.
- Spread, midpoint, book imbalance, depth slope, microprice, and queue-position estimates as first-class fields.
- Trade tape/recent trades as a strategy input.
- Explicit market metadata model with closed/accepting-orders flags and rollover guard.
- A clean venue adapter interface independent from strategy and lifecycle code.

Modularity judgment: partially adapter-like but tightly coupled. `OrderBook`, `APIQueue`, and `UserChannel` are useful modules, but `MarketLifecycle` constructs and wires them directly, and strategy code reaches concrete classes rather than stable feed interfaces.

## C. Resolution-Source BTC Data

This is the critical gap.

The engine has two relevant price paths:

- `TickerTracker.connectPolymarket` subscribes to `wss://ws-live-data.polymarket.com`, topic `crypto_prices_chainlink`, using the configured symbol such as `btc/usd`.
- `APIQueue.queueMarketPrice` polls `https://polymarket.com/api/crypto/crypto-price` for `openPrice` and `closePrice`.

That means the engine is close to resolution-source awareness, but it does not model it as resolution truth. `TickerTracker.price` returns `polymarketValue ?? binanceValue ?? coinbaseValue`, which silently falls back from Polymarket/Chainlink-like data to exchange data. That is dangerous for a live BTC 5m bot because resolution truth, venue pricing, and external predictive prices are different things.

Answers:

1. Direct true resolution-source ingestion: partial, not sufficient. It consumes Polymarket's `crypto_prices_chainlink` RTDS feed and Polymarket crypto-price open/close endpoint, but it does not prove or encapsulate the exact oracle truth source as an independent adapter.
2. Current substitute: `TickerTracker.price` prefers Polymarket RTDS, then Binance, then Coinbase. `openPrice`/`closePrice` come from Polymarket's crypto-price API.
3. Distinction between sources: no. The current model mixes resolution-ish price, external exchange prices, and strategy-facing asset price under `ticker`.
4. Required placement: a dedicated `ResolutionSourceAdapter` should sit beside, not inside, `TickerTracker`: `ResolutionSourceAdapter -> RoundState/EventBus -> StrategyContext` and `MarketResultResolver`.
5. Required interface:

```ts
type ResolutionSourceEvent = {
  source: "polymarket-chainlink-rtds" | "polymarket-crypto-price-api";
  asset: "btc";
  price: number;
  sourceTimestampMs: number | null;
  receivedAtMs: number;
  processedAtMs: number;
  monotonicReceivedNs: bigint;
  roundStartMs: number;
  roundEndMs: number;
  role: "live" | "open" | "close";
  freshnessMs: number | null;
  lagMs: number | null;
  confidence: "live" | "delayed" | "stale" | "missing";
};
```

The strategy context should expose `ctx.resolutionSource.latest`, `ctx.resolutionSource.priceToBeat`, `ctx.resolutionSource.close`, and a subscription/replay stream. It should not force strategies to infer truth from `ctx.ticker.price`.

## D. External BTC Exchange Feeds As Predictive Signal Inputs

The engine supports external BTC exchange feeds:

- Binance websocket `btcusdt@ticker`, parsed from `json.c` with event time `json.E`.
- Coinbase websocket ticker for `BTC-USD`, parsed from `json.price`.
- OKX websocket ticker.
- Bybit websocket ticker.

Default `TICKER` is `polymarket,coinbase`; `scripts/orderbook.ts` forces `polymarket,binance,coinbase`.

Fields received:

- Binance: last price and event timestamp.
- Coinbase: price; timestamp is not preserved in the tracker.
- OKX: last price; timestamp is not preserved.
- Bybit: last price; timestamp is not preserved.
- Polymarket RTDS: price and top-level timestamp.

Usage:

- Strategy `late-entry` uses `ctx.ticker.price`, `ctx.ticker.divergence`, and derived indicators.
- `TickerTracker.divergence` compares Binance and Coinbase.
- `isKillswitch` and `isWhaleDump` exist but are not enforced centrally before order placement.

Conflation risk: yes. Since `TickerTracker.price` falls back across feeds, a strategy can accidentally treat Binance/Coinbase as resolution truth when Polymarket RTDS is missing.

Modularity judgment: moderate scaffold, not enough. Feed connection methods are separated internally but all collapse into one `TickerTracker`. Future multi-exchange support needs normalized `PredictiveFeedAdapter` instances with per-feed timestamps, lag, and quality status.

## E. Time Model And Low-Latency Event Synchronization

Current time model:

- Slot time is wall-clock `Date.now()` aligned through `utils/slot.ts`.
- Engine tick is `setInterval(..., 100)`.
- Strategy timers use `setInterval(..., 0)` in `late-entry` and `setTimeout` in `simulation`.
- Logger uses `Date.now()` for every record.
- Binance and Polymarket RTDS validate first event staleness against source timestamps.
- Order expiration uses `expireAtMs`.
- User-channel fills are event-driven, but event source timestamps are not preserved.

Adequacy: not adequate for exploiting short-lived inefficiencies. It is adequate for a simple scripted bot or simulation, not for a low-latency multi-feed trader.

Failure points:

- Source, receive, and processing timestamps are not consistently stored.
- Coinbase, OKX, Bybit timestamps are discarded.
- Only first feed event is staleness-validated in `TickerTracker`.
- Feed events do not share a common event envelope.
- Order book websocket updates do not record source timestamp, receive timestamp, or sequence.
- Strategy timers can make decisions on stale cached values without a uniform freshness guard.

Fields that must be added:

- `sourceTimestampMs`
- `receivedAtMs`
- `processedAtMs`
- `monotonicReceivedNs`
- `feedName`
- `feedSequence` or exchange sequence if available
- `roundStartMs`, `roundEndMs`, `secondsRemaining`
- `latencyMs`, `freshnessMs`, `clockSkewMs`
- `isStale`, `isOutOfOrder`, `isInterpolated`
- `decisionEventId`, `triggerEventIds`

## F. Strategy Engine Quality

Strategies are represented as async functions receiving `StrategyContext` and optionally returning cleanup. This is a good start.

Separation:

- Strategy is separated from low-level CLOB client calls.
- Strategy is not fully separated from data ingestion because it directly reads concrete `OrderBook` and `TickerTracker`.
- Strategy is not fully separated from risk because it can call `postOrders` directly without a central risk/EV gate.
- Strategy is not fully separated from persistence because no replay stream abstraction exists.

Multiple strategy support exists through `engine/strategy/index.ts`, `DEFAULT_STRATEGY`, and the `--strategy` CLI option.

Existing strategies:

- `simulation`: useful as an API demo, not a real strategy.
- `late-entry`: useful scaffold for round-aware, gap/indicator/orderbook entry logic, but still simulation guarded and too monolithic for production.

Can it support advanced strategies? Yes, with refactor. The callback model can support price/source lag exploitation, orderbook mispricing, near-expiry confidence, spread capture, and microstructure entry/exit logic, but only after feed separation, event replay, and a central risk/execution gate are added.

Direct judgment: **good base, needs moderate refactor**. Not wrong base.

## G. Execution And Order Management Readiness

What exists:

- `EarlyBirdClient` abstraction with simulation and real Polymarket clients.
- Multi-order placement.
- GTC and FOK order types.
- Batch cancel.
- Pending order tracking.
- Partial matched amount handling.
- User websocket fill/cancel tracking.
- Reconnect reconciliation by REST lookup.
- Emergency sell loop.
- Retry behavior on balance/allowance timing.
- Fee rate passed to order placement; FOK fill fee accounting exists.
- Simulated fills against top-of-book liquidity.

What is missing:

- Explicit order-intent model separate from placed orders.
- Central pre-trade risk and EV validation.
- Stale-quote guard.
- Spread and slippage gate.
- Adverse-selection guard.
- Queue-position and maker/taker modeling.
- Time-in-force policy by market phase.
- Cancel/replace strategy as first-class order manager.
- Production dry-run/paper mode using live data but no signing.
- Strong production-mode kill switch independent from strategy code.

Execution readiness: promising but not live-ready. The plumbing is real, but credentials must not be added until order intents, quote freshness, risk limits, and kill switches are designed and tested in simulation/paper.

## H. Risk Control Readiness

Existing controls:

- `--prod` requires confirmation unless `FORCE_PROD=true`.
- Simulation strategies have explicit production guards.
- `MAX_SESSION_LOSS` exits once cumulative losses breach threshold.
- Wallet tracker prevents known insufficient balance/share placements.
- Buy and sell block flags exist.
- Emergency sell path exists.
- Some strategy-local liquidity and timing checks exist.
- Feed divergence helpers exist.

Must-have before live:

- Hard production mode gate with a separate config file and default-off live execution.
- Max exposure per market.
- Max open positions.
- Max trades/orders per round.
- Max order size and max notional per order.
- Max daily/session loss with persisted accounting.
- Stale-data no-trade guard across all feeds.
- Market rollover no-trade guard.
- Weak-signal no-trade gate.
- Spread/slippage/fee EV gate.
- Feed-disagreement kill switch.
- Operator panic stop.
- Dry-run/paper mode that uses live venue data but cannot sign.

Ease of adding: moderate. The lifecycle has natural insertion points around `postOrders`, but risk should become a mandatory layer between strategy intent and execution rather than optional strategy logic.

## I. Logging, Replay, And Training-Data Suitability

Current NDJSON logging:

- `slot`
- `orderbook_snapshot`
- `remaining`
- `ticker`
- `market_price`
- `order`
- `resolution`

The market log records top-five orderbook state once per second, ticker summary, price-to-beat/gap, and order events. It does not log every raw websocket event, every strategy decision, every missed signal, or every orderbook delta.

Replay suitability: not enough. The same strategy logic cannot yet run unchanged on live streams, recorded replay streams, and paper trading because there is no normalized event bus or replay adapter. The current logs are useful for visual review and analysis, not deterministic replay.

Training-data schema needed:

- Normalized event envelope for every feed update.
- Full venue orderbook delta/snapshot events with timestamps.
- Resolution-source BTC events with source/receive/processing timestamps.
- External exchange events with source/receive/processing timestamps.
- Strategy decision events with inputs, thresholds, output intent, and reason.
- Risk gate result events.
- Execution intent, placement, acknowledgement, fill, cancel, replace, reject, timeout.
- Opportunity markers, missed-trade markers, and false-positive/false-negative labels.
- Round metadata, market metadata, fee schedule, and liquidity summary.

Missing for later analysis:

- Opportunity detection inputs.
- Entry quality at decision/ack/fill time.
- Venue repricing delay versus resolution-source movement.
- Resolution-source versus exchange lag.
- Missed trades and why they were skipped.
- False positives and stale-data decisions.
- Per-feed lag/freshness metrics.

## J. Role Of polyterm And polyrec

`polyterm` should remain reference material for operator-deck and market-intelligence views. It has useful CLI patterns for Gamma/CLOB data discovery, dashboards, depth/slippage views, market comparison, whale/activity views, correlation, EV, and risk-oriented operator commands. It should not become the execution base.

`polyrec` should remain reference material for signal research. `dash.py` explicitly combines Polymarket RTDS Chainlink-like BTC data, Binance 1s data, Polymarket order books, lag, VWAP, microprice, depth slope, and CSV logging. Its missing `./chainlink/btc-feed.js` remains a blocker; do not invent a replacement. Conceptually, its lead-lag and impulse/fade ideas are relevant to strategy research, but it is not the primary bot base.

## K. Final Verdict And Phases

1. Is `polymarket-trade-engine` still the right base? **Yes.**
2. Why: it is already closest to a real Polymarket BTC 5m bot: round targeting, CLOB orderbook ingestion, user-channel fills, simulated and real clients, state persistence, strategy interface, logging, and analysis all exist.
3. Why not sufficient: it conflates source-truth BTC, predictive exchange BTC, and venue pricing; it lacks normalized timing/event infrastructure; risk and execution gates are not central; replay/training data is incomplete.

Highest-priority architectural additions:

1. `ResolutionSourceAdapter` for Polymarket/Chainlink RTDS plus open/close resolver API.
2. `VenueDataAdapter` for Gamma metadata, CLOB orderbook, trade tape, fees, and market status.
3. `PredictiveFeedAdapter` for Binance/Coinbase/OKX/Bybit with strict timestamps and freshness.
4. Normalized event bus and event log schema.
5. Central `RiskGate` and `ExecutionManager` between strategy intents and order placement.

Next five implementation phases:

1. **Architecture correction and data-source abstraction:** split resolution truth, venue data, and predictive exchange feeds into explicit adapters and update strategy context types.
2. **Resolution-source BTC integration and resolver model:** make Polymarket RTDS/API open-close truth a first-class round model with freshness, fallback, confidence, and audit records.
3. **Synchronized event logging and replay infrastructure:** record normalized timestamped feed/order/decision events and build replay adapters before writing new strategies.
4. **Strategy, risk, and execution refactor:** require strategies to emit intents, pass every intent through risk/EV/stale-data gates, then hand approved intents to execution.
5. **Operator deck and control surface:** only after the bot core is structured, build monitoring, manual override, kill switch, paper/live mode visibility, and post-run review.

Immediate next task: implement Phase 1 as a narrow architecture skeleton in `polymarket-trade-engine` without enabling production trading.
