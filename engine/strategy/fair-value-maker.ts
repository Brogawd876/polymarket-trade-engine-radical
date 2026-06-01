import type { OrderRequest, Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";
import { digitalCallProbability } from "../../utils/math.ts";
import { predictIsotonicProbability } from "../replay/isotonic-calibration.ts";

export interface FairValueMakerConfig {
  /** If true, bypasses 'Quote Hygiene' (early aborts on disagreement and price bounding). Use for backtesting only. */
  skipHygiene?: boolean;
  /** Position sizing mode. Defaults to 'fixed'. */
  sharesMode?: "fixed" | "pct_of_balance";
  /** Percentage of current wallet balance to use per trade if sharesMode is 'pct_of_balance'. (e.g. 0.10 for 10%) */
  sharePct?: number;
  shares?: number;
  /** Minimum order size accepted by the venue for buy quotes. */
  minShares?: number;
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
  /** Subtract Polymarket fees from quoted edge. Defaults to true for live EV correctness. */
  feeAwareEdge?: boolean;
  /** Pull or avoid quotes when same-side imbalance is below this threshold. */
  minImbalance?: number;
  /** Pull or avoid quotes when same-side 10s CVD is below this USD threshold. */
  minCvd10s?: number;
  /** Never submit a quote that would cross the current top of book. */
  makerOnly?: boolean;
  /** Pull quotes during jump regimes. */
  blockOnJump?: boolean;
  /** Pull quotes above this annualized sigma. */
  maxSigma?: number;
  /** Widen quotes during high-vol regimes instead of crossing into taker flow. */
  highVolExtraMargin?: number;
  /** Do not emit maker BUY bids above this price until calibration proves they are safe. */
  maxMakerBidPrice?: number;
  /** Suppress repeated identical exposure-limit rejections for this long. */
  exposureBlockCooldownMs?: number;

  // ── v1.3.0 Profit-Selective Controls ────────────────────────────────────────
  /**
   * Scale share size linearly with edge quality.
   * Ratio = clamp(edge / minEdge, 0.5, 2.0). Fat edge → larger size; thin edge → smaller.
   */
  edgeWeightedSizing?: boolean;
  /**
   * Scale share size down when market regime is unfavourable:
   * - High sigma (> 1.0): multiply by 1/sigma (capped 0.5..1.0)
   * - Unstable basis (abs(composite - anchor) > unstableBasisThreshold): multiply by 0.5
   */
  regimeWeightedSizing?: boolean;
  /**
   * Block new BUY orders on a side after N consecutive fills where the mid-price
   * at fill time was lower than the fill price (adverse momentum signal).
   * Block persists for the remainder of the round.
   */
  fallingKnifeBlock?: boolean;
  /** Number of consecutive adverse fills required to trigger the falling-knife block. Default: 3. */
  fallingKnifeWindow?: number;
  /**
   * Halve target share size when the predictive composite price diverges from the
   * settlement anchor by more than `unstableBasisThreshold` USD.
   * Applied independently of regimeWeightedSizing.
   */
  unstableBasisDownsize?: boolean;
  /** Threshold (USD) at which the basis is considered unstable. Default: 5.0. */
  unstableBasisThreshold?: number;

  // ── v1.4.0 Take-Profit Controls ──────────────────────────────────────────────
  /**
   * Enable mid-round take-profit sell.
   * When the best BID on a held side reaches `takeProfitThreshold`, the bot
   * immediately posts a maker SELL order for all inventory on that side.
   *
   * Implements the Avellaneda-Stoikov (2008) reservation-price exit:
   * once mark-to-market value approaches the maximum payout ($1.00), the
   * marginal gain from holding is less than the reversal risk, so the
   * rational action is to exit.
   *
   * Default: false (backward-compatible — all existing variants unaffected).
   */
  takeProfitEnabled?: boolean;
  /**
   * Sell all inventory on a side when the market best BID for that side
   * reaches this threshold.
   *
   * Mathematical basis: a binary contract pays $1.00 at settlement.
   * If the market will pay us $0.97 now, we capture 97% of max payout
   * while eliminating all remaining settlement risk. Remaining upside
   * ($0.03) is negligible vs. downside risk of a BTC reversal.
   *
   * Range: 0.90–0.99. Default: 0.97.
   */
  takeProfitThreshold?: number;

  // ── v2.0.0 Toxicity & Jump Filters ─────────────────────────────────────────────
  /**
   * Enable toxic flow cancellation & volatility jump filter.
   */
  toxicJumpEnabled?: boolean;
  /**
   * The absolute USD change in the predictive composite price within a 1-second window
   * that triggers a toxic jump alert. (e.g. 50 or 100).
   */
  toxicJumpThresholdAbs?: number;
  /**
   * How long to block all new quotes after a jump is detected (in milliseconds).
   * Default: 10000ms (10 seconds).
   */
  toxicJumpCooldownMs?: number;

  // ── v2.1.0 Advanced Exits (Scale-Out & Trailing Stop) ────────────────────────
  /** Enable advanced exits. */
  advancedExitsEnabled?: boolean;
  /** Absolute profit margin (in USD cents) above VWAP to trigger a partial scale-out. */
  scaleOutProfitMargin?: number;
  /** Percentage of current inventory to sell in the partial scale-out (e.g. 0.50). */
  scaleOutInventoryPct?: number;
  /** Minimum unrealized profit (in USD cents) before the trailing stop arms. */
  trailingStopActivationMargin?: number;
  /** Drawdown from the high-water mark (in USD cents) that triggers the trailing stop exit. */
  trailingStopDrawdownMargin?: number;
  /** Order type to use for the trailing stop: "maker", "taker", or "hybrid". */
  trailingStopOrderType?: "maker" | "taker" | "hybrid";
  
  // ── v2.1.1 Safeguards ──────────────────────────────────────────────────────────
  /** Maximum absolute USD to spend on a single position, regardless of sharePct. */
  maxSpendAbs?: number;

  // ── v3.0.0 Momentum-Confirmed Dynamic Sizing ────────────────────────────────
  /**
   * Enable momentum-confirmed dynamic sizing.
   * Reads the velocity of the predictive composite price (Binance/Coinbase)
   * over a rolling window and scales sharePct accordingly:
   * - Strong confirming momentum → scale up to momentumMaxPct
   * - Contradicting momentum → scale down to momentumMinPct
   * - Neutral / no data → use base sharePct unchanged
   *
   * This NEVER changes entry gates. It only amplifies or dampens bet size
   * after the gate has already approved the trade.
   */
  momentumSizingEnabled?: boolean;
  /** Rolling window (ms) over which to measure price velocity. Default: 5000 (5s). */
  momentumWindowMs?: number;
  /** Velocity threshold ($/sec) below which momentum is considered neutral. Default: 2.0 */
  momentumNeutralThreshold?: number;
  /** Maximum sharePct when momentum strongly confirms. Default: 0.25 (25%) */
  momentumMaxPct?: number;
  /** Minimum sharePct when momentum contradicts. Default: 0.05 (5%) */
  momentumMinPct?: number;

  // ── v3.6.0 Calibration Support ─────────────────────────────────────────────
  /**
   * Isotonic calibration model. When provided, the raw Black-Scholes
   * probability is mapped through this model before being used for
   * edge calculation, inventory skew, and quote placement.
   */
  calibrationModel?: {
    buckets: Array<{ lowerScore: number; upperScore: number; calibratedRate: number; count: number; positiveCount: number; empiricalRate: number }>;
    sampleCount: number;
    positiveLabelRate: number;
  };
}

const DEFAULT_CONFIG: Required<FairValueMakerConfig> = {
  skipHygiene: false,
  sharesMode: "pct_of_balance",
  sharePct: 0.10,
  shares: 10,
  minShares: 5,
  maxSpendAbs: 15.00,
  margin: 0.01,
  inventorySkew: 0.05,
  maxInventory: 100,
  minEdge: 0.005,
  makerRebateEstimate: 0,
  feeAwareEdge: true,
  minImbalance: -0.5,
  minCvd10s: -100,
  makerOnly: true,
  blockOnJump: true,
  maxSigma: 1.5,
  highVolExtraMargin: 0.02,
  maxMakerBidPrice: 0.89,
  exposureBlockCooldownMs: 10_000,
  edgeWeightedSizing: true,
  regimeWeightedSizing: true,
  fallingKnifeBlock: false,
  fallingKnifeWindow: 3,
  unstableBasisDownsize: false,
  unstableBasisThreshold: 5.0,
  takeProfitEnabled: false,
  takeProfitThreshold: 0.97,
  toxicJumpEnabled: false,
  toxicJumpThresholdAbs: 50.0,
  toxicJumpCooldownMs: 10_000,
  advancedExitsEnabled: false,
  scaleOutProfitMargin: 0.10,
  scaleOutInventoryPct: 0.50,
  trailingStopActivationMargin: 0.15,
  trailingStopDrawdownMargin: 0.05,
  trailingStopOrderType: "hybrid",
  // v3.0.0 Momentum-Confirmed Dynamic Sizing defaults
  momentumSizingEnabled: false,
  momentumWindowMs: 5_000,
  momentumNeutralThreshold: 2.0,
  momentumMaxPct: 0.25,
  momentumMinPct: 0.05,
  calibrationModel: undefined as any,
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
  const exposureBlockCooldowns = new Map<string, number>();
  const affordabilityLogCooldowns = new Map<string, number>();
  
  const releaseLock = ctx.hold?.() ?? (() => {});

  let isDone = false;
  let lastLogSec = -1;

  let inFlightUp = false;
  let inFlightDown = false;

  // ── v1.3.0 Profit-Selective State ────────────────────────────────────────────
  // Falling-knife tracking: count consecutive fills where mid-price at fill time
  // was BELOW the fill price (adverse momentum — we bought into a down-move).
  let consecutiveAdverseUp = 0;
  let consecutiveAdverseDown = 0;
  let sideBlockedUp = false;
  let sideBlockedDown = false;

  // ── v1.4.0 Take-Profit State ──────────────────────────────────────────────────
  // Track pending sell orders and whether take-profit has fired this round.
  // Once fired, new BUY orders on that side are suppressed (no point accumulating
  // inventory we are trying to exit).
  let inFlightSellUp = false;
  let inFlightSellDown = false;
  let takeProfitFiredUp = false;
  let takeProfitFiredDown = false;

  // ── v2.0.0 Toxic Jump State ─────────────────────────────────────────────────────
  let toxicBlockUntilMs = 0;
  const priceHistory: { ts: number; price: number }[] = [];

  // ── v2.1.0 Advanced Exits State ────────────────────────────────────────────────
  // High water marks track the maximum bestBidPrice observed while holding inventory
  let highWaterMarkUp = 0;
  let highWaterMarkDown = 0;
  
  let scaleOutFiredUp = false;
  let scaleOutFiredDown = false;
  let trailingExitFiredUp = false;
  let trailingExitFiredDown = false;
  let inFlightScaleOutUp = false;
  let inFlightScaleOutDown = false;
  let inFlightTrailingUp = false;
  let inFlightTrailingDown = false;

  // ── v3.0.0 Momentum Velocity Buffer ────────────────────────────────────────
  // Rolling window of predictive composite prices to compute $/sec velocity
  const velocityBuffer: { ts: number; price: number }[] = [];

  const evaluateQuotes = () => {
    if (isDone) return;
    const quant = ctx.quant?.latest();
    const sigma = quant?.sigma;
    const quoteRegime = quant as ({ jumpDetected?: boolean; volatilityRegime?: string } & typeof quant);
    const aggregate = ctx.predictive?.aggregate?.latest() ?? null;
    
    const remainingSecs = (ctx.slotEndMs - ctx.clock.nowMs()) / 1000;
    
    if (remainingSecs <= 0) {
        isDone = true;
        releaseLock();
        return;
    }

    // 1. Hygiene: Early abort on disagreement to prevent blocked intent spam
    if (!config.skipHygiene && aggregate?.disagreement === true) {
      if (ctx.clock.nowMs() % 10000 === 0) {
        ctx.log("[fair-value] No quote: predictive aggregate disagreement", "dim");
      }
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      return;
    }

    const fairValue = calculateSettlementAnchoredFairValue(ctx, sigma);
    let probUp = fairValue.probabilityUp;

    // v3.6.0: Apply isotonic calibration if a model is provided.
    // Maps raw Black-Scholes probability -> historically-calibrated probability.
    if (probUp !== null && probUp !== undefined && config.calibrationModel) {
      const calibrated = predictIsotonicProbability(config.calibrationModel as any, probUp);
      if (calibrated !== null) {
        probUp = calibrated;
      }
    }
    
    // ── v2.0.0 Toxicity Jump Filter ────────────────────────────────────────────────
    if (config.toxicJumpEnabled && fairValue.predictiveCompositePrice !== null) {
      const now = ctx.clock.nowMs();
      
      // Update history buffer
      priceHistory.push({ ts: now, price: fairValue.predictiveCompositePrice });
      
      // Prune history older than 1000ms
      while (priceHistory.length > 0 && now - priceHistory[0]!.ts > 1000) {
        priceHistory.shift();
      }

      if (now < toxicBlockUntilMs) {
        // We are currently in the penalty box. Cancel everything.
        ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
        return;
      }

      if (priceHistory.length > 1) {
        const oldest = priceHistory[0]!;
        const current = priceHistory[priceHistory.length - 1]!;
        if (oldest && current) {
            const oldestPrice = oldest.price;
            const currentPrice = current.price;
            const delta = currentPrice - oldestPrice;

            if (Math.abs(delta) >= config.toxicJumpThresholdAbs) {
              ctx.log(`[fair-value] v2.0.0 TOXIC JUMP DETECTED ($${Math.abs(delta).toFixed(2)} move). Canceling quotes for ${config.toxicJumpCooldownMs}ms`, "red");
              toxicBlockUntilMs = now + config.toxicJumpCooldownMs;
              ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
              return;
            }
        }
      }
    }

    if (probUp === null || probUp === undefined || sigma === null || sigma === undefined) {
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      if (fairValue.noTradeReason && ctx.clock.nowMs() % 5000 === 0) {
        ctx.log(`[fair-value] No quote: ${fairValue.noTradeReason}`, "dim");
      }
      return;
    }
    const remFloor = Math.floor(remainingSecs);
    if (remFloor % 30 === 0 && remFloor !== lastLogSec) {
      ctx.log(`[fair-value] P(UP)=${probUp.toFixed(4)} Sigma=${sigma.toFixed(4)} settlement=${fairValue.settlementAnchorPrice?.toFixed(2) ?? "n/a"} predictive=${fairValue.predictiveCompositePrice?.toFixed(2) ?? "n/a"} Rem=${remFloor}s`, "dim");
      lastLogSec = remFloor;
    }
    if (remainingSecs < 10) {
      // Too close to expiry, stop quoting to avoid getting picked off
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      return;
    }
    if (config.blockOnJump && quoteRegime?.jumpDetected) {
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      if (ctx.clock.nowMs() % 5000 === 0) {
        ctx.log("[fair-value] No quote: jump regime detected", "yellow");
      }
      return;
    }
    if (sigma > config.maxSigma) {
      ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
      if (ctx.clock.nowMs() % 5000 === 0) {
        ctx.log(`[fair-value] No quote: high-vol sigma ${sigma.toFixed(4)} exceeds ${config.maxSigma.toFixed(4)}`, "yellow");
      }
      return;
    }

    // 1. Determine current inventory and VWAP (Cost Basis)
    const upTokenId = ctx.clobTokenIds[0];
    const downTokenId = ctx.clobTokenIds[1];
    
    let inventoryUp = 0;
    let inventoryDown = 0;
    let totalSpendUp = 0;
    let totalSpendDown = 0;

    for (const h of ctx.orderHistory) {
      if (h.tokenId === upTokenId) {
        if (h.action === "buy") {
          inventoryUp += h.shares;
          totalSpendUp += (h.shares * h.price);
        } else {
          // Selling reduces inventory at VWAP to maintain correct cost basis representation
          const vwap = inventoryUp > 0 ? totalSpendUp / inventoryUp : 0;
          inventoryUp = Math.max(0, inventoryUp - h.shares);
          totalSpendUp = inventoryUp * vwap;
        }
      } else if (h.tokenId === downTokenId) {
        if (h.action === "buy") {
          inventoryDown += h.shares;
          totalSpendDown += (h.shares * h.price);
          inventoryUp -= h.shares; // UP-equivalent inventory tracking
        } else {
          const vwap = inventoryDown > 0 ? totalSpendDown / inventoryDown : 0;
          inventoryDown = Math.max(0, inventoryDown - h.shares);
          totalSpendDown = inventoryDown * vwap;
          inventoryUp += h.shares;
        }
      }
    }

    const vwapUp = inventoryUp > 0 ? totalSpendUp / inventoryUp : 0;
    const vwapDown = inventoryDown > 0 ? totalSpendDown / inventoryDown : 0;

    // Reset high water marks if inventory is fully exited
    if (inventoryUp <= 0) {
      highWaterMarkUp = 0;
      scaleOutFiredUp = false;
      trailingExitFiredUp = false;
    }
    if (inventoryDown <= 0) {
      highWaterMarkDown = 0;
      scaleOutFiredDown = false;
      trailingExitFiredDown = false;
    }

    // ── v1.4.0 Take-Profit Evaluation ────────────────────────────────────────────
    // Check each side independently: if we hold inventory AND the market will pay
    // us >= takeProfitThreshold per share, cross the current bid and exit now.
    if (config.takeProfitEnabled) {
      const tp = config.takeProfitThreshold;

      // UP side take-profit
      if (inventoryUp > 0 && !inFlightSellUp) {
        const bestBidUp = ctx.orderBook.bestBidPrice("UP");
        if (bestBidUp !== null && bestBidUp >= tp) {
          // Cancel any pending UP buy orders — stop accumulating what we are exiting
          const pendingUpBuys = ctx.pendingOrders.filter(
            o => o.tokenId === upTokenId && o.action === "buy"
          );
          if (pendingUpBuys.length > 0) {
            ctx.cancelOrders(pendingUpBuys.map(o => o.orderId));
          }
          const sellPrice = bestBidUp;
          if (sellPrice !== null) {
            inFlightSellUp = true;
            takeProfitFiredUp = true;
            ctx.log(
              `[fair-value] v1.4.0 TAKE-PROFIT UP: bidPrice=${bestBidUp.toFixed(3)} >= threshold=${tp.toFixed(3)} | selling ${inventoryUp.toFixed(3)} shares @ ${sellPrice.toFixed(3)}`,
              "green"
            );
            ctx.postOrders([{
              req: {
                tokenId: upTokenId,
                action: "sell" as const,
                price: sellPrice,
                shares: inventoryUp,
                orderType: "FOK" as const,
              },
              expireAtMs: ctx.clock.nowMs() + 1_000,
              onFilled: (filledShares) => {
                inFlightSellUp = false;
                ctx.log(
                  `[fair-value] v1.4.0 TAKE-PROFIT UP FILLED: ${filledShares.toFixed(3)} shares sold @ ${sellPrice.toFixed(3)} | estimated exit proceeds: $${(filledShares * sellPrice).toFixed(3)}`,
                  "green"
                );
              },
              onExpired: () => {
                // Sell expired unfilled — clear flag so we can retry if price recovers
                inFlightSellUp = false;
                // NOTE: takeProfitFiredUp remains true to keep buy block in effect
                ctx.log(
                  `[fair-value] v1.4.0 take-profit UP sell expired unfilled — will retry if bid recovers`,
                  "yellow"
                );
              },
              onFailed: (reason) => {
                inFlightSellUp = false;
                ctx.log(
                  `[fair-value] v1.4.0 take-profit UP sell failed: ${reason}`,
                  "yellow"
                );
              },
            }]);
          }
        }
      }

      // DOWN side take-profit
      if (inventoryDown > 0 && !inFlightSellDown) {
        const bestBidDown = ctx.orderBook.bestBidPrice("DOWN");
        if (bestBidDown !== null && bestBidDown >= tp) {
          const pendingDownBuys = ctx.pendingOrders.filter(
            o => o.tokenId === downTokenId && o.action === "buy"
          );
          if (pendingDownBuys.length > 0) {
            ctx.cancelOrders(pendingDownBuys.map(o => o.orderId));
          }
          const sellPrice = bestBidDown;
          if (sellPrice !== null) {
            inFlightSellDown = true;
            takeProfitFiredDown = true;
            ctx.log(
              `[fair-value] v1.4.0 TAKE-PROFIT DOWN: bidPrice=${bestBidDown.toFixed(3)} >= threshold=${tp.toFixed(3)} | selling ${inventoryDown.toFixed(3)} shares @ ${sellPrice.toFixed(3)}`,
              "green"
            );
            ctx.postOrders([{
              req: {
                tokenId: downTokenId,
                action: "sell" as const,
                price: sellPrice,
                shares: inventoryDown,
                orderType: "FOK" as const,
              },
              expireAtMs: ctx.clock.nowMs() + 1_000,
              onFilled: (filledShares) => {
                inFlightSellDown = false;
                ctx.log(
                  `[fair-value] v1.4.0 TAKE-PROFIT DOWN FILLED: ${filledShares.toFixed(3)} shares sold @ ${sellPrice.toFixed(3)} | estimated exit proceeds: $${(filledShares * sellPrice).toFixed(3)}`,
                  "green"
                );
              },
              onExpired: () => {
                inFlightSellDown = false;
                ctx.log(
                  `[fair-value] v1.4.0 take-profit DOWN sell expired unfilled — will retry if bid recovers`,
                  "yellow"
                );
              },
              onFailed: (reason) => {
                inFlightSellDown = false;
                ctx.log(
                  `[fair-value] v1.4.0 take-profit DOWN sell failed: ${reason}`,
                  "yellow"
                );
              },
            }]);
          }
        }
      }
    }

    // ── v2.1.0 Advanced Exits (Scale-Out & Trailing Stop) ────────────────────────
    if (config.advancedExitsEnabled) {
      // UP Side Advanced Exits
      if (inventoryUp > 0) {
        const bestBidUp = ctx.orderBook.bestBidPrice("UP");
        if (bestBidUp !== null) {
          // Update High Water Mark
          if (bestBidUp > highWaterMarkUp) {
            highWaterMarkUp = bestBidUp;
          }

          // 1. Partial Scale-Out (Resting Take-Profit)
          if (!scaleOutFiredUp && !inFlightScaleOutUp && vwapUp > 0) {
            const scaleOutTarget = vwapUp + config.scaleOutProfitMargin;
            const scaleOutShares = Math.max(1, Math.floor(inventoryUp * config.scaleOutInventoryPct));
            
            if (scaleOutShares >= 1) {
              const sellPrice = makerSafePrice(ctx, "UP", "sell", scaleOutTarget, config.makerOnly);
              if (sellPrice !== null) {
                inFlightScaleOutUp = true;
                scaleOutFiredUp = true;
                ctx.log(`[fair-value] v2.1.0 SCALE-OUT UP: Cost Basis=$${vwapUp.toFixed(3)} | Posting partial sell of ${scaleOutShares.toFixed(3)} shares @ $${sellPrice.toFixed(3)} (Target: +$${config.scaleOutProfitMargin.toFixed(3)})`, "green");
                
                ctx.postOrders([{
                  req: {
                    tokenId: upTokenId,
                    action: "sell" as const,
                    price: sellPrice,
                    shares: scaleOutShares,
                    orderType: "GTC" as const,
                  },
                  expireAtMs: ctx.slotEndMs - 10_000,
                  onFilled: (filledShares) => {
                    inFlightScaleOutUp = false;
                    ctx.log(`[fair-value] v2.1.0 SCALE-OUT UP FILLED: ${filledShares.toFixed(3)} shares sold @ $${sellPrice.toFixed(3)}`, "green");
                  },
                  onExpired: () => {
                    inFlightScaleOutUp = false;
                    scaleOutFiredUp = false; // Allow retry
                  },
                  onFailed: (reason) => {
                    inFlightScaleOutUp = false;
                    scaleOutFiredUp = false;
                  },
                }]);
              }
            }
          }

                // 2. Dynamic Trailing Stop
          if (!trailingExitFiredUp && !inFlightTrailingUp && vwapUp > 0) {
            const unrealizedProfit = bestBidUp - vwapUp;
            if (unrealizedProfit >= config.trailingStopActivationMargin) {
              const drawdown = highWaterMarkUp - bestBidUp;
              if (drawdown >= config.trailingStopDrawdownMargin) {
                inFlightTrailingUp = true;
                trailingExitFiredUp = true;
                
                // Cancel pending buys so we don't re-accumulate
                const pendingUpBuys = ctx.pendingOrders.filter(o => o.tokenId === upTokenId && o.action === "buy");
                if (pendingUpBuys.length > 0) ctx.cancelOrders(pendingUpBuys.map(o => o.orderId));
                
                const sellPrice = bestBidUp;

                ctx.log(`[fair-value] v2.1.1 TRAILING STOP UP (FOK): Dropped $${drawdown.toFixed(3)} from high ($${highWaterMarkUp.toFixed(3)}). Selling ${inventoryUp.toFixed(3)} shares @ $${sellPrice.toFixed(3)} to protect profit.`, "yellow");

                ctx.postOrders([{
                  req: {
                    tokenId: upTokenId,
                    action: "sell" as const,
                    price: sellPrice,
                    shares: inventoryUp, // Dump all remaining
                    orderType: "FOK" as const,
                  },
                  expireAtMs: ctx.clock.nowMs() + 1_000,
                  onFilled: (filledShares) => {
                    inFlightTrailingUp = false;
                  },
                  onExpired: () => {
                    inFlightTrailingUp = false;
                    trailingExitFiredUp = false; // Allow retry if it didn't fill (Hybrid logic relies on this!)
                  },
                  onFailed: (reason) => {
                    inFlightTrailingUp = false;
                    trailingExitFiredUp = false;
                  },
                }]);
              }
            }
          }
        }
      }

      // DOWN Side Advanced Exits
      if (inventoryDown > 0) {
        const bestBidDown = ctx.orderBook.bestBidPrice("DOWN");
        if (bestBidDown !== null) {
          if (bestBidDown > highWaterMarkDown) {
            highWaterMarkDown = bestBidDown;
          }

          // 1. Partial Scale-Out
          if (!scaleOutFiredDown && !inFlightScaleOutDown && vwapDown > 0) {
            const scaleOutTarget = vwapDown + config.scaleOutProfitMargin;
            const scaleOutShares = Math.max(1, Math.floor(inventoryDown * config.scaleOutInventoryPct));
            
            if (scaleOutShares >= 1) {
              const sellPrice = makerSafePrice(ctx, "DOWN", "sell", scaleOutTarget, config.makerOnly);
              if (sellPrice !== null) {
                inFlightScaleOutDown = true;
                scaleOutFiredDown = true;
                ctx.log(`[fair-value] v2.1.0 SCALE-OUT DOWN: Cost Basis=$${vwapDown.toFixed(3)} | Posting partial sell of ${scaleOutShares.toFixed(3)} shares @ $${sellPrice.toFixed(3)} (Target: +$${config.scaleOutProfitMargin.toFixed(3)})`, "green");
                
                ctx.postOrders([{
                  req: {
                    tokenId: downTokenId,
                    action: "sell" as const,
                    price: sellPrice,
                    shares: scaleOutShares,
                    orderType: "GTC" as const,
                  },
                  expireAtMs: ctx.slotEndMs - 10_000,
                  onFilled: (filledShares) => {
                    inFlightScaleOutDown = false;
                    ctx.log(`[fair-value] v2.1.0 SCALE-OUT DOWN FILLED: ${filledShares.toFixed(3)} shares sold @ $${sellPrice.toFixed(3)}`, "green");
                  },
                  onExpired: () => {
                    inFlightScaleOutDown = false;
                    scaleOutFiredDown = false;
                  },
                  onFailed: (reason) => {
                    inFlightScaleOutDown = false;
                    scaleOutFiredDown = false;
                  },
                }]);
              }
            }
          }

          // 2. Dynamic Trailing Stop
          if (!trailingExitFiredDown && !inFlightTrailingDown && vwapDown > 0) {
            const unrealizedProfit = bestBidDown - vwapDown;
            if (unrealizedProfit >= config.trailingStopActivationMargin) {
              const drawdown = highWaterMarkDown - bestBidDown;
              if (drawdown >= config.trailingStopDrawdownMargin) {
                inFlightTrailingDown = true;
                trailingExitFiredDown = true;
                
                const pendingDownBuys = ctx.pendingOrders.filter(o => o.tokenId === downTokenId && o.action === "buy");
                if (pendingDownBuys.length > 0) ctx.cancelOrders(pendingDownBuys.map(o => o.orderId));
                
                const sellPrice = bestBidDown;

                ctx.log(`[fair-value] v2.1.1 TRAILING STOP DOWN (FOK): Dropped $${drawdown.toFixed(3)} from high ($${highWaterMarkDown.toFixed(3)}). Selling ${inventoryDown.toFixed(3)} shares @ $${sellPrice.toFixed(3)} to protect profit.`, "yellow");

                ctx.postOrders([{
                  req: {
                    tokenId: downTokenId,
                    action: "sell" as const,
                    price: sellPrice,
                    shares: inventoryDown,
                    orderType: "FOK" as const,
                  },
                  expireAtMs: ctx.clock.nowMs() + 1_000,
                  onFilled: (filledShares) => {
                    inFlightTrailingDown = false;
                  },
                  onExpired: () => {
                    inFlightTrailingDown = false;
                    trailingExitFiredDown = false;
                  },
                  onFailed: (reason) => {
                    inFlightTrailingDown = false;
                    trailingExitFiredDown = false;
                  },
                }]);
              }
            }
          }
        }
      }
    }
    
    // 2. Calculate Avellaneda-style reservation probability.
    const timeFraction = Math.max(0, Math.min(1, remainingSecs / 300));
    const inventoryRatio = inventoryUp / config.maxInventory;
    const skew = inventoryRatio * config.inventorySkew * Math.max(0.25, timeFraction);
    const adjustedProbUp = Math.max(0.01, Math.min(0.99, probUp - skew));
    const volatilityBuffer = Math.min(0.05, Math.max(0, sigma) * Math.sqrt(Math.max(remainingSecs, 1) / 31_536_000) * 2);
    const quoteMargin = config.margin + volatilityBuffer + (quoteRegime?.volatilityRegime === "high_vol" ? config.highVolExtraMargin : 0);

    // 3. Define Quotes
    // Hygiene: Strictly bound raw quotes before attempting maker adjustments
    let rawBidPriceUp = parseFloat((adjustedProbUp - quoteMargin).toFixed(2));
    let rawBidPriceDown = parseFloat(((1 - adjustedProbUp) - quoteMargin).toFixed(2));
    
    if (!config.skipHygiene) {
      if (rawBidPriceUp <= 0.01 || rawBidPriceUp > config.maxMakerBidPrice) rawBidPriceUp = NaN;
      if (rawBidPriceDown <= 0.01 || rawBidPriceDown > config.maxMakerBidPrice) rawBidPriceDown = NaN;
    }

    const bidPriceUp = Number.isFinite(rawBidPriceUp) ? makerSafePrice(ctx, "UP", "buy", rawBidPriceUp, config.makerOnly) : null;
    const bidPriceDown = Number.isFinite(rawBidPriceDown) ? makerSafePrice(ctx, "DOWN", "buy", rawBidPriceDown, config.makerOnly) : null;

    // 3.5. Position Sizing — base
    const balance = ctx.walletBalanceUsd;
    let targetNotional: number | null = null;
    let targetSharesBase = config.shares;
    if (config.sharesMode === "pct_of_balance" && balance > 0) {
      let effectivePct = config.sharePct;

      // ── v3.0.0 Momentum-Confirmed Dynamic Sizing ──────────────────────────
      if (config.momentumSizingEnabled && fairValue.predictiveCompositePrice !== null) {
        const now = ctx.clock.nowMs();
        velocityBuffer.push({ ts: now, price: fairValue.predictiveCompositePrice });

        // Prune entries older than the window
        while (velocityBuffer.length > 0 && now - velocityBuffer[0]!.ts > config.momentumWindowMs) {
          velocityBuffer.shift();
        }

        if (velocityBuffer.length >= 2) {
          const oldest = velocityBuffer[0]!;
          const newest = velocityBuffer[velocityBuffer.length - 1]!;
          const dtSec = (newest.ts - oldest.ts) / 1000;

          if (dtSec > 0.5) { // Need at least 500ms of data
            const velocityPerSec = (newest.price - oldest.price) / dtSec;
            const absVelocity = Math.abs(velocityPerSec);

            if (absVelocity > config.momentumNeutralThreshold) {
              // Determine if momentum confirms or contradicts our probable trade
              // If P(UP) > 0.5, we're likely buying UP → positive velocity confirms
              // If P(UP) < 0.5, we're likely buying DOWN → negative velocity confirms
              const probUp = fairValue.probabilityUp;
              const momentumConfirms = probUp !== null && (
                (probUp > 0.5 && velocityPerSec > 0) ||
                (probUp < 0.5 && velocityPerSec < 0)
              );

              if (momentumConfirms) {
                // Scale up: interpolate between base and max based on velocity strength
                const strength = Math.min(1.0, absVelocity / (config.momentumNeutralThreshold * 5));
                effectivePct = config.sharePct + (config.momentumMaxPct - config.sharePct) * strength;
                if (now % 10000 < 1100) {
                  ctx.log(`[fair-value] v3.0.0 MOMENTUM CONFIRMS: velocity=$${velocityPerSec.toFixed(2)}/s → sizing UP to ${(effectivePct * 100).toFixed(1)}%`, "green");
                }
              } else {
                // Scale down: interpolate between base and min based on velocity strength
                const strength = Math.min(1.0, absVelocity / (config.momentumNeutralThreshold * 5));
                effectivePct = config.sharePct - (config.sharePct - config.momentumMinPct) * strength;
                if (now % 10000 < 1100) {
                  ctx.log(`[fair-value] v3.0.0 MOMENTUM CONTRADICTS: velocity=$${velocityPerSec.toFixed(2)}/s → sizing DOWN to ${(effectivePct * 100).toFixed(1)}%`, "yellow");
                }
              }
            }
            // else: neutral velocity → effectivePct stays at base sharePct
          }
        }
      }

      targetNotional = balance * effectivePct;
    }

    // 3.5a. v1.3.0 — Regime-Weighted Sizing
    // Reduces share size / notional when volatility is elevated.
    let regimeSizeMultiplier = 1.0;
    if (config.regimeWeightedSizing && sigma !== null && sigma !== undefined) {
      if (sigma > 1.0) {
        regimeSizeMultiplier = Math.max(0.5, Math.min(1.0, 1.0 / sigma));
      }
    }

    // 3.5b. v1.3.0 — Unstable-Basis Downsize
    // |composite - anchor| > threshold → halve size.
    if (config.unstableBasisDownsize) {
      const composite = aggregate?.predictiveTape?.compositePrice ?? aggregate?.price ?? null;
      const anchorPrice = ctx.resolution?.latestAnchor()?.priceToBeat ?? ctx.resolution?.latestAnchor()?.price ?? null;
      if (composite !== null && anchorPrice !== null) {
        const basisAbs = Math.abs(composite - anchorPrice);
        if (basisAbs > config.unstableBasisThreshold) {
          regimeSizeMultiplier *= 0.5;
          if (ctx.clock.nowMs() % 10000 === 0) {
            ctx.log(`[fair-value] v1.3.0 unstable-basis downsize: basis=${basisAbs.toFixed(2)} > ${config.unstableBasisThreshold} → halving shares`, "yellow");
          }
        }
      }
    }

    // Apply regime multiplier to both base modes
    if (targetNotional !== null) {
      targetNotional *= regimeSizeMultiplier;
    } else {
      targetSharesBase *= regimeSizeMultiplier;
    }

    // 4. Update Orders
    let existingUp = ctx.pendingOrders.find(o => o.tokenId === upTokenId && o.action === "buy");
    let existingDown = ctx.pendingOrders.find(o => o.tokenId === downTokenId && o.action === "buy");

    if (existingUp) {
      inFlightUp = false;
    }
    if (existingDown) {
      inFlightDown = false;
    }

    const feeRateUp = feeRate(ctx, upTokenId);
    const feeRateDown = feeRate(ctx, downTokenId);

    // Ensure resting quotes are still safe
    if (existingUp) {
      const existingEv = quoteEv(adjustedProbUp, existingUp.price, feeRateUp, config.makerRebateEstimate, config.feeAwareEdge);
      if (existingEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale UP quote: ${existingUp.price} (Edge: ${existingEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingUp.orderId]);
        existingUp = undefined;
      }
    }
    if (existingDown) {
      const existingEv = quoteEv(1 - adjustedProbUp, existingDown.price, feeRateDown, config.makerRebateEstimate, config.feeAwareEdge);
      if (existingEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale DOWN quote: ${existingDown.price} (Edge: ${existingEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingDown.orderId]);
        existingDown = undefined;
      }
    }

    const ordersToPost: OrderRequest[] = [];

    const TOLERANCE = 0.01;
    const EPSILON = 0.0001;

    const evUp = quoteEv(adjustedProbUp, bidPriceUp, feeRateUp, config.makerRebateEstimate, config.feeAwareEdge);
    const evDown = quoteEv(1 - adjustedProbUp, bidPriceDown, feeRateDown, config.makerRebateEstimate, config.feeAwareEdge);
    const flow = ctx.orderFlow?.latest() ?? null;
    const allowUpFlow = flowAllowsSide(flow, "UP", config, ctx);
    const allowDownFlow = flowAllowsSide(flow, "DOWN", config, ctx);

    // Strategy-side Exposure Clamp
    const hasExposureBudget =
      Number.isFinite(ctx.maxOpenExposureUsd) &&
      Number.isFinite(ctx.openExposureUsd);
    const remainingExposure = hasExposureBudget
      ? Math.max(0, ctx.maxOpenExposureUsd - ctx.openExposureUsd)
      : Number.POSITIVE_INFINITY;
    let cashBudget = Number.isFinite(balance) ? Math.max(0, balance) : 0;

    const reserveAffordableShares = (side: "UP" | "DOWN", price: number, requestedShares: number): number => {
      const maxSharesByExposure = Number.isFinite(remainingExposure)
        ? Math.floor(remainingExposure / price)
        : requestedShares;
      const maxSharesByCash = Math.floor(cashBudget / price);
      const minShares = Math.max(1, config.minShares);
      const targetShares = Math.max(requestedShares, minShares);
      const shares = Math.min(targetShares, maxSharesByExposure, maxSharesByCash);
      if (shares < minShares) {
        const reason = maxSharesByExposure < minShares ? "insufficient exposure budget" : "insufficient cash";
        const available = maxSharesByExposure < minShares ? remainingExposure : cashBudget;
        logSuppressedAffordability(ctx, affordabilityLogCooldowns, side, price, targetShares, reason, available);
        return 0;
      }
      if (shares < targetShares) {
        const reason = shares === maxSharesByCash ? "cash balance" : "remaining exposure budget";
        ctx.log(`[fair-value] Clamping ${side} shares to ${shares.toFixed(2)} due to ${reason}`, "yellow");
      }
      cashBudget -= price * shares;
      return shares;
    };

    // 3.5c. v1.3.0 — Edge-Weighted Sizing
    // Edge ratio relative to min edge: fat edge → up to 2x; thin edge → down to 0.5x.
    // Computed per-side to account for asymmetric edge.
    let edgeMultiplierUp = 1.0;
    let edgeMultiplierDown = 1.0;
    if (config.edgeWeightedSizing && config.minEdge > 0) {
      if (bidPriceUp !== null && evUp.edge > 0) {
        edgeMultiplierUp = Math.max(0.5, Math.min(2.0, evUp.edge / config.minEdge));
      }
      if (bidPriceDown !== null && evDown.edge > 0) {
        edgeMultiplierDown = Math.max(0.5, Math.min(2.0, evDown.edge / config.minEdge));
      }
    }

    // Helper: compute final shares for a given side, applying notional/price formula and edge multiplier.
    // In pct_of_balance mode: shares = (balance × pct × regimeMultiplier × edgeMultiplier) / price
    // In fixed mode: shares = targetSharesBase × regimeMultiplier × edgeMultiplier
    const computeTargetShares = (side: "UP" | "DOWN", price: number, edgeMultiplier: number): number => {
      let shares = config.minShares;
      if (targetNotional !== null && price > 0) {
        shares = Math.max(config.minShares, (targetNotional * edgeMultiplier) / price);
      } else {
        shares = Math.max(config.minShares, targetSharesBase * edgeMultiplier);
      }
      
      // v2.1.1 Enforce Max Spend Cap
      if (config.maxSpendAbs !== undefined && price > 0) {
        const spentSoFar = side === "UP" ? totalSpendUp : totalSpendDown;
        const availableSpend = Math.max(0, config.maxSpendAbs - spentSoFar);
        const maxShares = availableSpend / price;
        if (shares > maxShares) {
          shares = maxShares;
        }
      }
      return shares;
    };

    // Helper: compound falling-knife adverse signal check (all live-available signals, no replay leakage)
    const checkFallingKnifeAdverse = (side: "UP" | "DOWN", fillPrice: number): boolean => {
      let adverseSignals = 0;

      // Signal 1: Current mid has moved below fill price (adverse momentum in OB)
      const curBid = ctx.orderBook.bestBidPrice(side);
      const curAsk = ctx.orderBook.bestAskPrice(side);
      const curMid = curBid !== null && curAsk !== null ? (curBid + curAsk) / 2 : curBid;
      if (curMid !== null && curMid < fillPrice - 0.005) adverseSignals++;

      // Signal 2: OB imbalance turned against this side
      const liveFlow = ctx.orderFlow?.latest() ?? null;
      if (liveFlow) {
        const imbalance = side === "UP" ? liveFlow.imbalanceUp : liveFlow.imbalanceDown;
        if (imbalance !== null && imbalance < -0.10) adverseSignals++;

        // Signal 3: CVD (10s) flowing against this side
        const cvdThisSide = side === "UP"
          ? liveFlow.cvd10s.up - liveFlow.cvd10s.down
          : liveFlow.cvd10s.down - liveFlow.cvd10s.up;
        if (cvdThisSide < -50) adverseSignals++;
      }

      // Signal 4: Predictive composite drifted against our side
      const composite = ctx.predictive?.aggregate?.latest()?.price ?? null;
      if (composite !== null) {
        // For UP fills: adverse if composite is now well below our fill price
        // For DOWN fills: adverse if composite is now well above (1 - fillPrice threshold)
        const compositeAdverse = side === "UP"
          ? composite < fillPrice - 0.010
          : (1 - composite) < fillPrice - 0.010;
        if (compositeAdverse) adverseSignals++;
      }

      // Require at least 2 of 4 signals for this to count as adverse
      return adverseSignals >= 2;
    };

    // v1.4.0: suppress new buys on a side once take-profit has fired — we are exiting, not accumulating
    if (bidPriceUp !== null && bidPriceUp > 0.01 && bidPriceUp < 0.99 && evUp.edge >= config.minEdge && allowUpFlow && !takeProfitFiredUp) {
      // v1.3.0 — Falling-Knife Block: suppress new UP buys if we've detected consecutive adverse fills
      if (config.fallingKnifeBlock && sideBlockedUp) {
        if (ctx.clock.nowMs() % 10000 === 0) {
          ctx.log(`[fair-value] v1.3.0 falling-knife block: UP side blocked (${consecutiveAdverseUp} consecutive adverse fills)`, "yellow");
        }
        if (existingUp) ctx.cancelOrders([existingUp.orderId]);
      } else if (!existingUp || Math.abs(existingUp.price - bidPriceUp) > (TOLERANCE + EPSILON)) {
        if (existingUp) {
          ctx.log(`[fair-value] Replacing UP quote: ${existingUp.price} -> ${bidPriceUp} (P=${probUp.toFixed(3)})`, "dim");
          ctx.cancelOrders([existingUp.orderId]);
        }

        const sharesToBuy = reserveAffordableShares("UP", bidPriceUp, computeTargetShares("UP", bidPriceUp, edgeMultiplierUp));

        if (inventoryUp < config.maxInventory && sharesToBuy >= 1 && !inFlightUp) {
          const exposureKey = exposureBlockKey(ctx, "UP", bidPriceUp, sharesToBuy);
          if (!isExposureBlocked(ctx, exposureBlockCooldowns, exposureKey, "UP", bidPriceUp, sharesToBuy)) {
            inFlightUp = true;
            const capturedFillPriceUp = bidPriceUp;
            ordersToPost.push({
              req: {
                tokenId: upTokenId,
                action: "buy" as const,
                price: bidPriceUp,
                shares: sharesToBuy,
                orderType: "GTC" as const,
              },
              expireAtMs: ctx.clock.nowMs() + 10000,
              onFilled: config.fallingKnifeBlock ? (_filledShares) => {
                // Compound falling-knife detection — only live-available signals, no replay leakage
                const isAdverse = checkFallingKnifeAdverse("UP", capturedFillPriceUp);
                if (isAdverse) {
                  consecutiveAdverseUp += 1;
                  if (consecutiveAdverseUp >= config.fallingKnifeWindow) {
                    sideBlockedUp = true;
                    ctx.log(`[fair-value] v1.3.0 falling-knife TRIGGERED: UP blocked after ${consecutiveAdverseUp} adverse fills @ ${capturedFillPriceUp.toFixed(3)}`, "yellow");
                  }
                } else {
                  consecutiveAdverseUp = 0; // Reset on non-adverse fill
                }
              } : undefined,
              onFailed: (reason) => {
                inFlightUp = false;
                recordExposureBlock(ctx, exposureBlockCooldowns, exposureKey, reason, config.exposureBlockCooldownMs);
              },
            });
          }
        }
      }
    } else if (existingUp) {
      ctx.cancelOrders([existingUp.orderId]);
    }

    if (bidPriceDown !== null && bidPriceDown > 0.01 && bidPriceDown < 0.99 && evDown.edge >= config.minEdge && allowDownFlow && !takeProfitFiredDown) {
      // v1.3.0 — Falling-Knife Block: suppress new DOWN buys if we've detected consecutive adverse fills
      if (config.fallingKnifeBlock && sideBlockedDown) {
        if (ctx.clock.nowMs() % 10000 === 0) {
          ctx.log(`[fair-value] v1.3.0 falling-knife block: DOWN side blocked (${consecutiveAdverseDown} consecutive adverse fills)`, "yellow");
        }
        if (existingDown) ctx.cancelOrders([existingDown.orderId]);
      } else if (!existingDown || Math.abs(existingDown.price - bidPriceDown) > (TOLERANCE + EPSILON)) {
        if (existingDown) {
          ctx.log(`[fair-value] Replacing DOWN quote: ${existingDown.price} -> ${bidPriceDown}`, "dim");
          ctx.cancelOrders([existingDown.orderId]);
        }

        const sharesToBuy = reserveAffordableShares("DOWN", bidPriceDown, computeTargetShares("DOWN", bidPriceDown, edgeMultiplierDown));

        if (inventoryUp > -config.maxInventory && sharesToBuy >= 1 && !inFlightDown) {
          const exposureKey = exposureBlockKey(ctx, "DOWN", bidPriceDown, sharesToBuy);
          if (!isExposureBlocked(ctx, exposureBlockCooldowns, exposureKey, "DOWN", bidPriceDown, sharesToBuy)) {
            inFlightDown = true;
            const capturedFillPriceDown = bidPriceDown;
            ordersToPost.push({
              req: {
                tokenId: downTokenId,
                action: "buy" as const,
                price: bidPriceDown,
                shares: sharesToBuy,
                orderType: "GTC" as const,
              },
              expireAtMs: ctx.clock.nowMs() + 10000,
              onFilled: config.fallingKnifeBlock ? (_filledShares) => {
                // Compound falling-knife detection — only live-available signals, no replay leakage
                const isAdverse = checkFallingKnifeAdverse("DOWN", capturedFillPriceDown);
                if (isAdverse) {
                  consecutiveAdverseDown += 1;
                  if (consecutiveAdverseDown >= config.fallingKnifeWindow) {
                    sideBlockedDown = true;
                    ctx.log(`[fair-value] v1.3.0 falling-knife TRIGGERED: DOWN blocked after ${consecutiveAdverseDown} adverse fills @ ${capturedFillPriceDown.toFixed(3)}`, "yellow");
                  }
                } else {
                  consecutiveAdverseDown = 0;
                }
              } : undefined,
              onFailed: (reason) => {
                inFlightDown = false;
                recordExposureBlock(ctx, exposureBlockCooldowns, exposureKey, reason, config.exposureBlockCooldownMs);
              },
            });
          }
        }
      }
    } else if (existingDown) {
      ctx.cancelOrders([existingDown.orderId]);
    }

    if (ordersToPost.length > 0) {
      ctx.log(`[fair-value] Posting ${ordersToPost.length} maker-safe orders. Bids: UP=${bidPriceUp ?? "skip"} (EV=${evUp.edge.toFixed(4)}) DOWN=${bidPriceDown ?? "skip"} (EV=${evDown.edge.toFixed(4)}) settlementAnchor=${fairValue.settlementAnchorPrice?.toFixed(2) ?? "n/a"} predictiveComposite=${fairValue.predictiveCompositePrice?.toFixed(2) ?? "n/a"}`, "cyan");
      ctx.postOrders(ordersToPost);
    }
  };

  // Event Subscriptions for Quote Hygiene
  // Instantly re-evaluate (and potentially cancel) quotes when market state changes
  const unsubs: Array<() => void> = [];
  
  if (ctx.predictive?.aggregate) {
    unsubs.push(ctx.predictive.aggregate.subscribe(() => evaluateQuotes()));
  }
  if (ctx.quant) {
    unsubs.push(ctx.quant.subscribe(() => evaluateQuotes()));
  }
  if (ctx.orderFlow) {
    unsubs.push(ctx.orderFlow.subscribe(() => evaluateQuotes()));
  }

  // Fallback heartbeat timer for time-decay (Theta) and safety nets
  const tickInterval = ctx.clock.setInterval(() => evaluateQuotes(), 1000);

  // Initial evaluation
  evaluateQuotes();

  return () => {
    ctx.clock.clearInterval(tickInterval);
    unsubs.forEach(unsub => unsub());
  };
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

function quoteEv(
  probability: number,
  price: number | null,
  feeRate: number,
  makerRebateEstimate: number,
  feeAwareEdge: boolean,
) {
  if (price === null) {
    return { edge: Number.NEGATIVE_INFINITY, feeReference: 0 };
  }
  const feeReference = feeRate * price * (1 - price);
  return {
    edge: probability - price - (feeAwareEdge ? feeReference : 0) + makerRebateEstimate,
    feeReference,
  };
}

function makerSafePrice(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
  action: "buy" | "sell",
  targetPrice: number,
  makerOnly: boolean,
): number | null {
  if (!makerOnly) return targetPrice;
  const tokenId = ctx.orderBook.getTokenId?.(side) ?? (side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1]);
  const tick = Number.parseFloat(ctx.orderBook.getTickSize?.(tokenId) ?? "0.01");
  const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  if (action === "buy") {
    const ask = ctx.orderBook.bestAskPrice(side);
    if (ask === null) return null;
    return parseFloat(Math.min(targetPrice, ask - safeTick).toFixed(2));
  }
  const bid = ctx.orderBook.bestBidPrice(side);
  if (bid === null) return null;
  return parseFloat(Math.max(targetPrice, bid + safeTick).toFixed(2));
}

function makerBidWithinMax(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
  price: number | null,
  maxMakerBidPrice: number,
): boolean {
  if (price === null || price <= maxMakerBidPrice) return true;
  ctx.log(
    `[fair-value] No quote: candidate maker bid exceeds max maker bid price side=${side} price=${price.toFixed(2)} max=${maxMakerBidPrice.toFixed(2)}`,
    "yellow",
  );
  return false;
}

function exposureBlockKey(ctx: StrategyContext, side: "UP" | "DOWN", price: number, shares: number): string {
  return `buy:${side}:${price.toFixed(2)}:${shares.toFixed(4)}:${exposureStateFingerprint(ctx)}`;
}

function exposureStateFingerprint(ctx: StrategyContext): string {
  const history = ctx.orderHistory
    .map((order) => `${order.action}:${order.tokenId}:${order.price.toFixed(2)}:${order.shares.toFixed(4)}`)
    .join("|");
  const pending = ctx.pendingOrders
    .map((order) => `${order.action}:${order.tokenId}:${order.price.toFixed(2)}:${order.shares.toFixed(4)}`)
    .sort()
    .join("|");
  return `${history}::${pending}`;
}

function recordExposureBlock(
  ctx: StrategyContext,
  cooldowns: Map<string, number>,
  key: string,
  reason: string,
  cooldownMs: number,
): void {
  if (!reason.includes("open exposure would exceed max exposure limit")) return;
  cooldowns.set(key, ctx.clock.nowMs() + cooldownMs);
}

function logSuppressedAffordability(
  ctx: StrategyContext,
  cooldowns: Map<string, number>,
  side: "UP" | "DOWN",
  price: number,
  shares: number,
  reason: string,
  available: number,
): void {
  const key = `${side}:${price.toFixed(2)}:${shares.toFixed(4)}`;
  const now = ctx.clock.nowMs();
  const nextLogMs = cooldowns.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now < nextLogMs) return;
  cooldowns.set(key, now + 10_000);
  ctx.log(
    `[fair-value] Suppressing ${side} quote: ${reason} price=${price.toFixed(2)} shares=${shares} available=$${available.toFixed(4)}`,
    "dim",
  );
}

function isExposureBlocked(
  ctx: StrategyContext,
  cooldowns: Map<string, number>,
  key: string,
  side: "UP" | "DOWN",
  price: number,
  shares: number,
): boolean {
  const until = cooldowns.get(key);
  if (until === undefined) return false;
  if (ctx.clock.nowMs() >= until) {
    cooldowns.delete(key);
    return false;
  }
  ctx.log(
    `[fair-value] No quote: duplicate exposure-limit blocked intent suppressed side=${side} price=${price.toFixed(2)} shares=${shares}`,
    "yellow",
  );
  return true;
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
