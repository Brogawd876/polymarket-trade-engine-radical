# Decisions

## Template

### Date

### Decision

### Reason

### Alternatives Rejected

### Implications

---

### 2026-05-15

### Decision

Initialize `Polymarket-Deck-Lab` as a top-level Git repository and ignore `repos/`.

### Reason

The workspace orchestration files should be versionable independently while cloned upstream repositories remain separate Git repositories.

### Alternatives Rejected

Leaving the workspace unversioned; committing cloned upstream repositories into the orchestration repo.

### Implications

Agents can track changes to shared continuity files without interfering with upstream repo histories.

---

### 2026-05-15

### Decision

Use `polymarket-trade-engine` as the recommended main base for the future BTC 5-minute trading desk, pending deeper simulation validation.

### Reason

It explicitly targets Polymarket BTC Up/Down 5-minute and 15-minute markets and already includes simulation, strategy lifecycle, logging, state persistence, run analysis, live order book monitoring, and risk-control concepts.

### Alternatives Rejected

Using `polyterm` as the main base because it is stronger as a market-intelligence/operator CLI than as a BTC 5-minute execution engine. Using `polyrec` as the main base because a documented external Chainlink dependency is missing and the repo is smaller/less complete.

### Implications

Next work should install Bun and audit `polymarket-trade-engine` more deeply in simulation-only mode, while mining `polyterm` and `polyrec` for reference ideas.

---

### 2026-05-15

### Decision

Formally define the project as bot-first, deck-second: build a modular, low-latency, bot-first Polymarket BTC 5-minute trading system with a local operator deck for monitoring, override, and review.

### Reason

The user's actual target is a live-trading bot. The deck is important, but it is a control/review surface around the bot rather than the core product.

### Alternatives Rejected

Continuing as a primarily UI/deck-oriented simulation review project; treating run-summary/UI schema work as the next main milestone.

### Implications

`polymarket-trade-engine` remains the designated primary base candidate, but the next milestone is source-data/live-trader architecture validation rather than UI schema mapping.

---

### 2026-05-15

### Decision

Keep `polymarket-trade-engine` as the primary base after the BTC 5-minute live-trader architecture audit, but require Phase 1 architecture correction before new strategy or deck work.

### Reason

The repo already has the strongest bot foundation: BTC 5m/15m round targeting, CLOB orderbook ingestion, user-channel fill tracking, simulated and real clients, strategy callbacks, state persistence, logs, and an analysis app. The audit found that its main weakness is source separation and timing, not lack of core trading-engine scaffolding.

### Alternatives Rejected

Switching primary base to `polyterm`, which is better as market-intelligence/operator reference material. Switching primary base to `polyrec`, which has useful lead-lag ideas but is missing a documented external Chainlink script and is not a full execution engine. Continuing directly into UI/deck work before correcting bot architecture.

### Implications

The next implementation task should add narrow, simulation-safe adapter/interface boundaries for resolution-source BTC data, Polymarket venue data, predictive exchange feeds, strategy intents, and risk/execution gates. Production trading remains forbidden.

---

### 2026-05-15

### Decision

Implement Phase 1 as a simulation-safe architecture skeleton first, without routing existing live order placement through the new gates yet.

### Reason

The current engine already places simulated and production-capable orders through existing lifecycle APIs. A safe first phase should establish contracts and tests before changing runtime order flow, so later work can wire the adapters and risk gate deliberately.

### Alternatives Rejected

Immediately refactoring `MarketLifecycle._postOrders` through the new risk/execution gate, because that would change order behavior before the data-source separation is tested. Building UI/deck panels before the bot-core contracts are stable.

### Implications

The next task is to add the first concrete `ResolutionSourceAdapter` around existing Polymarket RTDS and crypto-price logic while keeping production trading disabled and behavior-compatible.

---

### 2026-05-15

### Decision

Share a single resolution adapter instance in EarlyBird.

### Reason

The Polymarket RTDS WebSocket is a shared resource. Creating a new connection per MarketLifecycle would be inefficient and potentially lead to rate limiting. Sharing a single adapter allows all lifecycles to consume the same stream.

### Implications

The EarlyBird class is now responsible for starting and stopping the resolution adapter. Lifecycles receive a reference to the started adapter.

---

### 2026-05-16

### Decision

Use per-MarketLifecycle VenueDataAdapter instances with a listener pattern on the shared OrderBook.

### Reason

