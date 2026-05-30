import { describe, expect, it } from "bun:test";
import { ConservativeFillScorer, type ScoreFillOptions } from "../../engine/replay/fill-scoring.ts";
import type { ProfitEventEnvelope } from "../../engine/event-store/events.ts";

function mockEvent(type: string, tsMs: number, payload: any): ProfitEventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    schemaVersion: 1,
    runId: "test",
    sessionId: "test",
    eventType: type as any,
    source: "test",
    receivedTsMs: tsMs,
    processedTsMs: tsMs,
    commitSha: "test",
    payload,
  };
}

describe("ConservativeFillScorer", () => {
  const scorer = new ConservativeFillScorer();

  const baseOrder: ScoreFillOptions = {
    orderId: "order1",
    tokenId: "tokenA",
    action: "buy",
    side: "UP",
    price: 0.50,
    shares: 100,
    placedTsMs: 1000,
  };

  // ── Touch logic ──────────────────────────────────────────────────────────

  it("buy touch uses bestBid (resting on bid side), not bestAsk", () => {
    // maker BUY at 0.50 — touch occurs when bestBid >= 0.50 (bid queue reached our price)
    const withBidTouch = [
      mockEvent("market_book_snapshot", 1001, { tokenId: "tokenA", side: "UP", bestBid: 0.50, bestAsk: 0.52 }),
    ];
    expect(scorer.evaluate(baseOrder, withBidTouch).verdict).toBe("touch_only");

    // bestAsk alone at 0.50 does not constitute a maker-BUY touch (that would be taker logic)
    const askOnlyAtPrice = [
      mockEvent("market_book_snapshot", 1001, { tokenId: "tokenA", side: "UP", bestBid: 0.48, bestAsk: 0.50 }),
    ];
    // bestBid 0.48 < 0.50 — no touch
    expect(scorer.evaluate(baseOrder, askOnlyAtPrice).verdict).toBe("no_fill");
  });

  it("sell touch uses bestAsk (resting on ask side), not bestBid", () => {
    const sellOrder: ScoreFillOptions = { ...baseOrder, action: "sell", price: 0.60 };

    // maker SELL at 0.60 — touch occurs when bestAsk <= 0.60 (ask queue reached our price)
    const withAskTouch = [
      mockEvent("market_book_snapshot", 1001, { tokenId: "tokenA", side: "UP", bestBid: 0.58, bestAsk: 0.60 }),
    ];
    expect(scorer.evaluate(sellOrder, withAskTouch).verdict).toBe("touch_only");

    // bestBid alone at 0.60 does not constitute a maker-SELL touch
    const bidOnlyAtPrice = [
      mockEvent("market_book_snapshot", 1001, { tokenId: "tokenA", side: "UP", bestBid: 0.60, bestAsk: 0.62 }),
    ];
    // bestAsk 0.62 > 0.60 — no touch
    expect(scorer.evaluate(sellOrder, bidOnlyAtPrice).verdict).toBe("no_fill");
  });

  // ── bids/asks array fallback for markout reference ───────────────────────

  it("raw snapshot with bids/asks arrays (no explicit bestBid/bestAsk) still supports markout reference", () => {
    // Simulate raw L2 recorder output: bids and asks as BookLevel arrays, no explicit bestBid/bestAsk
    const events = [
      // Fill at t=1001 via trade-through
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.49, shares: 10 }),
      // Reference at t=2001 (1s after fill) — only bids/asks arrays present
      mockEvent("market_book_snapshot", 2001, {
        tokenId: "tokenA",
        side: "UP",
        bids: [[0.47, 50], [0.46, 100]],
        asks: [[0.49, 30], [0.50, 200]],
        // no bestBid / bestAsk fields
      }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.verdict).toBe("trade_through_fill");
    expect(result.fillTsMs).toBe(1001);
    // bestBid derived as 0.47 (top of bids), bestAsk as 0.49 (top of asks)
    // mid = (0.47 + 0.49) / 2 = 0.48
    // 1s markout for BUY: mid(2001) - fillPrice(0.50) = 0.48 - 0.50 = -0.02
    expect(result.markouts["1s"]).not.toBeNull();
    expect(result.markouts["1s"]).toBeCloseTo(-0.02, 5);
    expect(result.adverseSelection).toBe(true);
  });

  it("prefers explicit bestBid/bestAsk over bids/asks arrays", () => {
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.49, shares: 10 }),
      mockEvent("market_book_snapshot", 2001, {
        tokenId: "tokenA",
        side: "UP",
        bids: [[0.40, 50]],  // array says 0.40
        asks: [[0.42, 30]],  // array says 0.42
        bestBid: 0.47,       // explicit overrides
        bestAsk: 0.49,       // explicit overrides
      }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    // mid from explicit fields: (0.47 + 0.49) / 2 = 0.48
    // 1s markout: 0.48 - 0.50 = -0.02
    expect(result.markouts["1s"]).toBeCloseTo(-0.02, 5);
  });

  // ── Trade-through evidence ───────────────────────────────────────────────

  it("exact-price trade with unknown queue is not a fill", () => {
    const events = [
      // Book shows bid reaching our price (touch)
      mockEvent("market_book_snapshot", 1001, { tokenId: "tokenA", side: "UP", bestBid: 0.50, bestAsk: 0.52 }),
      mockEvent("market_trade", 1002, { tokenId: "tokenA", price: 0.50, shares: 1000 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    // Queue is unknown (Infinity) — exact-price volume can never satisfy it
    expect(result.verdict).toBe("touch_only");
    expect(result.fillTsMs).toBeNull();
  });

  it("exact-price trade with known queue satisfied is a probable fill", () => {
    const order = { ...baseOrder, queuePosition: 200 };
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.50, shares: 200 }), // cumulative=200, need 300
      mockEvent("market_trade", 1002, { tokenId: "tokenA", price: 0.50, shares: 150 }), // cumulative=350 >= 300 ✓
    ];
    const result = scorer.evaluate(order, events);
    expect(result.verdict).toBe("probable_fill");
    expect(result.fillTsMs).toBe(1002);
  });

  it("exact-price trade with known queue not satisfied is not a fill", () => {
    const order = { ...baseOrder, queuePosition: 200 };
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.50, shares: 100 }), // cumulative=100 < 300
    ];
    const result = scorer.evaluate(order, events);
    expect(result.verdict).toBe("no_fill");
  });

  it("trade-through is strong fill evidence", () => {
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.49, shares: 10 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.verdict).toBe("trade_through_fill");
    expect(result.fillTsMs).toBe(1001);
  });

  // ── Buy/sell symmetry ────────────────────────────────────────────────────

  it("buy/sell symmetry for trade-through and probable fill", () => {
    const sellOrder: ScoreFillOptions = { ...baseOrder, action: "sell", price: 0.60, queuePosition: 100 };

    // Trade through for SELL: trade above price
    const buyThroughEvents = [mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.61, shares: 10 })];
    expect(scorer.evaluate(sellOrder, buyThroughEvents).verdict).toBe("trade_through_fill");

    // Exact price satisfied for SELL
    const exactSatisfied = [mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.60, shares: 250 })];
    expect(scorer.evaluate(sellOrder, exactSatisfied).verdict).toBe("probable_fill");

    // Trade through for BUY: trade below price (already covered above, verify symmetry)
    const sellThrough = [mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.51, shares: 10 })];
    expect(scorer.evaluate(sellOrder, sellThrough).verdict).toBe("no_fill"); // 0.51 not > 0.60
    const sellThroughReal = [mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.65, shares: 10 })];
    expect(scorer.evaluate(sellOrder, sellThroughReal).verdict).toBe("trade_through_fill");
  });

  // ── Token mismatch ───────────────────────────────────────────────────────

  it("token mismatch ignored — events for wrong tokenId produce no data", () => {
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenB", price: 0.40, shares: 1000 }),
      mockEvent("market_book_snapshot", 1002, { tokenId: "tokenB", side: "UP", bestBid: 0.50 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.verdict).toBe("unknown_insufficient_data");
  });

  // ── last_trade_price ─────────────────────────────────────────────────────

  it("last_trade_price does not create fill evidence", () => {
    const events = [
      // Would be a trade-through if it were a market_trade — but it's last_trade_price
      mockEvent("last_trade_price", 1001, { tokenId: "tokenA", price: 0.45 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.verdict).not.toBe("trade_through_fill");
    expect(result.verdict).not.toBe("probable_fill");
    // v1: last_trade_price ignored entirely — no hasData set, so unknown_insufficient_data
    expect(result.verdict).toBe("unknown_insufficient_data");
  });

  it("last_trade_price is not used as markout reference (v1: ignored)", () => {
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.49, shares: 10 }), // fill
      // last_trade_price at markout horizon — should NOT produce a markout value
      mockEvent("last_trade_price", 2001, { tokenId: "tokenA", price: 0.52 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.fillTsMs).toBe(1001);
    // No book snapshot at 2001, so markout reference is missing
    expect(result.markouts["1s"]).toBeNull();
    expect(result.markoutReasons["1s"]).toBe("missing_horizon");
  });

  // ── Markout behavior ─────────────────────────────────────────────────────

  it("missing future reference gives null markout with reason", () => {
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.49, shares: 10 }),
      // No subsequent book snapshots
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.fillTsMs).toBe(1001);
    expect(result.markouts["1s"]).toBeNull();
    expect(result.markoutReasons["1s"]).toBe("missing_horizon");
  });

  it("adverse selection flagged when 1s markout is negative", () => {
    const events = [
      mockEvent("market_trade", 1001, { tokenId: "tokenA", price: 0.49, shares: 10 }),
      // 1s later: price drops (adverse)
      mockEvent("market_book_snapshot", 2001, { tokenId: "tokenA", side: "UP", bestBid: 0.44, bestAsk: 0.46 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    expect(result.fillTsMs).toBe(1001);
    // mid = 0.45; buy markout = 0.45 - 0.50 = -0.05
    expect(result.markouts["1s"]).not.toBeNull();
    expect(result.markouts["1s"]!).toBeLessThan(0);
    expect(result.adverseSelection).toBe(true);
  });

  // ── Temporal filtering ───────────────────────────────────────────────────

  it("pre-placement events ignored", () => {
    const events = [
      mockEvent("market_trade", 900, { tokenId: "tokenA", price: 0.45, shares: 1000 }), // before placedTsMs
      mockEvent("market_trade", 1005, { tokenId: "tokenA", price: 0.50, shares: 10 }),  // after, but not enough
    ];
    const result = scorer.evaluate({ ...baseOrder, queuePosition: 100 }, events);
    // Pre-placement trade-through at 900 must be ignored
    expect(result.verdict).toBe("no_fill"); // cumulative exact-price 10 < 200 needed
  });

  it("out-of-order events are sorted before processing", () => {
    const events = [
      // Provided out-of-order: trade at 1005, book at 1002
      mockEvent("market_trade", 1005, { tokenId: "tokenA", price: 0.45, shares: 100 }),
      mockEvent("market_book_snapshot", 1002, { tokenId: "tokenA", side: "UP", bestBid: 0.48, bestAsk: 0.52 }),
    ];
    const result = scorer.evaluate(baseOrder, events);
    // After sort: book at 1002 first, trade at 1005 second
    expect(result.verdict).toBe("trade_through_fill");
    expect(result.fillTsMs).toBe(1005);
  });
});
