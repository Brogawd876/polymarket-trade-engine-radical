import { describe, expect, it } from "bun:test";
import { evaluateBlockedIntent, deduplicateBlockedRecords, type BlockedCounterfactualRecord } from "../../../engine/replay/blocked-counterfactual.ts";
import { type ProfitEventEnvelope, type StrategyPayload, type SettlementPayload } from "../../../engine/event-store/events.ts";

describe("Blocked Counterfactual Engine", () => {
  const mockIntentEvent: ProfitEventEnvelope<StrategyPayload> = {
    eventType: "order_intent",
    source: "market-lifecycle",
    slug: "btc-updown-5m-1779833100",
    processedTsMs: 1779833100000,
    strategyId: "fair-value-maker",
    payload: {
      intentId: "intent-1",
      variantId: "default",
      side: "UP",
      action: "buy",
      tokenId: "UP-TOKEN",
      price: 0.5,
      shares: 100,
      orderType: "GTC",
      createdAtMs: 1779833100000,
    } as any
  };

  const mockDecisionEvent: ProfitEventEnvelope<StrategyPayload> = {
    eventType: "risk_gate_decision",
    source: "market-lifecycle",
    slug: "btc-updown-5m-1779833100",
    processedTsMs: 1779833100100,
    payload: {
      approved: false,
      decision: {
        approved: false,
        reasons: ["predictive aggregate disagreement is true"],
        intent: { id: "intent-1" }
      }
    } as any
  };

  const mockSettlement: SettlementPayload = {
    slug: "btc-updown-5m-1779833100",
    direction: "UP",
    openPrice: 60000,
    closePrice: 60100,
    resolvedAtMs: 1779833400000,
  };

  it("should classify a blocked intent as inconclusive if L2 data is missing", () => {
    const record = evaluateBlockedIntent(mockIntentEvent, mockDecisionEvent, [], mockSettlement);
    expect(record.verdict).toBe("inconclusive");
    expect(record.fillEvidence).toBe("unknown_insufficient_data");
  });

  it("should classify as good_block if it would have filled but lost money", () => {
    // Mock L2 events that show a fill but a loss
    const l2Events: ProfitEventEnvelope[] = [
      {
        eventType: "market_book_snapshot",
        processedTsMs: 1779833100500,
        payload: {
          tokenId: "UP-TOKEN",
          bids: [[0.49, 1000]],
          asks: [[0.51, 1000]],
        }
      } as any,
      {
        eventType: "market_trade",
        processedTsMs: 1779833101000,
        payload: {
          tokenId: "UP-TOKEN",
          price: 0.48, // Trade through 0.5
          shares: 100,
        }
      } as any,
      {
        eventType: "market_book_snapshot",
        processedTsMs: 1779833102000,
        payload: {
          tokenId: "UP-TOKEN",
          bids: [[0.45, 1000]],
          asks: [[0.47, 1000]], // Price moved down
        }
      } as any
    ];

    const lossSettlement: SettlementPayload = { ...mockSettlement, direction: "DOWN" };
    const record = evaluateBlockedIntent(mockIntentEvent, mockDecisionEvent, l2Events, lossSettlement);
    
    expect(record.wouldFill).toBe(true);
    expect(record.hypotheticalPnl).toBeLessThan(0);
    expect(record.verdict).toBe("good_block");
  });

  it("should classify as bad_block if it would have filled and made money", () => {
    const l2Events: ProfitEventEnvelope[] = [
      {
        eventType: "market_book_snapshot",
        processedTsMs: 1779833100500,
        payload: {
          tokenId: "UP-TOKEN",
          bids: [[0.49, 1000]],
          asks: [[0.51, 1000]],
        }
      } as any,
      {
        eventType: "market_trade",
        processedTsMs: 1779833101000,
        payload: {
          tokenId: "UP-TOKEN",
          price: 0.48,
          shares: 100,
        }
      } as any,
      {
        eventType: "market_book_snapshot",
        processedTsMs: 1779833102000,
        payload: {
          tokenId: "UP-TOKEN",
          bids: [[0.55, 1000]],
          asks: [[0.57, 1000]], // Price moved up
        }
      } as any
    ];

    const winSettlement: SettlementPayload = { ...mockSettlement, direction: "UP" };
    const record = evaluateBlockedIntent(mockIntentEvent, mockDecisionEvent, l2Events, winSettlement);
    
    expect(record.wouldFill).toBe(true);
    expect(record.hypotheticalPnl).toBeGreaterThan(0);
    expect(record.verdict).toBe("bad_block");
  });

  it("should classify touch_only as not wouldFill", () => {
    const l2Events: ProfitEventEnvelope[] = [
      {
        eventType: "market_book_snapshot",
        processedTsMs: 1779833100500,
        payload: {
          tokenId: "UP-TOKEN",
          bids: [[0.50, 1000]], // Touch our resting buy price of 0.50
          asks: [[0.51, 1000]],
        }
      } as any,
      {
        eventType: "market_trade",
        processedTsMs: 1779833101000,
        payload: {
          tokenId: "UP-TOKEN",
          price: 0.50, // trade at price, but queue is infinite
          shares: 100,
        }
      } as any,
    ];
    const record = evaluateBlockedIntent(mockIntentEvent, mockDecisionEvent, l2Events, mockSettlement);
    expect(record.fillEvidence).toBe("touch_only");
    expect(record.wouldFill).toBe(false);
  });

  describe("Validation", () => {
    const testInvalid = (intentOverrides: any, expectedReason: string) => {
      const intentEv = {
        ...mockIntentEvent,
        payload: { ...mockIntentEvent.payload, ...intentOverrides }
      } as any;
      const decEv = {
        ...mockDecisionEvent,
        payload: { ...mockDecisionEvent.payload, intent: { ...mockDecisionEvent.payload.intent, ...intentOverrides } }
      } as any;
      const record = evaluateBlockedIntent(intentEv, decEv, [], mockSettlement);
      expect(record.verdict).toBe("inconclusive");
      expect(record.unavailableReasons).toContain(expectedReason);
    };

    it("should invalidate price <= 0 or >= 1 or NaN", () => {
      testInvalid({ price: 0 }, "invalid_price");
      testInvalid({ price: 1 }, "invalid_price");
      testInvalid({ price: NaN }, "invalid_price");
    });

    it("should invalidate shares <= 0 or NaN", () => {
      testInvalid({ shares: 0 }, "invalid_shares");
      testInvalid({ shares: NaN }, "invalid_shares");
    });

    it("should invalidate missing or empty tokenId", () => {
      testInvalid({ tokenId: undefined }, "missing_token_id");
      testInvalid({ tokenId: "   " }, "missing_token_id");
    });

    it("should invalidate invalid action", () => {
      testInvalid({ action: "hold" }, "invalid_action");
    });

    it("should mark side missing instead of inferring DOWN", () => {
      const intentEv = {
        ...mockIntentEvent,
        payload: { ...mockIntentEvent.payload, side: undefined, tokenId: "RANDOM-TOKEN" }
      } as any;
      const record = evaluateBlockedIntent(intentEv, mockDecisionEvent, [], mockSettlement);
      expect(record.side).toBe(null);
      expect(record.unavailableReasons).toContain("missing_side");
    });

    it("should use verified token mapping when explicit side is missing", () => {
      const intentEv = {
        ...mockIntentEvent,
        payload: { ...mockIntentEvent.payload, side: undefined, tokenId: "RANDOM-DOWN" }
      } as any;
      const record = evaluateBlockedIntent(intentEv, mockDecisionEvent, [], mockSettlement, {
        tokenMapping: { upTokenId: "RANDOM-UP", downTokenId: "RANDOM-DOWN" }
      });
      expect(record.side).toBe("DOWN");
      expect(record.unavailableReasons).not.toContain("missing_side");
    });

    it("should prefer explicit top-level side even if token map exists", () => {
      const intentEv = {
        ...mockIntentEvent,
        payload: { ...mockIntentEvent.payload, side: "UP", tokenId: "RANDOM-DOWN" }
      } as any;
      const record = evaluateBlockedIntent(intentEv, mockDecisionEvent, [], mockSettlement, {
        tokenMapping: { upTokenId: "RANDOM-UP", downTokenId: "RANDOM-DOWN" }
      });
      expect(record.side).toBe("UP");
    });
  });

  describe("Audit Script Reporting", () => {
    it("should summarize unmatched blocked decisions and mismatches", async () => {
      const { summarizeRecords } = await import("../../../scripts/audit-blocked-counterfactuals.ts");
      const summary = summarizeRecords([], [{
         unmatchedBlockedDecisionCount: 5,
         predictiveDisagreementMismatchCount: 2,
      }]);
      expect(summary.totalUnmatchedBlockedDecisionCount).toBe(5);
      expect(summary.totalPredictiveDisagreementMismatchCount).toBe(2);
    });

    it("should adjust markdown based on allow-contaminated", async () => {
      const { generateMarkdownReport } = await import("../../../scripts/audit-blocked-counterfactuals.ts");
      const summary1 = {
         runDiagnostics: [{ contaminated: true }],
         allowContaminatedUsed: false,
         totalBlocked: 0, totalUnique: 0, totalUnmatchedBlockedDecisionCount: 0, totalPredictiveDisagreementMismatchCount: 0,
         byStrategy: {}, byFillEvidence: {}, bySide: {}, byBlockReason: {}, byTimeToCloseBucket: {}, byPredictiveDisagreementState: {}, byUnavailableReason: {}
      };
      const md1 = generateMarkdownReport(summary1);
      expect(md1).toContain("They were skipped from the summary");

      const summary2 = { ...summary1, allowContaminatedUsed: true };
      const md2 = generateMarkdownReport(summary2);
      expect(md2).toContain("These contaminated results are directional evidence only");
    });
  });
});

