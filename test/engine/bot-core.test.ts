import { describe, expect, test } from "bun:test";
import {
  AggregatedRiskGate,
  createEventClock,
  DEFAULT_SIMULATION_RISK_LIMITS,
  measureFreshness,
  measureProcessingLag,
  StaticRiskGate,
  type LeadLagSnapshot,
  type PredictiveAggregateSnapshot,
  type PredictivePriceEvent,
  type ResolutionPriceEvent,
  type RiskSnapshot,
  type RoundWindow,
  type StrategyIntent,
  type VenueOrderBookEvent,
} from "../../engine/bot-core/index.ts";

const round: RoundWindow = {
  slug: "btc-updown-5m-1778891400",
  asset: "btc",
  window: "5m",
  startTimeMs: 1778891400_000,
  endTimeMs: 1778891700_000,
};

function resolutionEvent(nowMs: number): ResolutionPriceEvent {
  return {
    id: "resolution-1",
    role: "resolution",
    source: "polymarket-chainlink-rtds",
    sourceType: "chainlink_polygon",
    asset: "btc",
    kind: "live",
    price: 100_000,
    priceToBeat: 99_950,
    clock: createEventClock({
      sourceTimestampMs: nowMs - 100,
      receivedAtMs: nowMs,
      processedAtMs: nowMs,
      monotonicReceivedNs: 1n,
    }),
    quality: "live",
    freshnessMs: 100,
    lagMs: 0,
    round,
  };
}

function venueEvent(nowMs: number): VenueOrderBookEvent {
  return {
    id: "venue-1",
    role: "venue",
    source: "polymarket-clob",
    asset: "btc",
    kind: "orderbook",
    clock: createEventClock({
      sourceTimestampMs: nowMs - 100,
      receivedAtMs: nowMs,
      processedAtMs: nowMs,
      monotonicReceivedNs: 2n,
    }),
    quality: "live",
    freshnessMs: 100,
    lagMs: 0,
    round,
    up: { bids: [[0.48, 100]], asks: [[0.49, 100]] },
    down: { bids: [[0.5, 100]], asks: [[0.51, 100]] },
    bestBidUp: 0.48,
    bestAskUp: 0.49,
    bestBidDown: 0.5,
    bestAskDown: 0.51,
  };
}

function predictiveEvent(nowMs: number): PredictivePriceEvent {
  return {
    id: "predictive-1",
    role: "predictive",
    source: "binance",
    asset: "btc",
    kind: "ticker",
    exchange: "binance",
    price: 100_010,
    clock: createEventClock({
      sourceTimestampMs: nowMs - 50,
      receivedAtMs: nowMs,
      processedAtMs: nowMs,
      monotonicReceivedNs: 3n,
    }),
    quality: "live",
    freshnessMs: 50,
    lagMs: 0,
    round,
  };
}

function buyIntent(nowMs: number): StrategyIntent {
  return {
    id: "intent-1",
    slug: round.slug,
    strategyName: "test-strategy",
    createdAtMs: nowMs,
    reason: "test entry",
    triggerEventIds: ["resolution-1", "venue-1", "predictive-1"],
    round,
    action: "buy",
    side: "UP",
    tokenId: "UP_TOKEN",
    price: 0.49,
    shares: 5,
    expireAtMs: nowMs + 30_000,
  };
}

function snapshot(nowMs: number): RiskSnapshot {
  return {
    nowMs,
    productionEnabled: false,
    resolution: resolutionEvent(nowMs),
    venue: venueEvent(nowMs),
    predictiveFeeds: [predictiveEvent(nowMs)],
    openExposureUsd: 0,
    sessionPnlUsd: 0,
  };
}

