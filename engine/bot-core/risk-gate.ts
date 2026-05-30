import {
  type BotFeedEvent,
  type LeadLagSnapshot,
  type PredictiveAggregateSnapshot,
  type ResolutionPriceEvent,
  type VenueOrderBookEvent,
  type OrderFlowSnapshot,
} from "./data-sources.ts";
import { Env } from "../../utils/config.ts";
import { isPolymarketMaintenance } from "../../utils/maintenance.ts";
import type { PlaceOrderIntent, StrategyIntent } from "./strategy-intent.ts";
import { isPlaceOrderIntent } from "./strategy-intent.ts";

export type RiskDecision =
  | {
      approved: true;
      intent: StrategyIntent;
      checkedAtMs: number;
      reasons: string[];
    }
  | {
      approved: false;
      intent: StrategyIntent;
      checkedAtMs: number;
      reasons: string[];
    };

export type RiskSnapshot = {
  nowMs: number;
  productionEnabled: boolean;
  resolution: BotFeedEvent | null;
  venue: BotFeedEvent | null;
  predictiveFeeds: BotFeedEvent[];
  predictiveAggregate?: PredictiveAggregateSnapshot | null;
  leadLag?: LeadLagSnapshot | null;
  orderFlow?: OrderFlowSnapshot | null;
  probabilityUp?: number | null;
  sigma?: number | null;
  maintenance?: { active: boolean; reason?: string } | null;
  openExposureUsd: number;

  sessionPnlUsd: number;
  clobTokenIds?: [string, string];
};

export type StaticRiskLimits = {
  allowProduction: boolean;
  maxOrderNotionalUsd: number;
  maxSharesPerOrder: number;
  maxOpenExposureUsd: number;
  maxSessionLossUsd: number;
  maxFeedFreshnessMs: number;
  maxOracleLagMs: number;
  noTradeLastMs: number;
};

export type ExecutionQualityLimits = {
  /** Maximum best bid/ask spread allowed (e.g. 0.05). */
  maxSpreadUsd: number;
  /** Maximum age of the venue quote (ms). Default 500ms. */
  maxVenueAgeMs: number;
  /** Minimum liquidity required at or better than target price. Defaults to 1.0 (shares). */
  minTargetLiquidity: number;
  /** Maximum allowed slippage percentage relative to best price. Default 1.0 (1%). */
  maxSlippagePct: number;
  /** If true, block orders that are theoretically unprofitable after taker fees. Default false. */
  requireProfitability: boolean;
};

export interface RiskGate {
  evaluate(intent: StrategyIntent, snapshot: RiskSnapshot): RiskDecision;
}

export const DEFAULT_SIMULATION_RISK_LIMITS: StaticRiskLimits = {
  allowProduction: false,
  maxOrderNotionalUsd: 10,
  maxSharesPerOrder: 25,
  maxOpenExposureUsd: 50,
  maxSessionLossUsd: 3,
  maxFeedFreshnessMs: 1000,
  maxOracleLagMs: 60_000,
  noTradeLastMs: 5000,
};

export const DEFAULT_EXECUTION_QUALITY_LIMITS: ExecutionQualityLimits = {
  /**
   * Deployed defaults are tightened to professional levels to prevent
   * accidental execution during extreme volatility or stale feed windows.
   */
  maxSpreadUsd: 0.1,
  maxVenueAgeMs: 5000, // 5 seconds
  minTargetLiquidity: 0,
  maxSlippagePct: 1.0,
  requireProfitability: false,
};
export class StaticRiskGate implements RiskGate {
  constructor(
    private readonly limits: StaticRiskLimits = DEFAULT_SIMULATION_RISK_LIMITS,
  ) {}

  evaluate(intent: StrategyIntent, snapshot: RiskSnapshot): RiskDecision {
    const reasons: string[] = [];

    if (snapshot.productionEnabled && !this.limits.allowProduction) {
      reasons.push("production trading is disabled by this risk gate");
    }

    const remainingMs = intent.round.endTimeMs - snapshot.nowMs;
    if (remainingMs <= this.limits.noTradeLastMs) {
      reasons.push("market is inside the configured no-trade close window");
    }

    if (snapshot.sessionPnlUsd <= -Math.abs(this.limits.maxSessionLossUsd)) {
      reasons.push("session loss limit is reached");
    }

    const maintenance = snapshot.maintenance;
    if (maintenance?.active) {
      reasons.push(
        `Polymarket matching engine maintenance: ${maintenance.reason}`,
      );
    }

    this.checkFeedFreshness(
      "resolution",
      snapshot.resolution,
      snapshot,
      reasons,
    );
    this.checkFeedFreshness("venue", snapshot.venue, snapshot, reasons);

    if (isPlaceOrderIntent(intent)) {
      this.checkOrderIntent(intent, snapshot, reasons);
    }

    return {
      approved: reasons.length === 0,
      intent,
      checkedAtMs: snapshot.nowMs,
      reasons: reasons.length === 0 ? ["approved"] : reasons,
    };
  }

