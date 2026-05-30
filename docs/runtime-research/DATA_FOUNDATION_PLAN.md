# Data Foundation Plan

## Implemented In This Tranche

- Typed profit-critical event schema in `engine/event-store/events.ts`.
- Append-only NDJSON writer and no-op writer in `engine/event-store/writer.ts`.
- Runtime scaffold that mirrors run start/completion, price anchor, strategy/risk decisions, order lifecycle, spread/depth snapshots, and settlement result.
- Replay markout calculator in `engine/replay/markout.ts`, now integrated into Strategy Lab where replay data contains token-side observations.
- Conservative queue-aware fill model scaffold in `engine/replay/fill-model.ts`.
- Wallet invariant tests and fail-fast checks for impossible sell/settlement inventory.
- CI now runs `bun run check` and focused data-foundation tests.
- Raw Polymarket L2 Recorder in `engine/recorders/raw-l2-recorder.ts` with direct WebSocket capture to NDJSON.

## Next Wiring Tasks

1. Persist Binance/Coinbase price ticks and feed freshness events directly from adapters.
2. Integrate `ConservativeFillScorer` into `engine/strategy-lab.ts` (behind an explicit option, or as report-only, then default).
3. Add maker/taker and fee/rebate event emission for every fill; rebates must remain estimates, not guaranteed PnL.

## Go/No-Go Gates

- Do not tune strategy until markouts are populated on a larger corpus and pessimistic fills are integrated.
- Do not tiny-live until maker/taker classification and fail-closed risk limits are in evidence.
- Do not scale until tiny-live maker fills show positive expected markout and simulator/live fill behavior aligns.
