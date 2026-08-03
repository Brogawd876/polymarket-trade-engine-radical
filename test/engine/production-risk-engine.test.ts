import { describe, expect, test } from "bun:test";
import { MemoryJournal } from "../../engine/production/journal.ts";
import {
  PILOT_RISK_DEFAULTS,
  ProductionRiskEngine,
  type ProductionRiskInput,
} from "../../engine/production/risk-engine.ts";

function healthyInput(): ProductionRiskInput {
  return {
    riskDecisionId: "risk-1",
    runId: "run-1",
    candidateId: "candidate-1",
    decisionTimestampMs: 100,
    mode: "PAPER",
    liveAuthorizationPresent: false,
    dependencies: {
      anchorVerified: true,
      exactMarketVerified: true,
      marketUnambiguous: true,
      acceptingOrders: true,
      resolutionFresh: true,
      predictiveSourceCount: 3,
      minimumPredictiveSourceCount: 2,
      venueBookFresh: true,
      venueBookContinuous: true,
      userChannelHealthy: true,
      userChannelOutageWithinReconciliationTolerance: false,
      reconciliationValid: true,
      unresolvedExchangeCommand: false,
      modelCompatible: true,
      modelApproved: true,
      modelExpired: false,
      tickSizeSupported: true,
      minimumSizeSupported: true,
      depthSufficient: true,
      spreadWithinLimit: true,
      priceImpactWithinLimit: true,
      quoteAgeWithinLimit: true,
      clockDriftWithinLimit: true,
      exchangeHealthy: true,
      orphanRiskOrder: false,
      orderChurnWithinLimit: true,
      requiredEvidenceComplete: true,
      settlementRulesUnambiguous: true,
      journalHealthy: true,
    },
    financials: {
      startingBankroll: "100",
      requestedOrderNotional: "5",
      venueMinimumOrderNotional: "5",
      proposedMarketWorstCaseLoss: "5",
      proposedAggregateWorstCaseOpenLoss: "5",
      sessionLoss: "0",
      drawdown: "0",
      activeMarketIds: [],
      proposedMarketId: "market-1",
    },
  };
}

describe("ProductionRiskEngine", () => {
  test("uses fixed pilot caps and allows a healthy paper candidate", async () => {
    const journal = new MemoryJournal(() => 100);
    const engine = new ProductionRiskEngine(journal);
    const result = await engine.evaluate(healthyInput());
    expect(result.approved).toBe(true);
    expect(result.limits).toEqual({
      maximumPerMarketWorstCaseLoss: "10",
      maximumAggregateWorstCaseOpenLoss: "20",
      maximumDrawdown: "20",
      maximumActiveMarkets: 1,
    });
    expect(PILOT_RISK_DEFAULTS.kellyEnabled).toBe(false);
    expect(PILOT_RISK_DEFAULTS.compoundingEnabled).toBe(false);
    expect(journal.records().at(-1)?.kind).toBe("risk_decision_recorded");
  });

  test("enumerates operational blockers instead of hiding them behind alpha", async () => {
    const engine = new ProductionRiskEngine(new MemoryJournal());
    const input = healthyInput();
    input.dependencies.anchorVerified = false;
    input.dependencies.reconciliationValid = false;
    input.dependencies.unresolvedExchangeCommand = true;
    input.dependencies.journalHealthy = false;
    input.dependencies.settlementRulesUnambiguous = false;
    const result = await engine.evaluate(input);
    expect(result.approved).toBe(false);
    expect(result.hardBlockReasons).toContain("unverified anchor");
    expect(result.hardBlockReasons).toContain(
      "unresolved wallet or ledger mismatch",
    );
    expect(result.hardBlockReasons).toContain("unresolved exchange command");
    expect(result.hardBlockReasons).toContain("disk or journal failure");
    expect(result.hardBlockReasons).toContain("settlement-rule ambiguity");
  });

  test("blocks venue minimum above cap, aggregate exposure, and a second market", async () => {
    const engine = new ProductionRiskEngine(new MemoryJournal());
    const input = healthyInput();
    input.financials.venueMinimumOrderNotional = "11";
    input.financials.requestedOrderNotional = "11";
    input.financials.proposedAggregateWorstCaseOpenLoss = "20.000001";
    input.financials.activeMarketIds = ["other-market"];
    const result = await engine.evaluate(input);
    expect(result.hardBlockReasons).toContain(
      "venue minimum or order size exceeds per-market risk cap",
    );
    expect(result.hardBlockReasons).toContain("aggregate exposure limit");
    expect(result.hardBlockReasons).toContain(
      "one active five-minute market limit",
    );
  });

  test("kill switch and live authorization fail closed", async () => {
    const journal = new MemoryJournal();
    const engine = new ProductionRiskEngine(journal);
    await engine.engageKillSwitch("operator stop");
    const input = healthyInput();
    input.mode = "MICRO_LIVE";
    const blocked = await engine.evaluate(input);
    expect(blocked.hardBlockReasons).toContain("manual kill switch");
    expect(blocked.hardBlockReasons).toContain(
      "separate explicit live authorization is absent",
    );
    await engine.resetKillSwitch("investigation complete");
    input.mode = "PAPER";
    expect((await engine.evaluate(input)).approved).toBe(true);
  });

  test("simultaneous channel, clock, maintenance, and loss failures are pure and evidenced", async () => {
    const journal = new MemoryJournal(() => 200);
    const engine = new ProductionRiskEngine(journal);
    const input = healthyInput();
    input.dependencies.userChannelHealthy = false;
    input.dependencies.userChannelOutageWithinReconciliationTolerance = false;
    input.dependencies.clockDriftWithinLimit = false;
    input.dependencies.exchangeHealthy = false;
    input.financials.sessionLoss = "20";
    const financialsBefore = structuredClone(input.financials);

    const result = await engine.evaluate(input);

    expect(result.approved).toBe(false);
    expect(result.hardBlockReasons).toContain(
      "user-channel failure beyond reconciliation tolerance",
    );
    expect(result.hardBlockReasons).toContain("excessive clock drift");
    expect(result.hardBlockReasons).toContain(
      "market maintenance or degraded exchange state",
    );
    expect(result.hardBlockReasons).toContain("session loss limit");
    expect(input.financials).toEqual(financialsBefore);
    expect(journal.records().at(-1)?.kind).toBe("risk_decision_recorded");
    expect(journal.records().at(-1)?.payload.approved).toBe(false);
  });
});
