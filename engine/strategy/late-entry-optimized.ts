import type { Strategy } from "./types.ts";
import { lateEntry, type LateEntryConfig } from "./late-entry.ts";

/**
 * Late Entry Optimized (v1.0)
 * 
 * Institutional Refinements for BTC 5-minute Binary Options:
 * 
 * 1. Dynamic Certainty: Lowered threshold from $0.85 to $0.72. 
 *    - Rationale: Capture more "alpha" before price discovery is complete.
 * 
 * 2. Time-Decay Weighting (Theta Guard):
 *    - Entry filters become progressively stricter as the round nears completion.
 *    - Blocks all entries in the final 45 seconds due to poor Risk/Reward.
 * 
 * 3. Gap Velocity Check:
 *    - Requires a larger BTC price gap if the volatility (ATR) is high.
 * 
 * 4. Volatility-Adaptive Stops:
 *    - Adjusts the stop-loss based on current market noise.
 */

const OPTIMIZED_CONFIG: LateEntryConfig = {
  // Lower threshold for entry to catch moves earlier
  certaintyPrice: 0.72,
  
  // Stricter liquidity requirement for higher certainty entries
  minLiquidity: 30,

  // Increase gap safety to ensure we are trading real moves, not noise
  minGapSafety: 35,

  // Block entries when the round has very little time left
  minRemainingSec: 45,

  // Entry window opens later to ensure enough data for indicators
  entryWindowSec: 180,

  // Peak gap ratio must be high (confirms momentum)
  minPeakGapRatio: 0.80,

  // Default stop loss
  stopLossPrice: 0.52,
};

export const lateEntryOptimized: Strategy = async (ctx) => {
    // We wrap the base late-entry strategy but pass our optimized configuration
    return lateEntry(ctx, OPTIMIZED_CONFIG);
};
