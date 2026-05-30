import { expect, test, describe } from "bun:test";
import { extractCalibrationRecords } from "../../engine/replay/calibration-extractor.ts";
import type { StrategyLabBatch, StrategyLabRunResult } from "../../engine/strategy-lab.ts";
import type { PairManifest } from "../../engine/replay/pair-manifest.ts";
import type { DecisionFeatureSnapshot } from "../../engine/decision-features.ts";

function decisionFeature(overrides: Partial<DecisionFeatureSnapshot> = {}): DecisionFeatureSnapshot {
  return {
    schemaVersion: 1,
    event: "consider",
    ts: 900,
    slug: "test-slug",
    strategy: {
      id: "test-strat",
      version: "1.0.0",
      configHash: "cfg-123",
      gitCommit: "commit-123",
      presetId: "variant-abc",
    },
    round: {
      asset: "btc",
      window: "5m",
      startTimeMs: 0,
      endTimeMs: 300_000,
      timeRemainingMs: 120_000,
      openPrice: 100_000,
      currentPrice: 100_050,
      gap: 50,
      direction: "UP",
      priceToBeat: 100_000,
    },
    orderbook: {
      side: "UP",
      bid: 0.49,
      ask: 0.51,
      spread: 0.02,
      targetLiquidity: 42,
      slippageEstimatePct: null,
    },
    flow: {
      imbalance: null,
      cvd10s: null,
      cvd60s: null,
      whaleCount: 0,
      sentiment: "neutral",
    },
    feeds: {
      predictivePrice: 100_060,
      predictiveDisagreement: false,
      divergencePct: 0.01,
      leadLagConfidence: null,
      resolutionFreshnessMs: 10,
      venueFreshnessMs: 20,
      predictiveFreshnessMs: 30,
    },
    settlementTruth: {
      source: "chainlink",
      sourceType: "oracle",
      settlementAnchorPrice: 100_000,
      roundId: "round-1",
      rawOracleAnswer: null,
      updatedAtMs: 0,
      localReceivedAtMs: 0,
      oracleLagMs: null,
      stalenessStatus: null,
      contractAddress: null,
    },
    predictiveTape: {
      compositePrice: 100_060,
      divergenceFromSettlementAbs: 60,
      divergenceFromSettlementPct: 0.06,
      inputs: {},
    },
    marketPrice: {
      yesBestBid: 0.49,
      yesBestAsk: 0.51,
      noBestBid: 0.48,
      noBestAsk: 0.52,
      executable: true,
    },
    quant: {
      probabilityUp: 0.64,
      sigma: 8.5,
    },
    risk: {
      approved: true,
      reasons: [],
    },
    intent: {
      id: "intent-1",
      action: "buy",
      side: "UP",
      price: 0.5,
      shares: 100,
      orderType: "GTC",
    },
    outcome: {},
    ...overrides,
  };
}

