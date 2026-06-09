# Active Task: Order Churn and FVM Workflow Audit
Status: **COMPLETED**

## Objective
Audit the FVM/live-order workflow to reduce order churn, fix market latching, ensure safe cancel lifecycles, and verify PnL/settlement tie-breaker rules.

## Progress
1. Implemented MOL (Minimum Order Life) and Hysteresis to reduce order churn.
2. Fixed future-round Chainlink anchor latching.
3. Fixed PolymarketVenueAdapter token mapping to parse `outcomes` array.
4. Repaired UserChannel untracking bug (untracked *after* API confirm instead of before).
5. Rewrote FVM active order state machine from loose booleans to explicit synced state map.
6. Refactored `WalletTracker` to support partial fills properly.
7. Explicitly tested and locked in tie-breaker settlement logic (DOWN wins on ties).
8. Enforced `ConservativeMakerFillModel` as the default in simulation clients.

## Next Actions
- Monitor Paper Trading for 48 hours to validate the new OrderMachineState syncing against live websocket data.
- Merge `feature/reduce-order-churn` into main.