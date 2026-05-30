import { describe, expect, test } from "bun:test";
import { BinancePredictiveAdapter } from "../../engine/bot-core/binance-predictive-adapter.ts";

describe("BinancePredictiveAdapter", () => {
  test("implements the PredictiveFeedAdapter interface", () => {
    const adapter = new BinancePredictiveAdapter();
    expect(adapter.role).toBe("predictive");
    expect(adapter.source).toBe("binance-ticker");
  });

  test("normalizes Binance ticker message with source timestamp", (done) => {
    const adapter = new BinancePredictiveAdapter();
    const now = Date.now();
    
    // Binance ticker message structure
    const mockBinanceMsg = {
      e: "24hrTicker",  // Event type
      E: now - 100,     // Event time (source timestamp)
      s: "BTCUSDT",     // Symbol
      p: "100.0",       // Price change
      P: "0.1",         // Price change percent
      w: "99990.0",     // Weighted average price
      x: "99980.0",     // First trade(F)-1 price
      c: "100000.5",    // Last price (c)
      Q: "0.5",         // Last quantity
      b: "100000.0",    // Best bid price
      B: "1.0",         // Best bid quantity
      a: "100001.0",    // Best ask price
      A: "2.0",         // Best ask quantity
      o: "99900.0",     // Open price
      h: "101000.0",    // High price
      l: "99000.0",     // Low price
      v: "5000.0",      // Total traded base asset volume (v)
      q: "500000000.0", // Total traded quote asset volume
      O: now - 86400000,// Statistics open time
      C: now,           // Statistics close time
      F: 0,             // First trade ID
      L: 1000,          // Last trade ID
      n: 1001           // Total number of trades
    };

    adapter.subscribe((event) => {
      expect(event.role).toBe("predictive");
      expect(event.exchange).toBe("binance");
      expect(event.price).toBe(100000.5);
      expect(event.volume).toBe(5000.0);
      expect(event.clock.sourceTimestampMs).toBe(now - 100);
      expect(event.quality).toBe("live");
      expect(event.freshnessMs).toBeGreaterThanOrEqual(100);
      done();
    });

    adapter.handleMessage({ data: JSON.stringify(mockBinanceMsg) } as any);
  });

  test("isStale detection logic correctly identifies old data", () => {
    const adapter = new BinancePredictiveAdapter() as any;
    const now = Date.now();

    // Not stale (within 1000ms limit)
    expect(adapter.isStale({ sourceTimestampMs: now - 500, receivedAtMs: now })).toBe(false);

    // Stale (exceeds 1000ms limit)
    expect(adapter.isStale({ sourceTimestampMs: now - 1500, receivedAtMs: now })).toBe(true);
  });
});
