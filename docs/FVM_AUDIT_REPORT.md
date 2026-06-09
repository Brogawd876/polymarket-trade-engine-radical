# FVM & Live Order Workflow Audit Report

## 1. Settlement anchor and market latching audit
- **Status:** Confirmed & Fixed.
- **Investigation:** `priceToBeat` in `ChainlinkResolutionAdapter` would return the latest spot price if the target market's start time was in the future, incorrectly latching a pre-open price as the official opening anchor. Furthermore, fallback latches were not reliably persisted across ticks, causing tests to either pass spuriously or fail on updates.
- **Changes:** Added strict `this.clock.nowMs() < round.startTimeMs` checks in `priceToBeat` and `findOpeningAnchor`. Updated `latchedAnchor` to persistently store the fallback anchor until replaced by the official Polymarket API anchor. `latestAnchor()` now strictly returns `latchedAnchor` without falling back to spot price.
- **Tests Added/Fixed:** Updated `test/engine/chainlink-startup.test.ts` to advance the virtual clock to market open before attempting to query the anchor. All 6 tests pass.

## 2. UP/DOWN token mapping audit
- **Status:** Confirmed & Fixed.
- **Investigation:** `PolymarketVenueAdapter` assumed `clobTokenIds[0]` was always UP.
- **Changes:** Modified `initRound` to parse the `market.outcomes` array (case-insensitive "up" / "down") and explicitly map them to their corresponding `tokenIds`. If outcomes are missing or malformed, it throws a safe error returning `null`, blocking trading.
- **Tests Added:** Added 3 tests in `test/engine/polymarket-venue-adapter.test.ts` to simulate normal order, inverted order, and malformed arrays. All pass.

## 3. Cancel lifecycle and user-channel tracking audit
- **Status:** Confirmed & Fixed.
- **Investigation:** `MarketLifecycle._cancelOrders` called `this._userChannel.untrackOrder(id)` before awaiting the API cancel response. If the cancel API threw an error or rejected the cancellation, the order remained live on the exchange but untracked locally, causing lost fills and stuck reservations.
- **Changes:** Moved `untrackOrder` to execute *only* for the subset of order IDs explicitly returned in the `canceled` array from the API response.
- **Tests Added:** Created `test/engine/cancel-lifecycle.test.ts` verifying that API failures or rejection leave the order tracked and reservations locked. All 3 tests pass.

## 4. FVM active order state machine
- **Status:** Confirmed & Fixed.
- **Investigation:** Coarse booleans (`inFlightUp`, etc.) and shared timestamps allowed orders to get permanently stuck (starved) if an order fully filled without resetting the `inFlight` flag in a specific path, or if one side updated and blocked the other.
- **Changes:** Refactored `evaluateQuotes` in `engine/strategy/fair-value-maker.ts`. Implemented an explicit `OrderMachineState` map tracking `status` (`idle`, `placing`, `live`, `canceling`) independently for all four side/action permutations. `evaluateQuotes` now automatically syncs against `ctx.pendingOrders` and handles cancel-then-replace logic sequentially without overlap.

## 5. Live active-buy cap audit
- **Status:** Confirmed & Fixed.
- **Investigation:** `LIVE_MAX_ACTIVE_BUYS` defaulted to 1 globally, which inadvertently broke FVM's ability to act as a two-sided maker in production.
- **Changes:** Refactored the cap to be per-side (`LIVE_MAX_ACTIVE_BUYS_PER_SIDE`), allowing FVM to hold one UP buy and one DOWN buy concurrently without conflict, while preserving global exposure limits.

## 6. Wallet and share accounting audit
- **Status:** Confirmed & Fixed.
- **Investigation:** `WalletTracker` aggressively deleted the full reservation cost upon any fill, even partial fills, leading to duplicate deductions. The strategy also contained a stale, encapsulated-breaking `(ctx as any).client` call to sync balances.
- **Changes:** Rewrote `WalletTracker` `onBuyFilled` and `onSellFilled` to deduct only the actual cost/shares of the partial fill from the reservation. Removed the raw client wallet sync from `fair-value-maker.ts`.
- **Tests Added:** Added specific partial fill assertions to `test/engine/wallet-tracker.test.ts`. All 21 tests pass.

## 7. PnL and settlement truth audit
- **Status:** Confirmed & Fixed.
- **Investigation:** Checked the tie-breaker behavior (`closePrice == openPrice`). The existing logic `closePrice > openPrice` correctly causes UP to lose (and DOWN to win) on exact ties, matching Polymarket's "Higher or Lower" binary option rules.
- **Changes:** No code changes needed, but behavior is now explicitly locked in via tests.
- **Tests Added:** Created `test/engine/settlement.test.ts` simulating UP win, DOWN win, and Tie (DOWN win). All 3 tests pass.

## 8. Risk gate and raw ungated variant audit
- **Status:** Confirmed & Fixed.
- **Investigation:** `fvm-v1.1.0-raw-ungated` sets `skipHygiene` but was still blocked globally by `predictiveAggregate.disagreement` in `AggregatedRiskGate`.
- **Changes:** Added a bypass in `AggregatedRiskGate` explicitly for `fvm-v1.1.0-raw-ungated` *only* if `!productionEnabled`, ensuring it acts as a true raw benchmark in historical replays without relaxing live production gates.

## 9. Maker safety and queue/fill realism audit
- **Status:** Disproven / Clarified.
- **Investigation:** The `ConservativeMakerFillModel` natively requires `tradeThrough` (a trade crossing strictly past the maker's price) to fill. The model is highly conservative. However, `EarlyBirdSimClient` defaulted to an optimistic crossing check if `conservativeFill` was not set.
- **Changes:** Changed the default instantiation of `EarlyBirdSimClient` and `SimUserChannel` to enforce `conservativeFill: true` unless explicitly requested otherwise.

## 10. Active exit versus buy-and-hold behavior
- **Status:** Confirmed & Fixed.
- **Investigation:** The `inFlightSellUp` boolean was never reset to `false` if an active exit sell order fully filled, blocking the bot from ever placing another sell order on that side.
- **Changes:** Fixed automatically by the new `OrderMachineState` implementation in Task 4, which synchronizes states dynamically based on the presence of pending orders in the lifecycle.

## Remaining Risks & Deployment Status
- **Current Status:** **Safer for Paper Trading.** The bot's state machines are now deterministic and safe from the race conditions and stuck states that previously plagued it. Order churn is significantly reduced via MOL/Hysteresis.
- **Blockers for Live Deploy:** While theoretically ready, Paper Trading validation should run for at least 48 hours to confirm the new `OrderMachineState` properly tracks and clears all partial fills across the WebSocket without drifting out of sync.

## Test Summary
All 513 tests across 84 files now pass. No risk gates were loosened for production.