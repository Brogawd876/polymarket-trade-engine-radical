import { describe, expect, test, beforeEach } from "bun:test";
import { DefaultPredictiveAggregator } from "../../engine/bot-core/predictive-signal-aggregator.ts";
import {
  type PredictivePriceEvent,
  type ResolutionPriceEvent,
  type VenueOrderBookEvent,
  createEventClock,
} from "../../engine/bot-core/data-sources";

// Mock adapter
class MockPredictiveAdapter {
  private handler?: (event: PredictivePriceEvent) => void;
  subscribe(handler: (event: PredictivePriceEvent) => void) {
    this.handler = handler;
    return () => {};
  }
  emit(event: PredictivePriceEvent) {
    this.handler?.(event);
  }
}

class StaticAdapter<T> {
  constructor(private event: T | null) {}
  subscribe() {
    return () => {};
  }
  latest() {
    return this.event;
  }
  latestAnchor() {
    return this.event as any;
  }
}

describe("DefaultPredictiveAggregator", () => {
  let binance: MockPredictiveAdapter;
  let coinbase: MockPredictiveAdapter;
  let aggregator: DefaultPredictiveAggregator;

  beforeEach(() => {
    binance = new MockPredictiveAdapter();
    coinbase = new MockPredictiveAdapter();
    aggregator = new DefaultPredictiveAggregator({
      asset: "btc",
      feeds: {
        binance: binance as any,
        coinbase: coinbase as any,
      },
      divergenceThresholdAbs: 50,
    });
  });

  const btcEvent = (exchange: string, price: number, quality: any = "live", delayMs: number = 10): PredictivePriceEvent => {
    const now = Date.now();
    return {
      id: `${exchange}-${now}`,
      role: "predictive",
      source: `${exchange}-ticker`,
      asset: "btc",
      kind: "ticker",
      price,
      exchange,
      clock: createEventClock({
        sourceTimestampMs: now - delayMs,
        receivedAtMs: now,
      }),
      quality,
      freshnessMs: delayMs,
      lagMs: 0,
    };
  };

  const resolutionEvent = (price: number): ResolutionPriceEvent => {
    const now = Date.now();
    return {
      id: "chainlink-1",
      role: "resolution",
      source: "chainlink-polygon-btc-usd",
      sourceType: "chainlink_polygon",
      asset: "btc",
      kind: "live",
      price,
      rawOracleAnswer: String(Math.round(price * 1e8)),
      roundId: "1",
      chainUpdatedAtMs: now - 100,
      localReceivedAtMs: now,
      oracleLagMs: 100,
      clock: createEventClock({ sourceTimestampMs: now - 100, receivedAtMs: now }),
      quality: "live",
      stalenessStatus: "fresh",
      freshnessMs: 100,
      lagMs: 100,
    };
  };

  const venueEvent = (): VenueOrderBookEvent => {
    const now = Date.now();
    return {
      id: "venue-1",
      role: "venue",
      source: "polymarket-clob",
      asset: "btc",
      kind: "orderbook",
      clock: createEventClock({ receivedAtMs: now }),
      quality: "live",
      freshnessMs: null,
      lagMs: 0,
      up: { bids: [[0.49, 10]], asks: [[0.51, 10]] },
      down: { bids: [[0.48, 10]], asks: [[0.5, 10]] },
      bestBidUp: 0.49,
      bestAskUp: 0.51,
      bestBidDown: 0.48,
      bestAskDown: 0.5,
    };
  };

  test("initial state has disagreement (no feeds)", () => {
    const latest = aggregator.latest();
    expect(latest.price).toBeNull();
    expect(latest.disagreement).toBe(true);
  });

  test("one-feed state is correctly tracked with age and delay", () => {
    binance.emit(btcEvent("binance", 100000, "live", 15));
    const latest = aggregator.latest();
    expect(latest.price).toBe(100000);
    
    const feed = latest.feeds.binance;
    expect(feed).toBeDefined();
    if (feed) {
      expect(feed.price).toBe(100000);
      expect(feed.arrivalDelayMs).toBe(15);
      expect(feed.latestEventAgeMs).toBeLessThan(100);
    }
    
    expect(latest.disagreement).toBe(false); 
  });

  test("two-feed aggregation calculates average and divergence", () => {
    binance.emit(btcEvent("binance", 100000));
    coinbase.emit(btcEvent("coinbase", 100020));
    const latest = aggregator.latest();
    expect(latest.price).toBe(100010);
    expect(latest.divergenceAbs).toBe(20);
    expect(latest.divergencePct).toBeCloseTo(0.02, 2);
    expect(latest.disagreement).toBe(false);
  });

  test("plausible BTC feed divergence remains a tiny percent", () => {
    binance.emit(btcEvent("binance", 78135.20));
    coinbase.emit(btcEvent("coinbase", 78135.50));
    const latest = aggregator.latest();
    expect(latest.price).toBe(78135.35);
    expect(latest.divergenceAbs).toBeCloseTo(0.30, 6);
    expect(latest.divergencePct).toBeCloseTo(0.000384, 6);
    expect(latest.disagreement).toBe(false);
  });

  test("disagreement flag fires when divergence exceeds threshold", () => {
    binance.emit(btcEvent("binance", 100000));
    coinbase.emit(btcEvent("coinbase", 100060));
    const latest = aggregator.latest();
    expect(latest.price).toBe(100030);
    expect(latest.divergenceAbs).toBe(60);
    expect(latest.disagreement).toBe(true);
  });

  test("stale feeds are excluded from average but still recorded", () => {
    binance.emit(btcEvent("binance", 100000));
    coinbase.emit(btcEvent("coinbase", 100500, "stale"));
    const latest = aggregator.latest();
    expect(latest.price).toBe(100000); // Only binance is healthy
    
    const feed = latest.feeds.coinbase;
    expect(feed).toBeDefined();
    if (feed) {
      expect(feed.quality).toBe("stale");
    }
    
    expect(latest.divergenceAbs).toBeNull(); // Cannot calculate divergence with one healthy feed
    expect(latest.disagreement).toBe(false); // One healthy feed is enough to avoid disagreement
  });

  test("disagreement if all feeds are stale", () => {
    binance.emit(btcEvent("binance", 100000, "stale"));
    coinbase.emit(btcEvent("coinbase", 100500, "stale"));
    const latest = aggregator.latest();
    expect(latest.price).toBeNull();
    expect(latest.disagreement).toBe(true);
  });

  test("resilience: aggregator continues with one healthy feed when other becomes stale", () => {
    // Both live initially
    binance.emit(btcEvent("binance", 100000));
    coinbase.emit(btcEvent("coinbase", 100020));
    expect(aggregator.latest().price).toBe(100010);
    expect(aggregator.latest().disagreement).toBe(false);

    // Coinbase becomes stale
    coinbase.emit(btcEvent("coinbase", 100020, "stale"));
    const latest = aggregator.latest();
    
    expect(latest.price).toBe(100000); // Only healthy binance price used
    
    const feed = latest.feeds.coinbase;
    expect(feed).toBeDefined();
    if (feed) {
      expect(feed.quality).toBe("stale");
    }
    
    expect(latest.disagreement).toBe(false); // One healthy feed remains
  });

  test("keeps settlement anchor, predictive tape, and market price separate", () => {
    aggregator = new DefaultPredictiveAggregator({
      asset: "btc",
      feeds: {
        binance: binance as any,
        coinbase: coinbase as any,
      },
      resolution: new StaticAdapter(resolutionEvent(99_900)) as any,
      venue: new StaticAdapter(venueEvent()) as any,
    });

    binance.emit(btcEvent("binance", 100_000));
    coinbase.emit(btcEvent("coinbase", 100_020));

    const latest = aggregator.latest();
    expect(latest.settlementAnchor.price).toBe(99_900);
    expect(latest.predictiveTape.compositePrice).toBe(100_010);
    expect(latest.price).toBe(100_010);
    expect(latest.predictiveTape.feeds.binance?.divergenceFromSettlementAbs).toBe(100);
    expect(latest.marketPrice.yesBestBid).toBe(0.49);
    expect(latest.marketPrice.yesBestAsk).toBe(0.51);
    expect("referencePrice" in latest).toBe(false);
  });
});