  private checkFeedFreshness(
    label: string,
    event: BotFeedEvent | null,
    snapshot: RiskSnapshot,
    reasons: string[],
  ): void {
    if (!event) {
      reasons.push(`${label} feed is missing`);
      return;
    }
    if (event.quality === "stale" || event.quality === "missing") {
      reasons.push(`${label} feed quality is ${event.quality}`);
    }
    const maxSourceFreshnessMs =
      label === "resolution"
        ? this.limits.maxOracleLagMs
        : this.limits.maxFeedFreshnessMs;
    const maxReceivedAgeMs =
      label === "resolution"
        ? Math.max(this.limits.maxFeedFreshnessMs, 3_000)
        : this.limits.maxFeedFreshnessMs;
    if (event.freshnessMs !== null && event.freshnessMs > maxSourceFreshnessMs) {
      reasons.push(`${label} feed is stale by freshness threshold`);
    }
    if (snapshot.nowMs - event.clock.receivedAtMs > maxReceivedAgeMs) {
      reasons.push(`${label} feed is stale by received age threshold`);
    }
    if (label === "resolution") {
      this.checkResolutionTruth(event as ResolutionPriceEvent, snapshot, reasons);
    }
  }

  private checkResolutionTruth(
    event: ResolutionPriceEvent,
    snapshot: RiskSnapshot,
    reasons: string[],
  ): void {
    if (event.stalenessStatus === "stale" || event.stalenessStatus === "missing" || event.stalenessStatus === "degraded") {
      reasons.push(`resolution staleness status is ${event.stalenessStatus}`);
    }
    const oracleLagMs = event.oracleLagMs ?? event.lagMs;
    if (oracleLagMs !== null && oracleLagMs !== undefined && oracleLagMs > this.limits.maxOracleLagMs) {
      reasons.push("resolution oracle lag exceeds threshold");
    }
    if (snapshot.productionEnabled && event.sourceType !== "chainlink_polygon") {
      reasons.push("production requires Chainlink Polygon settlement truth");
    }
  }

  private checkOrderIntent(
    intent: PlaceOrderIntent,
    snapshot: RiskSnapshot,
    reasons: string[],
  ): void {
    const notional = intent.price * intent.shares;
    if (notional > this.limits.maxOrderNotionalUsd) {
      reasons.push("order notional exceeds max order limit");
    }
    if (intent.shares > this.limits.maxSharesPerOrder) {
      reasons.push("order shares exceed max shares limit");
    }
    if (
      intent.action === "buy" &&
      snapshot.openExposureUsd + notional > this.limits.maxOpenExposureUsd
    ) {
      reasons.push("open exposure would exceed max exposure limit");
    }
    if (intent.expireAtMs > intent.round.endTimeMs) {
      reasons.push("order expiry is after round end");
    }
  }
}

/**
 * ExecutionQualityGate focuses on the immediate liquidity and spread of the
 * Polymarket venue. It ensures the order book is healthy enough to support
 * the intended order.
 */
export class ExecutionQualityGate implements RiskGate {
  constructor(
    private readonly limits: ExecutionQualityLimits = DEFAULT_EXECUTION_QUALITY_LIMITS,
  ) {}

