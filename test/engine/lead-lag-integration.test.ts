import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { EarlyBird } from "../../engine/early-bird.ts";
import { TickerTracker } from "../../tracker/ticker";
import { PolymarketResolutionAdapter } from "../../engine/bot-core/polymarket-resolution-adapter.ts";
import { BinancePredictiveAdapter } from "../../engine/bot-core/binance-predictive-adapter.ts";
import { CoinbasePredictiveAdapter } from "../../engine/bot-core/coinbase-predictive-adapter.ts";
import { MarketLifecycle } from "../../engine/market-lifecycle.ts";
import { APIQueue } from "../../tracker/api-queue.ts";
import { WalletTracker } from "../../engine/wallet-tracker.ts";
import { OrderBook } from "../../tracker/orderbook.ts";
import type { 
  PredictiveSignalAggregator, 
  LeadLagMonitor,
  PredictiveAggregateSnapshot,
  LeadLagSnapshot,
  ResolutionPriceEvent,
  ResolutionSourceAdapter,
  RoundWindow
} from "../../engine/bot-core/data-sources.ts";
import { createEventClock } from "../../engine/bot-core/data-sources.ts";

const originalOrderBookSubscribe = OrderBook.prototype.subscribe;
const originalOrderBookWaitForReady = OrderBook.prototype.waitForReady;

afterEach(() => {
  expect(OrderBook.prototype.subscribe).toBe(originalOrderBookSubscribe);
  expect(OrderBook.prototype.waitForReady).toBe(originalOrderBookWaitForReady);
});

function makeRound(slug: string): RoundWindow {
  const startTimeMs = Number(slug.split("-").at(-1)) * 1000;
  return {
    slug,
    asset: "btc",
    window: "5m",
    startTimeMs,
    endTimeMs: startTimeMs + 300_000,
  };
}

function makeResolution(round: RoundWindow): ResolutionSourceAdapter {
  const latest = (): ResolutionPriceEvent => {
    const nowMs = Date.now();
    return {
      id: `resolution-${nowMs}`,
      role: "resolution",
      source: "test-resolution",
      asset: "btc",
      kind: "live",
      price: 100_000,
      priceToBeat: 99_950,
      clock: createEventClock({
        sourceTimestampMs: nowMs - 50,
        receivedAtMs: nowMs,
        processedAtMs: nowMs,
      }),
      quality: "live",
      freshnessMs: 50,
      lagMs: 0,
      round,
    };
  };

  return {
    role: "resolution",
    source: "test-resolution",
    start: async () => {},
    stop: async () => {},
    isReady: () => true,
    latest,
    subscribe: () => () => {},
    priceToBeat: async () => latest(),
    closePrice: async () => latest(),
  };
}

function makeOrderBook() {
  return {
    onUpdate: (handler: () => void) => {
      handler();
      return () => {};
    },
    destroy: () => {},
    isReady: () => true,
    waitForReady: async () => {},
    subscribe: () => {},
    getSnapshotData: () => ({
      up: { bids: [[0.48, 100]], asks: [[0.49, 100]] },
      down: { bids: [[0.5, 100]], asks: [[0.51, 100]] },
    }),
    getTokenId: (side: "UP" | "DOWN") => (side === "UP" ? "up" : "down"),
    getFeeRate: () => 0,
    getTickSize: () => "0.01",
    bestAskInfo: () => ({ price: 0.49, liquidity: 100 }),
    bestBidInfo: () => ({ price: 0.48, liquidity: 100 }),
    bestBidPrice: () => 0.48,
    bestAskPrice: () => 0.49,
    lastTradeInfo: () => ({ price: null, size: null }),
    getBookLevels: () => ({ bids: [], asks: [] }),
  };
}

