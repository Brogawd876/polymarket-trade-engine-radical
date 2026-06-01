# CURRENT_STATE

## Repository State
* **Current Branch**: `radical-checkpoint-may31`
* **Commit Hash**: `a178b1129fc413bb9057b48521f7a9028d5388d3`

## Phase 3 Completion State
* **Config/Auth**: `POLYGON_RPC_URL` and `POLY_API_KEY_NONCE` validated in production. `CHAINLINK_BTC_5M_REFERENCE_VERIFIED` is strictly required in production but bypassed in simulation.
* **Risk Gates**: `AggregatedRiskGate` fail-closed in production regardless of `BLOCK_ON_PREDICTIVE_DISAGREEMENT`. In simulation, bypass is allowed. Telemetry divergence logged.
* **Tests**: All backend (513) and UI (20) tests are passing. `bun version` pinned safely to `1.3.14`.

## Runtime Architecture (Phase 4 Focus)
### Actual Runtime Spine Diagram
`index.ts` -> `SessionManager` -> `EarlyBird` (Legacy Orchestrator) -> `MarketLifecycle` -> `Strategy (e.g. FairValueMaker)`

* `index.ts` handles CLI options and delegates to `SessionManager`.
* `session-manager.ts` handles telemetry bus, and starts the `EarlyBird` instance in simulation or replay mode.
* `early-bird.ts` currently owns initializing data adapters (Chainlink, Binance, Coinbase, TickerTracker), aggregators, lead-lag monitors, OrderBook, APIQueue, the Polymarket/Sim clients, and the `MarketLifecycle` manager per slot.
* `market-lifecycle.ts` manages an individual market round, evaluating risk gates, polling `strategy`, and pushing orders to the client.
* `bot-core/*` owns isolated infrastructure (data adapters, pure risk evaluation gates, aggregators).

### Dependency Map for `early-bird.ts`
**Imported by:**
* `engine/session-manager.ts` (Instantiates and runs it)
* `engine/strategy-lab.ts` (Uses it for backtests)
* **Test Suites:** `early-bird.test.ts`, `aggregator-integration.test.ts`, `geoblock-integration.test.ts`, `lead-lag-integration.test.ts`, `replay-fixtures.test.ts`, `session-lifecycle.test.ts`, `telemetry-server.test.ts`.

### Files Safe to Modify (for Extraction)
* `engine/early-bird.ts` (Only to extract logic into other components without breaking the public interface).
* `engine/bot-core/*` (To house extracted adapter logic).
* `engine/session-manager.ts` (To take ownership of high-level initialization).

### Files Not Safe to Delete
* `engine/early-bird.ts` (Cannot be deleted until all 7 test suites and `session-manager.ts` are fully decoupled).

### Migration Sequence
1. **Extraction 1 (Smallest Safe Extraction):** Extract the adapter initialization (Binance, Coinbase, Chainlink, DefaultPredictiveAggregator) from `EarlyBird` constructor into a dependency injection pattern or a dedicated `BotContextFactory` inside `bot-core/`. Ensure `EarlyBird` uses this factory so tests remain green.
2. **Extraction 2:** Move the `TickerTracker` and slot-matching loop out of `EarlyBird` and into a dedicated `MarketSpawner`. 
3. **Extraction 3:** Update `SessionManager` to assemble the dependencies using `BotContextFactory` and pass them to `MarketSpawner`, bypassing `EarlyBird` for live/sim paths. 
4. **Extraction 4:** Refactor the 7 test suites to use the new `MarketSpawner` instead of `EarlyBird`.
5. **Final Step:** Once no references remain, archive `early-bird.ts`.

### Exact Tests Protecting Each Step
* **Extraction 1:** Protected by `early-bird.test.ts` and `bot-core.test.ts`.
* **Extraction 2:** Protected by `session-lifecycle.test.ts` and `aggregator-integration.test.ts`.
* **Extraction 3 & 4:** Protected by all 513 backend tests (`bun test`).

## Invariants (Do Not Change Without Evidence)
* Do not bypass risk gates in production.
* Do not delete `engine/early-bird.ts` until dependency mapping proves it is no longer needed.
* Do not replace `fair-value-maker.ts` as the live benchmark.
