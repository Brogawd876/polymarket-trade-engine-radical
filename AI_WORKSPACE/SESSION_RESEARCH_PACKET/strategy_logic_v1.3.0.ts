import type { OrderRequest, Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";
import { digitalCallProbability } from "../../utils/math.ts";

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
}

const DEFAULT_CONFIG: Required<FairValueMakerConfig> = {
  skipHygiene: false,
  sharesMode: "fixed",
  sharePct: 0.10,
  shares: 10,
  minShares: 1,
  margin: 0.01,
  inventorySkew: 0.05, // Skew price by 5% of fair value per maxInventory unit
  maxInventory: 100,
  minEdge: 0.005,
  makerRebateEstimate: 0,
  minImbalance: -0.5,
  minCvd10s: -100,
  makerOnly: true,
  blockOnJump: true,
  maxSigma: 1.5,
  highVolExtraMargin: 0.02,
  maxMakerBidPrice: 0.89,
  exposureBlockCooldownMs: 10_000,
  // v1.3.0 defaults — all disabled so legacy variants are unaffected
  edgeWeightedSizing: false,
  regimeWeightedSizing: false,
  fallingKnifeBlock: false,
  fallingKnifeWindow: 3,
  unstableBasisDownsize: false,
  unstableBasisThreshold: 5.0,
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
    const probUp = fairValue.probabilityUp;
    
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

    // 1. Determine current inventory
    const upTokenId = ctx.clobTokenIds[0];
    const downTokenId = ctx.clobTokenIds[1];
    
    let inventoryUp = 0;
    for (const h of ctx.orderHistory) {
      if (h.tokenId === upTokenId) {
        inventoryUp += (h.action === "buy" ? h.shares : -h.shares);
      } else if (h.tokenId === downTokenId) {
        inventoryUp += (h.action === "buy" ? -h.shares : h.shares);
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
    // For fixed mode: targetShares is a constant share count.
    // For pct_of_balance mode: targetNotional = balance × pct; shares = notional / sidePrice.
    // This ensures notional risk is fixed regardless of price level.
    const balance = ctx.walletBalanceUsd;
    let targetNotional: number | null = null;  // pct_of_balance mode: USD notional per order
    let targetSharesBase = config.shares;      // fixed mode: share count
    if (config.sharesMode === "pct_of_balance" && balance > 0) {
      targetNotional = balance * config.sharePct;
      // targetSharesBase is unused in pct_of_balance mode; per-side shares computed from notional/price
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
      const existingEv = quoteEv(adjustedProbUp, existingUp.price, feeRateUp, config.makerRebateEstimate);
      if (existingEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale UP quote: ${existingUp.price} (Edge: ${existingEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingUp.orderId]);
        existingUp = undefined;
      }
    }
    if (existingDown) {
      const existingEv = quoteEv(1 - adjustedProbUp, existingDown.price, feeRateDown, config.makerRebateEstimate);
      if (existingEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale DOWN quote: ${existingDown.price} (Edge: ${existingEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingDown.orderId]);
        existingDown = undefined;
      }
    }

    const ordersToPost: OrderRequest[] = [];

    const TOLERANCE = 0.01;
    const EPSILON = 0.0001;

    const evUp = quoteEv(adjustedProbUp, bidPriceUp, feeRateUp, config.makerRebateEstimate);
    const evDown = quoteEv(1 - adjustedProbUp, bidPriceDown, feeRateDown, config.makerRebateEstimate);
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
      if (targetNotional !== null && price > 0) {
        // True notional sizing: fixed dollar risk per order
        return Math.max(config.minShares, (targetNotional * edgeMultiplier) / price);
      }
      return Math.max(config.minShares, targetSharesBase * edgeMultiplier);
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

    if (bidPriceUp !== null && bidPriceUp > 0.01 && bidPriceUp < 0.99 && evUp.edge >= config.minEdge && allowUpFlow) {
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

    if (bidPriceDown !== null && bidPriceDown > 0.01 && bidPriceDown < 0.99 && evDown.edge >= config.minEdge && allowDownFlow) {
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

function quoteEv(probability: number, price: number | null, feeRate: number, makerRebateEstimate: number) {
  if (price === null) {
    return { edge: Number.NEGATIVE_INFINITY, feeReference: 0 };
  }
  const takerFee = 0;
  const feeReference = feeRate * price * (1 - price);
  return {
    edge: probability - price - takerFee + makerRebateEstimate,
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
