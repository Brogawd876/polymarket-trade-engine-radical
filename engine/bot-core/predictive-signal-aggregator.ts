import {
  type BotAsset,
  type PredictiveFeedAdapter,
  type PredictivePriceEvent,
  type PredictiveAggregateSnapshot,
  type PredictiveSignalAggregator,
  type ResolutionSourceAdapter,
  type VenueDataAdapter,
  type Clock,
  RealClock,
} from "./data-sources";

export type AggregatorOptions = {
  asset: BotAsset;
  feeds: Record<string, PredictiveFeedAdapter>;
  /** Weights per feed. Default: uniform weights. Example: { binance: 0.7, coinbase: 0.3 } */
  feedWeights?: Record<string, number>;
  /** Max divergence between feeds before marking disagreement. Default: 50 ($50 for BTC). */
  divergenceThresholdAbs?: number;
  resolution?: ResolutionSourceAdapter;
  venue?: VenueDataAdapter;
  clock?: Clock;
};

export class DefaultPredictiveAggregator implements PredictiveSignalAggregator {
  private asset: BotAsset;
  private feeds: Record<string, PredictiveFeedAdapter>;
  private latestEvents = new Map<string, PredictivePriceEvent>();
  private handlers = new Set<(snapshot: PredictiveAggregateSnapshot) => void>();
  private divergenceThresholdAbs: number;
  private feedWeights: Record<string, number>;
  private clock: Clock;
  private resolution?: ResolutionSourceAdapter;
  private venue?: VenueDataAdapter;

  constructor(opts: AggregatorOptions) {
    this.asset = opts.asset;
    this.feeds = opts.feeds;
    this.divergenceThresholdAbs = opts.divergenceThresholdAbs ?? 50;
    this.feedWeights = opts.feedWeights ?? {};
    this.clock = opts.clock ?? new RealClock();
    this.resolution = opts.resolution;
    this.venue = opts.venue;

    for (const [name, adapter] of Object.entries(this.feeds)) {
      adapter.subscribe((event) => {
        this.latestEvents.set(name, event);
        this.notify();
      });
    }
  }

  latest(): PredictiveAggregateSnapshot {
    const snapshotFeeds: PredictiveAggregateSnapshot["feeds"] = {};
    const predictiveFeeds: PredictiveAggregateSnapshot["predictiveTape"]["feeds"] = {};
    const healthyFeedNames: string[] = [];
    const now = this.clock.nowMs();
    const resolution = this.resolution?.latest() ?? null;
    const anchor =
      typeof this.resolution?.latestAnchor === "function"
        ? this.resolution.latestAnchor()
        : null;
    const settlementAnchorPrice = anchor?.priceToBeat ?? anchor?.price ?? resolution?.price ?? null;

    for (const [name, event] of this.latestEvents) {
      const divergenceFromSettlementAbs =
        settlementAnchorPrice === null ? null : event.price - settlementAnchorPrice;
      const divergenceFromSettlementPct =
        divergenceFromSettlementAbs !== null && settlementAnchorPrice !== null && settlementAnchorPrice !== 0
          ? (divergenceFromSettlementAbs / settlementAnchorPrice) * 100
          : null;
      snapshotFeeds[name] = {
        price: event.price,
        quality: event.quality,
        latestEventAgeMs: now - event.clock.receivedAtMs,
        arrivalDelayMs: event.freshnessMs,
      };
      predictiveFeeds[name] = {
        ...snapshotFeeds[name]!,
        divergenceFromSettlementAbs,
        divergenceFromSettlementPct,
      };

      if (event.quality === "live") {
        healthyFeedNames.push(name);
      }
    }

    let price: number | null = null;
    let divergenceAbs: number | null = null;
    let divergencePct: number | null = null;
    let disagreement = false;

    if (healthyFeedNames.length > 0) {
      // Calculate Weighted Price
      let totalWeight = 0;
      let weightedSum = 0;
      const healthyPrices: number[] = [];

      for (const name of healthyFeedNames) {
        const weight = this.feedWeights[name] ?? 1.0;
        const p = this.latestEvents.get(name)!.price;
        weightedSum += p * weight;
        totalWeight += weight;
        healthyPrices.push(p);
      }
      
      price = totalWeight > 0 ? weightedSum / totalWeight : null;

      if (price !== null && healthyPrices.length > 1) {
        const max = Math.max(...healthyPrices);
        const min = Math.min(...healthyPrices);
        divergenceAbs = max - min;
        divergencePct = (divergenceAbs / price) * 100;

        // Institutional Disagreement: If high-weight feeds agree but low-weight lags, 
        // we might NOT mark disagreement. For now, we stick to the absolute threshold.
        if (divergenceAbs > this.divergenceThresholdAbs) {
          disagreement = true;
        }
      }
    } else {
      disagreement = true;
    }
    const venue = this.venue?.latest() ?? null;
    const yesSpread = venue?.bestBidUp != null && venue.bestAskUp != null
      ? venue.bestAskUp - venue.bestBidUp
      : null;
    const noSpread = venue?.bestBidDown != null && venue.bestAskDown != null
      ? venue.bestAskDown - venue.bestBidDown
      : null;

    const settlementIsStale =
      !resolution ||
      resolution.quality === "stale" ||
      resolution.quality === "missing" ||
      resolution.stalenessStatus === "stale" ||
      resolution.stalenessStatus === "missing" ||
      resolution.stalenessStatus === "degraded";

    return {
      asset: this.asset,
      timestampMs: now,
      price,
      settlementAnchor: {
        price: settlementAnchorPrice,
        roundId: resolution?.roundId ?? null,
        updatedAtMs: resolution?.chainUpdatedAtMs ?? resolution?.clock.sourceTimestampMs ?? null,
        localReceivedAtMs: resolution?.localReceivedAtMs ?? resolution?.clock.receivedAtMs ?? null,
        lagMs: resolution?.oracleLagMs ?? resolution?.lagMs ?? null,
        isStale: settlementIsStale,
        quality: resolution?.quality ?? null,
        source: resolution?.source ?? null,
        sourceType: resolution?.sourceType ?? null,
      },
      predictiveTape: {
        compositePrice: price,
        feeds: predictiveFeeds,
        divergenceAbs,
        divergencePct,
        disagreement,
      },
      marketPrice: {
        yesBestBid: venue?.bestBidUp ?? null,
        yesBestAsk: venue?.bestAskUp ?? null,
        yesMidpoint: venue?.bestBidUp != null && venue.bestAskUp != null
          ? (venue.bestBidUp + venue.bestAskUp) / 2
          : null,
        noBestBid: venue?.bestBidDown ?? null,
        noBestAsk: venue?.bestAskDown ?? null,
        noMidpoint: venue?.bestBidDown != null && venue.bestAskDown != null
          ? (venue.bestBidDown + venue.bestAskDown) / 2
          : null,
        yesSpread,
        noSpread,
        executable: venue?.bestBidUp != null && venue.bestAskUp != null && venue.bestBidDown != null && venue.bestAskDown != null,
        source: venue?.source ?? null,
      },
      feeds: snapshotFeeds,
      divergenceAbs,
      divergencePct,
      disagreement,
    };
  }

  subscribe(handler: (snapshot: PredictiveAggregateSnapshot) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private notify() {
    const snapshot = this.latest();
    for (const handler of this.handlers) {
      handler(snapshot);
    }
  }
}
