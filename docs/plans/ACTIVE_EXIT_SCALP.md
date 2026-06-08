# Implementation Plan: Active Exit (Two-Sided Scalping)

This plan upgrades the `fairValueMaker` strategy from a "Buy-and-Hold" approach to an active "Market Maker" approach by implementing two-sided quoting.

## Objective
The bot currently only places BUY orders. If a BUY is filled, it holds the position until the market resolves (Win or Zero). This plan adds logic to immediately place a SELL order once a position is held, attempting to "scalp" a profit before expiration.

---

## Step 1: Inventory Detection
Modify `evaluateQuotes` to correctly identify existing positions for both UP and DOWN tokens.
*   **UP Inventory**: Sum of BUYS - Sum of SELLS for the UP token.
*   **DOWN Inventory**: Sum of BUYS - Sum of SELLS for the DOWN token.
*   *Note: Current code already calculates `inventoryUp` (Net position relative to BTC UP outcome).*

## Step 2: SELL Price Calculation
Calculate a profitable exit price based on the current Black-Scholes Fair Value.
*   **Formula**: `SellPrice = FairValue + exit_edge`.
*   **Constraint**: The SELL order must be a "Maker" order (placed on the book) to capture rebates and avoid taker fees. 
*   **Buffer**: Use a configurable `minExitEdge` (e.g., 0.005 or 0.01) to ensure the scalp is worth the risk/fee.

## Step 3: Batch Order Dispatch
Modify the `ordersToPost` array logic to allow both a BUY intent and a SELL intent in the same heartbeat.
*   **BUY Side**: Continue posting bids based on `FairValue - entry_edge` (current logic).
*   **SELL Side**: If inventory > 0, post an ask based on `FairValue + exit_edge`.
*   **Conflict Resolution**: Ensure the bot doesn't try to BUY and SELL at the same price (wash trading).

## Step 4: Event-Driven Re-quoting
Ensure that a fill immediately triggers a re-evaluation.
*   The bot already subscribes to `predictive`, `quant`, and `orderFlow` updates.
*   **New**: Ensure the `onFilled` callback for BUY orders triggers `evaluateQuotes()` to post the SELL order without waiting for the 1-second heartbeat.

---

## Technical Constraints & Safety
1.  **5-Share Minimum**: Maintain the Polymarket 5-share rule for both BUY and SELL.
2.  **Wash Trade Protection**: Add a check to ensure `AskPrice > BidPrice + 2*tickSize`.
3.  **Capital Awareness**: Priority is given to SELLS (freeing up capital) over BUYS (consuming capital).

## Verification Strategy
1.  **Unit Tests**: Update `test/engine/strategies.test.ts` to mock a filled BUY and verify that the next `evaluateQuotes` produces a SELL intent.
2.  **Paper Run**: Run the strategy in simulation mode on a live market to verify two-sided order placement in the logs.
3.  **Forensic Audit**: Verify that `sessionPnl` correctly tracks the "realized" scalp profit.
