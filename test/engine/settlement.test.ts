import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FixtureRunner, UP_TOKEN, SLOT_START_MS, SLOT_END_MS } from "./helpers/fixture-runner.ts";

const LOG_START_TS = 1777108047232;

describe("PnL and Settlement Truth Audit", () => {
  let runner: FixtureRunner;

  beforeEach(() => {
    runner = new FixtureRunner();
  });

  afterEach(() => {
    runner.teardown();
  });

  test("UP wins when closePrice > openPrice", async () => {
    await runner.setup(async (ctx) => {
      ctx.postOrders([
        { req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 }, expireAtMs: SLOT_END_MS }
      ]);
    });
    
    await runner.advanceTo(LOG_START_TS + 1000);

    // Verify order is pending
    expect(runner.lifecycle.pendingOrders.length).toBe(1);
    const orderId = runner.lifecycle.pendingOrders[0]!.orderId;

    // Simulate buy fill
    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "10",
      taker_order_id: orderId,
      maker_orders: []
    });

    runner.apiQueue.marketResult.set(SLOT_START_MS, { openPrice: 100, closePrice: 101 } as any);
    
    // Advance to end of slot
    await runner.advanceTo(SLOT_END_MS + 100);
    
    // Shutdown initiates redemption and settlement
    runner.lifecycle.shutdown();
    await runner.advanceTo(SLOT_END_MS + 2000);

    // Expected PnL: $10 payout - $5 cost = $5
    expect(runner.lifecycle.pnl).toBeCloseTo(5);
  });

  test("DOWN wins when closePrice < openPrice", async () => {
    await runner.setup(async (ctx) => {
      ctx.postOrders([
        { req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 }, expireAtMs: SLOT_END_MS }
      ]);
    });
    
    await runner.advanceTo(LOG_START_TS + 1000);
    const orderId = runner.lifecycle.pendingOrders[0]!.orderId;

    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "10",
      taker_order_id: orderId,
      maker_orders: []
    });

    // Close < Open -> UP loses
    runner.apiQueue.marketResult.set(SLOT_START_MS, { openPrice: 100, closePrice: 99 } as any);
    
    await runner.advanceTo(SLOT_END_MS + 100);
    runner.lifecycle.shutdown();
    await runner.advanceTo(SLOT_END_MS + 2000);

    // Expected PnL: $0 payout - $5 cost = -$5
    expect(runner.lifecycle.pnl).toBeCloseTo(-5);
  });

  test("DOWN wins when closePrice == openPrice (Tie-breaker rule)", async () => {
    // According to Polymarket "Up or Down" rules, "Up" requires strictly greater.
    // If close == open, "Up" is false, therefore "Down" wins (UP loses).
    await runner.setup(async (ctx) => {
      ctx.postOrders([
        { req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 }, expireAtMs: SLOT_END_MS }
      ]);
    });

    await runner.advanceTo(LOG_START_TS + 1000);
    const orderId = runner.lifecycle.pendingOrders[0]!.orderId;
    
    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1", status: "MINED", size: "10",
      taker_order_id: orderId, maker_orders: []
    });

    // Tie
    runner.apiQueue.marketResult.set(SLOT_START_MS, { openPrice: 100, closePrice: 100 } as any);
    
    await runner.advanceTo(SLOT_END_MS + 100);
    runner.lifecycle.shutdown();
    await runner.advanceTo(SLOT_END_MS + 2000);

    // Cost: $5 for UP. Payout: $0 for UP.
    expect(runner.lifecycle.pnl).toBeCloseTo(-5);
  });
});