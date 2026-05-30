import { lateEntry } from "./late-entry.ts";
import type { Strategy } from "./types.ts";

export const hyperAggressive: Strategy = async (ctx) => {
    return lateEntry(ctx, {
        certaintyPrice: 0.51,
        minGapSafety: 0,
        minPeakGapRatio: 0,
        minLiquidity: 0,
        entryWindowSec: 300, // Entire 5 minutes
        minRemainingSec: 0
    });
};
