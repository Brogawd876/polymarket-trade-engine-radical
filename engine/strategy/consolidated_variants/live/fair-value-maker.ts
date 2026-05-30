import type { Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";
import { digitalCallProbability } from "../../utils/math.ts";

export interface FairValueMakerConfig {
  shares?: number;
  /** Fixed profit margin buffer (e.g. 0.01 = 1 cent) */
  margin?: number;
  /** Inventory skew factor. Higher values make the bot more aggressive at offloading inventory. */
  inventorySkew?: number;
  /** Maximum inventory (in shares) allowed for one side. */
  maxInventory?: number;
  /** Minimum probability edge required to place any order. */
  minEdge?: number;
  /** Estimated maker rebate per share, expressed as probability/USDC cents. */
  makerRebateEstimate?: number;
  /** Pull or avoid quotes when same-side imbalance is below this threshold. */
  minImbalance?: number;
  /** Pull or avoid quotes when same-side 10s CVD is below this USD threshold. */
  minCvd10s?: number;
}

const DEFAULT_CONFIG: Required<FairValueMakerConfig> = {
  shares: 10,
  margin: 0.01,
  inventorySkew: 0.05, // Skew price by 5% of fair value per maxInventory unit
  maxInventory: 100,
  minEdge: 0.005,
  makerRebateEstimate: 0,
  minImbalance: -1,
  minCvd10s: Number.NEGATIVE_INFINITY,
};

/**
 * Fair Value Maker Strategy
 * 
 * Implements the "Market Maker" approach from the research paper:
 * 1. Calculates fair value probability via Black-Scholes digital option model.
 * 2. Places resting limit orders (Maker) to capture rebates and avoid taker fees.
 * 3. skews quotes based on current inventory to manage risk.
 */
export const fairValueMaker: Strategy = async (ctx) => {
  const config = { ...DEFAULT_CONFIG, ...(ctx.strategyConfig as FairValueMakerConfig) };
  
  const releaseLock = ctx.hold?.() ?? (() => {});

  const tickInterval = ctx.clock.setInterval(() => {
    const quant = ctx.quant?.latest();
    const sigma = quant?.sigma;
    const fairValue = calculateSettlementAnchoredFairValue(ctx, sigma);
    const probUp = fairValue.probabilityUp;
    
    const remainingSecs = (ctx.slotEndMs - ctx.clock.nowMs()) / 1000;
    
    if (remainingSecs <= 0) {
        ctx.clock.clearInterval(tickInterval);
        releaseLock();
        return;
    }
    if (probUp === null || probUp === undefined || sigma === null || sigma === undefined) {
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      if (fairValue.noTradeReason) {
        ctx.log(`[fair-value] No quote: ${fairValue.noTradeReason}`, "dim");
      }
      return;
    }
    const remFloor = Math.floor(remainingSecs);
    if (remFloor % 30 === 0 && ctx.clock.nowMs() % 1000 === 0) {
      ctx.log(`[fair-value] P(UP)=${probUp.toFixed(4)} Sigma=${sigma.toFixed(4)} settlement=${fairValue.settlementAnchorPrice?.toFixed(2) ?? "n/a"} predictive=${fairValue.predictiveCompositePrice?.toFixed(2) ?? "n/a"} Rem=${remFloor}s`, "dim");
    }
    if (remainingSecs < 10) {
      // Too close to expiry, stop quoting to avoid getting picked off
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      return;
    }

    // 1. Determine current inventory
    const upTokenId = ctx.clobTokenIds[0];
    const downTokenId = ctx.clobTokenIds[1];
    
    let inventoryUp = 0;
    for (const h of ctx.orderHistory) {
      if (h.tokenId === upTokenId) {
        inventoryUp += (h.action === "buy" ? h.shares : -h.shares);
      }
    }
    
    // 2. Calculate Avellaneda-style reservation probability.
    // Inventory pushes quotes away from the side we already hold; volatility and
    // time-to-expiry widen the required margin rather than pretending alpha is larger.
    const timeFraction = Math.max(0, Math.min(1, remainingSecs / 300));
    const inventoryRatio = inventoryUp / config.maxInventory;
    const skew = inventoryRatio * config.inventorySkew * Math.max(0.25, timeFraction);
    const adjustedProbUp = Math.max(0.01, Math.min(0.99, probUp - skew));
    const volatilityBuffer = Math.min(0.05, Math.max(0, sigma) * Math.sqrt(Math.max(remainingSecs, 1) / 31_536_000) * 2);
    const quoteMargin = config.margin + volatilityBuffer;

    // 3. Define Quotes
    // We want to buy UP at adjustedProbUp - margin
    // We want to buy DOWN at (1 - adjustedProbUp) - margin
    const bidPriceUp = parseFloat((adjustedProbUp - quoteMargin).toFixed(2));
    const bidPriceDown = parseFloat(((1 - adjustedProbUp) - quoteMargin).toFixed(2));

    // 4. Update Orders
    const existingUp = ctx.pendingOrders.find(o => o.tokenId === upTokenId && o.action === "buy");
    const existingDown = ctx.pendingOrders.find(o => o.tokenId === downTokenId && o.action === "buy");

    const ordersToPost = [];

    // Use a 1-cent tolerance to avoid churn
    const TOLERANCE = 0.01;
    const EPSILON = 0.0001;

    const feeRateUp = feeRate(ctx, upTokenId);
    const feeRateDown = feeRate(ctx, downTokenId);
    const evUp = quoteEv(adjustedProbUp, bidPriceUp, feeRateUp, config.makerRebateEstimate);
    const evDown = quoteEv(1 - adjustedProbUp, bidPriceDown, feeRateDown, config.makerRebateEstimate);
    const flow = ctx.orderFlow?.latest() ?? null;
    const allowUpFlow = flowAllowsSide(flow, "UP", config, ctx);
    const allowDownFlow = flowAllowsSide(flow, "DOWN", config, ctx);

    if (bidPriceUp > 0.01 && bidPriceUp < 0.99 && evUp.edge >= config.minEdge && allowUpFlow) {
      if (!existingUp || Math.abs(existingUp.price - bidPriceUp) > (TOLERANCE + EPSILON)) {
        if (existingUp) {
          ctx.log(`[fair-value] Replacing UP quote: ${existingUp.price} -> ${bidPriceUp} (P=${probUp.toFixed(3)})`, "dim");
          ctx.cancelOrders([existingUp.orderId]);
        }
        if (inventoryUp < config.maxInventory) {
          ordersToPost.push({
            req: {
              tokenId: upTokenId,
              action: "buy" as const,
              price: bidPriceUp,
              shares: config.shares,
              orderType: "GTC" as const
            },
            expireAtMs: ctx.clock.nowMs() + 10000
          });
        }
      }
    } else if (existingUp) {
      ctx.cancelOrders([existingUp.orderId]);
    }

    if (bidPriceDown > 0.01 && bidPriceDown < 0.99 && evDown.edge >= config.minEdge && allowDownFlow) {
      if (!existingDown || Math.abs(existingDown.price - bidPriceDown) > (TOLERANCE + EPSILON)) {
        if (existingDown) {
          ctx.log(`[fair-value] Replacing DOWN quote: ${existingDown.price} -> ${bidPriceDown}`, "dim");
          ctx.cancelOrders([existingDown.orderId]);
        }
        if (inventoryUp > -config.maxInventory) {
          ordersToPost.push({
            req: {
              tokenId: downTokenId,
              action: "buy" as const,
              price: bidPriceDown,
              shares: config.shares,
              orderType: "GTC" as const
            },
            expireAtMs: ctx.clock.nowMs() + 10000
          });
        }
      }
    } else if (existingDown) {
      ctx.cancelOrders([existingDown.orderId]);
    }
    if (ordersToPost.length > 0) {
      ctx.log(`[fair-value] Posting ${ordersToPost.length} orders. Bids: UP=${bidPriceUp} (EV=${evUp.edge.toFixed(4)}) DOWN=${bidPriceDown} (EV=${evDown.edge.toFixed(4)}) settlementAnchor=${fairValue.settlementAnchorPrice?.toFixed(2) ?? "n/a"} predictiveComposite=${fairValue.predictiveCompositePrice?.toFixed(2) ?? "n/a"}`, "cyan");
      ctx.postOrders(ordersToPost);
    }

  }, 1000); // 1s quote refresh

  return () => ctx.clock.clearInterval(tickInterval);
};

export function calculateSettlementAnchoredFairValue(
  ctx: StrategyContext,
  sigma: number | null | undefined,
): {
  probabilityUp: number | null;
  settlementAnchorPrice: number | null;
  predictiveCompositePrice: number | null;
  noTradeReason: string | null;
} {
  const resolution = ctx.resolution?.latest() ?? null;
  const anchor = ctx.resolution?.latestAnchor() ?? null;

  if (!anchor) {
    return {
      probabilityUp: null,
      settlementAnchorPrice: null,
      predictiveCompositePrice: null,
      noTradeReason: "missing Chainlink settlement anchor",
    };
  }
  const chainlinkHealthStale =
    !resolution ||
    resolution.quality !== "live" ||
    resolution.stalenessStatus === "stale" ||
    resolution.stalenessStatus === "missing" ||
    resolution.stalenessStatus === "degraded";
  if (chainlinkHealthStale) {
    return {
      probabilityUp: null,
      settlementAnchorPrice: anchor.priceToBeat ?? anchor.price,
      predictiveCompositePrice: ctx.predictive?.aggregate?.latest().predictiveTape.compositePrice ?? ctx.predictive?.aggregate?.latest().price ?? null,
      noTradeReason: "Chainlink resolution feed is stale or degraded",
    };
  }
  if (sigma === null || sigma === undefined) {
    return {
      probabilityUp: null,
      settlementAnchorPrice: anchor.priceToBeat ?? anchor.price,
      predictiveCompositePrice: ctx.predictive?.aggregate?.latest().predictiveTape.compositePrice ?? ctx.predictive?.aggregate?.latest().price ?? null,
      noTradeReason: "missing volatility estimate",
    };
  }

  const aggregate = ctx.predictive?.aggregate?.latest() ?? null;
  const predictiveCompositePrice =
    aggregate?.predictiveTape.compositePrice ?? aggregate?.price ?? null;
  if (predictiveCompositePrice === null) {
    return {
      probabilityUp: null,
      settlementAnchorPrice: anchor.priceToBeat ?? anchor.price,
      predictiveCompositePrice: null,
      noTradeReason: "missing predictive composite price",
    };
  }

  const settlementAnchorPrice = anchor.priceToBeat ?? anchor.price;
  const remainingMs = ctx.slotEndMs - ctx.clock.nowMs();
  if (remainingMs <= 0) {
    return {
      probabilityUp: predictiveCompositePrice >= settlementAnchorPrice ? 1 : 0,
      settlementAnchorPrice,
      predictiveCompositePrice,
      noTradeReason: null,
    };
  }
  const yearsToExpiry = remainingMs / (1000 * 3600 * 24 * 365);
  return {
    probabilityUp: digitalCallProbability(
      predictiveCompositePrice,
      settlementAnchorPrice,
      yearsToExpiry,
      sigma,
    ),
    settlementAnchorPrice,
    predictiveCompositePrice,
    noTradeReason: null,
  };
}

function feeRate(ctx: StrategyContext, tokenId: string): number {
  const raw = (ctx.orderBook as unknown as { getFeeRate?: (assetId: string) => number } | undefined)?.getFeeRate?.(tokenId) ?? 0;
  return raw > 1 ? raw / 10_000 : raw;
}

function quoteEv(probability: number, price: number, feeRate: number, makerRebateEstimate: number) {
  const takerFee = 0;
  const feeReference = feeRate * price * (1 - price);
  return {
    edge: probability - price - takerFee + makerRebateEstimate,
    feeReference,
  };
}

function flowAllowsSide(
  flow: ReturnType<NonNullable<StrategyContext["orderFlow"]>["latest"]> | null,
  side: "UP" | "DOWN",
  config: Required<FairValueMakerConfig>,
  ctx: StrategyContext,
): boolean {
  if (!flow) return true;

  const isProd = Env.get("PROD");
  // Down-weight or ignore public inferred flow in production
  if (isProd && flow.source === "public_inferred" && flow.confidence === "low") {
    return true; // Don't block based on low-confidence noise
  }

  const imbalance = side === "UP" ? flow.imbalanceUp : flow.imbalanceDown;
  if (imbalance !== null && imbalance < config.minImbalance) return false;
  const cvd = side === "UP"
    ? flow.cvd10s.up - flow.cvd10s.down
    : flow.cvd10s.down - flow.cvd10s.up;
  return cvd >= config.minCvd10s;
}
