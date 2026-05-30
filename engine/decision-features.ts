import type { RiskDecision, RiskSnapshot } from "./bot-core/risk-gate.ts";
import type { VenueOrderBookEvent } from "./bot-core/data-sources.ts";
import type { StrategyIntent } from "./bot-core/strategy-intent.ts";
import { stableConfigHash } from "./live-readiness.ts";

export type DecisionFeatureSnapshot = {
  schemaVersion: 1;
  event: "consider" | "blocked" | "placed" | "filled" | "failed" | "settled" | "skipped";
  ts: number;
  slug: string;
  strategy: {
    id: string;
    version: string;
    configHash: string;
    gitCommit: string;
    presetId?: string;
  };
  round: {
    asset: string;
    window: string;
    startTimeMs: number;
    endTimeMs: number;
    timeRemainingMs: number;
    openPrice: number | null;
    currentPrice: number | null;
    gap: number | null;
    direction: "UP" | "DOWN" | "TIE" | null;
    priceToBeat: number | null;
  };
  orderbook: {
    side: "UP" | "DOWN" | null;
    bid: number | null;
    ask: number | null;
    spread: number | null;
    targetLiquidity: number | null;
    slippageEstimatePct: number | null;
  };
  flow: {
    imbalance: number | null;
    cvd10s: number | null;
    cvd60s: number | null;
    whaleCount: number;
    sentiment: string | null;
  };
  feeds: {
    predictivePrice: number | null;
    predictiveDisagreement: boolean | null;
    divergencePct: number | null;
    leadLagConfidence: string | null;
    resolutionFreshnessMs: number | null;
    venueFreshnessMs: number | null;
    predictiveFreshnessMs: number | null;
  };
  settlementTruth: {
    source: string | null;
    sourceType: string | null;
    settlementAnchorPrice: number | null;
    roundId: string | null;
    rawOracleAnswer: string | null;
    updatedAtMs: number | null;
    localReceivedAtMs: number | null;
    oracleLagMs: number | null;
    stalenessStatus: string | null;
    contractAddress: string | null;
  };
  predictiveTape: {
    compositePrice: number | null;
    divergenceFromSettlementAbs: number | null;
    divergenceFromSettlementPct: number | null;
    inputs: Record<string, unknown>;
  };
  marketPrice: {
    yesBestBid: number | null;
    yesBestAsk: number | null;
    noBestBid: number | null;
    noBestAsk: number | null;
    executable: boolean;
  };
  quant: {
    probabilityUp: number | null;
    sigma: number | null;
  };
  risk: {
    approved: boolean | null;
    reasons: string[];
  };
  intent: {
    id?: string;
    action?: "buy" | "sell";
    side?: "UP" | "DOWN";
    price?: number;
    shares?: number;
    orderType?: string;
  } | null;
  outcome: {
    orderStatus?: string;
    orderId?: string;
    pnl?: number;
    resolutionDirection?: "UP" | "DOWN";
  };
};

function gitCommit(): string {
  return process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "local";
}

function orderbookSide(snapshot: RiskSnapshot, side: "UP" | "DOWN" | undefined) {
  const venue = snapshot.venue?.role === "venue" ? snapshot.venue as VenueOrderBookEvent : null;
  if (!venue || !side) return { bid: null, ask: null, spread: null, targetLiquidity: null, slippageEstimatePct: null };
  const bid = side === "UP" ? venue.bestBidUp : venue.bestBidDown;
  const ask = side === "UP" ? venue.bestAskUp : venue.bestAskDown;
  const bookSide = side === "UP" ? venue.up : venue.down;
  const spread = bid != null && ask != null ? parseFloat((ask - bid).toFixed(4)) : null;
  const targetLiquidity = bookSide ? parseFloat(bookSide.asks.slice(0, 3).reduce((sum, [, size]) => sum + size, 0).toFixed(4)) : null;
  return { bid, ask, spread, targetLiquidity, slippageEstimatePct: null };
}

