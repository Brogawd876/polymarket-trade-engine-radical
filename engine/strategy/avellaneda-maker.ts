import type { OrderRequest, Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";
import { digitalCallProbability } from "../../utils/math.ts";
import { predictIsotonicProbability } from "../replay/isotonic-calibration.ts";
import type { IsotonicBucket } from "../replay/isotonic-calibration.ts";

export interface AvellanedaMakerConfig {
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

  /** Maximum absolute USD to spend on a single side per round. Prevents catastrophic side imbalance. */
  maxSpendAbs?: number;

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

  // ── v3.0.0 Momentum-Confirmed Dynamic Sizing ────────────────────────────────
  /**
   * Enable momentum-confirmed dynamic sizing.
   * Reads the velocity of the predictive composite price (Binance/Coinbase)
   * over a rolling window and scales sharePct accordingly:
   * - Strong confirming momentum → scale up to momentumMaxPct
   * - Contradicting momentum → scale down to momentumMinPct
   * - Neutral / no data → use base sharePct unchanged
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

  // ── v3.2.0 Max Drawdown Kill Switch ─────────────────────────────────────────
  /**
   * Enable per-round max drawdown kill switch.
   * If mark-to-market equity (cash + inventory × bestBid) drops below
   * startingBalance - maxDrawdownAbs, the bot cancels all orders and
   * stops trading for the remainder of the round.
   *
   * This caps catastrophic losses to a fixed dollar amount instead of
   * allowing the full bankroll to bleed out.
   */
  maxDrawdownEnabled?: boolean;
  /** Maximum allowed drawdown in absolute USD. Default: 15.00 */
  maxDrawdownAbs?: number;

  // ── v3.3.0 Probability-Based Pre-Settlement Liquidation ───────────────────
  /**
   * Enable probability-based liquidation.
   * If the bot holds UP inventory and P(UP) drops below `liquidationProbThreshold`,
   * it immediately sells all inventory at the best bid and blocks further buys.
   * Same logic for DOWN inventory when P(DOWN) drops below the threshold.
   *
   * This catches losses BEFORE binary resolution wipes the position to $0.
   * The bot salvages whatever the market will pay (e.g., sell UP at $0.30)
   * instead of holding to resolution and getting $0.00.
   */
  liquidationEnabled?: boolean;
  /** Probability threshold below which to liquidate. Default: 0.35 */
  liquidationProbThreshold?: number;

  // ── v3.4.0 Fill Rate Monitor ─────────────────────────────────────────────
  /**
   * Enable fill rate imbalance monitor.
   * Tracks per-side fill timestamps in a rolling window. If one side
   * accumulates `fillRateMaxImbalance` more fills than the other side
   * within `fillRateWindowMs`, that side is PAUSED until the other
   * side catches up (gets at least one fill) or the cooldown expires.
   *
   * This prevents burst-fill patterns where one side gets 7 fills in
   * 50ms while the other gets 0, causing catastrophic side imbalance.
   */
  fillRateMonitorEnabled?: boolean;
  /** Rolling window (ms) over which to count fills per side. Default: 10000 (10s). */
  fillRateWindowMs?: number;
  /** Max fill count advantage one side can have over the other. Default: 3. */
  fillRateMaxImbalance?: number;
  /** Cooldown (ms) to pause the fast-filling side. Default: 5000 (5s). */
  fillRatePauseDurationMs?: number;

  // ── v5.0.0 Paper-Faithful Avellaneda + Calibration ────────────────────────
  /**
   * When true, subtracts the Polymarket fee (feeRate × price × (1-price))
   * from the edge calculation in quoteEv(). This fixes a bug where fees
   * were computed but never used, causing edge to be overestimated.
   *
   * Defaults to true because Polymarket fees are real execution drag. Set false
   * only when reproducing old backtests that intentionally ignored fees.
   */
  feeAwareEdge?: boolean;

  /**
   * Isotonic calibration model. When provided, the raw Black-Scholes
   * probability is mapped through this model before being used for
   * edge calculation, inventory skew, and quote placement.
   *
   * This implements the paper's recommendation: "Never size on raw
   * probabilities; size only on calibrated probabilities."
   *
   * The model is produced by the offline calibration pipeline:
   * scripts/run-corpus-calibration-pipeline.ts
   */
  calibrationModel?: {
    buckets: Array<{ lowerScore: number; upperScore: number; calibratedRate: number; count: number; positiveCount: number; empiricalRate: number }>;
    sampleCount: number;
    positiveLabelRate: number;
  };
}

const DEFAULT_CONFIG: Required<AvellanedaMakerConfig> = {
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
  maxSpendAbs: Infinity,
  // v1.3.0 defaults — all disabled so legacy variants are unaffected
  edgeWeightedSizing: false,
  regimeWeightedSizing: false,
  fallingKnifeBlock: false,
  fallingKnifeWindow: 3,
  unstableBasisDownsize: false,
  unstableBasisThreshold: 5.0,
  // v1.4.0 defaults — disabled so all existing variants are unaffected
  takeProfitEnabled: false,
  takeProfitThreshold: 0.97,
  // v3.0.0 Momentum-Confirmed Dynamic Sizing defaults
  momentumSizingEnabled: false,
  momentumWindowMs: 5_000,
  momentumNeutralThreshold: 2.0,
  momentumMaxPct: 0.25,
  momentumMinPct: 0.05,
  // v3.2.0 Max Drawdown Kill Switch defaults
  maxDrawdownEnabled: false,
  maxDrawdownAbs: 15.00,
  // v3.3.0 Probability-Based Liquidation defaults
  liquidationEnabled: false,
  liquidationProbThreshold: 0.35,
  // v3.4.0 Fill Rate Monitor defaults
  fillRateMonitorEnabled: false,
  fillRateWindowMs: 10_000,
  fillRateMaxImbalance: 3,
  fillRatePauseDurationMs: 5_000,
  feeAwareEdge: true,
  calibrationModel: undefined as any,
  };

/**
 * Avellaneda-Stoikov Continuous Maker Strategy
 * 
 * Implements the "Market Maker" approach from the research paper:
 * 1. Calculates fair value probability via Black-Scholes digital option model.
 * 2. Places resting limit orders (Maker) to capture rebates and avoid taker fees.
 * 3. skews quotes based on current inventory to manage risk.
 */
export const avellanedaMaker: Strategy = async (ctx) => {
  const config = { ...DEFAULT_CONFIG, ...(ctx.strategyConfig as AvellanedaMakerConfig) };
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
  
  // ── v3.0.0 Momentum Velocity Buffer ────────────────────────────────────────
  // Rolling window of predictive composite prices to compute $/sec velocity
  const velocityBuffer: { ts: number; price: number }[] = [];

  // ── v3.2.0 Max Drawdown Kill Switch State ──────────────────────────────────
  const startingBalance = ctx.walletBalanceUsd;
  let drawdownKilled = false;

  // ── v3.3.0 Probability-Based Liquidation State ───────────────────────────
  let liquidationFiredUp = false;
  let liquidationFiredDown = false;
  let inFlightLiquidationUp = false;
  let inFlightLiquidationDown = false;

  // ── v3.4.0 Fill Rate Monitor State ───────────────────────────────────
  const fillTimestampsUp: number[] = [];
  const fillTimestampsDown: number[] = [];
  let fillRatePausedUp = 0;   // timestamp until which UP buys are paused
  let fillRatePausedDown = 0; // timestamp until which DOWN buys are paused

  /** Record a fill and check if the other side needs to be paused */
  const recordFillAndCheckImbalance = (side: "UP" | "DOWN") => {
    if (!config.fillRateMonitorEnabled) return;
    const now = ctx.clock.nowMs();
    const myTimestamps = side === "UP" ? fillTimestampsUp : fillTimestampsDown;
    const otherTimestamps = side === "UP" ? fillTimestampsDown : fillTimestampsUp;
    myTimestamps.push(now);

    // Prune timestamps outside the window
    const cutoff = now - config.fillRateWindowMs;
    while (myTimestamps.length > 0 && myTimestamps[0]! < cutoff) myTimestamps.shift();
    while (otherTimestamps.length > 0 && otherTimestamps[0]! < cutoff) otherTimestamps.shift();

    const myCount = myTimestamps.length;
    const otherCount = otherTimestamps.length;
    const imbalance = myCount - otherCount;

    if (imbalance >= config.fillRateMaxImbalance) {
      // This side is filling too fast — pause it
      if (side === "UP") {
        fillRatePausedUp = now + config.fillRatePauseDurationMs;
        ctx.log(`[avellaneda] v3.4.0 FILL RATE MONITOR: UP paused (${myCount} fills vs ${otherCount} in ${config.fillRateWindowMs}ms window)`, "yellow");
      } else {
        fillRatePausedDown = now + config.fillRatePauseDurationMs;
        ctx.log(`[avellaneda] v3.4.0 FILL RATE MONITOR: DOWN paused (${myCount} fills vs ${otherCount} in ${config.fillRateWindowMs}ms window)`, "yellow");
      }
    }
  };

  /** Check if a side is currently paused by the fill rate monitor */
  const isFillRatePaused = (side: "UP" | "DOWN"): boolean => {
    if (!config.fillRateMonitorEnabled) return false;
    const now = ctx.clock.nowMs();
    return side === "UP" ? now < fillRatePausedUp : now < fillRatePausedDown;
  };

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

    // v5.0.0: Apply isotonic calibration if a model is provided.
    // Maps raw Black-Scholes probability → historically-calibrated probability.
    // Per the paper: "Never size on raw probabilities; size only on calibrated probabilities."
    if (probUp !== null && probUp !== undefined && config.calibrationModel) {
      const calibrated = predictIsotonicProbability(config.calibrationModel as any, probUp);
      if (calibrated !== null) {
        probUp = calibrated;
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

    // 1. Determine current inventory
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
          totalSpendUp += h.price * h.shares;
        } else {
          const vwap = inventoryUp > 0 ? totalSpendUp / inventoryUp : 0;
          inventoryUp = Math.max(0, inventoryUp - h.shares);
          totalSpendUp = inventoryUp * vwap;
        }
      } else if (h.tokenId === downTokenId) {
        if (h.action === "buy") {
          inventoryDown += h.shares;
          totalSpendDown += h.price * h.shares;
          inventoryUp -= h.shares; // UP-equivalent inventory tracking (existing logic)
        } else {
          const vwap = inventoryDown > 0 ? totalSpendDown / inventoryDown : 0;
          inventoryDown = Math.max(0, inventoryDown - h.shares);
          totalSpendDown = inventoryDown * vwap;
          inventoryUp += h.shares;
        }
      }
    }
    for (const pending of ctx.pendingOrders) {
      if (pending.action !== "buy") continue;
      if (pending.tokenId === upTokenId) {
        totalSpendUp += pending.price * pending.shares;
      } else if (pending.tokenId === downTokenId) {
        totalSpendDown += pending.price * pending.shares;
      }
    }

    // ── v3.2.0 Max Drawdown Kill Switch ────────────────────────────────────────
    if (config.maxDrawdownEnabled && !drawdownKilled) {
      // Mark-to-market: cash + inventory value at current best bids
      const bidUp = ctx.orderBook.bestBidPrice("UP");
      const bidDown = ctx.orderBook.bestBidPrice("DOWN");
      const mtmInventory =
        (inventoryUp > 0 && bidUp !== null ? inventoryUp * bidUp : 0) +
        (inventoryDown > 0 && bidDown !== null ? inventoryDown * bidDown : 0);
      const currentEquity = ctx.walletBalanceUsd + mtmInventory;
      const drawdown = startingBalance - currentEquity;

      if (drawdown >= config.maxDrawdownAbs) {
        ctx.log(`[avellaneda] v3.2.0 DRAWDOWN KILL SWITCH: equity=$${currentEquity.toFixed(2)} drawdown=$${drawdown.toFixed(2)} >= limit=$${config.maxDrawdownAbs.toFixed(2)} — STOPPING ALL TRADING`, "yellow");
        drawdownKilled = true;
        ctx.cancelOrders(ctx.pendingOrders.map(o => o.orderId));
        ctx.blockBuys();
        isDone = true;
        releaseLock();
        return;
      }
    }
    if (drawdownKilled) return;

    // ── v3.3.0 Probability-Based Pre-Settlement Liquidation ───────────────────
    if (config.liquidationEnabled) {
      const upTokenId = ctx.clobTokenIds[0];
      const downTokenId = ctx.clobTokenIds[1];

      // Liquidate UP inventory if P(UP) has collapsed
      if (inventoryUp > 0 && !liquidationFiredUp && !inFlightLiquidationUp && probUp < config.liquidationProbThreshold) {
        const bestBidUp = ctx.orderBook.bestBidPrice("UP");
        if (bestBidUp !== null && bestBidUp > 0.01) {
          ctx.log(`[avellaneda] v3.3.0 LIQUIDATION TRIGGER: P(UP)=${probUp.toFixed(4)} < ${config.liquidationProbThreshold} — dumping ${inventoryUp} UP shares @ bestBid=$${bestBidUp.toFixed(2)}`, "yellow");
          // Cancel all pending buy orders first
          const pendingBuys = ctx.pendingOrders.filter(o => o.tokenId === upTokenId && o.action === "buy");
          if (pendingBuys.length > 0) ctx.cancelOrders(pendingBuys.map(o => o.orderId));
          // Emergency sell all UP inventory
          inFlightLiquidationUp = true;
          ctx.postOrders([{
            req: {
              tokenId: upTokenId,
              action: "sell",
              price: bestBidUp,
              shares: inventoryUp,
              orderType: "FOK",
            },
            expireAtMs: ctx.clock.nowMs() + 5000,
            onFilled: () => {
              liquidationFiredUp = true;
              inFlightLiquidationUp = false;
              ctx.log(`[avellaneda] v3.3.0 LIQUIDATION FILLED: UP inventory sold`, "yellow");
            },
            onFailed: () => { inFlightLiquidationUp = false; },
            onExpired: () => { inFlightLiquidationUp = false; },
          }]);
        }
      }

      // Liquidate DOWN inventory if P(DOWN) has collapsed
      const probDown = 1 - probUp;
      if (inventoryDown > 0 && !liquidationFiredDown && !inFlightLiquidationDown && probDown < config.liquidationProbThreshold) {
        const bestBidDown = ctx.orderBook.bestBidPrice("DOWN");
        if (bestBidDown !== null && bestBidDown > 0.01) {
          ctx.log(`[avellaneda] v3.3.0 LIQUIDATION TRIGGER: P(DOWN)=${probDown.toFixed(4)} < ${config.liquidationProbThreshold} — dumping ${inventoryDown} DOWN shares @ bestBid=$${bestBidDown.toFixed(2)}`, "yellow");
          const pendingBuys = ctx.pendingOrders.filter(o => o.tokenId === downTokenId && o.action === "buy");
          if (pendingBuys.length > 0) ctx.cancelOrders(pendingBuys.map(o => o.orderId));
          inFlightLiquidationDown = true;
          ctx.postOrders([{
            req: {
              tokenId: downTokenId,
              action: "sell",
              price: bestBidDown,
              shares: inventoryDown,
              orderType: "FOK",
            },
            expireAtMs: ctx.clock.nowMs() + 5000,
            onFilled: () => {
              liquidationFiredDown = true;
              inFlightLiquidationDown = false;
              ctx.log(`[avellaneda] v3.3.0 LIQUIDATION FILLED: DOWN inventory sold`, "yellow");
            },
            onFailed: () => { inFlightLiquidationDown = false; },
            onExpired: () => { inFlightLiquidationDown = false; },
          }]);
        }
      }

      // After liquidation fires on a side, block new buys on that side
      // (no point rebuilding a position we just dumped)
      if (liquidationFiredUp || liquidationFiredDown) {
        // Don't return — let normal quoting continue on the non-liquidated side
        // The buy blocks below will prevent re-accumulation
      }
    }

    // 2. Calculate Avellaneda-style reservation probability.
    //
    // NOTE: The paper formula r(s,q,t) = s - q·γ·σ²·(T-t) was tested and produces
    // near-zero skew for 5-minute windows because σ_prob² ≈ 1e-8 at this timescale.
    // Shootout showed v5.0.0 paper-faithful: -$249 vs v1.5.0 heuristic: -$126.
    //
    // We keep the battle-tested heuristic skew with two targeted improvements:
    // (1) Removed the 0.25 floor — skew now decays to 0 at expiry per the paper's
    //     insight that terminal skew should vanish (forces inventory liquidation).
    // (2) Volatility buffer uses probability sigma (σ_price · √T_years) instead of
    //     raw price sigma, capturing how much P(UP) can actually move.
    const timeFraction = Math.max(0, Math.min(1, remainingSecs / 300));
    const inventoryRatio = inventoryUp / config.maxInventory;

    // Heuristic skew: inventoryRatio × fixed skew factor × time decay
    // Restored 0.25 floor to match v1.5.0 — removing it was tested and hurt PnL
    const skew = inventoryRatio * config.inventorySkew * Math.max(0.25, timeFraction);
    const adjustedProbUp = Math.max(0.01, Math.min(0.99, probUp - skew));

    // Volatility buffer uses probability sigma for properly-scaled quote widening
    const yearsRemaining = Math.max(0, remainingSecs) / 31_536_000;
    const sigmaProbability = Math.max(0, sigma) * Math.sqrt(yearsRemaining);
    const volatilityBuffer = Math.min(0.05, sigmaProbability * 2);
    const quoteMargin = config.margin + volatilityBuffer + (quoteRegime?.volatilityRegime === "high_vol" ? config.highVolExtraMargin : 0);

    // 3. Define Quotes
        // Hygiene: Strictly bound raw quotes before attempting maker adjustments
    let rawBidPriceUp = parseFloat((adjustedProbUp - quoteMargin).toFixed(2));
    let rawBidPriceDown = parseFloat(((1 - adjustedProbUp) - quoteMargin).toFixed(2));
    
    let rawAskPriceUp = parseFloat((adjustedProbUp + quoteMargin).toFixed(2));
    let rawAskPriceDown = parseFloat(((1 - adjustedProbUp) + quoteMargin).toFixed(2));

    if (!config.skipHygiene) {
      if (rawBidPriceUp <= 0.01 || rawBidPriceUp > config.maxMakerBidPrice) rawBidPriceUp = NaN;
      if (rawBidPriceDown <= 0.01 || rawBidPriceDown > config.maxMakerBidPrice) rawBidPriceDown = NaN;
      if (rawAskPriceUp >= 0.99) rawAskPriceUp = NaN;
      if (rawAskPriceDown >= 0.99) rawAskPriceDown = NaN;
    }

    const bidPriceUp = Number.isFinite(rawBidPriceUp) ? makerSafePrice(ctx, "UP", "buy", rawBidPriceUp, config.makerOnly) : null;
    const bidPriceDown = Number.isFinite(rawBidPriceDown) ? makerSafePrice(ctx, "DOWN", "buy", rawBidPriceDown, config.makerOnly) : null;
    
    // For sells, makerSafePrice ensures we place our ask just above the best bid so we don't cross the spread
    const askPriceUp = Number.isFinite(rawAskPriceUp) ? makerSafePrice(ctx, "UP", "sell", rawAskPriceUp, config.makerOnly) : null;
    const askPriceDown = Number.isFinite(rawAskPriceDown) ? makerSafePrice(ctx, "DOWN", "sell", rawAskPriceDown, config.makerOnly) : null;

    // 3.5. Position Sizing — base
    // For fixed mode: targetShares is a constant share count.
    // For pct_of_balance mode: targetNotional = balance × pct; shares = notional / sidePrice.
    // This ensures notional risk is fixed regardless of price level.
    const balance = ctx.walletBalanceUsd;
    let targetNotional: number | null = null;  // pct_of_balance mode: USD notional per order
    let targetSharesBase = config.shares;      // fixed mode: share count
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

          if (dtSec > 0.5) {
            const velocityPerSec = (newest.price - oldest.price) / dtSec;
            const absVelocity = Math.abs(velocityPerSec);

            if (absVelocity > config.momentumNeutralThreshold) {
              const probUp = fairValue.probabilityUp;
              const momentumConfirms = probUp !== null && (
                (probUp > 0.5 && velocityPerSec > 0) ||
                (probUp < 0.5 && velocityPerSec < 0)
              );

              if (momentumConfirms) {
                const strength = Math.min(1.0, absVelocity / (config.momentumNeutralThreshold * 5));
                effectivePct = config.sharePct + (config.momentumMaxPct - config.sharePct) * strength;
                if (now % 10000 < 1100) {
                  ctx.log(`[avellaneda] v3.0.0 MOMENTUM CONFIRMS: velocity=$${velocityPerSec.toFixed(2)}/s → sizing UP to ${(effectivePct * 100).toFixed(1)}%`, "green");
                }
              } else {
                const strength = Math.min(1.0, absVelocity / (config.momentumNeutralThreshold * 5));
                effectivePct = config.sharePct - (config.sharePct - config.momentumMinPct) * strength;
                if (now % 10000 < 1100) {
                  ctx.log(`[avellaneda] v3.0.0 MOMENTUM CONTRADICTS: velocity=$${velocityPerSec.toFixed(2)}/s → sizing DOWN to ${(effectivePct * 100).toFixed(1)}%`, "yellow");
                }
              }
            }
          }
        }
      }

      targetNotional = balance * effectivePct;
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
    let existingSellUp = ctx.pendingOrders.find(o => o.tokenId === upTokenId && o.action === "sell");
    let existingSellDown = ctx.pendingOrders.find(o => o.tokenId === downTokenId && o.action === "sell");

    if (existingUp) inFlightUp = false;
    if (existingDown) inFlightDown = false;
    if (existingSellUp) inFlightSellUp = false;
    if (existingSellDown) inFlightSellDown = false;

    const feeRateUp = feeRate(ctx, upTokenId);
    const feeRateDown = feeRate(ctx, downTokenId);

        // Ensure resting quotes are still safe
    if (existingUp) {
      const existingEv = quoteEv(adjustedProbUp, existingUp.price, feeRateUp, config.makerRebateEstimate, config.feeAwareEdge);
      if (existingEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale UP buy quote: ${existingUp.price} (Edge: ${existingEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingUp.orderId]);
        existingUp = undefined;
      }
    }
    if (existingDown) {
      const existingEv = quoteEv(1 - adjustedProbUp, existingDown.price, feeRateDown, config.makerRebateEstimate, config.feeAwareEdge);
      if (existingEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale DOWN buy quote: ${existingDown.price} (Edge: ${existingEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingDown.orderId]);
        existingDown = undefined;
      }
    }
    if (existingSellUp) {
      // Selling UP at P is equivalent to buying DOWN at 1-P with probability 1-P_up
      const existingSellEv = quoteEv(1 - adjustedProbUp, 1 - existingSellUp.price, feeRateUp, config.makerRebateEstimate, config.feeAwareEdge);
      if (existingSellEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale UP sell quote: ${existingSellUp.price} (Edge: ${existingSellEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingSellUp.orderId]);
        existingSellUp = undefined;
      }
    }
    if (existingSellDown) {
      // Selling DOWN at P is equivalent to buying UP at 1-P with probability P_up
      const existingSellEv = quoteEv(adjustedProbUp, 1 - existingSellDown.price, feeRateDown, config.makerRebateEstimate, config.feeAwareEdge);
      if (existingSellEv.edge < config.minEdge) {
        ctx.log(`[fair-value] Canceling stale DOWN sell quote: ${existingSellDown.price} (Edge: ${existingSellEv.edge.toFixed(4)} < ${config.minEdge})`, "dim");
        ctx.cancelOrders([existingSellDown.orderId]);
        existingSellDown = undefined;
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
      let shares: number;
      if (targetNotional !== null && price > 0) {
        shares = Math.max(config.minShares, (targetNotional * edgeMultiplier) / price);
      } else {
        shares = Math.max(config.minShares, targetSharesBase * edgeMultiplier);
      }

      // Enforce maxSpendAbs per side
      if (Number.isFinite(config.maxSpendAbs) && price > 0) {
        const spentSoFar = side === "UP" ? totalSpendUp : totalSpendDown;
        const availableSpend = Math.max(0, config.maxSpendAbs - spentSoFar);
        const maxShares = availableSpend / price;
        if (shares > maxShares) {
          if (maxShares < config.minShares) {
            ctx.log(`[avellaneda] maxSpendAbs: ${side} capped — spent $${spentSoFar.toFixed(2)}/$${config.maxSpendAbs.toFixed(2)}`, "yellow");
            return 0;
          }
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
    // v3.3.0: also suppress buys after liquidation fires — no point rebuilding a dumped position
    if (liquidationFiredUp) {
      if (existingUp) ctx.cancelOrders([existingUp.orderId]);
    } else if (isFillRatePaused("UP")) {
      // v3.4.0: Fill rate monitor paused this side
      if (existingUp) ctx.cancelOrders([existingUp.orderId]);
    } else if (bidPriceUp !== null && bidPriceUp > 0.01 && bidPriceUp < 0.99 && evUp.edge >= config.minEdge && allowUpFlow) {
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
              onFilled: (_filledShares) => {
                // v3.5.0: Track per-side spend
                totalSpendUp += capturedFillPriceUp * _filledShares;
                // v3.4.0: Record fill for rate monitoring
                recordFillAndCheckImbalance("UP");
                // Compound falling-knife detection — only live-available signals, no replay leakage
                if (config.fallingKnifeBlock) {
                  const isAdverse = checkFallingKnifeAdverse("UP", capturedFillPriceUp);
                  if (isAdverse) {
                    consecutiveAdverseUp += 1;
                    if (consecutiveAdverseUp >= config.fallingKnifeWindow) {
                      sideBlockedUp = true;
                      ctx.log(`[fair-value] v1.3.0 falling-knife TRIGGERED: UP blocked after ${consecutiveAdverseUp} adverse fills @ ${capturedFillPriceUp.toFixed(3)}`, "yellow");
                    }
                  } else {
                    consecutiveAdverseUp = 0;
                  }
                }
              },
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

    if (liquidationFiredDown) {
      if (existingDown) ctx.cancelOrders([existingDown.orderId]);
    } else if (isFillRatePaused("DOWN")) {
      // v3.4.0: Fill rate monitor paused this side
      if (existingDown) ctx.cancelOrders([existingDown.orderId]);
    } else if (bidPriceDown !== null && bidPriceDown > 0.01 && bidPriceDown < 0.99 && evDown.edge >= config.minEdge && allowDownFlow) {
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
              onFilled: (_filledShares) => {
                // v3.5.0: Track per-side spend
                totalSpendDown += capturedFillPriceDown * _filledShares;
                // v3.4.0: Record fill for rate monitoring
                recordFillAndCheckImbalance("DOWN");
                // Compound falling-knife detection
                if (config.fallingKnifeBlock) {
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
                }
              },
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

        // ── v1.5.0 Avellaneda Continuous Ask Quoting ────────────────────────────────
    
    // Sell UP Inventory
    const evSellUp = askPriceUp !== null ? quoteEv(1 - adjustedProbUp, 1 - askPriceUp, feeRateUp, config.makerRebateEstimate, config.feeAwareEdge) : { edge: -1 };
    if (inventoryUp > 0 && askPriceUp !== null && askPriceUp >= 0.01 && askPriceUp <= 0.99 && evSellUp.edge >= config.minEdge) {
      if (!existingSellUp || Math.abs(existingSellUp.price - askPriceUp) > (0.005)) {
        if (existingSellUp) {
          ctx.log(`[fair-value] Replacing UP sell quote: ${existingSellUp.price} -> ${askPriceUp}`, "dim");
          ctx.cancelOrders([existingSellUp.orderId]);
        }
        if (!inFlightSellUp) {
          inFlightSellUp = true;
          ordersToPost.push({
            req: {
              tokenId: upTokenId,
              action: "sell",
              price: askPriceUp,
              shares: inventoryUp,
              orderType: "GTC",
            },
            expireAtMs: ctx.clock.nowMs() + 10000,
            onFilled: () => { inFlightSellUp = false; },
            onFailed: () => { inFlightSellUp = false; },
            onExpired: () => { inFlightSellUp = false; }
          });
        }
      }
    } else if (existingSellUp && inventoryUp === 0) {
      ctx.cancelOrders([existingSellUp.orderId]);
    }

    // Sell DOWN Inventory
    const evSellDown = askPriceDown !== null ? quoteEv(adjustedProbUp, 1 - askPriceDown, feeRateDown, config.makerRebateEstimate, config.feeAwareEdge) : { edge: -1 };
    if (inventoryDown > 0 && askPriceDown !== null && askPriceDown >= 0.01 && askPriceDown <= 0.99 && evSellDown.edge >= config.minEdge) {
      if (!existingSellDown || Math.abs(existingSellDown.price - askPriceDown) > (0.005)) {
        if (existingSellDown) {
          ctx.log(`[fair-value] Replacing DOWN sell quote: ${existingSellDown.price} -> ${askPriceDown}`, "dim");
          ctx.cancelOrders([existingSellDown.orderId]);
        }
        if (!inFlightSellDown) {
          inFlightSellDown = true;
          ordersToPost.push({
            req: {
              tokenId: downTokenId,
              action: "sell",
              price: askPriceDown,
              shares: inventoryDown,
              orderType: "GTC",
            },
            expireAtMs: ctx.clock.nowMs() + 10000,
            onFilled: () => { inFlightSellDown = false; },
            onFailed: () => { inFlightSellDown = false; },
            onExpired: () => { inFlightSellDown = false; }
          });
        }
      }
    } else if (existingSellDown && inventoryDown === 0) {
      ctx.cancelOrders([existingSellDown.orderId]);
    }

    if (ordersToPost.length > 0) {
      ctx.log(`[fair-value] Posting ${ordersToPost.length} maker-safe orders. Bids: UP=${bidPriceUp ?? "skip"} DOWN=${bidPriceDown ?? "skip"} | Asks: UP=${askPriceUp ?? "skip"} DOWN=${askPriceDown ?? "skip"}`, "cyan");
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

function quoteEv(probability: number, price: number | null, feeRate: number, makerRebateEstimate: number, feeAwareEdge: boolean = false) {
  if (price === null) {
    return { edge: Number.NEGATIVE_INFINITY, feeReference: 0 };
  }
  const takerFee = 0;
  const feeReference = feeRate * price * (1 - price);
  // v5.0.0: When feeAwareEdge is true, subtract the actual Polymarket fee from edge.
  // Previously this was computed but NEVER USED — a bug per the research paper which
  // states: "edge = estimated probability minus market price minus execution cost."
  const feeDeduction = feeAwareEdge ? feeReference : 0;
  return {
    edge: probability - price - takerFee - feeDeduction + makerRebateEstimate,
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
  config: Required<AvellanedaMakerConfig>,
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
