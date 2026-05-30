import { describe, expect, test } from "bun:test";
import { MarketLifecycle } from "../../engine/market-lifecycle.ts";
import { APIQueue } from "../../tracker/api-queue.ts";
import { WalletTracker } from "../../engine/wallet-tracker.ts";
import { TickerTracker } from "../../tracker/ticker";
import type { EarlyBirdClient, PlacedOrder } from "../../engine/client.ts";
import type { UserChannel } from "../../engine/user-channel.ts";
import type {
  LeadLagMonitor,
  LeadLagSnapshot,
  PredictiveAggregateSnapshot,
  PredictiveSignalAggregator,
  ResolutionSourceAdapter,
  ResolutionPriceEvent,
  RoundWindow,
} from "../../engine/bot-core/data-sources.ts";
import { createEventClock } from "../../engine/bot-core/data-sources.ts";

function aggregate(disagreement: boolean): PredictiveAggregateSnapshot {
  return {
    asset: "btc",
    timestampMs: Date.now(),
    price: 100_000,
    settlementAnchor: {
      price: 99_950,
      roundId: "1",
      updatedAtMs: Date.now(),
      localReceivedAtMs: Date.now(),
      lagMs: 50,
      isStale: false,
      quality: "live",
      source: "chainlink-polygon-btc-usd",
      sourceType: "chainlink_polygon",
    },
    predictiveTape: {
      compositePrice: 100_000,
      feeds: {},
      divergenceAbs: disagreement ? 100 : 5,
      divergencePct: disagreement ? 0.1 : 0.005,
      disagreement,
    },
    marketPrice: {
      yesBestBid: 0.48,
      yesBestAsk: 0.49,
      yesMidpoint: 0.485,
      noBestBid: 0.5,
      noBestAsk: 0.51,
      noMidpoint: 0.505,
      yesSpread: 0.01,
      noSpread: 0.01,
      executable: true,
      source: "polymarket-clob",
    },
    feeds: {
      binance: {
        price: 100_000,
        quality: "live",
        latestEventAgeMs: 100,
        arrivalDelayMs: 20,
      },
      coinbase: {
        price: disagreement ? 100_100 : 100_005,
        quality: "live",
        latestEventAgeMs: 100,
        arrivalDelayMs: 25,
      },
    },
    divergenceAbs: disagreement ? 100 : 5,
    divergencePct: disagreement ? 0.1 : 0.005,
    disagreement,
  };
}

function leadLag(): LeadLagSnapshot {
  return {
    asset: "btc",
    timestampMs: Date.now(),
    feeds: {},
    observedTimingLeader: null,
    observedTimingRunnerUp: null,
    averageDelaySpreadMs: null,
    leadershipConfidence: "none",
    sufficientSamples: false,
  };
}

function makeAggregator(disagreement: boolean): PredictiveSignalAggregator {
  return {
    latest: () => aggregate(disagreement),
    subscribe: () => () => {},
  };
}

const mockLeadLag: LeadLagMonitor = {
  latest: leadLag,
  subscribe: () => () => {},
};

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

