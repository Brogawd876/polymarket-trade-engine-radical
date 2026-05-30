import { describe, expect, test } from "bun:test";
import { TradeTapeTracker, type TradeEvent } from "../../tracker/trade-tape.ts";
import { VirtualClock } from "../../engine/bot-core/replay-runner.ts";

describe("TradeTapeTracker", () => {
  test("calculates CVD and OBI correctly", () => {
    const clock = new VirtualClock();
    const tracker = new TradeTapeTracker({
      asset: "btc",
      clock,
      whaleThresholdUsd: 1000
    });

    // 1. Initial state
    let snap = tracker.latest();
    expect(snap.cvd10s.up).toBe(0);
    expect(snap.sentiment).toBe("neutral");

    // 2. Add some trades
    const now = clock.nowMs();
    tracker.recordTrade({ price: 0.80, size: 1000, side: "buy", ts: now, assetId: "up" }); // $800
    tracker.recordTrade({ price: 0.20, size: 500, side: "sell", ts: now + 100, assetId: "down" }); // $100
    
    snap = tracker.latest();
    expect(snap.cvd10s.up).toBe(800);
    expect(snap.cvd10s.down).toBe(100);

    // 3. Update imbalance
    tracker.updateImbalance(0.5, -0.5);
    snap = tracker.latest();
    expect(snap.imbalanceUp).toBe(0.5);
    expect(snap.sentiment).toBe("bullish"); // Delta > 0 AND imbalance > 0.2

    // 4. Whale detection
    tracker.recordTrade({ price: 0.50, size: 10000, side: "buy", ts: now + 200, assetId: "up" }); // $5000
    snap = tracker.latest();
    expect(snap.recentWhales.length).toBe(1);
    expect(snap.recentWhales[0].notionalUsd).toBe(5000);

    // 5. Time window pruning
    clock.setNowMs(now + 15000); // 15s later
    snap = tracker.latest();
    expect(snap.cvd10s.up).toBe(0); // Older trades pruned from 10s window
    expect(snap.cvd60s.up).toBe(5800); // Still in 60s window
  });
});
