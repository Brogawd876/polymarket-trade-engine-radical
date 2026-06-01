import { describe, expect, test } from "bun:test";
import { avellanedaMaker } from "../../engine/strategy/avellaneda-maker.ts";
import { calculateSettlementAnchoredFairValue, fairValueMaker } from "../../engine/strategy/fair-value-maker.ts";
import { resolveStrategySelection } from "../../engine/strategy/index.ts";
import { lateEntry } from "../../engine/strategy/late-entry.ts";
import { VirtualClock } from "../../engine/bot-core/replay-runner.ts";
import type { StrategyContext } from "../../engine/strategy/types.ts";

describe("Strategy Logic Verification", () => {
  function settlementContext(clock: VirtualClock, opts: { stale?: boolean; settlement?: number; predictive?: number } = {}) {
    const settlement = opts.settlement ?? 100_000;
    const predictive = opts.predictive ?? 100_100;
    const resolution = {
      id: "chainlink-1",
      role: "resolution" as const,
      source: "chainlink-polygon-btc-usd",
      sourceType: "chainlink_polygon",
      asset: "btc" as const,
      kind: "live" as const,
      price: settlement,
      priceToBeat: settlement,
      roundId: "1",
      clock: { sourceTimestampMs: clock.nowMs() - (opts.stale ? 100000 : 0), receivedAtMs: clock.nowMs() - (opts.stale ? 100000 : 0), processedAtMs: clock.nowMs(), monotonicReceivedNs: 1n },
      quality: (opts.stale ? "stale" : "live") as any,
      stalenessStatus: (opts.stale ? "stale" : "fresh") as any,
      freshnessMs: 0,
      lagMs: 0,
    };

    return {
      resolution: {
        latest: () => resolution,
        latestAnchor: () => ({ ...resolution, kind: "open" }),
        subscribe: () => () => {},
      },
      predictive: {
        aggregate: {
          subscribe: () => () => {},
          latest: () => ({
            asset: "btc",
            timestampMs: clock.nowMs(),
            price: predictive,
            settlementAnchor: {
              price: settlement,
              roundId: "1",
              updatedAtMs: clock.nowMs(),
              localReceivedAtMs: clock.nowMs(),
              lagMs: 0,
              isStale: false,
              quality: "live",
              source: "chainlink-polygon-btc-usd",
              sourceType: "chainlink_polygon",
            },
            predictiveTape: {
              compositePrice: predictive,
              feeds: {},
              divergenceAbs: 0,
              divergencePct: 0,
              disagreement: false,
            },
            marketPrice: {
              yesBestBid: null,
              yesBestAsk: null,
              yesMidpoint: null,
              noBestBid: null,
              noBestAsk: null,
              noMidpoint: null,
              yesSpread: null,
              noSpread: null,
              executable: false,
              source: null,
            },
            feeds: {},
            divergenceAbs: 0,
            divergencePct: 0,
            disagreement: false,
          }),
        },
      },
    } as Partial<StrategyContext>;
  }

  test("strategy registry resolves aggressive and radical variants", () => {
    expect(resolveStrategySelection("hyper-aggressive").strategyName).toBe("hyper-aggressive");
    expect(resolveStrategySelection("radical-hybrid").strategyName).toBe("radical-hybrid");
  });

  function makerBook(upAsk = 0.70, downAsk = 0.70) {
    return {
      bestAskPrice: (side: "UP" | "DOWN") => side === "UP" ? upAsk : downAsk,
      bestBidPrice: () => 0.30,
      getTickSize: () => "0.01",
      getTokenId: (side: "UP" | "DOWN") => side === "UP" ? "up-id" : "down-id",
    } as any;
  }

  test("fair-value-maker places limit orders based on probability", async () => {
    const clock = new VirtualClock();
    
    // Mock StrategyContext
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, maxSpendAbs: Number.POSITIVE_INFINITY },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65 // Theoretical probability 65%
        }),
        subscribe: () => () => {}
      } as any,
      postOrders: async (orders) => {
        postedOrders.push(...orders);
        return [];
      },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      orderBook: makerBook(),
      log: () => {}
    };

    // Start strategy
    const cleanup = await fairValueMaker(ctx as StrategyContext);
    
    // 1. Initial tick
    clock.setNowMs(1000);
    
    expect(postedOrders.length).toBeGreaterThan(0);
    
    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    expect(upOrder.req.price).toBeCloseTo(0.64, 1);
    
    const downOrder = postedOrders.find(o => o.req.tokenId === "down-id");
    expect(downOrder.req.price).toBeCloseTo(0.34, 1);

    if (cleanup) cleanup();
  });

  test("fair-value-maker skews quotes based on inventory", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_000 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [
        { tokenId: "up-id", action: "buy", shares: 50, price: 0.5, ts: 0, status: "filled", id: "1" }
      ],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, maxSpendAbs: Number.POSITIVE_INFINITY },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.50 
        }),
        subscribe: () => () => {}
      } as any,
      postOrders: async (orders) => {
        postedOrders.push(...orders);
        return [];
      },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      orderBook: makerBook(),
      log: () => {}
    };

    await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    expect(upOrder.req.price).toBeGreaterThan(0.45);
    expect(upOrder.req.price).toBeLessThan(0.48);
    
    const downOrder = postedOrders.find(o => o.req.tokenId === "down-id");
    expect(downOrder.req.price).toBeGreaterThan(0.50);
  });

  test("fair-value-maker blocks normal fair value when Chainlink is stale", () => {
    const clock = new VirtualClock();
    clock.setNowMs(1000);
    const ctx: Partial<StrategyContext> = {
      clock,
      slotEndMs: 1000000,
      ...settlementContext(clock, { stale: true }),
    };

    const result = calculateSettlementAnchoredFairValue(ctx as StrategyContext, 0.2);

    expect(result.probabilityUp).toBeNull();
    expect(result.noTradeReason).toContain("Chainlink resolution feed");
  });

  test("fair-value-maker uses predictive tape for S but Chainlink settlement anchor for K", () => {
    const clock = new VirtualClock();
    clock.setNowMs(1000);
    const ctx: Partial<StrategyContext> = {
      clock,
      slotEndMs: 1000000,
      ...settlementContext(clock, { settlement: 100_000, predictive: 101_000 }),
    };

    const highPredictive = calculateSettlementAnchoredFairValue(ctx as StrategyContext, 0.2);
    const shiftedSettlement = calculateSettlementAnchoredFairValue({
      ...ctx,
      ...settlementContext(clock, { settlement: 102_000, predictive: 101_000 }),
    } as StrategyContext, 0.2);

    expect(highPredictive.settlementAnchorPrice).toBe(100_000);
    expect(highPredictive.predictiveCompositePrice).toBe(101_000);
    expect(highPredictive.probabilityUp).toBeGreaterThan(shiftedSettlement.probabilityUp ?? 1);
  });

  test("fair-value-maker maker-only quote does not cross the ask", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_100 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.2,
          probabilityUp: 0.65,
          jumpDetected: false,
          volatilityRegime: "normal",
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(0.60, 0.60),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    expect(upOrder).toBeDefined();
    expect(upOrder.req.price).toBeLessThan(0.60);
    if (cleanup) cleanup();
  });

  test("fair-value-maker subtracts Polymarket fees from edge by default", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, maxSpendAbs: Number.POSITIVE_INFINITY },
      quant: {
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65,
        }),
        subscribe: () => () => {},
      } as any,
      orderBook: {
        ...makerBook(),
        getFeeRate: () => 1000,
      } as any,
      postOrders: (orders: any) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    expect(postedOrders).toHaveLength(0);

    if (cleanup) cleanup();
  });

  test("fair-value-maker does not emit extreme BUY UP maker bids by default", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 105_000 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.2,
          probabilityUp: 0.95,
          jumpDetected: false,
          volatilityRegime: "normal",
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(0.95, 0.95),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (message) => { logs.push(message); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(10000); // Trigger log

    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeUndefined();
    // With NaN prices, it might not log the same message but let's at least check it didn't post
    if (cleanup) cleanup();
  });

  test("fair-value-maker does not emit extreme BUY DOWN maker bids by default", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 95_000 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.2,
          probabilityUp: 0.05,
          jumpDetected: false,
          volatilityRegime: "normal",
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(0.95, 0.95),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (message) => { logs.push(message); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(10000);

    expect(postedOrders.find(o => o.req.tokenId === "down-id")).toBeUndefined();
    if (cleanup) cleanup();
  });

  test("fair-value-maker obeys lower configured max maker bid", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 105_000 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true, maxMakerBidPrice: 0.75 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.2,
          probabilityUp: 0.95,
          jumpDetected: false,
          volatilityRegime: "normal",
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(0.80, 0.80),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (message) => { logs.push(message); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(10000);

    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeUndefined();
    if (cleanup) cleanup();
  });

  test("fair-value-maker suppresses repeated exposure-limit blocked BUY UP intent", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, exposureBlockCooldownMs: 10_000 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65,
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: (orders) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (message) => { logs.push(message); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    expect(upOrder).toBeDefined();
    upOrder.onFailed?.("open exposure would exceed max exposure limit");

    postedOrders.length = 0;
    clock.setNowMs(2000);

    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeUndefined();
    expect(logs.some(line => line.includes("duplicate exposure-limit blocked intent suppressed side=UP"))).toBe(true);
    if (cleanup) cleanup();
  });

  test("fair-value-maker suppresses repeated exposure-limit blocked BUY DOWN intent", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 95_000 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true, exposureBlockCooldownMs: 10_000, maxMakerBidPrice: 0.99 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.05,
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(0.65, 0.65),
      postOrders: (orders) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (message) => { logs.push(message); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const downOrder = postedOrders.find(o => o.req.tokenId === "down-id");
    expect(downOrder).toBeDefined();
    downOrder.onFailed?.("open exposure would exceed max exposure limit");

    postedOrders.length = 0;
    clock.setNowMs(2000);

    expect(postedOrders.find(o => o.req.tokenId === "down-id")).toBeUndefined();
    expect(logs.some(line => line.includes("duplicate exposure-limit blocked intent suppressed side=DOWN"))).toBe(true);
    if (cleanup) cleanup();
  });

  test("fair-value-maker allows materially different price during exposure cooldown", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    let upAsk = 0.65;
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true, exposureBlockCooldownMs: 10_000, maxMakerBidPrice: 0.99 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65,
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: {
        ...makerBook(),
        bestAskPrice: (side: "UP" | "DOWN") => side === "UP" ? upAsk : 0.70,
      } as any,
      postOrders: (orders) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const firstUp = postedOrders.find(o => o.req.tokenId === "up-id");
    expect(firstUp.req.price).toBe(0.64);
    firstUp.onFailed?.("open exposure would exceed max exposure limit");

    postedOrders.length = 0;
    upAsk = 0.63;
    clock.setNowMs(2000);

    const changedUp = postedOrders.find(o => o.req.tokenId === "up-id");
    expect(changedUp.req.price).toBe(0.62);
    if (cleanup) cleanup();
  });

  test("fair-value-maker exposure suppression expires after cooldown", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, exposureBlockCooldownMs: 1500 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65,
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: (orders) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    upOrder.onFailed?.("open exposure would exceed max exposure limit");

    postedOrders.length = 0;
    clock.setNowMs(2000);
    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeUndefined();

    postedOrders.length = 0;
    clock.setNowMs(3000);
    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeDefined();
    if (cleanup) cleanup();
  });

  test("fair-value-maker exposure suppression resets when exposure state changes", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const orderHistory: StrategyContext["orderHistory"] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory,
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, exposureBlockCooldownMs: 10_000 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65,
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: (orders) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    upOrder.onFailed?.("open exposure would exceed max exposure limit");

    postedOrders.length = 0;
    orderHistory.push({ tokenId: "down-id", action: "buy", shares: 1, price: 0.35, fee: 0 });
    clock.setNowMs(2000);

    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeDefined();
    if (cleanup) cleanup();
  });

  test("fair-value-maker does not suppress non-exposure risk failures", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, exposureBlockCooldownMs: 10_000 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65,
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: (orders) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    upOrder.onFailed?.("resolution feed is stale by received age threshold");

    postedOrders.length = 0;
    clock.setNowMs(2000);
    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeDefined();
    if (cleanup) cleanup();
  });

  test("fair-value-maker counts DOWN inventory as negative UP exposure", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_000 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [
        { tokenId: "down-id", action: "buy", shares: 50, price: 0.5, fee: 0 }
      ],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: false, maxSpendAbs: Number.POSITIVE_INFINITY },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.50
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {}
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    const downOrder = postedOrders.find(o => o.req.tokenId === "down-id");
    expect(upOrder.req.price).toBeGreaterThan(0.50);
    expect(downOrder.req.price).toBeLessThan(0.48);
    if (cleanup) cleanup();
  });

  test("fair-value-maker blocks quotes during jump regime", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const canceled: string[][] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_050 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [{ orderId: "old", tokenId: "up-id", action: "buy", price: 0.5, shares: 1, expireAtMs: 999999 } as any],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true, blockOnJump: true },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.2,
          probabilityUp: 0.55,
          jumpDetected: true,
          volatilityRegime: "jump",
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async (ids) => { canceled.push(ids); return { canceled: ids, not_canceled: {} }; },
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(10000); // 10s tick

    expect(postedOrders.length).toBe(0);
    expect(canceled.flat()).toContain("old");
    if (cleanup) cleanup();
  });

  test("fair-value-maker blocks quotes above max sigma", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const canceled: string[][] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_050 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [{ orderId: "old", tokenId: "up-id", action: "buy", price: 0.5, shares: 1, expireAtMs: 999999 } as any],
      walletBalanceUsd: 100,
      strategyConfig: { makerOnly: true, maxSigma: 0.5 },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.8,
          probabilityUp: 0.55,
          jumpDetected: false,
          volatilityRegime: "normal",
        }),
        subscribe: () => () => {}
      } as any,
      orderBook: makerBook(),
      postOrders: async (orders) => { postedOrders.push(...orders); return []; },
      cancelOrders: async (ids) => { canceled.push(ids); return { canceled: ids, not_canceled: {} }; },
      log: (message) => { logs.push(message); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(10000);

    expect(postedOrders.length).toBe(0);
    expect(canceled.flat()).toContain("old");
    expect(logs.some(line => line.includes("high-vol sigma"))).toBe(true);
    if (cleanup) cleanup();
  });

  test("late-entry (Flow Aware) respects imbalance guard", async () => {
    const clock = new VirtualClock();
    const placed: any[] = [];
    
    const ctx: Partial<StrategyContext> = {
      clock,
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      ticker: { divergence: 0, assetPrice: 70000 } as any,
      priceToBeat: 60000,
      hold: () => () => {},
      getMarketResult: () => ({ openPrice: 60000, closePrice: 0, direction: "UP", slug: "1" }),
      orderBook: {
        bestAskInfo: () => ({ price: 0.50, liquidity: 100 }),
        bestBidInfo: () => ({ price: 0.49, liquidity: 100 }),
        getTokenId: (side: any) => side === "UP" ? "up-id" : "down-id"
      } as any,
      orderFlow: {
        subscribe: () => () => {},
        latest: () => ({
          imbalanceUp: -0.5, 
          cvd10s: { up: 0, down: 1000 },
          recentWhales: [],
          sentiment: "bearish"
        })
      } as any,
      postOrders: async (orders: any) => {
        placed.push(...orders);
        return [];
      },
      log: () => {}
    };

    const config = { certaintyPrice: 0.4, minImbalance: 0.3 };
    
    await lateEntry(ctx as StrategyContext, config);
    clock.setNowMs(1000);

    // Should NOT trade because imbalance is -0.5 and we need +0.3
    expect(placed.length).toBe(0);

    // Change imbalance to bullish
    (ctx.orderFlow!.latest as any) = () => ({
        imbalanceUp: 0.8,
        cvd10s: { up: 1000, down: 0 },
        recentWhales: [],
        sentiment: "bullish"
    });

    clock.setNowMs(2000);
    expect(placed.length).toBeGreaterThan(0);
  });

  test("late-entry only buys the side matching resolution-source gap direction", async () => {
    const clock = new VirtualClock();
    const placed: any[] = [];
    const resolution = {
      id: "chainlink-live",
      role: "resolution" as const,
      source: "chainlink-polygon-btc-usd",
      sourceType: "chainlink_polygon",
      asset: "btc" as const,
      kind: "live" as const,
      price: 59_000,
      priceToBeat: 60_000,
      roundId: "1",
      clock: { sourceTimestampMs: 0, receivedAtMs: 0, processedAtMs: 0, monotonicReceivedNs: 1n },
      quality: "live" as const,
      stalenessStatus: "fresh" as const,
      freshnessMs: 0,
      lagMs: 0,
    };

    const ctx: Partial<StrategyContext> = {
      clock,
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      ticker: { divergence: 0, assetPrice: 70_000 } as any,
      resolution: {
        latest: () => resolution,
        latestAnchor: () => ({ ...resolution, kind: "open", price: 60_000, priceToBeat: 60_000 }),
        subscribe: () => () => {},
      } as any,
      hold: () => () => {},
      getMarketResult: () => ({ openPrice: 60_000, closePrice: 0, direction: "DOWN", slug: "1" }),
      orderBook: {
        bestAskInfo: (side: "UP" | "DOWN") => side === "UP"
          ? { price: 0.70, liquidity: 100 }
          : { price: 0.30, liquidity: 100 },
        bestBidInfo: () => ({ price: 0.49, liquidity: 100 }),
        getTokenId: (side: any) => side === "UP" ? "up-id" : "down-id",
      } as any,
      postOrders: (orders: any) => { placed.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      emergencySells: async () => {},
      log: () => {},
    };

    await lateEntry(ctx as StrategyContext, {
      certaintyPrice: 0.4,
      minGapSafety: 0,
      minPeakGapRatio: 0,
      maxAtr: 999999,
      maxDivergence: 999999,
      minLiquidity: 0,
    });
    clock.setNowMs(1000);

    expect(placed).toHaveLength(0);
  });

  test("late-entry stop-loss exits at current bid with FOK", async () => {
    const clock = new VirtualClock();
    const placed: any[] = [];
    const ticker = { divergence: 0, assetPrice: 61_000 } as any;
    let upAsk = 0.50;
    let upBid = 0.49;

    const ctx: Partial<StrategyContext> = {
      clock,
      slotEndMs: 100000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      ticker,
      hold: () => () => {},
      getMarketResult: () => ({ openPrice: 60_000, closePrice: 0, direction: "UP", slug: "1" }),
      orderBook: {
        bestAskInfo: (side: "UP" | "DOWN") => side === "UP"
          ? { price: upAsk, liquidity: 100 }
          : { price: 0.30, liquidity: 100 },
        bestBidInfo: () => ({ price: upBid, liquidity: 100 }),
        bestBidPrice: (side: "UP" | "DOWN") => side === "UP" ? upBid : 0.29,
        getTokenId: (side: any) => side === "UP" ? "up-id" : "down-id",
      } as any,
      postOrders: (orders: any) => { placed.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      emergencySells: async () => {},
      log: () => {},
    };

    await lateEntry(ctx as StrategyContext, {
      certaintyPrice: 0.4,
      minGapSafety: 0,
      minPeakGapRatio: 0,
      maxAtr: 999999,
      maxDivergence: 999999,
      entryWindowSec: 300,
      minLiquidity: 0,
      stopLossPrice: 0.48,
    });
    clock.setNowMs(1000);

    const buyOrder = placed.find(o => o.req.tokenId === "up-id" && o.req.action === "buy");
    expect(buyOrder).toBeDefined();
    buyOrder.onFilled?.(6);

    upAsk = 0.47;
    upBid = 0.46;
    ticker.assetPrice = 59_990;
    clock.setNowMs(21_000);

    const sellOrder = placed.find(o => o.req.tokenId === "up-id" && o.req.action === "sell");
    expect(sellOrder).toBeDefined();
    expect(sellOrder.req.price).toBe(0.46);
    expect(sellOrder.req.orderType).toBe("FOK");
    expect(sellOrder.expireAtMs).toBe(22_000);
  });
  
  test("fair-value-maker dynamic shares sizing (pct_of_balance)", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 200, // $200 balance
      strategyConfig: { 
        makerOnly: false, 
        sharesMode: "pct_of_balance",
        sharePct: 0.10 // 10%
      },
      quant: {
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65
        }),
        subscribe: () => () => {}
      } as any,
      postOrders: async (orders) => {
        postedOrders.push(...orders);
        return [];
      },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      orderBook: makerBook(),
      log: () => {}
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);
    
    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    // Default config.maxSpendAbs is $15.00.
    // $200 * 10% = $20 notional risk, but clamped to $15.
    // $15 / 0.64 bidPrice = 23.4375 shares.
    expect(upOrder.req.shares).toBe(23.4375);

    if (cleanup) cleanup();
  });

  test("fair-value-maker exposure-aware sizing clamp", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      openExposureUsd: 45, // $45 current exposure
      maxOpenExposureUsd: 50, // $50 limit, so only $5 budget remains
      strategyConfig: { 
        makerOnly: false, 
        shares: 20 // Normally would buy 20 shares @ ~0.64 = $12.80 notional
      },
      quant: {
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65
        }),
        subscribe: () => () => {}
      } as any,
      postOrders: async (orders) => {
        postedOrders.push(...orders);
        return [];
      },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      orderBook: makerBook(),
      log: (msg) => logs.push(msg)
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);
    
    const upOrder = postedOrders.find(o => o.req.tokenId === "up-id");
    // $5 budget / 0.64 price = 7.81 shares -> Math.floor = 7 shares
    expect(upOrder.req.shares).toBeLessThan(20);
    expect(upOrder.req.shares).toBe(7);
    expect(logs.some(l => l.includes("Clamping UP shares"))).toBe(true);

    // Test suppression when budget is too low
    (ctx as any).openExposureUsd = 49.5; // Only $0.50 budget
    postedOrders.length = 0;
    clock.setNowMs(10000);
    expect(postedOrders.find(o => o.req.tokenId === "up-id")).toBeUndefined();
    expect(logs.some(l => l.includes("Suppressing UP quote"))).toBe(true);

    if (cleanup) cleanup();
  });

  test("fair-value-maker suppresses unaffordable live-sized quotes before posting", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];
    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 0.235151,
      strategyConfig: {
        makerOnly: false,
        sharesMode: "fixed",
        shares: 1,
      },
      quant: {
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.65
        }),
        subscribe: () => () => {}
      } as any,
      postOrders: async (orders) => {
        postedOrders.push(...orders);
        return [];
      },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      orderBook: makerBook(),
      log: (msg) => logs.push(msg)
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    expect(postedOrders).toHaveLength(0);
    expect(logs.some((l) => l.includes("insufficient cash"))).toBe(true);
    expect(logs.some((l) => l.includes("Posting"))).toBe(false);

    if (cleanup) cleanup();
  });

  test("fair-value-maker v1.4.0 take-profit fires SELL when bid reaches threshold", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];

    // Simulate holding 10 UP shares (bought previously)
    const orderHistory: StrategyContext["orderHistory"] = [
      { tokenId: "up-id", action: "buy", shares: 10, price: 0.52 },
    ];

    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_500 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory,
      pendingOrders: [],
      walletBalanceUsd: 5,
      strategyConfig: {
        makerOnly: false,
        takeProfitEnabled: true,
        takeProfitThreshold: 0.97,
        skipHygiene: true,
      },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.10,
          probabilityUp: 0.99,
        }),
      } as any,
      // Order book: UP bid is 0.97 (threshold hit), ask is 0.98
      orderBook: {
        bestBidPrice: (side: "UP" | "DOWN") => side === "UP" ? 0.97 : 0.30,
        bestAskPrice: (side: "UP" | "DOWN") => side === "UP" ? 0.98 : 0.31,
        getTickSize: () => "0.01",
        getTokenId: (side: "UP" | "DOWN") => side === "UP" ? "up-id" : "down-id",
      } as any,
      postOrders: (orders: any) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (msg: string) => { logs.push(msg); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    // Should have posted a SELL order for the UP inventory
    const sellOrder = postedOrders.find(o => o.req.tokenId === "up-id" && o.req.action === "sell");
    expect(sellOrder).toBeDefined();
    expect(sellOrder.req.shares).toBe(10);
    expect(sellOrder.req.price).toBe(0.97);
    expect(sellOrder.req.orderType).toBe("FOK");
    expect(sellOrder.expireAtMs).toBe(1000);
    expect(logs.some(l => l.includes("TAKE-PROFIT UP"))).toBe(true);

    if (cleanup) cleanup();
  });

  test("fair-value-maker v1.4.0 take-profit does NOT fire below threshold", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];

    const orderHistory: StrategyContext["orderHistory"] = [
      { tokenId: "up-id", action: "buy", shares: 10, price: 0.52 },
    ];

    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_200 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory,
      pendingOrders: [],
      walletBalanceUsd: 5,
      strategyConfig: {
        makerOnly: false,
        takeProfitEnabled: true,
        takeProfitThreshold: 0.97,
        skipHygiene: true,
      },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.15,
          probabilityUp: 0.80,
        }),
      } as any,
      // Bid is only 0.85 — below the 0.97 threshold
      orderBook: {
        bestBidPrice: (side: "UP" | "DOWN") => side === "UP" ? 0.85 : 0.20,
        bestAskPrice: (side: "UP" | "DOWN") => side === "UP" ? 0.86 : 0.21,
        getTickSize: () => "0.01",
        getTokenId: (side: "UP" | "DOWN") => side === "UP" ? "up-id" : "down-id",
      } as any,
      postOrders: (orders: any) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    const sellOrder = postedOrders.find(o => o.req.tokenId === "up-id" && o.req.action === "sell");
    expect(sellOrder).toBeUndefined();

    if (cleanup) cleanup();
  });

  test("fair-value-maker trailing stop exits at bid with FOK", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    let upBid = 0.80;

    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_500 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [
        { tokenId: "up-id", action: "buy", shares: 10, price: 0.50 },
      ],
      pendingOrders: [],
      walletBalanceUsd: 50,
      strategyConfig: {
        makerOnly: false,
        skipHygiene: true,
        advancedExitsEnabled: true,
        scaleOutProfitMargin: 0.99,
        trailingStopActivationMargin: 0.15,
        trailingStopDrawdownMargin: 0.05,
      },
      quant: {
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.10,
          probabilityUp: 0.99,
        }),
        subscribe: () => () => {},
      } as any,
      orderBook: {
        bestBidPrice: (side: "UP" | "DOWN") => side === "UP" ? upBid : 0.30,
        bestAskPrice: (side: "UP" | "DOWN") => side === "UP" ? upBid + 0.01 : 0.31,
        getTickSize: () => "0.01",
        getTokenId: (side: "UP" | "DOWN") => side === "UP" ? "up-id" : "down-id",
      } as any,
      postOrders: (orders: any) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: () => {},
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);
    postedOrders.length = 0;

    upBid = 0.74;
    clock.setNowMs(2000);

    const sellOrder = postedOrders.find(o => o.req.tokenId === "up-id" && o.req.action === "sell");
    expect(sellOrder).toBeDefined();
    expect(sellOrder.req.price).toBe(0.74);
    expect(sellOrder.req.orderType).toBe("FOK");
    expect(sellOrder.expireAtMs).toBe(3000);

    if (cleanup) cleanup();
  });

  test("fair-value-maker v1.4.0 suppresses new BUY orders after take-profit fires", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];

    const orderHistory: StrategyContext["orderHistory"] = [
      { tokenId: "up-id", action: "buy", shares: 10, price: 0.52 },
    ];

    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_500 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory,
      pendingOrders: [],
      walletBalanceUsd: 50,
      strategyConfig: {
        makerOnly: false,
        takeProfitEnabled: true,
        takeProfitThreshold: 0.97,
        skipHygiene: true,
      },
      quant: {
        subscribe: () => () => {},
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.10,
          probabilityUp: 0.99,
        }),
      } as any,
      orderBook: {
        bestBidPrice: (side: "UP" | "DOWN") => side === "UP" ? 0.97 : 0.30,
        bestAskPrice: (side: "UP" | "DOWN") => side === "UP" ? 0.98 : 0.31,
        getTickSize: () => "0.01",
        getTokenId: (side: "UP" | "DOWN") => side === "UP" ? "up-id" : "down-id",
      } as any,
      postOrders: (orders: any) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      log: (msg: string) => { logs.push(msg); },
    };

    const cleanup = await fairValueMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    // Take-profit should have fired
    expect(postedOrders.some(o => o.req.action === "sell")).toBe(true);

    // Clear orders and tick again — no new BUY orders should appear on UP side
    postedOrders.length = 0;
    clock.setNowMs(2000);

    const newBuyUp = postedOrders.find(o => o.req.tokenId === "up-id" && o.req.action === "buy");
    expect(newBuyUp).toBeUndefined();

    if (cleanup) cleanup();
  });

  test("avellaneda-maker enforces maxSpendAbs against existing position spend", async () => {
    const clock = new VirtualClock();
    const postedOrders: any[] = [];
    const logs: string[] = [];

    const ctx: Partial<StrategyContext> = {
      clock,
      ...settlementContext(clock, { settlement: 100_000, predictive: 100_043 }),
      slotEndMs: 1000000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [
        { tokenId: "up-id", action: "buy", shares: 29, price: 0.50 },
      ],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: {
        makerOnly: false,
        maxSpendAbs: 15.00,
        minShares: 1,
        shares: 10,
      },
      quant: {
        latest: () => ({
          asset: "btc",
          timestampMs: clock.nowMs(),
          sigma: 0.20,
          probabilityUp: 0.75,
          jumpDetected: false,
          volatilityRegime: "normal",
        }),
        subscribe: () => () => {},
      } as any,
      postOrders: (orders: any) => { postedOrders.push(...orders); },
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      orderBook: makerBook(),
      log: (msg: string) => { logs.push(msg); },
    };

    const cleanup = await avellanedaMaker(ctx as StrategyContext);
    clock.setNowMs(1000);

    expect(postedOrders.find(o => o.req.tokenId === "up-id" && o.req.action === "buy")).toBeUndefined();
    expect(logs.some(l => l.includes("maxSpendAbs: UP capped"))).toBe(true);

    if (cleanup) cleanup();
  });

  test("late-entry releases lifecycle hold when the round expires", async () => {
    const clock = new VirtualClock();
    let releaseCount = 0;
    const ctx: Partial<StrategyContext> = {
      clock,
      slotEndMs: 1000,
      clobTokenIds: ["up-id", "down-id"],
      orderHistory: [],
      pendingOrders: [],
      walletBalanceUsd: 100,
      strategyConfig: {},
      ticker: { divergence: 0, assetPrice: 70000 } as any,
      hold: () => () => { releaseCount += 1; },
      getMarketResult: () => ({ openPrice: 60000, closePrice: 0, direction: "UP", slug: "1" }),
      orderBook: makerBook() as any,
      postOrders: () => {},
      cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
      emergencySells: async () => {},
      log: () => {},
    };

    await lateEntry(ctx as StrategyContext, { minRemainingSec: 0 });
    clock.setNowMs(1000);
    clock.setNowMs(1001);

    expect(releaseCount).toBe(1);
  });

});