Polymarket CLOB orderbook subscriptions are round-specific (tied to `clobTokenIds`). A shared adapter instance would cause round-switching races and disrupt overlapping lifecycles. By instantiating the adapter per-market and using an `onUpdate` listener on the existing `OrderBook`, we consolidate the source of truth while correctly managing round-specific metadata and event normalization.

### Alternatives Rejected

Shared `EarlyBird`-level venue adapter (caused state split and race conditions). Observable `OrderBook` subclass (unnecessarily complex, inheritance issues).

### Implications

`MarketLifecycle` is now responsible for its own venue adapter. The adapter encapsulates round initialization (`initRound`) and metadata fetching. Simulation and strategies now see the same live-updated state as the adapter.

---

### 2026-05-16

### Decision

Maintain global lifecycles for Predictive and Resolution adapters, but per-market for Venue.

### Reason

Predictive (Binance/Coinbase) and Resolution (Polymarket RTDS) feeds provide asset-level truth (BTC price) that is shared across all market rounds. Sharing a single connection reduces overhead and rate limiting. Venue data (Polymarket CLOB) is inherently round-specific and requires independent subscription management per MarketLifecycle.

### Implications

EarlyBird is responsible for the 'singleton' adapters. MarketLifecycle manages its own round-specific venue adapter while receiving references to the shared ones.

---

### 2026-05-16

### Decision

Add `AggregatedRiskGate` as a signal-aware implementation of the existing `RiskGate` interface and wire it into `MarketLifecycle._placeWithRetry()` before client order submission.

### Reason

This is the smallest correct architecture: it reuses the existing risk-gate model, keeps execution control centralized, and makes predictive-signal gating reachable from the actual order path without inventing a parallel pre-order system.

### Alternatives Rejected

Extending `StaticRiskGate` directly, because the static gate should remain a simple production/no-data safety checker. Adding a separate pre-order risk layer, because that would create a second control path and make future blocks harder to reason about.

### Implications

Predictive aggregate disagreement now blocks order placement through the real lifecycle path. Lead-lag timing confidence remains advisory by default because observed timing leadership is not proven price-discovery leadership. A strict `blockOnInsufficientLeadLagSamples` option exists for a later policy change.

---

### 2026-05-16

### Decision

Make `AggregatedRiskGate` delegate to the existing `StaticRiskGate` before applying predictive-signal checks.

### Reason

The runtime risk hook should not replace static safety controls. Stale required feeds, missing required feeds, close-window protection, session loss, order size, and exposure checks need to remain active on the same execution path as predictive disagreement checks.

### Alternatives Rejected

Keeping `AggregatedRiskGate` predictive-only, because that left stale-data and exposure checks outside the default runtime order path. Adding a second pre-order risk layer, because it would split execution control across multiple paths.

### Implications

The real order path now blocks missing/stale resolution and venue data as well as predictive disagreement. A strategy can no-trade immediately if required feeds are not ready, so the next narrow task should add an explicit feed readiness/warm-up gate rather than weakening the safety check.

---

### 2026-05-16

### Decision

Add required feed readiness as a `MarketLifecycle` warm-up step before strategy execution.

### Reason

Missing resolution or venue data is not a strategy problem; it is a lifecycle readiness problem. Waiting before the strategy callback prevents immediate order rejection while preserving the risk gate as the final pre-order safety layer.

### Alternatives Rejected

Allowing strategies to start immediately and rely on order-time risk rejection, because that produces noisy failed orders and hides the real startup condition. Weakening the risk gate to permit missing feeds, because that would make the bot less safe.

### Implications

Strategies only run after required feeds are fresh. If feeds do not become ready by timeout, the lifecycle no-trades cleanly and ends the round. The next quality increment should focus on fee, slippage, spread, and liquidity gating.

---

### 2026-05-16

### Decision

Add ExecutionQualityGate as a dedicated venue-condition checker inside AggregatedRiskGate, separate from StaticRiskGate.

### Reason

Venue-quality checks (spread, staleness, liquidity depth) are execution concerns, not static-safety concerns. Separating them keeps StaticRiskGate focused on hard limits (exposure, session loss, production guard) and makes venue gating independently testable and configurable without touching static limits.

### Alternatives Rejected

Extending StaticRiskGate with venue checks, because it would mix concerns and make limit configuration harder to reason about. Adding a separate pre-order hook outside the RiskGate interface, because it would create a second execution-control path.

### Implications

