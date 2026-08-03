import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeterministicFakeExchange } from "../../engine/production/fake-exchange.ts";
import type { ExchangeReconciliationSnapshot } from "../../engine/production/reconciliation.ts";
import type { RiskDependencyState } from "../../engine/production/risk-engine.ts";
import { SettlementEdgeMaker } from "../../engine/production/settlement-edge-maker.ts";
import { ProductionTradingRuntime } from "../../engine/production/trading-runtime.ts";

const latency = {
  name: "MEASURED_NORMAL" as const,
  submissionMs: 0,
  acknowledgementMs: 0,
  cancellationMs: 0,
  feedMs: 0,
  disconnectRecoveryMs: 100,
};

function snapshot(
  id: string,
  cashBalance: string,
  tokenBalances: Record<string, string> = {},
): ExchangeReconciliationSnapshot {
  return {
    evidenceId: id,
    capturedAtMs: 100,
    cashBalance,
    tokenBalances,
    openExchangeOrderIds: [],
    pendingTradeIds: [],
    reserveSemantics: {
      cash: "BALANCE_INCLUDES_RESERVED",
      tokens: "BALANCE_INCLUDES_RESERVED",
    },
  };
}

function healthy(): RiskDependencyState {
  return {
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
  };
}

function quote() {
  return {
    side: "UP" as const,
    tokenId: "up-token",
    bestBid: "0.5",
    bestAsk: "0.52",
    tickSize: "0.01",
    minimumOrderSize: "5",
    requestedSize: "5",
    gridLevels: 2,
    fillProbability: 1,
    expectedFillFraction: 1,
    fillConditionedWinProbabilityLower: 0.8,
    expectedFutureExitCostPerShare: "0",
    expectedLatencyCostPerShare: "0",
    expectedAdverseSelectionCostPerShare: "0",
    expectedInventoryCostPerShare: "0",
    expectedCancellationCost: "0",
    expectedRebate: "0",
    minimumConservativeEv: "0.1",
    decisionTimestampMs: 100,
    sourceSnapshotIds: ["anchor-1", "book-1", "model-1"],
  };
}

describe("ProductionTradingRuntime", () => {
  test("runs the complete non-live decision-to-ledger trace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "production-runtime-"));
    let now = 100;
    const exchange = new DeterministicFakeExchange(
      "OPTIMISTIC",
      latency,
      () => now,
    );
    exchange.setBook({
      tokenId: "up-token",
      bids: [{ price: "0.5", quantity: "10" }],
      asks: [{ price: "0.52", quantity: "10" }],
    });
    const runtime = await ProductionTradingRuntime.open({
      runId: "run-1",
      mode: "PAPER",
      journalPath: join(directory, "journal.ndjson"),
      initialCash: "100",
      exchange,
      nowMs: () => now,
    });
    await runtime.start(snapshot("startup", "100"));
    const result = await runtime.evaluate({
      marketId: "market-1",
      quote: quote(),
      dependencies: healthy(),
      financials: {
        startingBankroll: "100",
        venueMinimumOrderNotional: "2.5",
        sessionLoss: "0",
        drawdown: "0",
        activeMarketIds: [],
        existingMarketWorstCaseLoss: "0",
        existingAggregateWorstCaseOpenLoss: "0",
      },
    });
    expect(result.outcome).toBe("PAPER_ORDER_PROCESSED");
    expect(result.command?.evidence?.status).toBe("LIVE");
    expect(result.intentId).not.toBeNull();

    now = 101;
    await runtime.applyReplayTrade({
      tradeId: "public-trade-1",
      tokenId: "up-token",
      aggressorSide: "SELL",
      price: "0.5",
      quantity: "5",
      sourceTimestampMs: 101,
      ingestTimestampMs: 101,
    });
    const order = runtime.authority.lifecycle.get(result.intentId!);
    expect(order?.state).toBe("FILLED");
    const ledger = runtime.authority.ledger.snapshot();
    expect(ledger.cashBalance).toBe("97.5");
    expect(ledger.tokenBalances["up-token"]).toBe("5");
    expect(ledger.reservedBuyCash).toBe("0");
    expect(runtime.health().tradingReadiness).toBe("READY");

    const kinds = runtime.authority.journal.records().map((event) => event.kind);
    expect(kinds).toContain("candidate_evaluated");
    expect(kinds).toContain("risk_decision_recorded");
    expect(kinds).toContain("order_intent_created");
    expect(kinds).toContain("ledger_buy_reserved");
    expect(kinds).toContain("execution_command_queued");
    expect(kinds).toContain("order_fill_applied");
    expect(kinds).toContain("ledger_fill_applied");
    await runtime.stop(snapshot("shutdown", "97.5", { "up-token": "5" }));
  });

  test("a hard blocker creates no intent, reservation, or command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "production-runtime-"));
    const exchange = new DeterministicFakeExchange(
      "NEUTRAL",
      latency,
      () => 100,
    );
    exchange.setBook({
      tokenId: "up-token",
      bids: [{ price: "0.5", quantity: "10" }],
      asks: [{ price: "0.52", quantity: "10" }],
    });
    const runtime = await ProductionTradingRuntime.open({
      runId: "run-blocked",
      mode: "PAPER",
      journalPath: join(directory, "journal.ndjson"),
      initialCash: "100",
      exchange,
      nowMs: () => 100,
    });
    await runtime.start(snapshot("startup", "100"));
    const dependencies = healthy();
    dependencies.anchorVerified = false;
    const result = await runtime.evaluate({
      marketId: "market-1",
      quote: quote(),
      dependencies,
      financials: {
        startingBankroll: "100",
        venueMinimumOrderNotional: "2.5",
        sessionLoss: "0",
        drawdown: "0",
        activeMarketIds: [],
        existingMarketWorstCaseLoss: "0",
        existingAggregateWorstCaseOpenLoss: "0",
      },
    });
    expect(result.outcome).toBe("RISK_BLOCKED");
    expect(runtime.authority.lifecycle.all()).toHaveLength(0);
    expect(runtime.authority.outbox.all()).toHaveLength(0);
    expect(runtime.authority.ledger.snapshot().reservedBuyCash).toBe("0");
    await runtime.stop(snapshot("shutdown", "100"));
  });

  test("candidate IDs are deterministic for identical evidence", () => {
    const maker = new SettlementEdgeMaker();
    const first = maker.evaluate(quote());
    const second = maker.evaluate(quote());
    expect(first.candidates.map((item) => item.candidateId)).toEqual(
      second.candidates.map((item) => item.candidateId),
    );
  });
});
