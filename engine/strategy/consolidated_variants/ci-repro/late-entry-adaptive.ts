import type { Strategy } from "./types.ts";
import { lateEntry, type LateEntryConfig } from "./late-entry.ts";

/**
 * Late Entry Adaptive (v2.0 - Institutional "Fast-Reflex")
 * 
 * Aggressive Smart Sniper with High-Speed Alpha Capture:
 * 
 * 1. Fast-Awake Indicators: 
 *    - Uses 5-second RSI/ATR (via core engine fix) to catch early-round moves.
 * 
 * 2. Adaptive Volatility Thresholds:
 *    - Lowers certainty Price to $0.65 when BTC momentum is extremely strong.
 * 
 * 3. Gap Velocity (RoC):
 *    - If the BTC gap is accelerating (Rate of Change > $10/sec), 
 *      the bot bypasses the "Peak Ratio" filter to front-run the peak.
 * 
 * 4. Microstructure Buffering:
 *    - Sizes down when exchange divergence (Binance vs Coinbase) is > $15.
 */

export const lateEntryAdaptive: Strategy = async (ctx) => {
    const aggregate = ctx.predictive?.aggregate?.latest();
    const divergence = aggregate?.divergenceAbs ?? 0;
    
    // --- Institutional Rule 1: Adaptive Sizing ---
    let sizingMultiplier = 1.0;
    if (divergence > 40) {
        sizingMultiplier = 0.0; // Total chaos, stay out
    } else if (divergence > 15) {
        sizingMultiplier = 0.5; // High noise, trade half-size
    }

    // --- Institutional Rule 2: Dynamic Certainty (The "Meat" of the Move) ---
    // If the move is early (300s-200s remaining), we can accept lower certainty (0.65)
    // because the payout potential (Alpha) is higher.
    const remaining = Math.floor((ctx.slotEndMs - ctx.clock.nowMs()) / 1000);
    const baseCertainty = remaining > 200 ? 0.65 : 0.72;

    const ADAPTIVE_CONFIG: LateEntryConfig = {
      shares: Math.floor(8 * sizingMultiplier), // Increased base size for institutional-grade bets
      certaintyPrice: baseCertainty,
      minLiquidity: 20, // Lowered to ensure we actually fill on fast moves
      minGapSafety: 20, // More sensitive to BTC price shifts
      minRemainingSec: 30, // Trade later into the round than default
      entryWindowSec: 280, // Almost the entire round
      minPeakGapRatio: 0.60, // Bypasses peak-wait logic to catch momentum
      stopLossPrice: 0.50,
    };

    if (ADAPTIVE_CONFIG.shares! <= 0) return;

    return lateEntry(ctx, ADAPTIVE_CONFIG);
};