AggregatedRiskGate now runs StaticRiskGate → ExecutionQualityGate → predictive-signal checks in series. Each gate is independently configurable and independently unit-testable. ExecutionQualityLimits is a separate type from StaticRiskLimits.

---

### 2026-05-16

### Decision

Deploy real operational values as DEFAULT_EXECUTION_QUALITY_LIMITS rather than permissive placeholder values.

### Reason

Placeholder defaults (maxSpreadUsd: 1.0, maxVenueAgeMs: 60000, minTargetLiquidity: 0) made the ExecutionQualityGate functionally inert in any deployment that didn't explicitly override limits. The gate was wired in but blocking nothing. The test suite already used strict values (.05 / 500ms / 10 shares) and all integration tests pass with those values — the real mocks already produce realistic tight-spread, fresh-timestamp venue data.

### Alternatives Rejected

Keeping permissive defaults and requiring callers to always pass explicit limits, because that creates a footgun — any future code using 
ew ExecutionQualityGate() without explicit limits gets no protection. Removing the defaults entirely, because that breaks the zero-argument constructor used throughout the test suite.

### Implications

DEFAULT_EXECUTION_QUALITY_LIMITS is now: maxSpreadUsd: 0.05, maxVenueAgeMs: 500, minTargetLiquidity: 1.0. Any future change to these values is a policy change and should be recorded here. The test suite serves as a living specification of what the defaults must permit.

---

### 2026-05-16

### Decision

Make Historical Replay mode own an explicit `Clock`, replay data source, and replay persistence policy instead of patching live/sim behavior in place.

### Reason

The validation audit showed that replay crashed while saving ordinary state, used private `EarlyBird` internals, and still depended on several real-time paths. A reliable replay subsystem needs explicit mode boundaries: virtual time for deterministic replay-sensitive behavior, replay adapters for historical events, and isolated persistence so historical runs do not mutate live/sim state.

### Alternatives Rejected

Only suppressing the state-file `EPERM` crash, because that would leave replay timing and lifecycle behavior brittle. Continuing to drive `ReplayRunner` through private fields and `as any`, because that couples replay orchestration to implementation details. Claiming "100% fidelity", because no validated fidelity contract exists.

### Implications

`index.ts` now creates a `VirtualClock` before `EarlyBird` in replay mode and passes it through runtime options. `EarlyBird` exposes a small public replay orchestration surface for `ReplayRunner`. Replay mode does not write the normal state file by default. Future replay features should extend these explicit seams rather than adding scattered replay conditionals.

---

### 2026-05-16

### Decision

Classify engine/bot-core/execution-gate.ts as obsolete scaffolding.

### Reason

The audit found that RiskApprovedExecutionGate is not consumed by the EarlyBird or MarketLifecycle runtime paths. All current pre-order gating is handled by AggregatedRiskGate. Retaining the file as a legacy reference but it is no longer part of the active bot-core logic.

### Implications

Future execution-logic work (e.g. real order submission) should extend the RiskGate/AggregatedRiskGate flow rather than attempting to reactivate the execution-gate.ts scaffolding.

### 2026-05-16

### Decision
Keep telemetry events raw and un-throttled at the engine level for the local operator platform.

### Reason
The current telemetry frequency is governed by the engine tick rate (10Hz). For a local application running over loopback, this volume is extremely low overhead for both Bun and modern web browsers. Throttling or coalescing at the engine level would introduce unnecessary complexity and latency. If future remote monitoring or mobile UIs are added, a separate proxying or sampling layer should be introduced rather than slowing down the local control plane.

### Implications
UI developers should use efficient rendering techniques (e.g. non-React canvas or lightweight time-series charts) to handle the 10Hz stream without UI thread thrashing. The engine remains high-fidelity.


### 2026-05-16

### Decision

The new ui/ folder is the new real-time Operator Cockpit frontend, while nalysis/ remains preserved as the existing offline/historical analytics frontend.

### Reason

The nalysis/ app is a substantial existing React application with historical analytics, run-detail views, charting, and log-parsing logic. The new ui/ folder is only a fresh scaffold and does not yet replace that functionality.

### Implications

No deprecation or deletion of nalysis/ should happen until there is a deliberate migration/feature-parity plan. Both will coexist for now.

### 2026-05-16

### Decision

Use Zustand with a centralized reducer/store for the Operator Cockpit telemetry data layer.

### Reason

Directly parsing WebSocket messages inside React components leads to thrashing and scattered state. A central Zustand store (useStore) cleanly decouples the network lifecycle (via useTelemetry hook) from rendering, handles reconnection logic safely, and enables derived selectors for complex panels.

