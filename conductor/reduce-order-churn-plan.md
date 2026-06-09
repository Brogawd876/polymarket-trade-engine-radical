# Implementation Plan: Reduce Order Churn (Hysteresis & MOL)

## Objective
Fix the "order churn" issue where the bot rapidly replaces orders multiple times per second due to micro-volatility. This will reduce exchange latency, prevent potential rate-limiting, and improve the bot's Order-to-Fill (OTF) ratio.

## Key Files & Context
- `engine/strategy/fair-value-maker.ts`: The primary strategy file where quote evaluation and order replacements occur.

## Implementation Steps
1. **Configuration Updates:**
   - Add `minOrderLifeMs: number` (default `500`) to `FairValueMakerConfig`.
   - Add `priceHysteresis: number` (default `0.02`) to `FairValueMakerConfig` to replace the hardcoded `TOLERANCE` value.

2. **State Tracking (MOL):**
   - Introduce local state variables `lastUpdateUpMs` and `lastUpdateDownMs` inside the `fairValueMaker` closure.
   - When an order is placed or replaced, update these timestamps.

3. **Quote Evaluation Logic:**
   - Modify the `evaluateQuotes` loop: before canceling an `existingUp` or `existingDown` order to replace it, enforce the Minimum Order Life check (`ctx.clock.nowMs() - lastUpdateMs > config.minOrderLifeMs`).
   - Replace the `Math.abs(existing.price - newPrice) > (TOLERANCE + EPSILON)` check with `Math.abs(...) > (config.priceHysteresis + EPSILON)`.

4. **Log Backoff:**
   - Adjust the `exposureBlockCooldowns` and `logSuppressedAffordability` logic to back off exponentially or use a larger fixed window (e.g., 30s) to prevent the console from being flooded with "insufficient exposure budget" messages during high-volatility events.

5. **Version Control:**
   - Create a new branch: `feature/reduce-order-churn`.
   - Commit the changes with a descriptive message.
   - Push the branch to the remote repository.

## Verification & Testing
- Run the simulation logs (e.g., `out_final_50.log` equivalent) to verify that order updates are throttled to a maximum of 2 per second per side.
- Verify that minor probability shifts (e.g., 1 cent) do not trigger order replacements.