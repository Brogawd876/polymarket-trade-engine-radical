import { describe, expect, test } from "bun:test";
import type { StrategyIntent } from "../../engine/bot-core/strategy-intent.ts";
import {
  TradingKernel,
  deriveOperatingMode,
} from "../../engine/trading-kernel.ts";

function intent(id = "intent-1"): StrategyIntent {
  return {
    id,
    slug: "btc-updown-5m-1770000000",
    strategyName: "test-strategy",
    createdAtMs: 100,
    reason: "test",
    triggerEventIds: [],
    round: {
      slug: "btc-updown-5m-1770000000",
      asset: "btc",
      window: "5m",
      startTimeMs: 1770000000000,
      endTimeMs: 1770000300000,
    },
    action: "buy",
    side: "UP",
    tokenId: "up-token",
    price: 0.49,
    shares: 5,
    expireAtMs: 1770000300000,
  };
}

describe("TradingKernel", () => {
  test("derives replay, paper, and requested live modes explicitly", () => {
    expect(deriveOperatingMode({ replayFile: "round.log" })).toBe("replay");
    expect(deriveOperatingMode({})).toBe("paper");
    expect(deriveOperatingMode({ productionRequested: true })).toBe(
      "micro-live",
    );
  });

  test("allows only simulated replay/paper submission in Phase A", () => {
    expect(new TradingKernel("replay").authorizeSubmission("simulated")).toEqual(
      { approved: true, reason: null },
    );
    expect(new TradingKernel("paper").authorizeSubmission("simulated")).toEqual(
      { approved: true, reason: null },
    );
    expect(
      new TradingKernel("shadow").authorizeSubmission("simulated").approved,
    ).toBe(false);
    expect(
      new TradingKernel("micro-live").authorizeSubmission("exchange").approved,
    ).toBe(false);
    expect(
      new TradingKernel("pilot").authorizeSubmission("exchange").approved,
    ).toBe(false);
  });

  test("refuses construction of an exchange-backed runtime", () => {
    const kernel = new TradingKernel("micro-live");
    expect(() =>
      kernel.assertRuntimeCompatible({
        replayFile: false,
        exchangeClientRequested: true,
      }),
    ).toThrow(/live exchange submission is disabled/);
  });

  test("enforces authoritative intent transitions", () => {
    let now = 100;
    const kernel = new TradingKernel("paper", () => now++);
    kernel.recordIntent(intent());
    kernel.transitionIntent("intent-1", "risk_approved");
    kernel.transitionIntent("intent-1", "submitting");
    kernel.transitionIntent("intent-1", "acknowledged");
    kernel.transitionIntent("intent-1", "filled");

    expect(kernel.intentState("intent-1")?.state).toBe("filled");
    expect(() =>
      kernel.transitionIntent("intent-1", "failed"),
    ).toThrow(/terminal intent/);
  });

  test("restores acknowledged intents so recovered orders remain manageable", () => {
    const kernel = new TradingKernel("paper", () => 2000);
    const recoveredIntent = intent("recovered-intent");

    const restored = kernel.restoreIntent(recoveredIntent, "acknowledged");

    expect(restored.state).toBe("acknowledged");
    expect(
      kernel.transitionIntent(
        recoveredIntent.id,
        "canceled",
        "recovery cleanup",
      ).state,
    ).toBe("canceled");
  });

  test("rejects duplicate and unknown intents", () => {
    const kernel = new TradingKernel("paper");
    kernel.recordIntent(intent());
    expect(() => kernel.recordIntent(intent())).toThrow(/duplicate intent/);
    expect(() => kernel.transitionIntent("missing", "failed")).toThrow(
      /unknown intent/,
    );
  });
});
