export interface Clock {
  nowMs(): number;
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export class RealClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  setTimeout(handler: () => void, delayMs: number): unknown {
    return setTimeout(handler, delayMs);
  }
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as any);
  }
  setInterval(handler: () => void, intervalMs: number): unknown {
    return setInterval(handler, intervalMs);
  }
  clearInterval(handle: unknown): void {
    clearInterval(handle as any);
  }
}

export type BotAsset = "btc" | "eth" | "xrp" | "sol" | "doge";

export type FeedRole = "resolution" | "venue" | "predictive";

export type FeedQuality = "live" | "delayed" | "stale" | "missing";

export type EventClock = {
  /** Timestamp supplied by the upstream venue/feed, when available. */
  sourceTimestampMs: number | null;
  /** Local wall-clock timestamp captured as soon as the event is received. */
  receivedAtMs: number;
  /** Local wall-clock timestamp after parsing/normalization. */
  processedAtMs: number;
  /** Monotonic local timestamp for ordering within this process. */
  monotonicReceivedNs: bigint;
};

export type RoundWindow = {
  slug: string;
  asset: BotAsset;
  window: "5m" | "15m";
  startTimeMs: number;
  endTimeMs: number;
};

export type FeedEventBase = {
  id: string;
  role: FeedRole;
  source: string;
  asset: BotAsset;
  clock: EventClock;
  quality: FeedQuality;
  freshnessMs: number | null;
  lagMs: number | null;
  round?: RoundWindow;
};

export type ResolutionPriceKind = "live" | "open" | "close";
export type ResolutionSourceType =
  | "chainlink_polygon"
  | "polymarket_chainlink_rtds"
  | "polymarket_crypto_price_api"
  | "replay"
  | "fixture";

export type ResolutionStalenessStatus =
  | "fresh"
  | "stale"
  | "missing"
  | "degraded";

export type ResolutionFeedMetadata = {
  contractAddress?: string;
  description?: string;
  decimals?: number;
  network?: string;
};

export type ResolutionPriceEvent = FeedEventBase & {
  role: "resolution";
  kind: ResolutionPriceKind;
  sourceType?: ResolutionSourceType;
  price: number;
  priceToBeat?: number;
  rawOracleAnswer?: string;
  roundId?: string;
  answeredInRound?: string;
  chainStartedAtMs?: number | null;
  chainUpdatedAtMs?: number | null;
  localReceivedAtMs?: number;
  oracleLagMs?: number | null;
  stalenessStatus?: ResolutionStalenessStatus;
  metadata?: ResolutionFeedMetadata;
};

export type VenueBookSide = {
  bids: Array<[price: number, size: number]>;
  asks: Array<[price: number, size: number]>;
};

export type VenueMetadata = {
  conditionId: string;
  clobTokenIds: [string, string];
  feeRateBps: number;
  closed: boolean;
};

export type VenueOrderBookEvent = FeedEventBase & {
  role: "venue";
  kind: "orderbook";
  up: VenueBookSide | null;
  down: VenueBookSide | null;
  bestBidUp: number | null;
  bestAskUp: number | null;
  bestBidDown: number | null;
  bestAskDown: number | null;
  feeRateBps?: number;
};

export type PredictivePriceEvent = FeedEventBase & {
  role: "predictive";
  kind: "trade" | "ticker" | "mark";
  price: number;
  volume?: number;
  exchange: string;
};

export type BotFeedEvent =
  | ResolutionPriceEvent
  | VenueOrderBookEvent
  | PredictivePriceEvent;

export interface BotDataAdapter<TEvent extends BotFeedEvent> {
  readonly role: TEvent["role"];
  readonly source: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  latest(): TEvent | null;
  subscribe(handler: (event: TEvent) => void): () => void;
}

export interface ResolutionSourceAdapter
  extends BotDataAdapter<ResolutionPriceEvent> {
  priceToBeat(round: RoundWindow): Promise<ResolutionPriceEvent | null>;
  closePrice(round: RoundWindow): Promise<ResolutionPriceEvent | null>;
  /** Returns the most recently latched anchor price (kind: "open") for resolution truth. */
  latestAnchor(): ResolutionPriceEvent | null;
}

export interface VenueDataAdapter extends BotDataAdapter<VenueOrderBookEvent> {
  /**
   * Fetches metadata for a round and returns normalized venue state.
   * If metadata is already supplied (e.g. via recovery), it should be used
   * to avoid redundant network calls.
   */
  initRound(
    round: RoundWindow,
    existingMetadata?: Partial<VenueMetadata>,
  ): Promise<VenueMetadata | null>;
}

export interface PredictiveFeedAdapter
  extends BotDataAdapter<PredictivePriceEvent> {}

