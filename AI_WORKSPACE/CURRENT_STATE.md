# CURRENT_STATE

## Repository State
* **Current Branch**: `radical-checkpoint-may31`
* **Commit Hash**: `8bf6f53e6f9dc8e75dc8e367858c4f74d0a6c0ea`

## Phase 5 Completion State (Repair & Reconciliation Complete)
* **Status**: Repair/Reconciliation phase complete
* **Current Canonical Runtime Spine**: `SessionManager` → `EngineRuntime` → `MarketSpawner` → `MarketLifecycle` → `Strategy`/`RiskGate`/`Client`/`UserChannel`
* **Current Benchmark Strategy**: `fvm-v1.1.0-raw-ungated`
* **Deployment Status**: Not ready
* **Profitability Status**: Not proven
* **Reason**: All FVM variants were negative in replay. FVM v1.1.0 Raw/Ungated is restored as the benchmark/champion candidate, returning a net PnL of `-$380.10` over the same-sample replay corpus. Institutional/newer variants returned worse results (`-$726.82` for `fair-value-maker`), caused in large part by excessive blocked decisions.
* **Next Required Work**: Missing metric export (drawdown, capital utilization, settlement PnL, missed fills, good/bad blocks, and richer markout/block quality analysis) and continuous-bankroll validation.
* **Forbidden Next Work**: No more broad refactors, strategy tuning, or speculative feature additions (e.g., post-only changes, adverse-selection shields, isotonic calibration, FVM formula changes, or live/paper trading integrations) without hard, evidence-backed validation.

## Phase 4 Completion State
* **Truth Hierarchy**: Strict classification in `engine/types/market-truth.ts`. Inferred data is explicitly marked as `inferred_diagnostic`.
* **MarketLifecycle Boundary**: `StrategyContext.orderFlow` is conditionally injected. Production forces `orderFlow: undefined` if it relies on inferred data (`allowInferredFlow=false`).
* **SessionManager Default**: `SessionManager.startReplay` strictly defaults to `allowInferredFlow=false` (Production/Promotion mode) but supports explicitly overriding with `{ allowInferredFlow: true }` for research counterfactuals.
* **Test Assurances**: `truth-hierarchy.test.ts` formally verifies the extraction and drop rules for inferred feeds.

## Runtime Architecture (Post Phase 3C & 5)
### Actual Runtime Spine Diagram
`SessionManager` → `EngineRuntime` → `MarketSpawner` → `MarketLifecycle` → `Strategy`/`RiskGate`/`Client`/`UserChannel`

* `index.ts` handles CLI options and delegates to `SessionManager`.
* `SessionManager` handles telemetry bus, and starts the `EngineRuntime` instance in live/sim/replay modes.
* `EngineRuntime` canonically composes infrastructure initialization, clients, orchestrates ticks, and spins up `MarketSpawner`.
* `MarketSpawner` owns market/slot spawning only.
* `EarlyBird` remains only as a legacy compatibility wrapper for external orchestrators and is NOT the canonical runtime.
* `MarketLifecycle` manages an individual market round, evaluating risk gates, polling `strategy`, and pushing orders to the client.

## Invariants (Do Not Change Without Evidence)
* Do not bypass risk gates in production.
* Do not delete `engine/early-bird.ts` until dependency mapping proves it is no longer needed.
* Do not replace `fvm-v1.1.0-raw-ungated` as the live benchmark.
* **FVM behavior must not be changed blindly.**
