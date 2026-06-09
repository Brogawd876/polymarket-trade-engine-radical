import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import sinon from "sinon";
import { FixtureRunner, UP_TOKEN, SLOT_END_MS } from "./helpers/fixture-runner.ts";
import type { CancelOrderResponse } from "../../utils/trading.ts";

const LOG_START_TS = 1777108047232;

describe("Cancel Lifecycle and User Channel Tracking", () => {
  let runner: FixtureRunner;
  let cancelStub: sinon.SinonStub;

  beforeEach(() => {
    runner = new FixtureRunner();
  });

  afterEach(() => {
    runner.teardown();
  });

  test("Test A: cancel returns not_canceled -> order remains tracked and locks remain", async () => {
    cancelStub = sinon.stub(runner.client, "cancelOrders").resolves({
      canceled: [],
      not_canceled: {}
    });

    let filledShares = 0;

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 },
          expireAtMs: SLOT_END_MS,
          onFilled: (s) => { filledShares += s; }
        }
      ]);
    });

    await runner.advanceTo(LOG_START_TS + 100);
    
    // We have 1 pending order.
    const orderId = runner.lifecycle.pendingOrders[0]?.orderId;
    expect(orderId).toBeDefined();

    // The order should be tracked by the user channel
    expect((runner.lifecycle as any)._userChannel.tracked.has(orderId)).toBe(true);
    
    // The wallet should have a reservation
    expect((runner.lifecycle as any)._tracker._reservedForBuys.size).toBe(1);

    // Re-stub to return not_canceled for this specific order
    cancelStub.resolves({
      canceled: [],
      not_canceled: { [orderId!]: "Cancellation rejected" }
    });

    const res = await (runner.lifecycle as any)._cancelOrders([orderId!]);
    expect(res.canceled).toEqual([]);
    
    // Order should STILL be in pendingOrders
    expect(runner.lifecycle.pendingOrders.length).toBe(1);
    
    // Order should STILL be tracked
    expect((runner.lifecycle as any)._userChannel.tracked.has(orderId)).toBe(true);

    // Reservation should STILL be locked
    expect((runner.lifecycle as any)._tracker._reservedForBuys.size).toBe(1);

    // If a fill arrives, it should process it
    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1",
      status: "MATCHED",
      size: "10",
      taker_order_id: orderId!,
      maker_orders: []
    });
    (runner.lifecycle as any)._userChannel.processTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "10",
      taker_order_id: orderId!,
      maker_orders: []
    });

    expect(filledShares).toBe(10);
    expect(runner.lifecycle.pendingOrders.length).toBe(0); // removed by fill
  });

  test("Test B: cancel returns canceled -> order untracked, removed, and unlocked", async () => {
    let filledShares = 0;

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 },
          expireAtMs: SLOT_END_MS,
          onFilled: (s) => { filledShares += s; }
        }
      ]);
    });

    await runner.advanceTo(LOG_START_TS + 100);
    const orderId = runner.lifecycle.pendingOrders[0]?.orderId;

    cancelStub = sinon.stub(runner.client, "cancelOrders").resolves({
      canceled: [orderId!],
      not_canceled: {}
    });

    await (runner.lifecycle as any)._cancelOrders([orderId!]);
    
    // Order should be removed
    expect(runner.lifecycle.pendingOrders.length).toBe(0);
    
    // Order should be untracked
    expect((runner.lifecycle as any)._userChannel.tracked.has(orderId)).toBe(false);

    // Reservation should be unlocked
    expect((runner.lifecycle as any)._tracker._reservedForBuys.size).toBe(0);
  });

  test("Test C: cancel API throws -> pending order remains tracked", async () => {
    let filledShares = 0;

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.5, shares: 10 },
          expireAtMs: SLOT_END_MS,
          onFilled: (s) => { filledShares += s; }
        }
      ]);
    });

    await runner.advanceTo(LOG_START_TS + 100);
    const orderId = runner.lifecycle.pendingOrders[0]?.orderId;

    cancelStub = sinon.stub(runner.client, "cancelOrders").rejects(new Error("Network Error"));

    await expect((runner.lifecycle as any)._cancelOrders([orderId!])).rejects.toThrow("Network Error");
    
    // Order should STILL be in pendingOrders
    expect(runner.lifecycle.pendingOrders.length).toBe(1);
    
    // Order should STILL be tracked
    expect((runner.lifecycle as any)._userChannel.tracked.has(orderId)).toBe(true);

    // Reservation should STILL be locked
    expect((runner.lifecycle as any)._tracker._reservedForBuys.size).toBe(1);
  });
});
