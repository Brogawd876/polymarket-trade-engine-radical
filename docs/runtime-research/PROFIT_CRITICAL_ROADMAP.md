# Profit-Critical Roadmap

## Current Verdict

The platform is worth preserving: live/sim/replay modes, Chainlink-aware settlement truth, strategy variants, Strategy Lab, Live Readiness, and operator replay now work. The missing profit foundation is data truth and execution realism, not another round of late-entry tuning.

## Stage 1: Data Truth Foundation

Goal: record normalized, provenance-rich events for run lifecycle, strategy/risk decisions, order lifecycle, settlement, and market depth.

Why it matters for profit: no strategy can be trusted until we know exactly what data was available, when it arrived, what decision was made, and what execution actually happened.

Files/modules: `engine/event-store/*`, `engine/market-lifecycle.ts`, `engine/early-bird.ts`, `.github/workflows/test.yml`.

Acceptance: append-only NDJSON events exist; focused tests and `bun run check` pass; no live/replay foundation regression; Raw L2 WebSocket recorder implemented and capturing orderbook snapshots/deltas/trades.

Stop if: event-store wiring requires broad rewrites of validated auth, discovery, or replay.

## Stage 2: Replay Realism

Goal: populate conservative maker fill assumptions, maker/taker classification, fee/rebate estimates, and 1s/5s/30s/settlement markouts.

Why it matters for profit: PnL from optimistic replay fills is not evidence. Markouts reveal adverse selection and toxic maker fills.

Files/modules: `engine/replay/fill-model.ts`, `engine/replay/fill-scoring.ts`, `engine/replay/markout.ts`, `engine/strategy-lab.ts`.

Phase 8D status: Conservative fill-scoring module exists. Book touches do not create fake fills. Trade-through required for sure fills. Unknown queue correctly degrades to pessimistic. Markouts mapped accurately to token side. Strategy Lab integration is pending as an explicit next step.

Phase 8B status: Strategy Lab now reports markouts where replay token-side observations support them. Markout values are measurement-only and do not change ranking/scoring yet. Sparse replay fixtures can still produce unavailable horizons, and that is intentional.

Acceptance: Strategy Lab reports pessimistic fills and markouts without fake values.

Stop if: captured logs cannot support queue or markout reconstruction.

## Stage 3: Larger Corpus

Goal: capture 1,000-3,000 BTC 5m rounds across time zones and regimes.

Why it matters for profit: three fixtures prove plumbing, not edge.

Acceptance: replayable corpus has raw L2, settlement, decisions, fills, and regime labels.

Stop if: data gaps remain large enough to make replay nondeterministic.

## Stage 4: Fair-Value-Maker v2

Goal: calibrated probability, volatility/jump filter, maker-only quotes, inventory skew, cancel-before-toxic-flow, and explicit no-trade rules.

Why it matters for profit: maker-first EV is the credible path because makers avoid fees while takers pay crypto fees.

Acceptance: holdout evidence remains positive after pessimistic fills, fees, and adverse-selection markouts.

Stop if: edge disappears after realistic fill assumptions.

## Stage 5: Tiny-Live Proof

Goal: $1-$2 maker orders only, measuring live fills/cancels/markouts against the simulator.

Why it matters for profit: live execution quality, not backtest PnL, determines whether the edge is tradable.

Acceptance: live maker fills have non-negative or positive expected markout and simulator/live fill rates are close.

Stop if: maker fills are consistently toxic or simulator assumptions fail.

## Stage 6: Production Hardening

Goal: monitoring, alerts, fail-closed live preflight, backups/restart behavior, deployment profile, and kill switch.

Why it matters for profit: a small edge can be erased by stale feeds, runaway orders, or unobserved execution drift.

Acceptance: live trading is bounded, observable, restartable, and fail-closed.

Stop if: infrastructure cost exceeds plausible small-account return.