export function createDecisionFeatureSnapshot(params: {
  event: DecisionFeatureSnapshot["event"];
  ts: number;
  slug: string;
  strategyId: string;
  strategyConfig: Record<string, unknown>;
  presetId?: string;
  snapshot: RiskSnapshot;
  intent?: StrategyIntent;
  decision?: RiskDecision;
  orderStatus?: string;
  orderId?: string;
  pnl?: number;
  resolutionDirection?: "UP" | "DOWN";
}): DecisionFeatureSnapshot {
  const resolution = params.snapshot.resolution;
  const predictive = params.snapshot.predictiveAggregate;
  const leadLag = params.snapshot.leadLag;
  const intent = params.intent as (StrategyIntent & { action?: "buy" | "sell"; side?: "UP" | "DOWN"; price?: number; shares?: number; orderType?: string }) | undefined;
  const side = intent?.side;
  const book = orderbookSide(params.snapshot, side);
  const currentPrice = resolution && "price" in resolution ? resolution.price : null;
  const openPrice = resolution && "priceToBeat" in resolution ? resolution.priceToBeat ?? null : null;
  const gap = currentPrice != null && openPrice != null ? parseFloat((currentPrice - openPrice).toFixed(4)) : null;
  const direction = gap == null ? null : gap > 0 ? "UP" : gap < 0 ? "DOWN" : "TIE";
  const predictiveAges = predictive ? Object.values(predictive.feeds).map(feed => feed.latestEventAgeMs) : [];  
  const flow = params.snapshot.orderFlow;
  const settlementAnchorPrice = resolution?.role === "resolution" ? (resolution.priceToBeat ?? resolution.price) : null;
  const predictiveCompositePrice = predictive?.predictiveTape.compositePrice ?? predictive?.price ?? null;
  const divergenceFromSettlementAbs =
    predictiveCompositePrice !== null && settlementAnchorPrice !== null
      ? predictiveCompositePrice - settlementAnchorPrice
      : null;
  const divergenceFromSettlementPct =
    divergenceFromSettlementAbs !== null && settlementAnchorPrice !== null && settlementAnchorPrice !== 0
      ? (divergenceFromSettlementAbs / settlementAnchorPrice) * 100
      : null;

  return {
    schemaVersion: 1,
    event: params.event,
    ts: params.ts,
    slug: params.slug,
    strategy: {
      id: params.strategyId,
      version: "1.0.0",
      configHash: stableConfigHash(params.strategyConfig),
      gitCommit: gitCommit(),
      presetId: params.presetId,
    },
    round: {
      asset: params.snapshot.resolution?.round?.asset ?? intent?.round.asset ?? "btc",
      window: params.snapshot.resolution?.round?.window ?? intent?.round.window ?? "5m",
      startTimeMs: intent?.round.startTimeMs ?? 0,
      endTimeMs: intent?.round.endTimeMs ?? 0,
      timeRemainingMs: intent ? Math.max(0, intent.round.endTimeMs - params.ts) : 0,
      openPrice,
      currentPrice,
      gap,
      direction,
      priceToBeat: openPrice,
    },
    orderbook: {
      side: side ?? null,
      ...book,
    },
    flow: {
      imbalance: side === "UP" ? flow?.imbalanceUp ?? null : side === "DOWN" ? flow?.imbalanceDown ?? null : null,
      cvd10s: side === "UP" ? (flow?.cvd10s.up ?? 0) - (flow?.cvd10s.down ?? 0) : side === "DOWN" ? (flow?.cvd10s.down ?? 0) - (flow?.cvd10s.up ?? 0) : null,
      cvd60s: side === "UP" ? (flow?.cvd60s.up ?? 0) - (flow?.cvd60s.down ?? 0) : side === "DOWN" ? (flow?.cvd60s.down ?? 0) - (flow?.cvd60s.up ?? 0) : null,
      whaleCount: flow?.recentWhales.length ?? 0,
      sentiment: flow?.sentiment ?? "neutral",
    },
    feeds: {
      predictivePrice: predictive?.price ?? null,
      predictiveDisagreement: predictive?.disagreement ?? null,
      divergencePct: predictive?.divergencePct ?? null,
      leadLagConfidence: leadLag?.leadershipConfidence ?? null,
      resolutionFreshnessMs: params.snapshot.resolution?.freshnessMs ?? null,
      venueFreshnessMs: params.snapshot.venue?.freshnessMs ?? null,
      predictiveFreshnessMs: predictiveAges.length > 0 ? Math.max(...predictiveAges) : null,
    },
    settlementTruth: {
      source: resolution?.source ?? null,
      sourceType: resolution && "sourceType" in resolution ? resolution.sourceType ?? null : null,
      settlementAnchorPrice,
      roundId: resolution && "roundId" in resolution ? resolution.roundId ?? null : null,
      rawOracleAnswer: resolution && "rawOracleAnswer" in resolution ? resolution.rawOracleAnswer ?? null : null,
      updatedAtMs: resolution && "chainUpdatedAtMs" in resolution ? resolution.chainUpdatedAtMs ?? resolution.clock.sourceTimestampMs ?? null : resolution?.clock.sourceTimestampMs ?? null,
      localReceivedAtMs: resolution && "localReceivedAtMs" in resolution ? resolution.localReceivedAtMs ?? resolution.clock.receivedAtMs : resolution?.clock.receivedAtMs ?? null,
      oracleLagMs: resolution && "oracleLagMs" in resolution ? resolution.oracleLagMs ?? resolution.lagMs ?? null : resolution?.lagMs ?? null,
      stalenessStatus: resolution && "stalenessStatus" in resolution ? resolution.stalenessStatus ?? null : null,
      contractAddress: resolution && "metadata" in resolution ? resolution.metadata?.contractAddress ?? null : null,
    },
    predictiveTape: {
      compositePrice: predictiveCompositePrice,
      divergenceFromSettlementAbs,
      divergenceFromSettlementPct,
      inputs: predictive?.predictiveTape.feeds ?? predictive?.feeds ?? {},
    },
    marketPrice: {
      yesBestBid: predictive?.marketPrice.yesBestBid ?? book.bid,
      yesBestAsk: predictive?.marketPrice.yesBestAsk ?? book.ask,
      noBestBid: predictive?.marketPrice.noBestBid ?? null,
      noBestAsk: predictive?.marketPrice.noBestAsk ?? null,
      executable: predictive?.marketPrice.executable ?? (book.bid !== null && book.ask !== null),
    },
    quant: {
      probabilityUp: params.snapshot.probabilityUp ?? null,
      sigma: params.snapshot.sigma ?? null,
    },
    risk: {

      approved: params.decision?.approved ?? null,
      reasons: params.decision?.reasons ?? [],
    },
    intent: intent ? {
      id: intent.id,
      action: intent.action,
      side: intent.side,
      price: intent.price,
      shares: intent.shares,
      orderType: intent.orderType,
    } : null,
    outcome: {
      orderStatus: params.orderStatus,
      orderId: params.orderId,
      pnl: params.pnl,
      resolutionDirection: params.resolutionDirection,
    },
  };
}