### Implications

All new panels must select state from useStore rather than implementing their own network connections.

---

### 2026-05-16

### Decision

Throttle emergency-sell retries through the shared clock instead of suppressing repeated risk-gate diagnostics.

### Reason

The replay validation pass found that `MarketLifecycle._emergencySellLoop` could retry synchronously after an immediately rejected emergency sell. In replay mode this starved the event loop and blocked virtual clock progress. In live/sim mode the same pattern could waste CPU and flood logs under repeated rejection.

### Alternatives Rejected

Suppressing or deduplicating identical risk-gate log lines, because the root problem was retry cadence and the repeated diagnostics remain useful when paced. Using raw wall-clock sleeps, because replay and tests need the existing clock abstraction to own time.

### Implications

Emergency liquidation still retries until fill or slot end, but rejected attempts yield through the lifecycle clock first. Replay status endpoints remain responsive and log volume is naturally bounded by retry delay.

---

### 2026-05-16

### Decision

Treat `divergencePct` as backend percent units end-to-end in the Operator Cockpit.

### Reason

`DefaultPredictiveAggregator` computes `divergencePct = divergenceAbs / averagePrice * 100`, so the emitted telemetry field is already a percentage value. Multiplying it by 100 again in the UI inflated plausible cross-exchange BTC spreads into suspicious-looking percentages.

### Alternatives Rejected

Relabeling the existing inflated value, because that would preserve a misleading number. Changing the backend contract, because backend tests and naming already define the correct percent-unit contract.

### Implications

UI formatting must render `divergencePct` directly. A 30-cent spread around $78,135 renders near `0.0004%`, not `0.04%`.

---

### 2026-05-16

### Decision

Use backend round telemetry as the cockpit source of truth for Price To Beat, current result, lifecycle state, and final resolution.

### Reason

The screenshot comparison with Polymarket confirmed the backend-derived cockpit values match the real market round. Keeping the UI on backend-shaped telemetry avoids duplicating market-window math in the frontend.

### Alternatives Rejected

Deriving Price To Beat or final result in the UI from chart-only data, because that is fragile and can drift from engine reality.

### Implications

The cockpit chart now renders a target line from `MARKET_TICK.payload.priceToBeat`, while final resolution uses the explicit `ROUND_RESOLUTION` telemetry event.

---

### 2026-05-16

### Decision

Use the existing telemetry/control-plane channel for execution observability, with `ORDER_INTENT` as the only new event family added in the blotter pass.

### Reason

The engine already emitted structured `RISK_DECISION`, `ORDER_LIFECYCLE`, `ROUND_PNL`, and `ROUND_RESOLUTION` events. The real gap was the pre-risk/pre-submit attempt, plus correlation fields that let an operator follow intent -> risk -> order -> fill. Adding a separate execution feed would duplicate the control-plane path and increase contract drift risk.

### Alternatives Rejected

Creating a separate execution WebSocket/API stream, because it would split operator state across channels. Fabricating risk-check detail in the UI, because only engine-provided reasons should be shown. Collapsing execution into log strings, because typed rows are needed for durable cockpit filtering and drilldown.

### Implications

Future execution cockpit work should extend typed telemetry contracts and the centralized Zustand store. If the cockpit needs events emitted before browser connection, add a bounded recent-event buffer or REST backfill endpoint rather than creating a second telemetry channel.


### 2026-05-16

### Decision

Implement Operator Control Plane v1 using an active-idle backend design via SessionManager.

### Reason