describe("CalibrationExtractor", () => {
  test("generates records from a minimal valid Strategy Lab result", () => {
    const run: StrategyLabRunResult = {
      id: "run-1",
      strategy: "test-strat",
      baseStrategy: "test-strat",
      variantLabel: "Test Variant",
      paperEligible: false,
      file: "test.log",
      slug: "test-slug",
      status: "completed",
      pnl: 0,
      direction: "UP",
      openPrice: null,
      closePrice: null,
      counts: { intents: 1, allowed: 1, blocked: 0, fills: 1, problems: 0, settlements: 1 },
      verdict: "win",
      brierScore: null,
      logLoss: null,
      execution: {
        fillRate: 1,
        cancelRate: 0,
        takerFeeSpend: 0,
        makerRebateEstimate: 0,
        grossEdgeCapture: null,
        turnover: 100,
        maxDrawdown: 0,
        markouts: { oneSecond: null, fiveSecond: null, thirtySecond: null, settlement: null, samples: 0, unavailableCount: 0, unavailableReasons: {} },
        conservativeFill: {
          conservativeFillEvidenceAvailable: true,
          conservativeFillEvidenceSource: "raw_l2_event_store",
          conservativeFillVerdictCounts: { no_fill: 0, touch_only: 0, probable_fill: 1, trade_through_fill: 0, unknown_insufficient_data: 0 },
          conservativeFillUnavailableReasons: {},
          conservativeMarkout1sAvg: 0.01,
          conservativeMarkout5sAvg: 0.02,
          conservativeMarkout30sAvg: 0.03,
          conservativeAdverseSelectionRate: 0,
          usableEvidenceCount: 1,
          evaluatedFillCount: 1,
          eligibleFillCount: 1,
          evidence: [
            {
              orderId: "ord-1",
              tokenId: "token-1",
              action: "buy",
              side: "UP",
              price: 0.5,
              shares: 100,
              placedTsMs: 1000,
              verdict: "probable_fill",
              markouts: { "1s": 0.01, "5s": 0.02, "30s": 0.03 },
              adverseSelection: false,
              decisionFeature: decisionFeature(),
            }
          ]
        }
      }
    };

    const batch: StrategyLabBatch = {
      id: "batch-1",
      state: "completed",
      createdAtMs: 0,
      updatedAtMs: 0,
      progress: { totalRuns: 1, completedRuns: 1 },
      runs: [run],
      summary: {} as any
    };

    const manifests = new Map<string, PairManifest>();
    manifests.set("test-slug", {
      slug: "test-slug",
      pairValidity: "valid",
      coverage: "complete",
      replayLogPath: "test.log",
      rawL2LogPath: "test.l2",
      events: {} as any,
      recorderStopReason: "completed"
    });

    const records = extractCalibrationRecords(batch, manifests);
    expect(records.length).toBe(1);
    expect(records[0]!.slug).toBe("test-slug");
    expect(records[0]!.strategy).toBe("test-strat");
    expect(records[0]!.variantName).toBe("Test Variant");
    expect(records[0]!.fillPrice).toBe(0.5);
    expect(records[0]!.quotedPrice).toBe(0.5);
    expect(records[0]!.modelProbability).toBe(0.64);
    expect(records[0]!.rawProbability).toBe(0.64);
    expect(records[0]!.fairValue).toBe(0.64);
    expect(records[0]!.marketImpliedProbability).toBe(0.5);
    expect(records[0]!.quotedEdge).toBeCloseTo(0.14, 6);
    expect(records[0]!.fairValueEdge).toBeCloseTo(0.14, 6);
    expect(records[0]!.bestBid).toBe(0.49);
    expect(records[0]!.bestAsk).toBe(0.51);
    expect(records[0]!.mid).toBe(0.5);
    expect(records[0]!.spread).toBe(0.02);
    expect(records[0]!.topOfBookLiquidity).toBe(42);
    expect(records[0]!.timeToCloseMs).toBe(120_000);
    expect(records[0]!.volatilityEstimate).toBe(8.5);
    expect(records[0]!.predictiveDisagreement).toBe(false);
    expect(records[0]!.predictiveDivergence).toBe(0.01);
    expect(records[0]!.resolutionDistance).toBe(50);
    expect(records[0]!.distanceToOpenAnchor).toBe(50);
    expect(records[0]!.strategyId).toBe("test-strat");
    expect(records[0]!.variantId).toBe("variant-abc");
    expect(records[0]!.configHash).toBe("cfg-123");
    expect(records[0]!.quoteTsMs).toBe(900);
    expect(records[0]!.decisionTsMs).toBe(900);
    expect(records[0]!.fillTsMs).toBe(1000);
    expect(records[0]!.dataQuality.hasMarketTradeEvidence).toBe(true);
    expect(records[0]!.dataQuality.hasMarkout1s).toBe(true);
    expect(records[0]!.dataQuality.missingReasons.length).toBe(0);
  });

  test("derives DOWN-side sell edge from side-adjusted probability", () => {
    const run: StrategyLabRunResult = {
      id: "run-1",
      strategy: "test-strat",
      baseStrategy: "test-strat",
      variantLabel: "Test Variant",
      paperEligible: false,
      file: "test.log",
      slug: "test-slug",
      status: "completed",
      pnl: 0,
      direction: "UP",
      openPrice: null,
      closePrice: null,
      counts: { intents: 1, allowed: 1, blocked: 0, fills: 1, problems: 0, settlements: 1 },
      verdict: "win",
      brierScore: null,
      logLoss: null,
      execution: {
        fillRate: 1,
        cancelRate: 0,
        takerFeeSpend: 0,
        makerRebateEstimate: 0,
        grossEdgeCapture: null,
        turnover: 100,
        maxDrawdown: 0,
        markouts: { oneSecond: null, fiveSecond: null, thirtySecond: null, settlement: null, samples: 0, unavailableCount: 0, unavailableReasons: {} },
        conservativeFill: {
          conservativeFillEvidenceAvailable: true,
          conservativeFillEvidenceSource: "raw_l2_event_store",
          conservativeFillVerdictCounts: { no_fill: 0, touch_only: 1, probable_fill: 0, trade_through_fill: 0, unknown_insufficient_data: 0 },
          conservativeFillUnavailableReasons: {},
          conservativeMarkout1sAvg: null,
          conservativeMarkout5sAvg: null,
          conservativeMarkout30sAvg: null,
          conservativeAdverseSelectionRate: null,
          usableEvidenceCount: 1,
          evaluatedFillCount: 1,
          eligibleFillCount: 1,
          evidence: [
            {
              orderId: "ord-1",
              tokenId: "token-down",
              action: "sell",
              side: "DOWN",
              price: 0.42,
              shares: 100,
              placedTsMs: 1000,
              fillTsMs: 1100,
              verdict: "touch_only",
              markouts: { "1s": null, "5s": null, "30s": null },
              adverseSelection: null,
              decisionFeature: decisionFeature({
                orderbook: {
                  side: "DOWN",
                  bid: 0.41,
                  ask: 0.43,
                  spread: 0.02,
                  targetLiquidity: 10,
                  slippageEstimatePct: null,
                },
                quant: { probabilityUp: 0.7, sigma: null },
              }),
            }
          ]
        }
      }
    };
    const batch: StrategyLabBatch = {
      id: "batch-1",
      state: "completed",
      createdAtMs: 0,
      updatedAtMs: 0,
      progress: { totalRuns: 1, completedRuns: 1 },
      runs: [run],
      summary: {} as any
    };

    const records = extractCalibrationRecords(batch, new Map());
    expect(records[0]!.modelProbability).toBeCloseTo(0.3, 6);
    expect(records[0]!.fairValueEdge).toBeCloseTo(0.12, 6);
    expect(records[0]!.fillTsMs).toBe(1100);
  });

  test("falls back to predictive tape divergence when aggregate divergence is missing", () => {
    const run: StrategyLabRunResult = {
      id: "run-1",
      strategy: "test-strat",
      baseStrategy: "test-strat",
      variantLabel: "Test Variant",
      paperEligible: false,
      file: "test.log",
      slug: "test-slug",
      status: "completed",
      pnl: 0,
      direction: "UP",
      openPrice: null,
      closePrice: null,
      counts: { intents: 1, allowed: 1, blocked: 0, fills: 1, problems: 0, settlements: 1 },
      verdict: "win",
      brierScore: null,
      logLoss: null,
      execution: {
        fillRate: 1,
        cancelRate: 0,
        takerFeeSpend: 0,
        makerRebateEstimate: 0,
        grossEdgeCapture: null,
        turnover: 100,
        maxDrawdown: 0,
        markouts: { oneSecond: null, fiveSecond: null, thirtySecond: null, settlement: null, samples: 0, unavailableCount: 0, unavailableReasons: {} },
        conservativeFill: {
          conservativeFillEvidenceAvailable: true,
          conservativeFillEvidenceSource: "raw_l2_event_store",
          conservativeFillVerdictCounts: { no_fill: 0, touch_only: 1, probable_fill: 0, trade_through_fill: 0, unknown_insufficient_data: 0 },
          conservativeFillUnavailableReasons: {},
          conservativeMarkout1sAvg: null,
          conservativeMarkout5sAvg: null,
          conservativeMarkout30sAvg: null,
          conservativeAdverseSelectionRate: null,
          usableEvidenceCount: 1,
          evaluatedFillCount: 1,
          eligibleFillCount: 1,
          evidence: [
            {
              orderId: "ord-1",
              tokenId: "token-up",
              action: "buy",
              side: "UP",
              price: 0.5,
              shares: 100,
              placedTsMs: 1000,
              verdict: "touch_only",
              markouts: { "1s": null, "5s": null, "30s": null },
              adverseSelection: null,
              decisionFeature: decisionFeature({
                feeds: {
                  predictivePrice: 100_060,
                  predictiveDisagreement: false,
                  divergencePct: null,
                  leadLagConfidence: null,
                  resolutionFreshnessMs: 10,
                  venueFreshnessMs: 20,
                  predictiveFreshnessMs: 30,
                },
                predictiveTape: {
                  compositePrice: 100_060,
                  divergenceFromSettlementAbs: 60,
                  divergenceFromSettlementPct: 0.06,
                  inputs: {},
                },
              }),
            }
          ]
        }
      }
    };
    const batch: StrategyLabBatch = {
      id: "batch-1",
      state: "completed",
      createdAtMs: 0,
      updatedAtMs: 0,
      progress: { totalRuns: 1, completedRuns: 1 },
      runs: [run],
      summary: {} as any
    };

    const records = extractCalibrationRecords(batch, new Map());
    expect(records[0]!.predictiveDivergence).toBe(0.06);
  });

  test("handles missing markouts", () => {
    const run: StrategyLabRunResult = {
      id: "run-2",
      strategy: "test",
      baseStrategy: "test",
      variantLabel: "Test",
      paperEligible: false,
      file: "test2.log",
      slug: "test-slug-2",
      status: "completed",
      pnl: 0, direction: null, openPrice: null, closePrice: null,
      counts: { intents: 0, allowed: 0, blocked: 0, fills: 0, problems: 0, settlements: 0 },
      verdict: "flat",
      brierScore: null, logLoss: null,
      execution: {
        fillRate: 0, cancelRate: 0, takerFeeSpend: 0, makerRebateEstimate: 0, grossEdgeCapture: null, turnover: 0, maxDrawdown: 0,
        markouts: { oneSecond: null, fiveSecond: null, thirtySecond: null, settlement: null, samples: 0, unavailableCount: 0, unavailableReasons: {} },
        conservativeFill: {
          conservativeFillEvidenceAvailable: true,
          conservativeFillEvidenceSource: "raw_l2_event_store",
          conservativeFillVerdictCounts: { no_fill: 0, touch_only: 0, probable_fill: 0, trade_through_fill: 0, unknown_insufficient_data: 0 },
          conservativeFillUnavailableReasons: {},
          conservativeMarkout1sAvg: null, conservativeMarkout5sAvg: null, conservativeMarkout30sAvg: null, conservativeAdverseSelectionRate: null,
          usableEvidenceCount: 1, evaluatedFillCount: 1, eligibleFillCount: 1,
          evidence: [
            {
              orderId: "ord-2", tokenId: "token-2", action: "buy", side: "DOWN", price: 0.1, shares: 10, placedTsMs: 2000,
              verdict: "no_fill",
              markouts: { "1s": null, "5s": null, "30s": null },
              adverseSelection: null,
            }
          ]
        }
      }
    };
    const batch: StrategyLabBatch = {
      id: "batch-2", state: "completed", createdAtMs: 0, updatedAtMs: 0,
      progress: { totalRuns: 1, completedRuns: 1 },
      runs: [run], summary: {} as any
    };
    const records = extractCalibrationRecords(batch, new Map());
    expect(records.length).toBe(1);
    expect(records[0]!.dataQuality.hasMarketTradeEvidence).toBe(false);
    expect(records[0]!.dataQuality.hasMarkout1s).toBe(false);
    expect(records[0]!.dataQuality.missingReasons).toContain("missing_markout_1s");
    expect(records[0]!.dataQuality.missingReasons).toContain("missing_markout_5s");
    expect(records[0]!.dataQuality.missingReasons).toContain("missing_markout_30s");
    expect(records[0]!.dataQuality.missingReasons).toContain("missing_decision_feature");
    expect(records[0]!.modelProbability).toBeNull();
    expect(records[0]!.fairValueEdge).toBeNull();
    expect(records[0]!.spread).toBeNull();
  });
});
