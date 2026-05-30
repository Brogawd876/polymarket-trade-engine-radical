import { describe, expect, it } from "bun:test";
import { CounterfactualRiskGate } from "../../../engine/replay/counterfactual-risk-gate.ts";
import { type StrategyIntent } from "../../../engine/bot-core/strategy-intent.ts";
import { type RiskGate, type RiskDecision, type RiskSnapshot } from "../../../engine/bot-core/risk-gate.ts";

describe("CounterfactualRiskGate", () => {
  const mockIntent: StrategyIntent = {
    id: "intent-1",
    strategyId: "s1",
    action: "buy",
    tokenId: "UP-TOKEN",
    price: 0.5,
    shares: 100,
    orderType: "GTC",
  } as any;

  const mockSnapshot: RiskSnapshot = {
    nowMs: 1000,
    openExposureUsd: 0,
    walletBalanceUsd: 1000,
  } as any;

  class MockBaseGate implements RiskGate {
    evaluate(): RiskDecision {
      return {
        approved: false,
        intent: mockIntent,
        checkedAtMs: 1000,
        reasons: ["reason-1", "reason-2"],
      };
    }
  }

  it("should block normally in normal mode", () => {
    const gate = new CounterfactualRiskGate({
      mode: "normal",
      baseGate: new MockBaseGate(),
    });

    const decision = gate.evaluate(mockIntent, mockSnapshot);
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("reason-1");
  });

  it("should approve in permissive-counterfactual mode", () => {
    const gate = new CounterfactualRiskGate({
      mode: "permissive-counterfactual",
      replayOnly: true,
      baseGate: new MockBaseGate(),
    });

    const decision = gate.evaluate(mockIntent, mockSnapshot);
    expect(decision.approved).toBe(true);
    expect(decision.reasons).toContain("approved_replay_counterfactual");
    expect(decision.reasons).toContain("bypassed:reason-1");
    expect(decision.reasons).toContain("bypassed:reason-2");
  });

  it("should approve only matching reasons in selective mode", () => {
    const gate = new CounterfactualRiskGate({
      mode: "selective-counterfactual",
      bypassReasons: ["reason-1", "reason-2"],
      replayOnly: true,
      baseGate: new MockBaseGate(),
    });

    const decision = gate.evaluate(mockIntent, mockSnapshot);
    expect(decision.approved).toBe(true);
  });

  it("should NOT approve if not all reasons are bypassed in selective mode", () => {
    const gate = new CounterfactualRiskGate({
      mode: "selective-counterfactual",
      bypassReasons: ["reason-1"],
      replayOnly: true,
      baseGate: new MockBaseGate(),
    });

    const decision = gate.evaluate(mockIntent, mockSnapshot);
    expect(decision.approved).toBe(false);
  });

  it("should throw if PROD is enabled and mode is not normal", () => {
    process.env.PROD = "true";
    expect(() => {
      new CounterfactualRiskGate({ mode: "permissive-counterfactual", replayOnly: true });
    }).toThrow("Counterfactual risk modes are strictly prohibited in production.");
    delete process.env.PROD;
  });

  it("should throw if replayOnly is not true for counterfactual mode", () => {
    expect(() => {
      new CounterfactualRiskGate({ mode: "permissive-counterfactual" });
    }).toThrow("Counterfactual risk modes require replayOnly: true.");
  });

  it("should throw if evaluating a snapshot with productionEnabled in counterfactual mode", () => {
    const gate = new CounterfactualRiskGate({
      mode: "permissive-counterfactual",
      replayOnly: true,
      baseGate: new MockBaseGate(),
    });

    const prodSnapshot = { ...mockSnapshot, productionEnabled: true } as any;
    expect(() => {
      gate.evaluate(mockIntent, prodSnapshot);
    }).toThrow("Counterfactual risk modes cannot evaluate production snapshots.");
  });
});