export type PredictiveAggregateSnapshot = {
  asset: BotAsset;
  timestampMs: number;
  /** Deprecated compatibility alias for predictiveTape.compositePrice. */
  price: number | null;
  settlementAnchor: {
    price: number | null;
    roundId: string | null;
    updatedAtMs: number | null;
    localReceivedAtMs: number | null;
    lagMs: number | null;
    isStale: boolean;
    quality: FeedQuality | null;
    source: string | null;
    sourceType: ResolutionSourceType | null;
  };
  predictiveTape: {
    compositePrice: number | null;
    feeds: Record<string, {
      price: number;
      quality: FeedQuality;
      latestEventAgeMs: number;
      arrivalDelayMs: number | null;
      divergenceFromSettlementAbs: number | null;
      divergenceFromSettlementPct: number | null;
    }>;
    divergenceAbs: number | null;
    divergencePct: number | null;
    disagreement: boolean;
  };
  marketPrice: {
    yesBestBid: number | null;
    yesBestAsk: number | null;
    yesMidpoint: number | null;
    noBestBid: number | null;
    noBestAsk: number | null;
    noMidpoint: number | null;
    yesSpread: number | null;
    noSpread: number | null;
    executable: boolean;
    source: string | null;
  };
  /** Feeds included in this aggregate. */
  feeds: Record<string, {
    price: number;
    quality: FeedQuality;
    /** Time since the latest event was locally received (ms). */
    latestEventAgeMs: number;
    /** Observed source-to-receive delay (ms), where available. */
    arrivalDelayMs: number | null;
  }>;
  /** Absolute difference between highest and lowest feed prices. */
  divergenceAbs: number | null;
  /** Percentage difference (relative to average). */
  divergencePct: number | null;
  /** True if divergence exceeds threshold or NO healthy feeds remain. */
  disagreement: boolean;
};

export interface PredictiveSignalAggregator {
  latest(): PredictiveAggregateSnapshot;
  subscribe(handler: (snapshot: PredictiveAggregateSnapshot) => void): () => void;
}

export type FeedTimingStats = {
  feed: string;
  sampleCount: number;
  latestArrivalDelayMs: number | null;
  trailingAverageArrivalDelayMs: number | null;
};

export type LeadLagSnapshot = {
  asset: BotAsset;
  timestampMs: number;
  feeds: Record<string, FeedTimingStats>;
  /** The feed with the lowest trailing average arrival delay. */
  observedTimingLeader: string | null;
  /** The feed with the second lowest trailing average arrival delay. */
  observedTimingRunnerUp: string | null;
  /** Difference in trailing average delays between leader and runner-up (ms). */
  averageDelaySpreadMs: number | null;
  /** Qualitative measure of how consistently one feed is arriving before the other. */
  leadershipConfidence: "none" | "weak" | "moderate" | "strong";
  /** True if we have enough samples for all configured feeds to make a determination. */
  sufficientSamples: boolean;
};

export interface LeadLagMonitor {
  latest(): LeadLagSnapshot;
  subscribe(handler: (snapshot: LeadLagSnapshot) => void): () => void;
}

export type WhaleActivity = {
  ts: number;
  side: "buy" | "sell";
  price: number;
  shares: number;
  notionalUsd: number;
  maker?: string;
};

export type OrderFlowSource = "public_inferred" | "user_fill" | "authoritative";

export type OrderFlowSnapshot = {
  asset: BotAsset;
  timestampMs: number;
  source: OrderFlowSource;
  confidence: "low" | "medium" | "high";
  /** Order Book Imbalance: (BidVol - AskVol) / (BidVol + AskVol) */
  imbalanceUp: number | null;
  imbalanceDown: number | null;
  /** Cumulative Volume Delta (CVD) for recent windows */
  cvd10s: { up: number; down: number };
  cvd60s: { up: number; down: number };
  /** Recent Whale activity */
  recentWhales: WhaleActivity[];
  /** High-level sentiment derived from flow */
  sentiment: "bullish" | "bearish" | "neutral";
};

export interface OrderFlowMonitor {
  latest(): OrderFlowSnapshot;
  subscribe(handler: (snapshot: OrderFlowSnapshot) => void): () => void;
}

export type QuantSnapshot = {
  asset: BotAsset;
  timestampMs: number;
  /** Annualized Realized Volatility (sigma) */
  sigma: number | null;
  /** Probability of finishing UP (0.0 - 1.0) */
  probabilityUp: number | null;
  settlementAnchorPrice?: number | null;
  settlementRoundId?: string | null;
  settlementUpdatedAtMs?: number | null;
  settlementLagMs?: number | null;
  settlementIsStale?: boolean;
  predictiveCompositePrice?: number | null;
  noTradeReason?: string | null;
};

export interface QuantMonitor {
  latest(): QuantSnapshot;
  subscribe(handler: (snapshot: QuantSnapshot) => void): () => void;
}

export function createEventClock(params: {
  sourceTimestampMs?: number | null;
  receivedAtMs?: number;
  processedAtMs?: number;
  monotonicReceivedNs?: bigint;
} = {}): EventClock {
  const receivedAtMs = params.receivedAtMs ?? Date.now();
  return {
    sourceTimestampMs: params.sourceTimestampMs ?? null,
    receivedAtMs,
    processedAtMs: params.processedAtMs ?? receivedAtMs,
    monotonicReceivedNs: params.monotonicReceivedNs ?? process.hrtime.bigint(),
  };
}

export function measureFreshness(clock: EventClock): number | null {
  if (clock.sourceTimestampMs === null) return null;
  return Math.max(0, clock.receivedAtMs - clock.sourceTimestampMs);
}

export function measureProcessingLag(clock: EventClock): number {
  return Math.max(0, clock.processedAtMs - clock.receivedAtMs);
}
