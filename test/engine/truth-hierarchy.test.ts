import { describe, expect, test, spyOn } from "bun:test";
import { TradeTapeTracker } from "../../tracker/trade-tape.ts";
import { RealClock } from "../../engine/bot-core/data-sources.ts";
import { MarketLifecycle } from "../../engine/market-lifecycle.ts";
import { APIQueue } from "../../tracker/api-queue.ts";
import { SessionManager } from "../../engine/session-manager.ts";
import { TelemetryBus } from "../../engine/bot-core/index.ts";

class MockOrderBook {
  isReady() { return true; }
  subscribe() {}
}

describe("Truth Hierarchy Classification", () => {
  test("last_trade_price inferred direction is classified as inferred_diagnostic", () => {
    const clock = new RealClock();
    const tape = new TradeTapeTracker({ asset: "polymarket", clock });
    
    // Simulating public last_trade_price
    tape.recordTrade({
      assetId: "test",
      price: 0.50,
      size: 100,
      side: "buy", // The inferred direction
      ts: clock.nowMs()
    });

    const snap = tape.latest();
    expect(snap.truthSource).toEqual({
      sourceClass: "inferred_diagnostic",
      confidence: "low"
    });
    expect(snap.source).toBe("public_inferred");
  });

  test("inferred public flow is removed from executable StrategyContext in production (allowInferredFlow=false)", async () => {
    const clock = new RealClock();
    const tape = new TradeTapeTracker({ asset: "polymarket", clock });
    
    tape.recordTrade({ assetId: "test", price: 0.50, size: 100, side: "buy", ts: clock.nowMs() });

    let strategyCalled = false;
    let strategyReceivedFlow = undefined;

    const lifecycle = new MarketLifecycle({
      slug: "test-slug",
      strategyName: "test-strat",
      strategyConfig: { allowInferredFlow: false },
      clock,
      apiQueue: new APIQueue({} as any, {} as any),
      orderBook: new MockOrderBook() as any,
      client: { getOrderById: () => {} } as any,
      eventWriter: { append: async () => {}, close: async () => {} } as any,
      tracker: { balance: 100, locked: 0 } as any,
      log: () => {},
      strategy: async (ctx) => {
        strategyCalled = true;
        strategyReceivedFlow = ctx.orderFlow;
      },
      orderFlow: tape
    });

    spyOn(lifecycle as any, "setup").mockResolvedValue(undefined);
    spyOn(lifecycle as any, "_checkRequiredFeedsReadiness").mockReturnValue({ ready: true, reasons: [] });
    (lifecycle as any)._clobTokenIds = ["A", "B"];
    (lifecycle as any)._venue = { start: async () => {}, on: () => {}, latest: () => null };
    (lifecycle as any)._userChannel = { isReady: () => true, subscribe: () => {} };
    await (lifecycle as any)._handleInit();

    expect(strategyCalled).toBe(true);
    expect(strategyReceivedFlow).toBeUndefined();
  });

  test("inferred public flow is included in StrategyContext for research replay (allowInferredFlow=true)", async () => {
    const clock = new RealClock();
    const tape = new TradeTapeTracker({ asset: "polymarket", clock });
    
    tape.recordTrade({ assetId: "test", price: 0.50, size: 100, side: "buy", ts: clock.nowMs() });

    let strategyCalled = false;
    let strategyReceivedFlow = undefined;

    const lifecycle = new MarketLifecycle({
      slug: "test-slug",
      strategyName: "test-strat",
      strategyConfig: { allowInferredFlow: true },
      clock,
      apiQueue: new APIQueue({} as any, {} as any),
      orderBook: new MockOrderBook() as any,
      client: { getOrderById: () => {} } as any,
      eventWriter: { append: async () => {}, close: async () => {} } as any,
      tracker: { balance: 100, locked: 0 } as any,
      log: () => {},
      strategy: async (ctx) => {
        strategyCalled = true;
        strategyReceivedFlow = ctx.orderFlow;
      },
      orderFlow: tape
    });

    spyOn(lifecycle as any, "setup").mockResolvedValue(undefined);
    spyOn(lifecycle as any, "_checkRequiredFeedsReadiness").mockReturnValue({ ready: true, reasons: [] });
    (lifecycle as any)._clobTokenIds = ["A", "B"];
    (lifecycle as any)._venue = { start: async () => {}, on: () => {}, latest: () => null };
    (lifecycle as any)._userChannel = { isReady: () => true, subscribe: () => {} };
    await (lifecycle as any)._handleInit();

    expect(strategyCalled).toBe(true);
    expect(strategyReceivedFlow).toBeDefined();
    expect((strategyReceivedFlow as any).latest().truthSource.sourceClass).toBe("inferred_diagnostic");
  });

  test("SessionManager.startReplay defaults to allowInferredFlow=false (production-like)", async () => {
    const bus = new TelemetryBus();
    const manager = new SessionManager(bus);
    await manager.startReplay("dummy.db");
    const bot = (manager as any)._bot;
    expect(bot._strategyConfig.allowInferredFlow).toBe(false);
  });

  test("SessionManager.startReplay allows explicitly setting allowInferredFlow=true (research mode)", async () => {
    const bus = new TelemetryBus();
    const manager = new SessionManager(bus);
    await manager.startReplay("dummy.db", { allowInferredFlow: true });
    const bot = (manager as any)._bot;
    expect(bot._strategyConfig.allowInferredFlow).toBe(true);
  });
});
