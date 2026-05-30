import { 
  type BotAsset, 
  type Clock, 
  RealClock,
  type QuantSnapshot,
  type QuantMonitor,
  type PredictiveSignalAggregator,
  type ResolutionSourceAdapter,
  type RoundWindow
} from "./data-sources.ts";
import { digitalCallProbability } from "../../utils/math.ts";

export type QuantMonitorOptions = {
  asset: BotAsset;
  aggregator: PredictiveSignalAggregator;
  resolution: ResolutionSourceAdapter;
  clock?: Clock;
  rvWindow?: number;
};

/**
 * DefaultQuantMonitor implementation.
 * Integrates price aggregate and resolution threshold to produce 
 * real-time fair-value probabilities.
 */
export class DefaultQuantMonitor implements QuantMonitor {
  private asset: BotAsset;
  private aggregator: PredictiveSignalAggregator;
  private resolution: ResolutionSourceAdapter;
  private clock: Clock;
  private rvWindow: number;

  private samples: Array<{ price: number; ts: number }> = [];
  private handlers = new Set<(snapshot: QuantSnapshot) => void>();
  private _latest: QuantSnapshot;

  constructor(opts: QuantMonitorOptions) {
    this.asset = opts.asset;
    this.aggregator = opts.aggregator;
    this.resolution = opts.resolution;
    this.clock = opts.clock ?? new RealClock();
    this.rvWindow = opts.rvWindow ?? 20;

    this._latest = {
      asset: this.asset,
      timestampMs: this.clock.nowMs(),
      sigma: null,
      probabilityUp: null,
      settlementAnchorPrice: null,
      settlementRoundId: null,
      settlementUpdatedAtMs: null,
      settlementLagMs: null,
      settlementIsStale: true,
      predictiveCompositePrice: null,
      noTradeReason: "missing settlement anchor",
    };

    // Subscriptions
    this.aggregator.subscribe(() => this.update());
  }

  latest(): QuantSnapshot {
    return this._latest;
  }

  subscribe(handler: (snapshot: QuantSnapshot) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private update() {
    const agg = this.aggregator.latest();
    const price = agg.price;
    const now = this.clock.nowMs();
    if (price === null) return;

    this.samples.push({ price, ts: now });
    if (this.samples.length > this.rvWindow + 1) {
      this.samples.shift();
    }

    const sigma = this._calculateSigma();
    const resolution = this.resolution.latest();
    const anchor =
      typeof this.resolution.latestAnchor === "function"
        ? this.resolution.latestAnchor()
        : null;

    const settlementIsStale =
      !anchor ||
      !resolution ||
      resolution.quality !== "live" ||
      resolution.stalenessStatus === "stale" ||
      resolution.stalenessStatus === "missing" ||
      resolution.stalenessStatus === "degraded";
    const probabilityUp = settlementIsStale
      ? null
      : this._calculateProbability(price, sigma, anchor);

    this._latest = {
      asset: this.asset,
      timestampMs: now,
      sigma,
      probabilityUp,
      settlementAnchorPrice: anchor?.priceToBeat ?? anchor?.price ?? null,
      settlementRoundId: anchor?.roundId ?? null,
      settlementUpdatedAtMs: anchor?.chainUpdatedAtMs ?? anchor?.clock.sourceTimestampMs ?? null,
      settlementLagMs: resolution?.oracleLagMs ?? resolution?.lagMs ?? null,
      settlementIsStale,
      predictiveCompositePrice: price,
      noTradeReason: settlementIsStale ? "settlement anchor is missing or Chainlink resolution feed is stale" : probabilityUp === null ? "insufficient volatility estimate" : null,
    };
    for (const handler of this.handlers) {
      handler(this._latest);
    }
  }

  private _calculateSigma(): number | null {
    if (this.samples.length < 2) return null;

    let sumAnnualizedSqReturns = 0;
    let totalTimeYears = 0;

    const MS_PER_YEAR = 1000 * 3600 * 24 * 365;

    for (let i = 1; i < this.samples.length; i++) {
      const p1 = this.samples[i - 1]!.price;
      const p2 = this.samples[i]!.price;
      const dtMs = this.samples[i]!.ts - this.samples[i - 1]!.ts;
      
      // Avoid division by zero if multiple ticks happen at same timestamp
      if (dtMs <= 0) continue;

      const logReturn = Math.log(p2 / p1);
      const dtYears = dtMs / MS_PER_YEAR;

      // Variance is proportional to time. Annualized variance per step = return^2 / dtYears
      sumAnnualizedSqReturns += Math.pow(logReturn, 2) / dtYears;
      totalTimeYears += dtYears;
    }

    if (totalTimeYears === 0) return null;

    // The average annualized variance
    const avgAnnualizedVariance = sumAnnualizedSqReturns / (this.samples.length - 1);
    return Math.sqrt(avgAnnualizedVariance);
  }

  private _calculateProbability(
    predictiveCompositePrice: number,
    sigma: number | null,
    res: NonNullable<ReturnType<ResolutionSourceAdapter["latest"]>>,
  ): number | null {
    if (sigma === null) return null;

    if (!res.round) return null;

    const K = res.priceToBeat ?? res.price;
    const now = this.clock.nowMs();
    const T_ms = res.round.endTimeMs - now;
    
    if (T_ms <= 0) return predictiveCompositePrice >= K ? 1 : 0;

    // Convert T to years
    const T_years = T_ms / (1000 * 3600 * 24 * 365);

    return digitalCallProbability(predictiveCompositePrice, K, T_years, sigma);
  }
}
