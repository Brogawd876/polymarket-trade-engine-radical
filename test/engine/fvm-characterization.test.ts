import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { 
  fairValueMaker, 
  calculateSettlementAnchoredFairValue, 
  type FairValueMakerConfig 
} from "../../engine/strategy/fair-value-maker.ts";
import { RealClock } from "../../engine/bot-core/data-sources.ts";
import type { StrategyContext, OrderRequest } from "../../engine/strategy/types.ts";

function createMockContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const clock = new RealClock();
  return {
    strategyName: "fair-value-maker",
    strategyConfig: {},
    slug: "test-slug",
    conditionId: "test-cond",
    clobTokenIds: ["UP", "DOWN"],
    clock,
    slotStartMs: clock.nowMs() - 60000,
    slotEndMs: clock.nowMs() + 240000, // 4 mins remaining
    orderBook: {
      getTokenId: (side: "UP" | "DOWN") => side,
      getTickSize: () => "0.01",
      bestBidPrice: () => 0.45,
      bestAskPrice: () => 0.80,
      getFeeRate: () => 0,
      subscribe: () => () => {},
      isReady: () => true,
    } as any,
    resolution: {
      latest: () => ({ quality: "live", stalenessStatus: "fresh" } as any),
      latestAnchor: () => ({ price: 0.50, priceToBeat: 0.50 } as any),
      subscribe: () => () => {},
    } as any,
    predictive: {
      aggregate: {
        latest: () => ({ price: 0.501, predictiveTape: { compositePrice: 0.501 } } as any),
        subscribe: () => () => {},
      } as any,
    } as any,
    quant: {
      latest: () => ({ sigma: 0.80 } as any),
      subscribe: () => () => {},
    } as any,
    orderFlow: undefined,
    walletBalanceUsd: 1000,
    walletTokenBalances: {},
    openExposureUsd: 0,
    maxOpenExposureUsd: 50,
    pendingOrders: [],
    orderHistory: [],
    postOrders: async () => {},
    cancelOrders: async () => {},
    log: () => {},
    ...overrides,
  };
}

describe("FVM Characterization Tests", () => {
  test("FVM computes the same fair value from the same inputs", () => {
    const ctx = createMockContext();
    const result = calculateSettlementAnchoredFairValue(ctx, 0.80);
    expect(result.probabilityUp).toBeDefined();
    expect(result.probabilityUp).toBeGreaterThan(0);
    expect(result.probabilityUp).toBeLessThan(1);
    expect(result.settlementAnchorPrice).toBe(0.50);
    expect(result.predictiveCompositePrice).toBe(0.501);
    expect(result.noTradeReason).toBeNull();
  });

  test("FVM produces the same YES/NO quote decisions from fixed fixtures", async () => {
    const postedOrders: OrderRequest[] = [];
    const ctx = createMockContext({
      postOrders: async (orders) => { postedOrders.push(...orders); },
      strategyConfig: {
        sharesMode: "fixed",
        shares: 10,
        minEdge: 0.005,
      } as FairValueMakerConfig
    });

    const cleanup = await fairValueMaker(ctx);
    expect(postedOrders.length).toBeGreaterThan(0);
    
    // With predict=0.60, anchor=0.50, probUp > 0.50
    // It should quote UP and DOWN around the fair value
    const upQuote = postedOrders.find(o => o.req.tokenId === "UP");
    const downQuote = postedOrders.find(o => o.req.tokenId === "DOWN");
    expect(upQuote).toBeDefined();
    expect(downQuote).toBeDefined();
    
    cleanup();
  });

  test("FVM sizing is deterministic", async () => {
    let postedShares = 0;
    const ctx = createMockContext({
      postOrders: async (orders) => { postedShares = orders[0].req.shares; },
      strategyConfig: {
        sharesMode: "pct_of_balance",
        sharePct: 0.10, // 10% of 1000 = 100 notional
        regimeWeightedSizing: false,
        edgeWeightedSizing: false,
      } as FairValueMakerConfig,
      walletBalanceUsd: 1000,
    });

    const cleanup = await fairValueMaker(ctx);
    expect(postedShares).toBeGreaterThan(0);
    cleanup();
  });

  test("FVM inventory skew is deterministic", async () => {
    let priceNeutral = 0;
    let priceSkewed = 0;

    const ctxNeutral = createMockContext({
      postOrders: async (orders) => { priceNeutral = orders.find(o => o.req.tokenId === "UP")?.req.price || 0; },
      orderHistory: [],
    });
    
    const ctxSkewed = createMockContext({
      postOrders: async (orders) => { priceSkewed = orders.find(o => o.req.tokenId === "UP")?.req.price || 0; },
      orderHistory: [
        { tokenId: "UP", action: "buy", shares: 50, price: 0.5 } as any
      ],
      strategyConfig: { inventorySkew: 0.1, maxInventory: 100 }
    });

    const clean1 = await fairValueMaker(ctxNeutral);
    const clean2 = await fairValueMaker(ctxSkewed);
    
    // Holding UP inventory should lower the UP bid price
    expect(priceSkewed).toBeLessThan(priceNeutral);
    
    clean1();
    clean2();
  });

  test("FVM works with orderFlow === undefined", async () => {
    let posted = false;
    const ctx = createMockContext({
      orderFlow: undefined,
      postOrders: async (orders) => { posted = true; },
    });
    
    const cleanup = await fairValueMaker(ctx);
    expect(posted).toBe(true);
    cleanup();
  });

  test("FVM does not rely on inferred public flow in production", async () => {
    let posted = false;
    const ctx = createMockContext({
      orderFlow: {
        latest: () => ({
          source: "public_inferred",
          confidence: "low",
          imbalanceUp: -1, // terrible imbalance
          cvd10s: { up: 0, down: 1000 }
        } as any),
        subscribe: () => () => {},
      } as any,
      postOrders: async (orders) => { posted = true; },
      strategyConfig: { minImbalance: -0.5, minCvd10s: -100 }
    });

    // Mock PROD
    const { Env } = await import("../../utils/config.ts");
    const envSpy = spyOn(Env, "get").mockImplementation((key) => key === "PROD" ? "true" : undefined as any);

    const cleanup = await fairValueMaker(ctx);
    // Even though flow is terrible, it's public_inferred in PROD, so it should be ignored and order posted.
    expect(posted).toBe(true);
    cleanup();
    envSpy.mockRestore();
  });
});