function aggregateSnapshot(
  disagreement: boolean,
): PredictiveAggregateSnapshot {
  return {
    asset: "btc",
    timestampMs: round.startTimeMs + 60_000,
    price: disagreement ? 100_030 : 100_000,
    settlementAnchor: {
      price: 99_950,
      roundId: "1",
      updatedAtMs: round.startTimeMs,
      localReceivedAtMs: round.startTimeMs,
      lagMs: 100,
      isStale: false,
      quality: "live",
      source: "chainlink-polygon-btc-usd",
      sourceType: "chainlink_polygon",
    },
    predictiveTape: {
      compositePrice: disagreement ? 100_030 : 100_000,
      feeds: {},
      divergenceAbs: disagreement ? 100 : 5,
      divergencePct: disagreement ? 0.1 : 0.005,
      disagreement,
    },
    marketPrice: {
      yesBestBid: 0.48,
      yesBestAsk: 0.49,
      yesMidpoint: 0.485,
      noBestBid: 0.5,
      noBestAsk: 0.51,
      noMidpoint: 0.505,
      yesSpread: 0.01,
      noSpread: 0.01,
      executable: true,
      source: "test-venue",
    },
    feeds: {
      binance: {
        price: 100_000,
        quality: "live",
        latestEventAgeMs: 100,
        arrivalDelayMs: 20,
      },
      coinbase: {
        price: disagreement ? 100_100 : 100_005,
        quality: "live",
        latestEventAgeMs: 100,
        arrivalDelayMs: 25,
      },
    },
    divergenceAbs: disagreement ? 100 : 5,
    divergencePct: disagreement ? 0.1 : 0.005,
    disagreement,
  };
}

function noHealthyFeedsAggregate(): PredictiveAggregateSnapshot {
  return {
    asset: "btc",
    timestampMs: round.startTimeMs + 60_000,
    price: null,
    settlementAnchor: {
      price: 99_950,
      roundId: "1",
      updatedAtMs: round.startTimeMs,
      localReceivedAtMs: round.startTimeMs,
      lagMs: 100,
      isStale: false,
      quality: "live",
      source: "chainlink-polygon-btc-usd",
      sourceType: "chainlink_polygon",
    },
    predictiveTape: {
      compositePrice: null,
      feeds: {},
      divergenceAbs: null,
      divergencePct: null,
      disagreement: true,
    },
    marketPrice: {
      yesBestBid: null,
      yesBestAsk: null,
      yesMidpoint: null,
      noBestBid: null,
      noBestAsk: null,
      noMidpoint: null,
      yesSpread: null,
      noSpread: null,
      executable: false,
      source: null,
    },
    feeds: {},
    divergenceAbs: null,
    divergencePct: null,
    disagreement: true,
  };
}

function leadLagSnapshot(
  leadershipConfidence: LeadLagSnapshot["leadershipConfidence"],
  sufficientSamples: boolean,
): LeadLagSnapshot {
  return {
    asset: "btc",
    timestampMs: round.startTimeMs + 60_000,
    feeds: {},
    observedTimingLeader: sufficientSamples ? "binance" : null,
    observedTimingRunnerUp: sufficientSamples ? "coinbase" : null,
    averageDelaySpreadMs: sufficientSamples ? 5 : null,
    leadershipConfidence,
    sufficientSamples,
  };
}

describe("bot-core event clocks", () => {
  test("records source, receive, processing, and monotonic timestamps", () => {
    const clock = createEventClock({
      sourceTimestampMs: 1000,
      receivedAtMs: 1250,
      processedAtMs: 1265,
      monotonicReceivedNs: 42n,
    });

    expect(measureFreshness(clock)).toBe(250);
    expect(measureProcessingLag(clock)).toBe(15);
    expect(clock.monotonicReceivedNs).toBe(42n);
  });
});

