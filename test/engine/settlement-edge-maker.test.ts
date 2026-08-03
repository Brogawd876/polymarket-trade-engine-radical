import { describe, expect, test } from "bun:test";
import {
  PairedCostShadowStrategy,
  SettlementEdgeMaker,
  evaluateEconomicExit,
} from "../../engine/production/settlement-edge-maker.ts";

function quote(overrides = {}) {
  return {
    side: "UP" as const,
    tokenId: "UP",
    bestBid: "0.45",
    bestAsk: "0.5",
    tickSize: "0.01",
    minimumOrderSize: "5",
    requestedSize: "5",
    gridLevels: 5,
    fillProbability: 0.5,
    expectedFillFraction: 0.8,
    fillConditionedWinProbabilityLower: 0.65,
    expectedFutureExitCostPerShare: "0.01",
    expectedLatencyCostPerShare: "0.005",
    expectedAdverseSelectionCostPerShare: "0.01",
    expectedInventoryCostPerShare: "0.005",
    expectedCancellationCost: "0.001",
    expectedRebate: "0.5",
    minimumConservativeEv: "0.01",
    decisionTimestampMs: 100,
    sourceSnapshotIds: ["anchor-1", "book-1", "model-1"],
    ...overrides,
  };
}

describe("SettlementEdgeMaker", () => {
  test("selects the highest positive tick-aligned post-only utility", () => {
    const decision = new SettlementEdgeMaker().evaluate(quote());
    expect(decision.outcome).toBe("ORDER_INTENT_CREATED");
    expect(decision.selected?.requestedPrice).toBe("0.45");
    expect(decision.candidates.every((candidate) => candidate.postOnly)).toBe(
      true,
    );
    expect(
      decision.candidates.every(
        (candidate) => candidate.rebateContributionToApproval === "0",
      ),
    ).toBe(true);
  });

  test("defaults to no trade when conservative costs consume the edge", () => {
    const decision = new SettlementEdgeMaker().evaluate(
      quote({
        fillConditionedWinProbabilityLower: 0.47,
        expectedAdverseSelectionCostPerShare: "0.05",
      }),
    );
    expect(decision.outcome).toBe("NO_TRADE");
    expect(decision.selected).toBeNull();
  });

  test("risk blockers are separate from the alpha threshold", () => {
    const decision = new SettlementEdgeMaker().evaluate(
      quote({ riskReasons: ["anchor is not verified"] }),
    );
    expect(decision.outcome).toBe("BLOCKED");
    expect(decision.reason).toContain("anchor");
  });
});
describe("economic exits", () => {
  test("permits a profitable full FOK exit using walked depth and fees", () => {
    const decision = evaluateEconomicExit({
      quantity: "5",
      bids: [
        { price: "0.7", quantity: "3" },
        { price: "0.69", quantity: "2" },
      ],
      holdProbability: 0.6,
      takerFeeRate: "0.07",
      latencyCost: "0.001",
      riskLambda: "0.01",
      capitalCost: "0",
      stalenessCost: "0",
      uncertaintyCost: "0",
      hysteresis: "0.01",
      fullExitRequired: true,
      partialAcceptable: false,
      intentionallyRestingMaker: false,
    });
    expect(decision.action).toBe("SELL");
    expect(decision.orderType).toBe("FOK");
    expect(decision.worstPrice).toBe("0.69");
    expect(Number(decision.expectedFee)).toBeGreaterThan(0);
  });

  test("permits loss cutting when hold value is worse", () => {
    const decision = evaluateEconomicExit({
      quantity: "5",
      bids: [{ price: "0.3", quantity: "5" }],
      holdProbability: 0.1,
      takerFeeRate: "0.07",
      latencyCost: "0",
      riskLambda: "0.01",
      capitalCost: "0.1",
      stalenessCost: "0.1",
      uncertaintyCost: "0.1",
      hysteresis: "0.01",
      fullExitRequired: true,
      partialAcceptable: false,
      intentionallyRestingMaker: false,
    });
    expect(decision.action).toBe("SELL");
  });

  test("holds when executable proceeds do not beat hold plus hysteresis", () => {
    const decision = evaluateEconomicExit({
      quantity: "5",
      bids: [{ price: "0.4", quantity: "5" }],
      holdProbability: 0.8,
      takerFeeRate: "0.07",
      latencyCost: "0",
      riskLambda: "0",
      capitalCost: "0",
      stalenessCost: "0",
      uncertaintyCost: "0",
      hysteresis: "0.05",
      fullExitRequired: true,
      partialAcceptable: false,
      intentionallyRestingMaker: false,
    });
    expect(decision.action).toBe("HOLD");
  });

  test("uses FAK only when partial execution is explicitly acceptable", () => {
    const decision = evaluateEconomicExit({
      quantity: "5",
      bids: [{ price: "0.8", quantity: "2" }],
      holdProbability: 0.1,
      takerFeeRate: "0",
      latencyCost: "0",
      riskLambda: "0",
      capitalCost: "0",
      stalenessCost: "0",
      uncertaintyCost: "0",
      hysteresis: "0",
      fullExitRequired: false,
      partialAcceptable: true,
      intentionallyRestingMaker: false,
    });
    expect(decision.action).toBe("SELL");
    expect(decision.orderType).toBe("FAK");
    expect(decision.remainingQuantityAfterExit).toBe("3");
  });
});

describe("paired-cost shadow strategy", () => {
  test("does not call a pending second leg locked arbitrage", () => {
    const decision = new PairedCostShadowStrategy().evaluate({
      confirmedUpQuantity: "10",
      confirmedDownQuantity: "10",
      upAcquisitionCost: "4",
      downAcquisitionCost: "4",
      allFeesAndExecutionCosts: "0.1",
      pendingUnmatchedCost: "0.2",
      nakedLegStartedAtMs: null,
      decisionTimestampMs: 100,
      maximumNakedLegNotional: "2",
      maximumNakedLegMs: 1000,
      safetyBuffer: "0.1",
    });
    expect(decision.lockedArbitrage).toBe(false);
    expect(decision.blockedReasons.join(" ")).toContain("pending unmatched");
  });

  test("proves both outcome scenarios above the safety buffer", () => {
    const decision = new PairedCostShadowStrategy().evaluate({
      confirmedUpQuantity: "10",
      confirmedDownQuantity: "10",
      upAcquisitionCost: "4",
      downAcquisitionCost: "4",
      allFeesAndExecutionCosts: "0.1",
      pendingUnmatchedCost: "0",
      nakedLegStartedAtMs: null,
      decisionTimestampMs: 100,
      maximumNakedLegNotional: "2",
      maximumNakedLegMs: 1000,
      safetyBuffer: "0.1",
    });
    expect(decision.lockedArbitrage).toBe(true);
    expect(decision.minimumScenarioPnl).toBe("1.9");
  });
});
