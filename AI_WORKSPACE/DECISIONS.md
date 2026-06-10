# Decisions

## Recent Decisions (FVM Audit & Churn Optimization)

### 1. Order Churn (Hysteresis & MOL)
**Decision:** Orders will not be replaced for minor price movements. A Minimum Order Life (500ms) and Price Hysteresis (0.02) are enforced.
**Rationale:** The bot was churning orders multiple times per second, risking rate limits and high cancellation fees.

### 2. State Machine (Postponed)
**Decision:** Revert the `OrderMachineState` refactor and restore legacy `inFlight` booleans.
**Rationale:** The refactor was partially implemented and causing instability. To maintain a clean merge path for other critical fixes, the state machine work is postponed to a dedicated task.

### 3. Cancel Lifecycle Untracking
**Decision:** `MarketLifecycle` will only untrack an order from the user channel AFTER the exchange API confirms it is canceled.
**Rationale:** Previously, if the cancel API failed, the order remained live on the exchange but was untracked locally, causing missed fills and permanently locked wallet reservations.

### 4. Tie-Breaker Settlement
**Decision:** Maintain `closePrice > openPrice` for UP to win.
**Rationale:** Polymarket "Higher or Lower" binary markets require the asset to finish strictly higher for "Higher" (UP) to win. An exact tie resolves to Lower (DOWN). Tested and locked in.

### 5. Conservative Fill Default
**Decision:** Simulation clients now default to `ConservativeMakerFillModel` (`requireTradeThrough`).
**Rationale:** To prevent overstating maker profitability in backtests. Optimistic fills must be explicitly opted into.