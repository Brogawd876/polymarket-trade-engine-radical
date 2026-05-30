import { describe, expect, test } from "bun:test";
import { CoinbasePredictiveAdapter } from "../../engine/bot-core/coinbase-predictive-adapter.ts";

describe("CoinbasePredictiveAdapter", () => {
  test("implements the PredictiveFeedAdapter interface", () => {
    const adapter = new CoinbasePredictiveAdapter();
    expect(adapter.role).toBe("predictive");
    expect(adapter.source).toBe("coinbase-ticker");
  });

  test("normalizes Coinbase ticker message with source timestamp", (done) => {
    const adapter = new CoinbasePredictiveAdapter();
    const now = new Date();
    const isoTime = now.toISOString();
    const nowMs = now.getTime();
    
    // Coinbase ticker message structure
    const mockCoinbaseMsg = {
      type: "ticker",
      sequence: 12345678,
      product_id: "BTC-USD",
      price: "100000.5",
      open_24h: "99000.0",
      volume_24h: "5000.0",
      low_24h: "98000.0",
      high_24h: "101000.0",
      volume_30d: "150000.0",
      best_bid: "100000.0",
      best_ask: "100001.0",
      side: "buy",
      time: isoTime,
      trade_id: 12345,
      last_size: "0.01"
    };

    adapter.subscribe((event) => {
      expect(event.role).toBe("predictive");
      expect(event.exchange).toBe("coinbase");
      expect(event.price).toBe(100000.5);
      expect(event.clock.sourceTimestampMs).toBe(nowMs);
      expect(event.quality).toBe("live");
      done();
    });

    adapter.handleMessage({ data: JSON.stringify(mockCoinbaseMsg) } as any);
  });

  test("isStale detection logic correctly identifies old data", () => {
    const adapter = new CoinbasePredictiveAdapter() as any;
    const now = Date.now();

    // Not stale (within 1000ms limit)
    expect(adapter.isStale({ sourceTimestampMs: now - 500, receivedAtMs: now })).toBe(false);

    // Stale (exceeds 1000ms limit)
    expect(adapter.isStale({ sourceTimestampMs: now - 1500, receivedAtMs: now })).toBe(true);
  });
});
