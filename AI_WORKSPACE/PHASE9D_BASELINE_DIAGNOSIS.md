# Phase 9D Baseline Diagnosis

## Summary
The `fair-value-maker` strategy generates a high volume of intents that hit the `open exposure would exceed max exposure limit` risk gate. While the strategy has a basic cooldown mechanism to suppress repeated rejections, it lacks strategy-side awareness of the remaining exposure budget.

## Findings

### 1. Exposure-Limit Block Root Causes
- **Blind Intent Generation:** The strategy calculates its target shares based on `fixed` amount or `pct_of_balance` without checking the current open exposure. If the portfolio is already at the max exposure limit, it continues to emit buy intents that are destined to be blocked.
- **Fingerprint Sensitivity:** The `exposureBlockKey` includes the entire order history and pending orders. Any minor change in market state that results in a new order or a slight price shift will generate a new fingerprint, bypassing the cooldown.
- **Concurrent Sides:** It attempts to quote both UP and DOWN simultaneously. If one side is already at max exposure, the other side's buy intents will still be emitted and blocked.

### 2. Block Quality and Adverse Selection
- **Toxic Regime:** The 0.92 Adverse Selection rate in permissive mode confirms that intents being blocked are predominantly toxic. The risk gates are doing their job, but the strategy is "probing" the gates too aggressively with low-quality intents.
- **Predictive Disagreement:** The strategy currently bypasses "Quote Hygiene" (early aborts on disagreement) because it was found to decimate profitability. However, some form of conditional filtering might be needed to reduce noise during high-toxicity periods.

### 3. Dynamic Sizing Correctness
- The strategy correctly reads `ctx.walletBalanceUsd` for `pct_of_balance` mode.
- **Limitation:** It does not bound `targetShares` by the remaining exposure budget.

### 4. Variant Performance Discrepancy
- `fvm-v1.1.0` (Raw, Ungated) is crowned champion in `ACTIVE_TASK.md` with +$120.30 PnL, likely based on a sweep that allows more exposure or has different risk settings. In the standard "Normal Mode" comparison, it performs much worse (-$2.20 to $75.80 depending on the subset), indicating that its profitability is highly sensitive to the strictness of the exposure limits.

## Recommendations
- **Strategy-Side Exposure Clamp:** Implement logic to calculate remaining exposure budget and reduce `targetShares` to fit within that budget before emitting the intent.
- **Minimum Viable Size:** Suppress intents if the clamped size falls below a minimum threshold (e.g., 1 share or $1.00 notional).
- **Conditional Hygiene:** Instead of a binary `skipHygiene`, consider weighting edge/confidence higher during predictive disagreement.