  evaluate(intent: StrategyIntent, snapshot: RiskSnapshot): RiskDecision {
    const reasons: string[] = [];

    // Only applies to order placement
    if (!isPlaceOrderIntent(intent)) {
      return {
        approved: true,
        intent,
        checkedAtMs: snapshot.nowMs,
        reasons: ["approved"],
      };
    }

    const venue = snapshot.venue as VenueOrderBookEvent | null;
    if (!venue) {
      reasons.push("venue feed is missing");
      return this.result(intent, snapshot, reasons);
    }

    // 1. Stale Quote Check (Venue-specific strict threshold)
    const venueAge = snapshot.nowMs - venue.clock.receivedAtMs;
    if (venueAge > this.limits.maxVenueAgeMs) {
      reasons.push(
        `venue quote is stale (${venueAge}ms > ${this.limits.maxVenueAgeMs}ms limit)`,
      );
    }

    // 2. Side Detection
    // Robust side detection: use clobTokenIds if available, fall back to substring check.
    let isUp = false;
    if (snapshot.clobTokenIds) {
      if (intent.tokenId === snapshot.clobTokenIds[0]) {
        isUp = true;
      } else if (intent.tokenId === snapshot.clobTokenIds[1]) {
        isUp = false;
      } else {
        isUp = intent.tokenId.toLowerCase().includes("up");
      }
    } else {
      isUp = intent.tokenId.toLowerCase().includes("up");
    }

    // 3. Spread Check
    const bid = isUp ? venue.bestBidUp : venue.bestBidDown;
    const ask = isUp ? venue.bestAskUp : venue.bestAskDown;

    if (bid !== null && ask !== null) {
      const spread = ask - bid;
      if (spread > this.limits.maxSpreadUsd + 1e-9) {
        reasons.push(
          `spread is too wide ($${spread.toFixed(3)} > $${this.limits.maxSpreadUsd.toFixed(3)} limit)`,
        );
      }
    } else {
      reasons.push("best bid or ask is missing from venue");
    }

    // 4. Maker vs Taker detection
    let isTaker = false;
    if (ask !== null && intent.action === "buy" && intent.price >= ask - 1e-9) {
      isTaker = true;
    } else if (bid !== null && intent.action === "sell" && intent.price <= bid + 1e-9) {
      isTaker = true;
    }

    // 5. Liquidity/Depth/Fee-Aware Check (Takers only)
    if (isTaker) {
      const bookSide = isUp ? venue.up : venue.down;
      if (bookSide) {
        const levels = intent.action === "buy" ? bookSide.asks : bookSide.bids;
        const bestPrice = isUp
          ? intent.action === "buy"
            ? venue.bestAskUp
            : venue.bestBidUp
          : intent.action === "buy"
            ? venue.bestAskDown
            : venue.bestBidDown;

        let filledShares = 0;
        let totalUsdc = 0;
        const targetShares = intent.shares;

        for (const [price, size] of levels) {
          if (filledShares >= targetShares) break;

          const priceOk =
            intent.action === "buy"
              ? price <= intent.price + 1e-9
              : price >= intent.price - 1e-9;

          if (priceOk) {
            const take = Math.min(size, targetShares - filledShares);
            filledShares += take;
            totalUsdc += take * price;
          }
        }

        const required = Math.max(targetShares, this.limits.minTargetLiquidity);
        if (filledShares < required - 1e-9 || filledShares <= 0) {
          reasons.push(
            `insufficient liquidity at target price ($${filledShares.toFixed(2)} < $${required.toFixed(2)} required)`,
          );
          return this.result(intent, snapshot, reasons);
        }

        // 6. Effective Price & Slippage Check
        const effectivePrice = totalUsdc / filledShares;
        if (bestPrice !== null && bestPrice > 0) {
          const slippage =
            intent.action === "buy"
              ? (effectivePrice - bestPrice) / bestPrice
              : (bestPrice - effectivePrice) / bestPrice;
          const slippagePct = slippage * 100;
          if (slippagePct > this.limits.maxSlippagePct + 1e-7) {
            reasons.push(
              `excessive slippage (${slippagePct.toFixed(2)}% > ${this.limits.maxSlippagePct.toFixed(2)}% limit)`,
            );
          }
        }

        // 7. Fee-Aware Profitability Check
        if (this.limits.requireProfitability) {
          // Polymarket dynamic fee formula: rate * price * (1 - price)
          // Handle both BPS (e.g. 10) and decimal (e.g. 0.001) inputs.
          let rate = venue.feeRateBps ?? 0;
          if (rate > 1.0) rate = rate / 10000;

          const feePerShare = rate * effectivePrice * (1 - effectivePrice);
          const effectivePriceWithFees =
            intent.action === "buy"
              ? effectivePrice + feePerShare
              : effectivePrice - feePerShare;

          const profitable =
            intent.action === "buy"
              ? effectivePriceWithFees <= intent.price + 1e-9
              : effectivePriceWithFees >= intent.price - 1e-9;

          if (!profitable) {
            reasons.push(
              `fill unprofitable after fees (effective: $${effectivePriceWithFees.toFixed(4)} vs intent: $${intent.price.toFixed(4)})`,
            );
          }
        }
      } else {
        reasons.push("orderbook data is missing for the target side");
      }
    }

    return this.result(intent, snapshot, reasons);
  }

