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
});
