import { describe, expect, test } from "bun:test";
import { 
  ExecutionQualityGate, 
  DEFAULT_EXECUTION_QUALITY_LIMITS,
  type RiskSnapshot,
  type ExecutionQualityLimits
} from "../../engine/bot-core/risk-gate.ts";
import { 
  type VenueOrderBookEvent,
  createEventClock
} from "../../engine/bot-core/data-sources.ts";
import { type PlaceOrderIntent } from "../../engine/bot-core/strategy-intent.ts";

describe("ExecutionQualityGate", () => {
  const now = 1000000;

  const baseSnapshot = (venue: VenueOrderBookEvent | null): RiskSnapshot => ({
    nowMs: now,
    productionEnabled: false,
    resolution: null,
    venue,
    predictiveFeeds: [],
    openExposureUsd: 0,
    sessionPnlUsd: 0,
    clobTokenIds: ["btc-up", "btc-down"],
  });

  const btcUpIntent: PlaceOrderIntent = {
    id: "test-id",
    slug: "btc-updown-5m-1",
    strategyName: "test",
    createdAtMs: now,
    reason: "test",
    triggerEventIds: [],
    round: { slug: "btc-updown-5m-1", asset: "btc", window: "5m", startTimeMs: 0, endTimeMs: 2000000 },
    tokenId: "btc-up",
    action: "buy",
    side: "UP",
    price: 0.50,
    shares: 10,
    expireAtMs: 1500000,
  };

  const venueEvent = (params: Partial<VenueOrderBookEvent> = {}): VenueOrderBookEvent => ({
    id: "v1",
    role: "venue",
    source: "poly",
    asset: "btc",
    kind: "orderbook",
    clock: createEventClock({ receivedAtMs: now }),
    quality: "live",
    freshnessMs: 0,
    lagMs: 0,
    up: { bids: [[0.48, 100]], asks: [[0.49, 100]] },
    down: { bids: [[0.48, 100]], asks: [[0.49, 100]] },
    bestBidUp: 0.48,
    bestAskUp: 0.49,
    bestBidDown: 0.48,
    bestAskDown: 0.49,
    feeRateBps: 0.001, // 10 bps
    ...params,
  });

  const strictLimits: ExecutionQualityLimits = {
    maxSpreadUsd: 0.05,
    maxVenueAgeMs: 500,
    minTargetLiquidity: 10,
    maxSlippagePct: 1.0,
    requireProfitability: true,
  };

  test("approves normal market conditions", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    const venue = venueEvent();
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(true);
  });

  test("blocks stale venue quote", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    const venue = venueEvent({ clock: createEventClock({ receivedAtMs: now - 600 }) });
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("venue quote is stale (600ms > 500ms limit)");
  });

  test("blocks wide spread", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    const venue = venueEvent({ bestBidUp: 0.40, bestAskUp: 0.46 }); // 0.06 spread
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("spread is too wide ($0.060 > $0.050 limit)");
  });

  test("blocks insufficient liquidity at target price", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    // Buying UP @ 0.50. We need asks <= 0.50.
    // Here we have asks at 0.51 (worse than target) and 0.50 with only 5 shares.
    const venue = venueEvent({
      up: { bids: [], asks: [[0.50, 5], [0.51, 100]] }
    });
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("insufficient liquidity at target price ($5.00 < $10.00 required)");
  });

  test("calculates cumulative liquidity correctly", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    // Buying UP @ 0.50.
    const venue = venueEvent({
      up: { bids: [], asks: [[0.48, 4], [0.49, 4], [0.50, 4], [0.51, 100]] }
    });
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(true); // 4+4+4 = 12 shares available at or better than 0.50
  });

  test("blocks excessive slippage", () => {
    const gate = new ExecutionQualityGate({ ...strictLimits, maxSlippagePct: 0.5 });
    // Buying UP @ 0.50. Best ask is 0.48.
    // effectivePrice will be (4*0.48 + 6*0.50) / 10 = (1.92 + 3.0) / 10 = 0.492
    // slippage = (0.492 - 0.48) / 0.48 = 0.012 / 0.48 = 0.025 (2.5%)
    const venue = venueEvent({
      bestAskUp: 0.48,
      up: { bids: [], asks: [[0.48, 4], [0.50, 100]] }
    });
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("excessive slippage (2.50% > 0.50% limit)");
  });

  test("blocks if fill unprofitable after fees", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    // Buying UP @ 0.50.
    // If effective price is 0.499 and fee rate is 0.01 (1%):
    // fee = 0.01 * 0.499 * (1 - 0.499) = 0.00499 * 0.501 = 0.0025
    // priceWithFees = 0.499 + 0.0025 = 0.5015 > 0.50 (limit)
    const venue = venueEvent({
      feeRateBps: 0.01,
      bestAskUp: 0.499,
      up: { bids: [], asks: [[0.499, 100]] }
    });
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("fill unprofitable after fees (effective: $0.5015 vs intent: $0.5000)");
  });

  test("approves if fill profitable after fees", () => {
    const gate = new ExecutionQualityGate(strictLimits);
    // Buying UP @ 0.50.
    // If effective price is 0.49 and fee rate is 0.001 (10 bps):
    // fee = 0.001 * 0.49 * 0.51 = 0.00025
    // priceWithFees = 0.49025 <= 0.50
    const venue = venueEvent({
      feeRateBps: 0.001,
      bestAskUp: 0.49,
      up: { bids: [], asks: [[0.49, 100]] }
    });
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(venue));
    expect(decision.approved).toBe(true);
  });

  test("blocks if venue feed is missing", () => {
    const gate = new ExecutionQualityGate();
    const decision = gate.evaluate(btcUpIntent, baseSnapshot(null));
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain("venue feed is missing");
  });
});