  private result(
    intent: StrategyIntent,
    snapshot: RiskSnapshot,
    reasons: string[],
  ): RiskDecision {
    return {
      approved: reasons.length === 0,
      intent,
      checkedAtMs: snapshot.nowMs,
      reasons: reasons.length === 0 ? ["approved"] : reasons,
    };
  }
}

export type AggregatedRiskGateOptions = {
  staticLimits?: StaticRiskLimits;
  qualityLimits?: ExecutionQualityLimits;
  baseGate?: RiskGate;
  qualityGate?: RiskGate;
  /**
   * Conservative future hook. Default false because "none" commonly means
   * insufficient warm-up samples, not proven bad signal quality.
   */
  blockOnInsufficientLeadLagSamples?: boolean;
};

export const DEFAULT_PRODUCTION_RISK_LIMITS: StaticRiskLimits = {
  allowProduction: true,
  maxOrderNotionalUsd: 50,
  maxSharesPerOrder: 100,
  maxOpenExposureUsd: 250,
  maxSessionLossUsd: 10,
  maxFeedFreshnessMs: 500, // Strict 500ms
  maxOracleLagMs: 30_000,   // Strict 30s
  noTradeLastMs: 15000,    // Stop trading 15s before close
};

export const DEFAULT_PRODUCTION_EXECUTION_QUALITY_LIMITS: ExecutionQualityLimits = {
  maxSpreadUsd: 0.05,        // Max 5c spread
  maxVenueAgeMs: 500,       // Max 500ms old quote
  minTargetLiquidity: 1.0,  // Require at least 1 share
  maxSlippagePct: 1.0,      // Max 1% slippage
  requireProfitability: true, // Must be EV+ after taker fees
};

export class AggregatedRiskGate implements RiskGate {
  private readonly baseGate: RiskGate;
  private readonly qualityGate: RiskGate;
  private readonly _staticLimits: StaticRiskLimits;

  constructor(private readonly opts: AggregatedRiskGateOptions = {}) {
    const isProd = Env.get("PROD");
    const staticLimits =
      opts.staticLimits ??
      (isProd
        ? DEFAULT_PRODUCTION_RISK_LIMITS
        : DEFAULT_SIMULATION_RISK_LIMITS);
    const qualityLimits =
      opts.qualityLimits ??
      (isProd
        ? DEFAULT_PRODUCTION_EXECUTION_QUALITY_LIMITS
        : DEFAULT_EXECUTION_QUALITY_LIMITS);

    this._staticLimits = staticLimits;
    this.baseGate = opts.baseGate ?? new StaticRiskGate(staticLimits);
    this.qualityGate =
      opts.qualityGate ?? new ExecutionQualityGate(qualityLimits);
  }

  get staticLimits(): StaticRiskLimits {
    return this._staticLimits;
  }

  evaluate(intent: StrategyIntent, snapshot: RiskSnapshot): RiskDecision {
    const baseDecision = this.baseGate.evaluate(intent, snapshot);
    const qualityDecision = this.qualityGate.evaluate(intent, snapshot);

    const reasons: string[] = [];
    if (!baseDecision.approved) {
      reasons.push(...baseDecision.reasons.filter((r) => r !== "approved"));
    }
    if (!qualityDecision.approved) {
      reasons.push(...qualityDecision.reasons.filter((r) => r !== "approved"));
    }

    if (snapshot.predictiveAggregate?.disagreement === true) {
      reasons.push("predictive aggregate disagreement is true");
    }

    const leadLag = snapshot.leadLag;
    if (
      this.opts.blockOnInsufficientLeadLagSamples === true &&
      leadLag &&
      leadLag.leadershipConfidence === "none" &&
      leadLag.sufficientSamples === false
    ) {
      reasons.push("lead-lag monitor has insufficient samples");
    }

    return {
      approved: reasons.length === 0,
      intent,
      checkedAtMs: snapshot.nowMs,
      reasons: reasons.length === 0 ? ["approved"] : reasons,
    };
  }
}
