/**
 * FROZEN RESEARCH BENCHMARK — FVM v1.1.0 Raw/Ungated repository equivalent.
 *
 * This distinct entry point pins the benchmark configuration. The regression
 * test also pins the SHA-256 of the shared implementation it delegates to, so
 * that implementation cannot change silently underneath the benchmark.
 *
 * Research/replay only. Historical PnL is not evidence of live profitability.
 */
import type { Strategy } from "./types.ts";
import { fairValueMaker } from "./fair-value-maker.ts";

export const FVM_V110_RAW_UNGATED_CONFIG = Object.freeze({
  skipHygiene: true,
  minCvd10s: Number.NEGATIVE_INFINITY,
  sharesMode: "fixed",
  shares: 5,
  minShares: 5,
  divergenceThresholdAbs: 200,
} as const);

export const frozenFvmV110RawUngated: Strategy = async context => {
  await fairValueMaker({
    ...context,
    strategyConfig: FVM_V110_RAW_UNGATED_CONFIG,
  });
};