describe("StaticRiskGate", () => {
  test("blocks production by default", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new StaticRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      productionEnabled: true,
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "production trading is disabled by this risk gate",
    );
  });

  test("blocks missing resolution source", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new StaticRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      resolution: null,
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("resolution feed is missing");
  });

  test("blocks stale venue data", () => {
    const nowMs = round.startTimeMs + 60_000;
    const staleVenue = {
      ...venueEvent(nowMs),
      quality: "stale" as const,
      freshnessMs: 10_000,
    };
    const gate = new StaticRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      venue: staleVenue,
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("venue feed quality is stale");
    expect(result.reasons).toContain(
      "venue feed is stale by freshness threshold",
    );
  });

  test("blocks stale venue data by local received age when source freshness is unavailable", () => {
    const nowMs = round.startTimeMs + 60_000;
    const staleVenue = {
      ...venueEvent(nowMs),
      clock: createEventClock({
        sourceTimestampMs: null,
        receivedAtMs: nowMs - 10_000,
        processedAtMs: nowMs - 10_000,
        monotonicReceivedNs: 4n,
      }),
      freshnessMs: null,
    };
    const gate = new StaticRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      venue: staleVenue,
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "venue feed is stale by received age threshold",
    );
  });

  test("blocks stale or degraded Chainlink settlement truth", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new StaticRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      resolution: {
        ...resolutionEvent(nowMs),
        quality: "stale",
        stalenessStatus: "degraded",
        oracleLagMs: 120_000,
      },
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("resolution feed quality is stale");
    expect(result.reasons).toContain("resolution staleness status is degraded");
    expect(result.reasons).toContain("resolution oracle lag exceeds threshold");
  });

  test("production requires Chainlink Polygon settlement truth", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new StaticRiskGate({
      ...DEFAULT_SIMULATION_RISK_LIMITS,
      allowProduction: true,
    });
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      productionEnabled: true,
      resolution: {
        ...resolutionEvent(nowMs),
        sourceType: "polymarket_chainlink_rtds",
      },
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("production requires Chainlink Polygon settlement truth");
  });

  test("approves a small simulation intent with fresh required feeds", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new StaticRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), snapshot(nowMs));

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual(["approved"]);
  });
});

describe("AggregatedRiskGate", () => {
  test("allows orders when predictive aggregate is healthy", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      predictiveAggregate: aggregateSnapshot(false),
      leadLag: leadLagSnapshot("moderate", true),
    });

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual(["approved"]);
  });

  test("blocks orders when predictive aggregate disagreement is true", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      predictiveAggregate: aggregateSnapshot(true),
      leadLag: leadLagSnapshot("moderate", true),
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "predictive aggregate disagreement is true",
    );
  });

  test("blocks no healthy predictive feeds via aggregate disagreement", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      predictiveAggregate: noHealthyFeedsAggregate(),
      leadLag: leadLagSnapshot("none", false),
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "predictive aggregate disagreement is true",
    );
  });

  test("treats lead-lag none from insufficient samples as informational by default", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      predictiveAggregate: aggregateSnapshot(false),
      leadLag: leadLagSnapshot("none", false),
    });

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual(["approved"]);
  });

  test("can be configured to block insufficient lead-lag samples", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate({
      blockOnInsufficientLeadLagSamples: true,
    });
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      predictiveAggregate: aggregateSnapshot(false),
      leadLag: leadLagSnapshot("none", false),
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "lead-lag monitor has insufficient samples",
    );
  });

  test("preserves static stale-data blocking", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      venue: {
        ...venueEvent(nowMs),
        quality: "stale",
        freshnessMs: 10_000,
      },
      predictiveAggregate: aggregateSnapshot(false),
      leadLag: leadLagSnapshot("moderate", true),
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("venue feed quality is stale");
    expect(result.reasons).toContain(
      "venue feed is stale by freshness threshold",
    );
  });

  test("preserves static max exposure blocking", () => {
    const nowMs = round.startTimeMs + 60_000;
    const gate = new AggregatedRiskGate();
    const result = gate.evaluate(buyIntent(nowMs), {
      ...snapshot(nowMs),
      openExposureUsd: 49,
      predictiveAggregate: aggregateSnapshot(false),
      leadLag: leadLagSnapshot("moderate", true),
    });

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "open exposure would exceed max exposure limit",
    );
  });
});