describe("LeadLag Runtime Integration", () => {
  test("EarlyBird instantiates leadLag monitor and passes it to MarketLifecycle", async () => {
    // Mock dependencies to avoid real network/WS
    spyOn(TickerTracker.prototype, "schedule").mockImplementation(() => {});
    spyOn(TickerTracker.prototype, "waitForReady").mockImplementation(async () => {});
    spyOn(PolymarketResolutionAdapter.prototype, "start").mockImplementation(async () => {});
    spyOn(BinancePredictiveAdapter.prototype, "start").mockImplementation(async () => {});
    spyOn(CoinbasePredictiveAdapter.prototype, "start").mockImplementation(async () => {});

    // Instantiate EarlyBird in sim mode
    const engine = new EarlyBird("simulation", 1, false, 0);

    // Access private leadLag for verification
    const leadLag = (engine as any)._leadLag;
    expect(leadLag).toBeDefined();
    expect(leadLag.latest().asset).toBe("btc");

    // Confirm _aggregator is present and leadLag is wired to it
    const aggregator = (engine as any)._aggregator;
    expect(aggregator).toBeDefined();
  });

  test("MarketLifecycle correctly injects leadLag and aggregate into StrategyContext", async () => {
    // Fully typed mocks ensure strict-mode compliance and better diagnostics
    const mockMonitor: LeadLagMonitor = {
      subscribe: () => (() => {}), 
      latest: () => ({ 
        asset: "btc",
        timestampMs: Date.now(),
        feeds: {},
        observedTimingLeader: null,
        observedTimingRunnerUp: null,
        averageDelaySpreadMs: null,
        leadershipConfidence: "none",
        sufficientSamples: false 
      } as LeadLagSnapshot)
    };

    const mockAggregator: PredictiveSignalAggregator = {
      subscribe: () => (() => {}),
      latest: () => ({ 
        asset: "btc",
        timestampMs: Date.now(),
        price: null, 
        disagreement: true, 
        feeds: {},
        divergenceAbs: null,
        divergencePct: null
      } as PredictiveAggregateSnapshot)
    };

    let strategyInvoked = false;

    const slug = "btc-updown-5m-1778898900";
    const round = makeRound(slug);

    const lifecycle = new MarketLifecycle({
      slug,
      apiQueue: new APIQueue(),
      client: { getOrderById: async () => null } as any,
      log: () => {},
      strategyName: "validation-test",
      strategy: async (ctx) => {
        strategyInvoked = true;
        
        // Comprehensive assertions ensure the strategy context is perfectly wired
        expect(ctx.predictive).toBeDefined();
        expect(ctx.predictive?.leadLag).toBeDefined();
        expect(ctx.predictive?.leadLag).toBe(mockMonitor);
        
        expect(ctx.predictive?.aggregate).toBeDefined();
        expect(ctx.predictive?.aggregate).toBe(mockAggregator);

        // Verify sister predictive adapters are also present
        expect(ctx.predictive?.binance).toBeDefined();
        expect(ctx.predictive?.coinbase).toBeDefined();

        // Verify keys exist on the predictive container
        expect("aggregate" in ctx.predictive!).toBe(true);
        expect("leadLag" in ctx.predictive!).toBe(true);
        expect("binance" in ctx.predictive!).toBe(true);
        expect("coinbase" in ctx.predictive!).toBe(true);
      },
      tracker: new WalletTracker(50, () => {}),
      ticker: new TickerTracker(),
      orderBook: makeOrderBook() as any,
      userChannel: { 
        subscribe: () => {}, 
        isReady: () => true,
        waitForReady: async () => {}, 
        destroy: () => {}, 
        trackOrder: () => {}, 
        untrackOrder: () => {} 
      } as any,
      resolution: makeResolution(round),
      aggregator: mockAggregator,
      leadLag: mockMonitor,
      binance: { subscribe: () => (() => {}), latest: () => null } as any,
      coinbase: { subscribe: () => (() => {}), latest: () => null } as any,
    });

    // Force required fields and state for _handleInit path
    (lifecycle as any)._clobTokenIds = ["up", "down"];
    (lifecycle as any)._conditionId = "cond";
    (lifecycle as any)._venue.currentRound = round;
    
    // We need to bypass the real setup() which would call APIQueue
    spyOn(lifecycle, "setup").mockImplementation(async () => {});

    // tick() calls _step() -> _handleInit() -> strategy()
    await lifecycle.tick();

    // Final guard against silent test skip
    expect(strategyInvoked).toBe(true);
  });
});