The UI needs to be able to start, stop, and reset simulations and replays without forcing the user to manually restart the backend process. We decoupled the EarlyBird and ReplayRunner lifecycles from the main process thread. The ControlServer remains active while idle, exposing REST endpoints (/api/operator/*) to coordinate start/stop operations with the SessionManager. We explicitly rejected forcing process.exit in the backend code, converting errors like MAX_SESSION_LOSS into structured throw/catch boundaries so the control server can propagate the failure string to the UI.

### Implications

- Operators must start the engine using un run index.ts --idle to run the control server without an immediate bot start.
- EarlyBird does not process.exit(1) upon max loss; it throws an Error, which is presented gracefully in the OperatorControlPanel.

---

### 2026-05-18

### Decision

Keep ultra-tiny live mode UI-visible but execution-locked until paper evidence gates pass.

### Reason

The profitability roadmap allows capped tiny-live collection only as evidence, not as proof of edge. The implementation should make the caps and manual arm workflow visible to the operator without adding production keys, endpoint calls, or live enablement during the repair/validation phase.

### Implications

Control Center can display `$1/order`, `$5 exposure`, and `$5 loss` caps, but the tiny-live button remains locked and does not call a live trading endpoint. Future work must wire tiny-live only after deterministic replay, paper, and kill-switch gates are satisfied.

---

### 2026-05-18

### Decision

Treat root engine typecheck and UI verification as separate build surfaces.

### Reason

The repo has multiple historical TypeScript surfaces (`analysis`, `ui`, `test`) with different assumptions. The engine production code should be typechecked by root `bun run check`; the current cockpit UI should be verified with its own build/test commands.

### Implications

`tsconfig.json` excludes historical analysis/UI/test surfaces from the root engine check. UI changes must continue to be validated through `cd repos/polymarket-trade-engine/ui; npm run build` and targeted Vitest suites.

---

### 2026-05-19

### Decision

Split L2 auth header signer (EOA address) and Order Builder signer (wrapped Proxy) for EIP-1271 / Deposit Wallet setups.

### Reason

In Polymarket CLOB v2, EOA-derived API keys are associated with the EOA address, requiring the L2 auth header `POLY_ADDRESS` to be the EOA. However, for `signatureType: 3` (deposit wallets), the CTF Exchange requires the order's `signer` to be the deposit wallet contract address. To satisfy both constraints without an custom web-registered API key, we wrap the EOA signer in a Proxy to return the deposit wallet address as its `getAddress()` result, and assign it specifically to the ClobClient's `orderBuilder.signer` while keeping the standard EOA signer for L2 HTTP request authentication headers.

### Implications

Orders are correctly signed with the EOA key but contain the deposit wallet contract address as the `signer` field, passing both the CLOB API signer validation and on-chain ERC-1271 contract verification.


---

### 2026-05-19

### Decision

Adopt GNOSIS_SAFE (Signature Type 2) as the primary authentication mode and apply industrial-grade surgical hardening to the engine core.

### Reason

Browser-based Polymarket logins utilize Gnosis Safe smart contract wallets. Previous configurations using Type 3 (Deposit Wallets) were architecturally incorrect for this account, leading to 400 Bad Request errors. Additionally, silent failures in the WebSocket parser and overly permissive default risk limits (100% slippage) posed a significant risk to capital in a live environment.

### Alternatives Rejected

- **Maintaining Type 3 fallback**: Rejected because while it partially worked for balance checks, it failed full API key derivation and lacks true smart-contract signature validity for this account.
- **Ignoring Type Regressions**: Rejected because the use of 'any' for critical timers in a low-latency bot is a high-risk technical debt that leads to race conditions and obscure bugs.

### Implications

- **Authentication**: Orders are now correctly signed by the MetaMask EOA while being funded by the Gnosis Safe.
- **Safety**: The bot now enforces a 1% slippage cap and 5s data freshness by default, refusing to trade in degraded market conditions.
- **Observability**: WebSocket parsing errors are now logged, eliminating the 'idle bot' mystery when the exchange sends unexpected data.

---

### 2026-05-20

### Decision

Supersede the Type 2/Gnosis and signer-proxy theories with the officially derived Type 3 POLY_1271 deposit-wallet model.

### Reason

The accepted live BTC 5-minute order proved the real root cause was an incorrect `POLY_FUNDER_ADDRESS`, not a need to switch away from Type 3. Using `@polymarket/builder-relayer-client@0.0.9` and `deriveDepositWallet(owner, DepositWalletFactory, DepositWalletImplementation)`, owner `0x3528764a45bB13eC6BD8Deb1a73b5034742E6329` derives deposit wallet `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`. With that funder and fresh owner-derived CLOB credentials, a real Type 3 BTC 5-minute order was accepted, canceled, and open orders returned to zero.

### Alternatives Rejected

Continuing to use `0xbcbae6BE8cE9AD38C4FFD71254202f2aA27a30CF` or `0x609df252DF1371DBABD7aA234e028ACe9EAd90A2` as the live funder; reviving Type 2/Gnosis as the primary account model for this owner; preferring static `POLY_API_*` credentials over owner-derived CLOB credentials.

### Implications

The production client must keep deriving CLOB credentials from the owner signer and must build Type 3 orders with maker/signer equal to `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`, `signatureType=3`, and order version `2`. The 2026-05-19 Type 2/Gnosis decision is historical incident context only and is no longer active guidance.

