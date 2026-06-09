import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import sinon from "sinon";
import { FixtureRunner, UP_TOKEN, DOWN_TOKEN, SLOT_START_MS, SLOT_END_MS } from "./helpers/fixture-runner.ts";

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

    await runner.advanceTo(LOG_START_TS + 100);
    
    // Simulate buy fill
    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "10",
      taker_order_id: runner.lifecycle.pendingOrders[0]!.orderId,
      maker_orders: []
    });

    runner.apiQueue.marketResult.set(SLOT_START_MS, { openPrice: 100, closePrice: 101 } as any);
    
    await runner.advanceTo(SLOT_END_MS + 100);
    // Force transition
    runner.lifecycle.shutdown();
    await runner.advanceTo(SLOT_END_MS + 200);

    expect(runner.lifecycle.pnl).toBe(5); // $10 payout - $5 cost = $5
  });

  test("DOWN wins when closePrice < openPrice", async () => {
    await runner.setup(async (ctx) => {
      ctx.postOrders([
        { req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 }, expireAtMs: SLOT_END_MS }
      ]);
    });
    
    await runner.advanceTo(LOG_START_TS + 100);

    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "10",
      taker_order_id: runner.lifecycle.pendingOrders[0]!.orderId,
      maker_orders: []
    });

    // Close < Open -> UP loses
    runner.apiQueue.marketResult.set(SLOT_START_MS, { openPrice: 100, closePrice: 99 } as any);
    
    await runner.advanceTo(SLOT_END_MS + 100);
    runner.lifecycle.shutdown();
    await runner.advanceTo(SLOT_END_MS + 200);

    expect(runner.lifecycle.pnl).toBe(-5); // $0 payout - $5 cost = -$5
  });

  test("DOWN wins when closePrice == openPrice (Tie-breaker rule)", async () => {
    // According to Polymarket "Up or Down" rules, "Up" requires strictly greater.
    // If close == open, "Up" is false, therefore "Down" wins (UP loses).
    await runner.setup(async (ctx) => {
      ctx.postOrders([
        { req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 }, expireAtMs: SLOT_END_MS }
      ]);
    });

    await runner.advanceTo(LOG_START_TS + 100);
    
    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1", status: "MINED", size: "10",
      taker_order_id: runner.lifecycle.pendingOrders[0]!.orderId, maker_orders: []
    });

    // Tie
    runner.apiQueue.marketResult.set(SLOT_START_MS, { openPrice: 100, closePrice: 100 } as any);
    
    await runner.advanceTo(SLOT_END_MS + 100);
    runner.lifecycle.shutdown();
    await runner.advanceTo(SLOT_END_MS + 200);

    // Cost: $5 for UP. Payout: $0 for UP.
    expect(runner.lifecycle.pnl).toBe(-5);
  });
});