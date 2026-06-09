import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { PolymarketVenueAdapter } from "../../engine/bot-core/polymarket-venue-adapter.ts";
import { OrderBook } from "../../tracker/orderbook.ts";
import { APIQueue } from "../../tracker/api-queue.ts";
import { type RoundWindow, type VenueMetadata } from "../../engine/bot-core/data-sources";

const UP_ID = "0x123";
const DOWN_ID = "0x456";

describe("PolymarketVenueAdapter", () => {
  test("implements the VenueDataAdapter interface", () => {
    const orderBook = new OrderBook();
    const apiQueue = new APIQueue();
    const adapter = new PolymarketVenueAdapter("btc", orderBook, apiQueue);
    expect(adapter.role).toBe("venue");
    expect(adapter.source).toBe("polymarket-clob");
  });

  test("initRound with existing metadata avoids refetch and subscribes", async () => {
    const orderBook = new OrderBook();
    const apiQueue = new APIQueue();
    const adapter = new PolymarketVenueAdapter("btc", orderBook, apiQueue);
    
    const subSpy = spyOn(orderBook, "subscribe");
    const queueSpy = spyOn(apiQueue, "queueEventDetails");

    const round: RoundWindow = {
      slug: "btc-updown-5m-1",
      asset: "btc",
      window: "5m",
      startTimeMs: 1000,
      endTimeMs: 2000,
    };

    const existing: VenueMetadata = {
      conditionId: "cond1",
      clobTokenIds: [UP_ID, DOWN_ID],
      feeRateBps: 10,
      closed: false,
    };

    const metadata = await adapter.initRound(round, existing);

    expect(metadata).toEqual(existing);
    expect(subSpy).toHaveBeenCalledWith([UP_ID, DOWN_ID]);
    expect(queueSpy).not.toHaveBeenCalled();
  });

  test("emits VenueOrderBookEvent on orderbook updates via listener", (done) => {
    const orderBook = new OrderBook();
    const apiQueue = new APIQueue();
    const adapter = new PolymarketVenueAdapter("btc", orderBook, apiQueue);

    const round: RoundWindow = {
      slug: "btc-updown-5m-1",
      asset: "btc",
      window: "5m",
      startTimeMs: 1000,
      endTimeMs: 2000,
    };

    adapter.initRound(round, {
      conditionId: "cond1",
      clobTokenIds: [UP_ID, DOWN_ID],
      feeRateBps: 10,
    });

    adapter.start();

    adapter.subscribe((event) => {
      expect(event.role).toBe("venue");
      expect(event.kind).toBe("orderbook");
      expect(event.round).toBe(round);
      expect(event.clock.receivedAtMs).toBeDefined();
      expect(event.freshnessMs).toBeNull(); // Verified: null because no source timestamp
      adapter.stop();
      done();
    });

    // Manually trigger handleMessage on orderBook (which calls notify)
    (orderBook as any).handleMessage({ data: JSON.stringify({ event_type: "book", asset_id: UP_ID, bids: [], asks: [] }) } as any);
  });

  // Phase 8U: UP/DOWN Token Mapping Tests

  test("initRound normalizes tokenIds when outcomes are ['Up', 'Down']", async () => {
    const orderBook = new OrderBook();
    const apiQueue = new APIQueue();
    const adapter = new PolymarketVenueAdapter("btc", orderBook, apiQueue);

    const round: RoundWindow = {
      slug: "btc-updown-5m-2",
      asset: "btc",
      window: "5m",
      startTimeMs: 1000,
      endTimeMs: 2000,
    };

    // Mock APIQueue to return specific eventDetails
    apiQueue.queueEventDetails = async () => {};
    apiQueue.eventDetails.set("btc-updown-5m-2", {
      id: "ev2",
      ticker: "BTC",
      negRisk: false,
      markets: [{
        id: "m2",
        conditionId: "cond2",
        clobTokenIds: JSON.stringify(["upToken", "downToken"]),
        outcomes: JSON.stringify(["Up", "Down"]),
        outcomePrices: "[]",
        closed: false,
      }]
    });

    const metadata = await adapter.initRound(round);
    expect(metadata).not.toBeNull();
    expect(metadata?.clobTokenIds).toEqual(["upToken", "downToken"]);
  });

  test("initRound normalizes tokenIds when outcomes are ['Down', 'Up']", async () => {
    const orderBook = new OrderBook();
    const apiQueue = new APIQueue();
    const adapter = new PolymarketVenueAdapter("btc", orderBook, apiQueue);

    const round: RoundWindow = {
      slug: "btc-updown-5m-3",
      asset: "btc",
      window: "5m",
      startTimeMs: 1000,
      endTimeMs: 2000,
    };

    apiQueue.queueEventDetails = async () => {};
    apiQueue.eventDetails.set("btc-updown-5m-3", {
      id: "ev3",
      ticker: "BTC",
      negRisk: false,
      markets: [{
        id: "m3",
        conditionId: "cond3",
        clobTokenIds: JSON.stringify(["downToken", "upToken"]), // API returns DOWN first
        outcomes: JSON.stringify(["Down", "Up"]),               // API outcomes matching
        outcomePrices: "[]",
        closed: false,
      }]
    });

    const metadata = await adapter.initRound(round);
    expect(metadata).not.toBeNull();
    // Should be normalized to UP first, then DOWN
    expect(metadata?.clobTokenIds).toEqual(["upToken", "downToken"]);
  });

  test("initRound returns null when outcomes are missing or malformed", async () => {
    const orderBook = new OrderBook();
    const apiQueue = new APIQueue();
    const adapter = new PolymarketVenueAdapter("btc", orderBook, apiQueue);

    const round: RoundWindow = {
      slug: "btc-updown-5m-4",
      asset: "btc",
      window: "5m",
      startTimeMs: 1000,
      endTimeMs: 2000,
    };

    apiQueue.queueEventDetails = async () => {};
    apiQueue.eventDetails.set("btc-updown-5m-4", {
      id: "ev4",
      ticker: "BTC",
      negRisk: false,
      markets: [{
        id: "m4",
        conditionId: "cond4",
        clobTokenIds: JSON.stringify(["token1", "token2"]),
        outcomes: JSON.stringify(["Yes", "No"]), // Not explicitly Up/Down
        outcomePrices: "[]",
        closed: false,
      }]
    });

    const metadata = await adapter.initRound(round);
    // Should return null and prevent trading if we can't definitively map UP/DOWN
    expect(metadata).toBeNull();
  });
});
