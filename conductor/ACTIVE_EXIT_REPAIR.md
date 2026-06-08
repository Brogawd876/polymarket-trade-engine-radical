# Active Exit Order State and Wallet Invariants Repair

## 1. Strategy Context & Wallet Availability
- **Objective:** Allow strategies to check true available inventory (wallet balance minus pending sell reservations).
- **Changes:**
  - Add `getAvailableShares: (tokenId: string) => number;` to `StrategyContext` in `engine/strategy/types.ts`.
  - In `engine/market-lifecycle.ts` (around `ctx` creation), implement `getAvailableShares: (tokenId) => self._tracker.availableShares(tokenId)`.

## 2. Reservation-Safe Active Exit Logic
- **Objective:** Fix naive inventory usage and prevent wallet invariant violations (trying to sell more than owned).
- **Changes in `engine/strategy/fair-value-maker.ts`:**
  - Calculate `availableUp = ctx.getAvailableShares(upTokenId)` and `availableDown = ctx.getAvailableShares(downTokenId)`.
  - Calculate `pendingSellShares` by summing `shares` of `ctx.pendingOrders` where `action === 'sell'`.
  - Calculate `grossBotOwnedShares` based on `inventoryUp`.
  - Calculate `sellableShares = min(available, grossOwned - pendingSells)`.
  - Only emit a new sell order if `sellableShares >= config.minShares`.

## 3. Enforce Single Active Sell per Token
- **Objective:** Prevent overlapping active sells and extreme quote/order churn.
- **Changes in `engine/strategy/fair-value-maker.ts`:**
  - Enforce "max one pending sell per token per market."
  - If a sell order already exists for a token, DO NOT submit a new one if the old one is currently being canceled (we will introduce a `cancelingOrderIds` check in `StrategyContext` if necessary, or just rely on the existing order taking time to vanish from `pendingOrders`). 
  - Specifically, if `existingSell` needs updating due to price changes, call `cancelOrders` and wait for it to be removed from `pendingOrders` before placing the new one. (e.g., skip `ordersToPost.push(...)` if `existingSell` exists).

## 4. Entry-Price Awareness
- **Objective:** Ensure profit-taking exits are actually profitable based on average entry price.
- **Changes:**
  - Calculate `averageEntryPrice` for UP and DOWN tokens from `ctx.orderHistory`.
  - Target sell price: `targetSellPrice = max(makerSafeSellPrice, averageEntryPrice + minProfit, adjustedFairValue + minExitEdge)`.
  - Separate emergency loss exits into a dedicated block if needed (future feature, but we will ensure normal active exit uses the `averageEntryPrice` floor).

## 5. Wallet Invariants and Negative Balance Halting
- **Objective:** Invalidate replays or sessions if critical accounting bugs occur.
- **Changes:**
  - In `engine/wallet-tracker.ts`, if `balance < -EPSILON` after a trade, throw `NegativeBalanceError`.
  - In `engine/bot-core/replay-runner.ts` and `session-manager.ts`, catch these errors (and existing wallet invariant violation errors). Mark the session/replay as `INVALID_RUN` and omit PnL from the summary.

## 6. Improved Replay Fill Realism
- **Objective:** Stop overstating PnL with optimistic fills.
- **Changes:**
  - Introduce optimistic, neutral, and pessimistic fill models in the replay runner or user channel.
  - Neutral/Pessimistic models will require the order to be "in the money" deeply enough or require queue position estimates to fill.

## 7. Diagnostics & Logging
- **Objective:** Better observability into active-exit specific behaviors.
- **Changes:**
  - Add specific logs when a sell is suppressed due to insufficient available shares or missing profit margins.
  - Track fill attributes and markouts if feasible, or ensure `sessionPnl` is accurately reported by fill models.