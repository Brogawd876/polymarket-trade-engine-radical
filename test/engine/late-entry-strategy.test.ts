import { describe, expect, test } from "bun:test";
import { lateEntry } from "../../engine/strategy/late-entry.ts";
import type { OrderRequest, StrategyContext } from "../../engine/strategy/types.ts";

class ManualClock {
  private now = 0;
  private callbacks: Array<() => void> = [];

  nowMs(): number {
    return this.now;
  }

  setInterval(callback: () => void): number {
    this.callbacks.push(callback);
    return this.callbacks.length;
  }

  clearInterval(): void {}

  setTimeout(): number {
    return 0;
  }

  clearTimeout(): void {}

  tick(ms = 500): void {
    this.now += ms;
    for (const callback of [...this.callbacks]) callback();
  }
}

function makeContext(clock: ManualClock, posted: OrderRequest[]): StrategyContext {
  const ticker = { price: 100, divergence: 0 } as any;
  return {
    slug: "btc-updown-5m-test",
    strategyName: "late-entry",
    strategyConfig: {},
    slotStartMs: 0,
    slotEndMs: 300_000,
    clobTokenIds: ["up-token", "down-token"],
    orderBook: {
      bestAskInfo: (side: "UP" | "DOWN") => (
        side === "UP"
          ? { price: 0.52, liquidity: 100 }
          : { price: 0.48, liquidity: 100 }
      ),
      bestBidPrice: () => 0.5,
    } as any,
    log: () => {},
    getOrderById: async () => null,
    postOrders: (orders) => posted.push(...orders),
    cancelOrders: async () => ({ canceled: [], not_canceled: [] }),
    emergencySells: async () => {},
    blockBuys: () => {},
    blockSells: () => {},
    hold: () => () => {},
    pendingOrders: [],
    orderHistory: [],
    ticker,
    getMarketResult: () => ({ openPrice: 90 } as any),
    clock: clock as any,
  };
}

describe("lateEntry", () => {
  test("applies explicit config overrides when wrapped by a strategy variant", async () => {
    const clock = new ManualClock();
    const posted: OrderRequest[] = [];
    const ctx = makeContext(clock, posted);

    await lateEntry(ctx, {
      shares: 3,
      certaintyPrice: 0.51,
      entryWindowSec: 300,
      maxAtr: 100,
      minGapSafety: 1,
      maxDivergence: 100,
      minPeakGapRatio: 0.1,
      minLiquidity: 0,
    });

    const ticker = ctx.ticker as any;
    for (const price of [100, 101, 99, 102, 98, 103, 104]) {
      ticker.price = price;
      clock.tick();
    }

    expect(posted.length).toBe(1);
    expect(posted[0]!.req).toMatchObject({
      tokenId: "up-token",
      action: "buy",
      price: 0.52,
      shares: 3,
    });
  });
});