function makeResolution(slug: string): ResolutionSourceAdapter {
  const latest = (): ResolutionPriceEvent => {
    const nowMs = Date.now();
    return {
      id: `resolution-${nowMs}`,
      role: "resolution",
      source: "test-resolution",
      sourceType: "chainlink_polygon",
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
      round: makeRound(slug),
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

function makeUserChannel(): UserChannel {
  return {
    subscribe: () => {},
    isReady: () => true,
    waitForReady: async () => {},
    trackOrder: () => {},
    untrackOrder: () => {},
    getMatchedSoFar: () => 0,
    isMatched: () => false,
    destroy: () => {},
  };
}

function makeClient(onPost: () => void): EarlyBirdClient {
  return {
    init: async () => {},
    postMultipleOrders: async (): Promise<PlacedOrder[]> => {
      onPost();
      return [
        {
          orderId: "order-1",
          status: "live",
          success: true,
          errorMsg: "",
        },
      ];
    },
    getOpenOrderIds: async () => new Set(),
    getOrderById: async () => null,
    cancelOrder: async () => {},
    cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
    restoreOrder: () => {},
    getUSDCBalance: async () => 50,
    getAvailableShares: async () => 0,
    updateUSDCBalance: async () => {},
    updateAvailableShares: async () => {},
    redeemPositions: async () => {},
    wrapUSDC: async () => {},
    unwrapUSDC: async () => {},
    getTokenBalance: async () => 0n,
  };
}

async function exerciseLifecycle(opts: {
  disagreement?: boolean;
  seedOpenExposureUsd?: number;
  missingResolution?: boolean;
  feedReadinessTimeoutMs?: number;
} = {}) {
  const disagreement = opts.disagreement ?? false;
  let postCount = 0;
  let failedReason: string | null = null;
  let strategyInvoked = false;
  const logs: string[] = [];
  const slug = `btc-updown-5m-${Math.floor(Date.now() / 1000) + 600}`;

  const lifecycle = new MarketLifecycle({
    slug,
    apiQueue: new APIQueue(),
    client: makeClient(() => postCount++),
    log: (msg) => {
      logs.push(msg);
    },
    strategyName: "risk-integration-test",
    strategy: async (ctx) => {
      strategyInvoked = true;
      ctx.postOrders([
        {
          req: {
            tokenId: "up",
            action: "buy",
            price: 0.49,
            shares: 5,
          },
          expireAtMs: ctx.slotEndMs,
          onFailed: (reason) => {
            failedReason = reason;
          },
        },
      ]);
    },
    tracker: new WalletTracker(50, () => {}),
    ticker: new TickerTracker(),
    userChannel: makeUserChannel(),
    orderBook: makeOrderBook() as any,
    resolution: opts.missingResolution ? undefined : makeResolution(slug),
    aggregator: makeAggregator(disagreement),
    leadLag: mockLeadLag,
    feedReadinessTimeoutMs: opts.feedReadinessTimeoutMs,
    feedReadinessPollMs: 1,
  });

  (lifecycle as any)._clobTokenIds = ["up", "down"];
  (lifecycle as any)._conditionId = "cond";
  if (opts.seedOpenExposureUsd !== undefined) {
    (lifecycle as any)._pendingOrders = [
      {
        orderId: "existing-buy",
        tokenId: "up",
        action: "buy",
        price: opts.seedOpenExposureUsd,
        shares: 1,
        expireAtMs: Date.now() + 60_000,
        placedAtMs: Date.now(),
      },
    ];
  }

  await lifecycle.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  lifecycle.destroy();

  return {
    postCount,
    failedReason: failedReason as string | null,
    strategyInvoked,
    state: lifecycle.state,
    logs,
  };
}

describe("MarketLifecycle aggregated risk hook", () => {
  test("allows the real order path under healthy predictive conditions", async () => {
    const result = await exerciseLifecycle();

    expect(result.postCount).toBe(1);
    expect(result.failedReason).toBeNull();
    expect(result.strategyInvoked).toBe(true);
  });

  test("blocks the real order path when aggregate disagreement is true", async () => {
    const result = await exerciseLifecycle({ disagreement: true });

    expect(result.postCount).toBe(0);
    expect(result.failedReason).toBe("predictive aggregate disagreement is true");
    expect(result.strategyInvoked).toBe(true);
  });

  test("blocks the real order path when open exposure would exceed the limit", async () => {
    const result = await exerciseLifecycle({ seedOpenExposureUsd: 49 });

    expect(result.postCount).toBe(0);
    expect(result.failedReason).toBe(
      "open exposure would exceed max exposure limit",
    );
    expect(result.strategyInvoked).toBe(true);
  });

  test("skips strategy execution when required feeds never become ready", async () => {
    const result = await exerciseLifecycle({
      missingResolution: true,
      feedReadinessTimeoutMs: 0,
    });

    expect(result.postCount).toBe(0);
    expect(result.failedReason).toBeNull();
    expect(result.strategyInvoked).toBe(false);
    expect(result.state).toBe("DONE");
    expect(result.logs.some((msg) => msg.includes("Required feeds not ready"))).toBe(
      true,
    );
  });
});
