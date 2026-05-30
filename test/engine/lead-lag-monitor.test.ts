import { describe, expect, test, beforeEach } from "bun:test";
import { DefaultLeadLagMonitor } from "../../engine/bot-core/lead-lag-monitor.ts";
import { type PredictiveAggregateSnapshot } from "../../engine/bot-core/data-sources";

class MockAggregator {
  private handler?: (snapshot: PredictiveAggregateSnapshot) => void;
  private _latest: PredictiveAggregateSnapshot;

  constructor() {
    this._latest = {
      asset: "btc",
      timestampMs: Date.now(),
      price: null,
      feeds: {
        binance: { price: 0, quality: "live", latestEventAgeMs: 0, arrivalDelayMs: null },
        coinbase: { price: 0, quality: "live", latestEventAgeMs: 0, arrivalDelayMs: null },
      },
      divergenceAbs: null,
      divergencePct: null,
      disagreement: true,
    };
  }

  subscribe(handler: (snapshot: PredictiveAggregateSnapshot) => void) {
    this.handler = handler;
    return () => {};
  }

  latest() {
    return this._latest;
  }

  emit(feeds: Record<string, { arrivalDelayMs: number | null; quality?: any }>) {
    for (const [name, data] of Object.entries(feeds)) {
      this._latest.feeds[name] = {
        price: 100000,
        quality: data.quality ?? "live",
        latestEventAgeMs: 0,
        arrivalDelayMs: data.arrivalDelayMs,
      };
    }
    this.handler?.(this._latest);
  }
}

describe("DefaultLeadLagMonitor", () => {
  let aggregator: MockAggregator;
  let monitor: DefaultLeadLagMonitor;

  beforeEach(() => {
    aggregator = new MockAggregator();
    monitor = new DefaultLeadLagMonitor({
      asset: "btc",
      aggregator: aggregator as any,
      minSamples: 3,
      weakThresholdMs: 5,
      moderateThresholdMs: 15,
      strongThresholdMs: 50,
    });
  });

  test("initial state has no leader and insufficient samples", () => {
    const latest = monitor.latest();
    expect(latest.observedTimingLeader).toBeNull();
    expect(latest.sufficientSamples).toBe(false);
  });

  test("identifies Binance as leader when consistently faster", () => {
    // 3 samples each (minSamples = 3)
    for (let i = 0; i < 3; i++) {
      aggregator.emit({
        binance: { arrivalDelayMs: 10 },
        coinbase: { arrivalDelayMs: 100 },
      });
    }

    const latest = monitor.latest();
    expect(latest.observedTimingLeader).toBe("binance");
    expect(latest.observedTimingRunnerUp).toBe("coinbase");
    expect(latest.averageDelaySpreadMs).toBe(90);
    expect(latest.leadershipConfidence).toBe("strong");
    expect(latest.sufficientSamples).toBe(true);
  });

  test("switches leader when Coinbase becomes faster", () => {
    // Initially Binance is faster
    for (let i = 0; i < 3; i++) {
      aggregator.emit({
        binance: { arrivalDelayMs: 10 },
        coinbase: { arrivalDelayMs: 100 },
      });
    }
    expect(monitor.latest().observedTimingLeader).toBe("binance");

    // Then Coinbase becomes much faster (averages will take a few samples to shift)
    // We use a large number to overcome the initial bias in the rolling average (window 50)
    for (let i = 0; i < 10; i++) {
      aggregator.emit({
        binance: { arrivalDelayMs: 200 },
        coinbase: { arrivalDelayMs: 10 },
      });
    }

    const latest = monitor.latest();
    expect(latest.observedTimingLeader).toBe("coinbase");
    expect(latest.leadershipConfidence).toBe("strong");
  });

  test("reports weak confidence when feeds are nearly tied", () => {
    for (let i = 0; i < 3; i++) {
      aggregator.emit({
        binance: { arrivalDelayMs: 50 },
        coinbase: { arrivalDelayMs: 57 }, // 7ms spread > weak (5) but < moderate (15)
      });
    }

    const latest = monitor.latest();
    expect(latest.observedTimingLeader).toBe("binance");
    expect(latest.leadershipConfidence).toBe("weak");
  });

  test("stale feeds are excluded from timing averages", () => {
    // Both live
    for (let i = 0; i < 3; i++) {
      aggregator.emit({
        binance: { arrivalDelayMs: 10 },
        coinbase: { arrivalDelayMs: 100 },
      });
    }
    expect(monitor.latest().sufficientSamples).toBe(true);

    // Coinbase becomes stale
    aggregator.emit({
      binance: { arrivalDelayMs: 10 },
      coinbase: { arrivalDelayMs: 5, quality: "stale" }, // Faster but stale
    });

    const latest = monitor.latest();
    expect(latest.observedTimingLeader).toBe("binance");
    // Average for coinbase should not have changed from 100
    expect(latest.feeds.coinbase?.trailingAverageArrivalDelayMs).toBe(100);
    expect(latest.feeds.coinbase?.sampleCount).toBe(3); // count didn't increase
  });

  test("resilience: handles missing arrivalDelayMs gracefully", () => {
    aggregator.emit({
      binance: { arrivalDelayMs: 10 },
      coinbase: { arrivalDelayMs: null },
    });

    const latest = monitor.latest();
    expect(latest.feeds.coinbase?.sampleCount).toBe(0);
    expect(latest.sufficientSamples).toBe(false);
  });

  test("sufficientSamples is false if only one feed has data", () => {
    // 10 samples for binance only
    for (let i = 0; i < 10; i++) {
      aggregator.emit({
        binance: { arrivalDelayMs: 10 },
      });
    }

    const latest = monitor.latest();
    expect(latest.sufficientSamples).toBe(false);
    expect(latest.observedTimingLeader).toBeNull();
    expect(latest.leadershipConfidence).toBe("none");
  });
});
