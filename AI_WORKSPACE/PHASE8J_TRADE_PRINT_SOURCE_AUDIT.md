# Phase 8J: Polymarket Trade-Print Source Audit

## Executive Verdict

PASS for trade-print source discovery and recorder normalization. PARTIAL for clean paired-corpus validation.

Reliable public trade prints are available from the Polymarket market WebSocket as `last_trade_price` messages when those messages include `asset_id`, `price`, `size`, `timestamp`, `side`, and `market`. The previous zero-`market_trade` corpus was a recorder normalization gap: the recorder preserved `last_trade_price` as weak reference data but did not convert complete public trade prints into scorer-usable `market_trade` events.

No strategy tuning, ranking changes, readiness-gate changes, live trading, or profitability claim was made.

## Source Audit

Official Polymarket docs classify the market WebSocket as real-time orderbook, price, and trade data. They state the market channel subscription receives orderbook snapshots, price changes, trade executions, and market events, and define `last_trade_price` as emitted when maker and taker orders are matched.

Docs checked:

- https://docs.polymarket.com/market-data/websocket/market-channel
- https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets
- https://docs.polymarket.com/api-reference/market-data/get-last-trade-prices-request-body
- https://docs.polymarket.com/api-reference/market-data/get-last-trade-price

## Existing Raw Corpus Findings

The old raw L2 corpus did not hide trade prints under `raw_market_message`. It contained:

| File | events | book snapshots | book deltas | last_trade_price | raw message types | market_trade |
|---|---:|---:|---:|---:|---|---:|
| `raw-l2-btc-updown-5m-1779342600.ndjson` | 874 | 14 | 838 | 6 | `best_bid_ask` | 0 |
| `raw-l2-btc-updown-5m-1779343200.ndjson` | 182,549 | 4,576 | 169,821 | 2,139 | `best_bid_ask`, `new_market` | 0 |
| `raw-l2-btc-updown-5m-1779371700.ndjson` | 187,475 | 10,048 | 161,228 | 4,675 | `best_bid_ask`, `new_market` | 0 |
| `raw-l2-btc-updown-5m-1779372300.ndjson` | 141,187 | 6,768 | 123,324 | 3,168 | `best_bid_ask`, `new_market` | 0 |
| `raw-l2-btc-updown-5m-1779372900.ndjson` | 119,894 | 5,962 | 104,152 | 2,839 | `best_bid_ask`, `new_market` | 0 |

Interpretation: old captures had trade-print messages as `last_trade_price`, but the normalized event stream lacked `market_trade`, so conservative trade-through evidence could not be produced from those files.

## Probe Result

Added `scripts/probe-polymarket-trade-prints.ts` to inspect market WebSocket, CLOB last-trade-price, and Data API trades for an active BTC 5-minute market.

Probe command:

```bash
bun scripts/probe-polymarket-trade-prints.ts --duration-ms 10000 --min-seconds-remaining 90
```

Observed market:

- `btc-updown-5m-1779377400`
- condition: `0x3558f78157b4fca558c500442deac5b826377ee7554fc39062ed52ddaae47423`

Results:

| Source | connected | messages | trade-like | token | price | size | timestamp | market/slug match | freshness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| market WS | yes | 2,957 | 75 | 397 | 75 | 75 | 2,957 | 2,957 | near real time |
| CLOB last-trades-prices | yes | 2 | 0 | 2 | 2 | 0 | 0 | 0 | snapshot only |
| Data API trades | yes | 77 | 0 | 77 | 77 | 77 | 77 | 77 | lagging |

The market WS sample included `event_type: last_trade_price`, real token ID, market condition ID, price, size, side, millisecond timestamp, and transaction hash.

## Recorder Fix

`engine/recorders/raw-l2-recorder.ts` now:

- continues writing every `last_trade_price` event as `last_trade_price`;
- emits an additional `market_trade` event only when the message has the required evidence fields: token ID, finite price, finite size, and finite source timestamp;
- tags normalized trade prints with `tradePrintSource: "clob_market_last_trade_price"`;
- keeps incomplete `last_trade_price` out of `market_trade`, so weak references do not become trade-through evidence.

## Recorder Capture Proof

Short public raw L2 capture:

```bash
bun scripts/record-raw-l2.ts --auto-slug 0 --duration-ms 20000 --out data/raw-l2/phase8j-recorder-probe-current.ndjson
```

Result:

| event type | count |
|---|---:|
| `market_trade` | 201 |
| `last_trade_price` | 201 |
| `market_book_snapshot` | 428 |
| `market_book_delta` | 13,882 |
| `raw_market_message` | 472 |

This proves the repaired recorder can capture real Polymarket trade prints as normalized `market_trade`.

## Paired Capture Attempt

Command:

```bash
bun scripts/capture-paired-replay-l2.ts --strategy fair-value-maker --rounds 1 --slot-offset 1
```

Generated pair:

- slug: `btc-updown-5m-1779377700`
- replay events: 7,062
- raw L2 events: 219,656
- raw L2 book events: 201,994
- raw L2 `market_trade`: 3,874
- coverage: complete
- pair validity: invalid

Why invalid:

- recorder process exit code was recorded as `null` after SIGINT;
- embedded Strategy Lab validation reported `Strategy Lab batch failed or timed out. State: running`.

This artifact is useful proof that paired raw L2 can contain market-trade coverage, but it is not a clean valid corpus checkpoint and remains uncommitted.

## Evidence Hierarchy

Tier 1: direct public trade print with token ID, price, size, timestamp, and market match. Polymarket market WebSocket `last_trade_price` qualifies when complete and is normalized to `market_trade`.

Tier 2: authenticated/user fill events. Useful for own fills, not public maker fillability unless linked to our orders.

Tier 3: last-trade price snapshots without size/timestamp. Useful as weak market reference, not trade-through proof.

Tier 4: book touch only. Useful for possible touch evidence, not realistic fill proof.

## Current Corpus Status

The Phase 8I corpus still should not be treated as realistic profit evidence:

- late-entry: no eligible fills;
- fair-value-maker: usable touch-only evidence, but zero old-corpus trade-through evidence;
- old raw L2 files: zero normalized `market_trade`;
- newly generated Phase 8J raw captures: contain normalized `market_trade`, but the paired manifest attempt was invalid.

## Root Cause Answer

Reliable trade prints come from the Polymarket market WebSocket as complete `last_trade_price` trade-execution messages. The current recorder was not converting complete `last_trade_price` messages into `market_trade`, so old paired files could only support touch-only evidence. The source feed exists; the old evidence gap was primarily normalization plus the need for a fresh clean paired capture.

## Next Recommendation

Phase 8K should make clean paired capture robust:

1. Treat SIGINT-based recorder shutdown as expected success when the recorder wrote `recorder_completed`.
2. Harden paired validation so Strategy Lab timeouts are bounded and observable for the just-captured pair.
3. Capture one clean valid paired BTC 5-minute corpus with normalized `market_trade`.
4. Rerun paired Strategy Lab and require trade-through evidence before any strategy tuning.

## Profit Relevance

This phase moves the project past book-touch-only evidence by proving a real public trade-print source exists and can be normalized into the scorer input format. It does not prove the strategy is profitable. It only proves that future captures can collect the data needed to test whether simulated maker fills were plausibly executable.
