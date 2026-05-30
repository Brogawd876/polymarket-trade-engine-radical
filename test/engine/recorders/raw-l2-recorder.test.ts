import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { RawL2Recorder } from "../../../engine/recorders/raw-l2-recorder.ts";
import { NoopEventWriter } from "../../../engine/event-store/writer.ts";
let mockTime = 1779294600000;
class MockClock {
  nowMs() { return mockTime; }
  setTimeout() { return 1; }
  clearTimeout() {}
  setInterval() { return 1; }
  clearInterval() {}
}

let mockWsOpts: any = null;
let mockWsInstance = {
  send: mock(),
  destroy: mock(),
};

mock.module("../../../utils/reconnecting-ws.ts", () => ({
  createReconnectingWs: (opts: any) => {
    mockWsOpts = opts;
    return mockWsInstance;
  },
}));

mock.module("../../../tracker/api-queue.ts", () => ({
  APIQueue: class {
    eventDetails = new Map<string, any>();
    async queueEventDetails(slug: string) {
      this.eventDetails.set(slug, {
        markets: [
          {
            conditionId: "0xcond",
            clobTokenIds: '["up123", "down456"]',
          },
        ],
      });
    }
  },
}));

describe("RawL2Recorder", () => {
  let writer: NoopEventWriter;
  let clock: MockClock;
  let recorder: RawL2Recorder;

  beforeEach(() => {
    mockWsOpts = null;
    mockWsInstance.send.mockClear();
    mockWsInstance.destroy.mockClear();
    mockTime = 1779294600000;

    writer = new NoopEventWriter();
    clock = new MockClock();
    recorder = new RawL2Recorder({ writer, clock });
  });

  afterEach(async () => {
    await recorder.stop();
  });

  it("initializes and writes startup events", async () => {
    await recorder.start("btc-updown-test");
    expect(writer.events.length).toBe(2);
    expect(writer.events[0]?.eventType).toBe("recorder_started");
    expect(writer.events[1]?.eventType).toBe("market_resolved_for_recording");
    
    // Check WS connected
    expect(mockWsOpts).not.toBeNull();
    mockWsOpts.onopen(mockWsInstance);
    
    expect(writer.events.length).toBe(3);
    expect(writer.events[2]?.eventType).toBe("feed_connected");
    
    expect(mockWsInstance.send).toHaveBeenCalled();
  });

  it("normalizes book snapshots", async () => {
    await recorder.start("btc-updown-test");
    mockWsOpts.onopen(mockWsInstance);
    
    const wsMsg = {
      data: JSON.stringify([
        {
          asset_id: "up123",
          event_type: "book",
          bids: [{ price: "0.50", size: "100" }],
          asks: [{ price: "0.52", size: "200" }],
          tick_size: "0.01"
        }
      ])
    };
    
    const preLength = writer.events.length;
    mockWsOpts.onmessage(wsMsg);
    await Promise.resolve();
    await Promise.resolve(); // flush microtasks
    
    expect(writer.events.length).toBe(preLength + 1);
    const evt = writer.events[preLength]!;
    expect(evt.eventType).toBe("market_book_snapshot");
    expect(evt.payload).toMatchObject({
      tokenId: "up123",
      side: "UP",
      bids: [[0.50, 100]],
      asks: [[0.52, 200]],
      raw: { tick_size: "0.01" }
    });
    
    expect(recorder.health.messagesReceived).toBe(1);
    expect(recorder.health.messagesWritten).toBe(4); // 3 startup events + 1 book snapshot
  });

  it("normalizes price changes", async () => {
    await recorder.start("btc-updown-test");
    mockWsOpts.onopen(mockWsInstance);
    
    const wsMsg = {
      data: JSON.stringify({
        event_type: "price_change",
        price_changes: [
          {
            asset_id: "down456",
            price: "0.45",
            size: "50",
            side: "BUY",
            best_bid: "0.45",
            best_ask: "0.47"
          }
        ]
      })
    };
    
    const preLength = writer.events.length;
    mockWsOpts.onmessage(wsMsg);
    await Promise.resolve();
    await Promise.resolve();
    
    const evt = writer.events[preLength]!;
    expect(evt.eventType).toBe("market_book_delta");
    expect(evt.payload).toMatchObject({
      tokenId: "down456",
      side: "DOWN",
      bidChanges: [[0.45, 50]],
      bestBid: 0.45,
      bestAsk: 0.47
    });
  });

  it("normalizes trades", async () => {
    await recorder.start("btc-updown-test");
    mockWsOpts.onopen(mockWsInstance);
    
    const wsMsg = {
      data: JSON.stringify({
        event_type: "trades",
        asset_id: "up123",
        price: "0.60",
        size: "1000",
        side: "buy",
        timestamp: "1779294600000"
      })
    };
    
    const preLength = writer.events.length;
    mockWsOpts.onmessage(wsMsg);
    await Promise.resolve();
    await Promise.resolve();
    
    const evt = writer.events[preLength]!;
    expect(evt.eventType).toBe("market_trade");
    expect(evt.sourceTsMs).toBe(1779294600000);
    expect(evt.payload).toMatchObject({
      tokenId: "up123",
      side: "UP",
      action: "buy",
      price: 0.60,
      shares: 1000
    });
  });

  it("tracks decode errors", async () => {
    await recorder.start("btc-updown-test");
    mockWsOpts.onopen(mockWsInstance);
    
    mockWsOpts.onmessage({ data: "invalid-json" });
    await Promise.resolve();
    await Promise.resolve();
    
    expect(recorder.health.decodeErrorCount).toBe(1);
    const lastEvt = writer.events[writer.events.length - 1]!;
    expect(lastEvt.eventType).toBe("feed_decode_error");
  });

  it("keeps incomplete last_trade_price separate from market_trade evidence", async () => {
    await recorder.start("btc-updown-test");
    mockWsOpts.onopen(mockWsInstance);
    
    const wsMsg = {
      data: JSON.stringify({
        event_type: "last_trade_price",
        asset_id: "down456",
        price: "0.45",
        fee_rate_bps: "200"
      })
    };
    
    const preLength = writer.events.length;
    mockWsOpts.onmessage(wsMsg);
    await Promise.resolve();
    await Promise.resolve();
    
    const evt = writer.events[preLength]!;
    expect(evt.eventType).toBe("last_trade_price");
    expect(evt.payload).toMatchObject({
      tokenId: "down456",
      side: "DOWN",
      price: 0.45,
      raw: { fee_rate_bps: "200", event_type: "last_trade_price" }
    });
    
    // Ensure incomplete last_trade_price does not become fill evidence.
    const trades = writer.events.filter(e => e.eventType === "market_trade");
    expect(trades.length).toBe(0);
  });

  it("normalizes complete last_trade_price trade prints into market_trade evidence", async () => {
    await recorder.start("btc-updown-test");
    mockWsOpts.onopen(mockWsInstance);

    const wsMsg = {
      data: JSON.stringify({
        event_type: "last_trade_price",
        asset_id: "down456",
        market: "0xcond",
        price: "0.45",
        size: "12.5",
        side: "BUY",
        fee_rate_bps: "200",
        timestamp: "1779294600123"
      })
    };

    const preLength = writer.events.length;
    mockWsOpts.onmessage(wsMsg);
    await Promise.resolve();
    await Promise.resolve();

    const lastTrade = writer.events[preLength]!;
    const marketTrade = writer.events[preLength + 1]!;
    expect(lastTrade.eventType).toBe("last_trade_price");
    expect(lastTrade.sourceTsMs).toBe(1779294600123);
    expect(lastTrade.payload).toMatchObject({
      tokenId: "down456",
      side: "DOWN",
      action: "buy",
      price: 0.45,
      shares: 12.5,
    });
    expect(marketTrade.eventType).toBe("market_trade");
    expect(marketTrade.sourceTsMs).toBe(1779294600123);
    expect(marketTrade.payload).toMatchObject({
      tokenId: "down456",
      side: "DOWN",
      action: "buy",
      price: 0.45,
      shares: 12.5,
      makerTaker: "unknown",
      tradePrintSource: "clob_market_last_trade_price",
    });
  });
});
