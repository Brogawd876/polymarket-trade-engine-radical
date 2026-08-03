import { describe, expect, test } from "bun:test";
import {
  carryReplayState,
  createContinuousReplayState,
  verifyContinuousReplayState,
} from "../../engine/production/continuous-replay.ts";
import type { LedgerSnapshot } from "../../engine/production/ledger.ts";

function ledger(cash: string): LedgerSnapshot {
  return {
    cashBalance: cash,
    availableCash: cash,
    reservedBuyCash: "0",
    pendingCash: "0",
    tokenBalances: {},
    availableTokens: {},
    reservedSellTokens: {},
    pendingTokenAdjustments: {},
    realizedTradingPnl: "0",
    settlementPnl: "0",
    actualFees: "0",
    verifiedRebates: "0",
    externalDeposits: "0",
    externalWithdrawals: "0",
    lots: [],
  };
}

describe("continuous replay state", () => {
  test("carries bankroll, risk, pending, strategy, model, and churn state", () => {
    const first = createContinuousReplayState({
      ledger: ledger("100"),
      openOrderIntentIds: ["intent-1"],
      pendingTradeIds: ["trade-pending"],
      unsettledMarketIds: ["market-1"],
      equityHighWatermark: "100",
      drawdown: "0",
      sessionLoss: "0",
      strategyState: { inventorySkew: "0.1" },
      modelState: { artifactHash: "abc" },
      orderChurnState: { "market-1": 2 },
      capitalUtilization: "0.05",
    });
    const second = carryReplayState(first, {
      ledger: ledger("99"),
      openOrderIntentIds: [],
      pendingTradeIds: [],
      unsettledMarketIds: ["market-1"],
      equityHighWatermark: "100",
      drawdown: "1",
      sessionLoss: "1",
      strategyState: { inventorySkew: "0" },
      modelState: { artifactHash: "abc" },
      orderChurnState: { "market-1": 3 },
      capitalUtilization: "0.1",
    });
    expect(second.marketSequence).toBe(1);
    expect(second.previousStateHash).toBe(first.stateHash);
    expect(second.ledger.cashBalance).toBe("99");
    expect(second.drawdown).toBe("1");
    expect(second.modelState).toEqual({ artifactHash: "abc" });
    verifyContinuousReplayState(second);
  });

  test("detects tampering before the next market", () => {
    const state = createContinuousReplayState({
      ledger: ledger("100"),
      openOrderIntentIds: [],
      pendingTradeIds: [],
      unsettledMarketIds: [],
      equityHighWatermark: "100",
      drawdown: "0",
      sessionLoss: "0",
      strategyState: {},
      modelState: {},
      orderChurnState: {},
      capitalUtilization: "0",
    });
    state.ledger.cashBalance = "1000";
    expect(() => verifyContinuousReplayState(state)).toThrow(
      "continuous replay state hash mismatch",
    );
  });
});
