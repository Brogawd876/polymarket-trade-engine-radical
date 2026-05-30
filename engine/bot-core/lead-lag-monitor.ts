import {
  type BotAsset,
  type LeadLagMonitor,
  type LeadLagSnapshot,
  type FeedTimingStats,
  type PredictiveSignalAggregator,
  type PredictiveAggregateSnapshot,
  type Clock,
  RealClock,
} from "./data-sources";

export type LeadLagOptions = {
  asset: BotAsset;
  aggregator: PredictiveSignalAggregator;
  /** Window size for rolling average. Default: 50. */
  windowSize?: number;
  /** Minimum samples required per feed before identifying a leader. Default: 10. */
  minSamples?: number;
  /** Threshold for 'weak' confidence spread (ms). Default: 5. */
  weakThresholdMs?: number;
  /** Threshold for 'moderate' confidence spread (ms). Default: 15. */
  moderateThresholdMs?: number;
  /** Threshold for 'strong' confidence spread (ms). Default: 50. */
  strongThresholdMs?: number;
  clock?: Clock;
};

type FeedBuffer = {
  delays: number[];
  avg: number | null;
};

export class DefaultLeadLagMonitor implements LeadLagMonitor {
  private asset: BotAsset;
  private aggregator: PredictiveSignalAggregator;
  private windowSize: number;
  private minSamples: number;
  private weakThresholdMs: number;
  private moderateThresholdMs: number;
  private strongThresholdMs: number;

  private buffers = new Map<string, FeedBuffer>();
  private handlers = new Set<(snapshot: LeadLagSnapshot) => void>();
  private _latest: LeadLagSnapshot | null = null;
  private clock: Clock;

  constructor(opts: LeadLagOptions) {
    this.asset = opts.asset;
    this.aggregator = opts.aggregator;
    this.windowSize = opts.windowSize ?? 50;
    this.minSamples = opts.minSamples ?? 10;
    this.weakThresholdMs = opts.weakThresholdMs ?? 5;
    this.moderateThresholdMs = opts.moderateThresholdMs ?? 15;
    this.strongThresholdMs = opts.strongThresholdMs ?? 50;
    this.clock = opts.clock ?? new RealClock();

    this.aggregator.subscribe((snapshot) => {
      this.processSnapshot(snapshot);
    });
  }

  latest(): LeadLagSnapshot {
    if (!this._latest) {
      return this.emptySnapshot();
    }
    return this._latest;
  }

  subscribe(handler: (snapshot: LeadLagSnapshot) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private processSnapshot(aggSnapshot: PredictiveAggregateSnapshot) {
    for (const [name, feedData] of Object.entries(aggSnapshot.feeds)) {
      if (feedData.quality !== "live" || feedData.arrivalDelayMs === null) {
        continue;
      }

      let buffer = this.buffers.get(name);
      if (!buffer) {
        buffer = { delays: [], avg: null };
        this.buffers.set(name, buffer);
      }

      buffer.delays.push(feedData.arrivalDelayMs);
      if (buffer.delays.length > this.windowSize) {
        buffer.delays.shift();
      }

      buffer.avg = buffer.delays.reduce((a, b) => a + b, 0) / buffer.delays.length;
    }

    this.updateLatest();
  }

  private updateLatest() {
    const now = this.clock.nowMs();
    const feedStats: Record<string, FeedTimingStats> = {};
    const candidates: Array<{ name: string; avg: number }> = [];
    let sufficientSamples = true;

    // Check if we have seen all feeds that the aggregator knows about
    const aggregatorFeeds = Object.keys(this.aggregator.latest().feeds);
    for (const name of aggregatorFeeds) {
      const buffer = this.buffers.get(name);
      const latestFromAgg = this.aggregator.latest().feeds[name];
      
      const stats: FeedTimingStats = {
        feed: name,
        sampleCount: buffer?.delays.length ?? 0,
        latestArrivalDelayMs: latestFromAgg?.arrivalDelayMs ?? null,
        trailingAverageArrivalDelayMs: buffer?.avg ?? null,
      };
      feedStats[name] = stats;

      if (buffer && buffer.avg !== null && buffer.delays.length >= this.minSamples) {
        candidates.push({ name, avg: buffer.avg });
      } else {
        sufficientSamples = false;
      }
    }

    // Sort by average delay ascending (lower is better/faster)
    candidates.sort((a, b) => a.avg - b.avg);

    // Stricter rule: require at least 2 healthy feeds with sufficient samples
    // for a valid cross-exchange leadership comparison.
    const hasComparison = candidates.length >= 2;

    const leader = hasComparison ? candidates[0]!.name : null;
    const runnerUp = hasComparison ? candidates[1]!.name : null;
    const spread = hasComparison
      ? candidates[1]!.avg - candidates[0]!.avg
      : null;

    let confidence: LeadLagSnapshot["leadershipConfidence"] = "none";
    if (spread !== null && sufficientSamples && hasComparison) {
      if (spread > this.strongThresholdMs) confidence = "strong";
      else if (spread > this.moderateThresholdMs) confidence = "moderate";
      else if (spread > this.weakThresholdMs) confidence = "weak";
    }

    this._latest = {
      asset: this.asset,
      timestampMs: now,
      feeds: feedStats,
      observedTimingLeader: leader,
      observedTimingRunnerUp: runnerUp,
      averageDelaySpreadMs: spread,
      leadershipConfidence: confidence,
      sufficientSamples: sufficientSamples && hasComparison,
    };
    this.notify();
  }

  private notify() {
    if (!this._latest) return;
    for (const handler of this.handlers) {
      handler(this._latest);
    }
  }

  private emptySnapshot(): LeadLagSnapshot {
    return {
      asset: this.asset,
      timestampMs: this.clock.nowMs(),
      feeds: {},
      observedTimingLeader: null,
      observedTimingRunnerUp: null,
      averageDelaySpreadMs: null,
      leadershipConfidence: "none",
      sufficientSamples: false,
    };
  }
}
